package lakeadk

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/genai"

	lakeai "github.com/Clean-Lakes/Lake/internal/ai"
)

const (
	// DefaultAppName is the ADK application name used by the spike.
	DefaultAppName = "lake-adk-spike"
	// DefaultUserID is the single local user used by the spike.
	DefaultUserID = "lake"
)

// Approval is the Lake-facing view of an ADK HITL confirmation request.
type Approval struct {
	ID       string
	Hint     string
	Tool     string
	Args     map[string]any
	Payload  any
	Original *genai.FunctionCall
}

// ToolCall is one model-requested tool call observed in the ADK event stream.
type ToolCall struct {
	ID   string
	Name string
	Args map[string]any
}

// ToolResult is one tool response observed in the ADK event stream.
type ToolResult struct {
	ID       string
	Name     string
	Response map[string]any
}

// Sink receives mapped ADK events. Lake's web layer will implement this
// interface when the runtime is wired into the workbench.
type Sink interface {
	MessageDelta(text string)
	Message(text string)
	ToolCall(ToolCall)
	ToolResult(ToolResult)
	Approval(Approval)
	Error(error)
	Done()
}

// Runtime hosts one ADK LlmAgent and translates its events into Lake-shaped
// callbacks.
type Runtime struct {
	runner  *runner.Runner
	sink    Sink
	appName string
	userID  string
}

const defaultInstruction = "You are Lake's SRE agent. Use the available tools to collect evidence before drawing conclusions. " +
	"Never claim an operation was executed unless a tool response says so. " +
	"If a tool returns approval_required, stop this turn and wait for the user's decision in Lake; do not retry the operation."

// NewRuntime builds an ADK runtime with Lake's default SRE instruction.
func NewRuntime(llm model.LLM, tools []tool.Tool, sessions session.Service, sink Sink) (*Runtime, error) {
	return NewRuntimeWithInstruction(llm, tools, sessions, sink, defaultInstruction)
}

// NewRuntimeWithInstruction builds an ADK runtime with a caller-provided
// instruction. InstructionProvider is used so Lake prompts containing braces
// are not treated as ADK state templates.
func NewRuntimeWithInstruction(llm model.LLM, tools []tool.Tool, sessions session.Service, sink Sink, instruction string) (*Runtime, error) {
	if llm == nil {
		return nil, errors.New("model is required")
	}
	if sessions == nil {
		return nil, errors.New("session service is required")
	}
	if sink == nil {
		sink = NopSink{}
	}
	config := llmagent.Config{
		Name:        "lake_sre_agent",
		Description: "Lake SRE agent",
		Model:       llm,
		Tools:       tools,
	}
	if instruction == "" {
		config.Instruction = defaultInstruction
	} else {
		config.InstructionProvider = func(agent.ReadonlyContext) (string, error) {
			return instruction, nil
		}
	}
	root, err := llmagent.New(config)
	if err != nil {
		return nil, fmt.Errorf("create ADK agent: %w", err)
	}
	r, err := runner.New(runner.Config{
		AppName:           DefaultAppName,
		Agent:             root,
		SessionService:    sessions,
		AutoCreateSession: true,
	})
	if err != nil {
		return nil, fmt.Errorf("create ADK runner: %w", err)
	}
	return &Runtime{runner: r, sink: sink, appName: DefaultAppName, userID: DefaultUserID}, nil
}

// RunTurn sends one text user message through the ADK runtime.
func (r *Runtime) RunTurn(ctx context.Context, sessionID, text string) error {
	return r.RunTurnImages(ctx, sessionID, text, nil)
}

// RunTurnImages sends a user message with optional image attachments.
func (r *Runtime) RunTurnImages(ctx context.Context, sessionID, text string, images []lakeai.ImageAttachment) error {
	if strings.TrimSpace(text) == "" && len(images) == 0 {
		return errors.New("message is empty")
	}
	images, err := lakeai.ValidateImages(images)
	if err != nil {
		return err
	}
	parts := make([]*genai.Part, 0, len(images)+1)
	if text != "" {
		parts = append(parts, &genai.Part{Text: text})
	}
	for _, image := range images {
		data, err := base64.StdEncoding.DecodeString(image.Base64)
		if err != nil {
			return errors.New("invalid image data")
		}
		parts = append(parts, &genai.Part{InlineData: &genai.Blob{
			MIMEType: image.MimeType,
			Data:     data,
		}})
	}
	return r.run(ctx, sessionID, &genai.Content{Role: string(genai.RoleUser), Parts: parts})
}

// Resume sends the user's confirmation decision back to ADK. confirmationID is
// the ID of the adk_request_confirmation function call; payload is the opaque
// payload Lake rendered to the user (it carries the approval token).
func (r *Runtime) Resume(ctx context.Context, sessionID, confirmationID string, approved bool, payload any) error {
	if strings.TrimSpace(confirmationID) == "" {
		return errors.New("confirmation id is required")
	}
	content := &genai.Content{
		Role: genai.RoleUser,
		Parts: []*genai.Part{{
			FunctionResponse: &genai.FunctionResponse{
				Name: toolconfirmation.FunctionCallName,
				ID:   confirmationID,
				Response: map[string]any{
					"confirmed": approved,
					"payload":   payload,
				},
			},
		}},
	}
	return r.run(ctx, sessionID, content)
}

func (r *Runtime) run(ctx context.Context, sessionID string, content *genai.Content) error {
	for event, err := range r.runner.Run(ctx, r.userID, sessionID, content, agent.RunConfig{
		StreamingMode: agent.StreamingModeSSE,
	}) {
		if err != nil {
			r.sink.Error(err)
			return err
		}
		r.consume(event)
	}
	r.sink.Done()
	return nil
}

func (r *Runtime) consume(event *session.Event) {
	if event == nil {
		return
	}
	if event.Content != nil {
		for _, part := range event.Content.Parts {
			if part == nil {
				continue
			}
			if part.Text != "" {
				if event.LLMResponse.Partial {
					r.sink.MessageDelta(part.Text)
				} else {
					r.sink.Message(part.Text)
				}
			}
			if part.FunctionCall != nil {
				if part.FunctionCall.Name == toolconfirmation.FunctionCallName {
					approval, err := approvalFromCall(part.FunctionCall)
					if err != nil {
						r.sink.Error(err)
						continue
					}
					r.sink.Approval(approval)
					continue
				}
				r.sink.ToolCall(ToolCall{
					ID:   part.FunctionCall.ID,
					Name: part.FunctionCall.Name,
					Args: part.FunctionCall.Args,
				})
			}
			if part.FunctionResponse != nil {
				r.sink.ToolResult(ToolResult{
					ID:       part.FunctionResponse.ID,
					Name:     part.FunctionResponse.Name,
					Response: part.FunctionResponse.Response,
				})
			}
		}
	}
	if event.ErrorMessage != "" {
		r.sink.Error(errors.New(event.ErrorMessage))
	}
}

func approvalFromCall(call *genai.FunctionCall) (Approval, error) {
	original, err := toolconfirmation.OriginalCallFrom(call)
	if err != nil {
		return Approval{}, fmt.Errorf("decode confirmation call: %w", err)
	}
	approval := Approval{
		ID:       call.ID,
		Tool:     original.Name,
		Args:     original.Args,
		Original: original,
	}
	if raw, ok := call.Args["toolConfirmation"]; ok {
		switch conf := raw.(type) {
		case map[string]any:
			approval.Hint = stringValue(conf["hint"])
			approval.Payload = conf["payload"]
		case toolconfirmation.ToolConfirmation:
			approval.Hint = conf.Hint
			approval.Payload = conf.Payload
		case *toolconfirmation.ToolConfirmation:
			if conf != nil {
				approval.Hint = conf.Hint
				approval.Payload = conf.Payload
			}
		}
	}
	if approval.Payload == nil {
		approval.Payload = map[string]any{}
	}
	return approval, nil
}

// NopSink discards all events.
type NopSink struct{}

func (NopSink) MessageDelta(string)   {}
func (NopSink) Message(string)        {}
func (NopSink) ToolCall(ToolCall)     {}
func (NopSink) ToolResult(ToolResult) {}
func (NopSink) Approval(Approval)     {}
func (NopSink) Error(error)           {}
func (NopSink) Done()                 {}

// RecordingSink is a small in-memory sink for tests and the spike CLI.
type RecordingSink struct {
	mu        sync.Mutex
	Deltas    []string
	Messages  []string
	Calls     []ToolCall
	Results   []ToolResult
	Approvals []Approval
	Errors    []error
	DoneCount int
}

func (s *RecordingSink) MessageDelta(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Deltas = append(s.Deltas, text)
}

func (s *RecordingSink) Message(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Messages = append(s.Messages, text)
}

func (s *RecordingSink) ToolCall(call ToolCall) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Calls = append(s.Calls, call)
}

func (s *RecordingSink) ToolResult(result ToolResult) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Results = append(s.Results, result)
}

func (s *RecordingSink) Approval(approval Approval) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Approvals = append(s.Approvals, approval)
}

func (s *RecordingSink) Error(err error) {
	if err == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Errors = append(s.Errors, err)
}

func (s *RecordingSink) Done() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.DoneCount++
}

// Snapshot returns copies so tests can inspect a sink while the runtime runs.
func (s *RecordingSink) Snapshot() ([]string, []string, []ToolCall, []ToolResult, []Approval, []error, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.Deltas...),
		append([]string(nil), s.Messages...),
		append([]ToolCall(nil), s.Calls...),
		append([]ToolResult(nil), s.Results...),
		append([]Approval(nil), s.Approvals...),
		append([]error(nil), s.Errors...),
		s.DoneCount
}
