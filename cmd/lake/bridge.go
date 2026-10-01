package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/cloudwego/eino/lake/code"
	"github.com/cloudwego/eino/lake/code/remote"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cloudwego/eino/lake/agent"
	lakemodel "github.com/cloudwego/eino/lake/model"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/lake/workflow"
)

// The desktop client speaks newline-delimited JSON with a single, long-lived
// Lake Agent. The process owns the SSH connections and closes them on exit.
type bridgeRequest struct {
	UIAction         *agent.UIUserAction     `json:"ui_action,omitempty"`
	ReviewOnly       bool                    `json:"review_only,omitempty"`
	TaskCommands     bool                    `json:"task_commands,omitempty"`
	ExecutionRefs    []uint64                `json:"execution_refs,omitempty"`
	CommandReply     *commandReply           `json:"command_reply,omitempty"`
	Type             string                  `json:"type"`
	ID               string                  `json:"id,omitempty"`
	Version          int                     `json:"version,omitempty"`
	Prompt           string                  `json:"prompt,omitempty"`
	Approved         bool                    `json:"approved,omitempty"`
	Images           []store.ImageAttachment `json:"images,omitempty"`
	Workflow         *workflowRunInput       `json:"workflow,omitempty"`
	WorkflowV2       *workflowV2DesktopInput `json:"workflow_v2,omitempty"`
	SpecialistResume *specialistResumeInput  `json:"specialist_resume,omitempty"`
	QuestionID       string                  `json:"question_id,omitempty"`
	Answers          map[string]string       `json:"answers,omitempty"`
}

type bridgeEvent struct {
	UI          *agent.UISnapshot          `json:"ui,omitempty"`
	Activity    *store.ConversationEvent   `json:"activity,omitempty"`
	Report      *agent.VisualReport        `json:"report,omitempty"`
	ReportID    string                     `json:"report_id,omitempty"`
	Type        string                     `json:"type"`
	ID          string                     `json:"id,omitempty"`
	Version     int                        `json:"version"`
	Sequence    uint64                     `json:"sequence"`
	Model       string                     `json:"model,omitempty"`
	Label       string                     `json:"label,omitempty"`
	Text        string                     `json:"text,omitempty"`
	Error       string                     `json:"error,omitempty"`
	Path        string                     `json:"path,omitempty"`
	Command     string                     `json:"command,omitempty"`
	Kind        string                     `json:"kind,omitempty"`
	Sessions    []operate.SSHSessionStatus `json:"sessions,omitempty"`
	Workflow    *workflow.Progress         `json:"workflow,omitempty"`
	Specialist  *store.SpecialistCall      `json:"specialist,omitempty"`
	Specialists []store.SpecialistCall     `json:"specialists,omitempty"`
	ToolCallID  string                     `json:"tool_call_id,omitempty"`
	MCPServer   string                     `json:"mcp_server,omitempty"`
	MCPTool     string                     `json:"mcp_tool,omitempty"`
	Status      string                     `json:"status,omitempty"`
	Question    *agent.UserQuestionRequest `json:"question,omitempty"`
	QuestionID  string                     `json:"question_id,omitempty"`
	Answers     map[string]string          `json:"answers,omitempty"`
}

type bridgeOutput struct {
	mu           sync.Mutex
	enc          *json.Encoder
	nextSequence uint64
}

func (b *bridgeOutput) send(event bridgeEvent) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.nextSequence++
	event.Version = 1
	event.Sequence = b.nextSequence
	_ = b.enc.Encode(event)
}

func workflowTrace(call store.SpecialistCall, progress workflow.Progress) store.SpecialistCall {
	call.Steps = append([]store.WorkflowStepTrace(nil), call.Steps...)
	call.ID = "workflow-" + progress.RunID
	call.Kind = "workflow"
	call.Task = progress.Name
	call.RunID = progress.RunID
	call.Completed = progress.Completed
	call.Total = progress.Total
	if progress.Planning != nil {
		call.Planning, _ = json.Marshal(progress.Planning)
	}
	switch progress.Status {
	case "completed":
		call.Stage = "completed"
	case "failed", "interrupted", "cancelled":
		call.Stage = "failed"
	default:
		call.Stage = "working"
	}
	if progress.StepID != "" {
		message := progress.Message
		if len(message) > 512 {
			message = message[:512] + "…"
		}
		step := store.WorkflowStepTrace{ID: progress.StepID, Name: progress.StepName, Resource: progress.Resource, Kind: progress.Kind, Status: progress.StepStatus, Message: message}
		for i := range call.Steps {
			if call.Steps[i].ID == step.ID {
				call.Steps[i] = step
				return call
			}
		}
		call.Steps = append(call.Steps, step)
	}
	return call
}

// Eino may execute several SSH tools concurrently. The desktop UI displays
// one approval at a time, so each request must keep its own response channel
// until the user has answered it.
type bridgeApprovalGate struct {
	serial   sync.Mutex
	mu       sync.Mutex
	id       string
	response chan bool
	closed   bool
}

func (g *bridgeApprovalGate) request(ctx context.Context, id, kind, path, command string, emit func(bridgeEvent)) (bool, error) {
	g.serial.Lock()
	defer g.serial.Unlock()

	response := make(chan bool, 1)
	g.mu.Lock()
	if g.closed {
		g.mu.Unlock()
		return false, errors.New("审批通道已关闭")
	}
	g.id, g.response = id, response
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		g.id, g.response = "", nil
		g.mu.Unlock()
	}()

	emit(bridgeEvent{Type: "approval", ID: id, Kind: kind, Path: path, Command: command})
	select {
	case approved := <-response:
		return approved, nil
	case <-ctx.Done():
		return false, ctx.Err()
	}
}

func (g *bridgeApprovalGate) respond(id string, approved bool) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed || g.response == nil || g.id != id {
		return false
	}
	select {
	case g.response <- approved:
		return true
	default:
		return false
	}
}

func (g *bridgeApprovalGate) close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
	if g.response != nil {
		select {
		case g.response <- false:
		default:
		}
	}
}

func runBridge(ctx context.Context, root string, input io.Reader, out io.Writer) error {
	return runBridgeConversation(ctx, root, "", input, out)
}

func runBridgeConversation(ctx context.Context, root, conversationID string, input io.Reader, out io.Writer) error {
	return runBridgeConversationRuntime(ctx, root, conversationID, input, out, "eino")
}

func runBridgeConversationRuntime(ctx context.Context, root, conversationID string, input io.Reader, out io.Writer, runtimeName string) error {
	uiSession := agent.NewUISession()
	var conversationStore *store.Store
	var initialTurns []store.ConversationTurn
	var projectPath string
	var remoteWorkspaceID string
	var lakeID, projectID string
	if conversationID != "" {
		var err error
		conversationStore, err = store.Open(ctx, root)
		if err != nil {
			return err
		}
		defer conversationStore.Close()
		conversation, err := conversationStore.GetConversation(ctx, conversationID)
		if err != nil {
			return err
		}
		current, err := conversationStore.CurrentLake(ctx)
		if err != nil {
			return err
		}
		if current.ID != conversation.LakeID {
			return errors.New("会话所属湖与当前湖不一致")
		}
		projectPath = conversation.ProjectPath
		remoteWorkspaceID = conversation.RemoteWorkspaceID
		lakeID, projectID = conversation.LakeID, conversation.ProjectID
		initialTurns, err = conversationStore.ListConversationTurns(ctx, conversationID)
		if err != nil {
			return err
		}
		for after := uint64(0); ; {
			events, err := conversationStore.ListAgentEvents(ctx, conversationID, after, 200)
			if err != nil {
				return err
			}
			if len(events) == 0 {
				break
			}
			for _, event := range events {
				if event.Kind != "a2ui" {
					continue
				}
				var payload struct {
					UIJSON string `json:"ui_json"`
				}
				var snapshot agent.UISnapshot
				if json.Unmarshal(event.Payload, &payload) == nil && json.Unmarshal([]byte(payload.UIJSON), &snapshot) == nil {
					if err := uiSession.Restore(snapshot); err != nil {
						return fmt.Errorf("恢复动态界面: %w", err)
					}
				}
			}
			after = events[len(events)-1].Sequence
		}
	}
	writer := &bridgeOutput{enc: json.NewEncoder(out)}
	var stateMu sync.Mutex
	var pendingID string
	recordEvent := func(kind, actor, toolCallID string, body map[string]any) (store.ConversationEvent, error) {
		if conversationStore == nil {
			return store.ConversationEvent{}, nil
		}
		payload, err := json.Marshal(body)
		if err != nil {
			return store.ConversationEvent{}, err
		}
		event, err := conversationStore.AppendAgentEvent(ctx, conversationID, store.AgentEventInput{Kind: kind, Actor: actor, ToolCallID: toolCallID, Payload: payload})
		if err == nil && (kind == "tool_proposed" || kind == "tool_finished" || kind == "summary_created") {
			stateMu.Lock()
			turnID := pendingID
			stateMu.Unlock()
			if turnID != "" {
				writer.send(bridgeEvent{Type: "activity", ID: turnID, Activity: &event})
			}
		}
		return event, err
	}
	chatInput, chatWriter := io.Pipe()
	var capture bytes.Buffer
	var pendingReviewOnly bool
	var pendingUIAction *agent.UIUserAction
	var presentedUI []string
	var presentedReports []string
	emitUI := func(uiCtx context.Context, snapshot agent.UISnapshot) error {
		stateMu.Lock()
		id := pendingID
		stateMu.Unlock()
		if id == "" {
			return errors.New("当前没有可展示界面的任务")
		}
		if err := uiCtx.Err(); err != nil {
			return err
		}
		checked, err := store.SanitizeUISnapshot(snapshot)
		if err != nil {
			return err
		}
		body, _ := json.Marshal(checked)
		if _, err := recordEvent("a2ui", "agent", "", map[string]any{"ui_json": string(body)}); err != nil {
			return err
		}
		if err := uiSession.Restore(checked); err != nil {
			return err
		}
		stateMu.Lock()
		presentedUI = append(presentedUI, string(body))
		stateMu.Unlock()
		writer.send(bridgeEvent{Type: "a2ui", ID: id, UI: &checked})
		return nil
	}
	emitReport := func(reportCtx context.Context, report agent.VisualReport) error {
		stateMu.Lock()
		id := pendingID
		stateMu.Unlock()
		if id == "" {
			return errors.New("当前没有可展示报告的任务")
		}
		if err := reportCtx.Err(); err != nil {
			return err
		}
		checked, err := store.SanitizeVisualReport(report)
		if err != nil {
			return err
		}
		reportID, err := store.NewActionID()
		if err != nil {
			return err
		}
		body, err := json.Marshal(checked)
		if err != nil {
			return err
		}
		event, err := recordEvent("visual_report", "agent", "", map[string]any{"report_id": reportID, "report_json": string(body)})
		if err != nil {
			return err
		}
		if conversationStore != nil {
			var payload struct {
				ReportJSON string `json:"report_json"`
			}
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				return err
			}
			checked, err = agent.ParseVisualReport([]byte(payload.ReportJSON))
			if err != nil {
				return err
			}
		}
		body, _ = json.Marshal(checked)
		stateMu.Lock()
		if pendingID == id {
			presentedReports = append(presentedReports, string(body))
			if len(presentedReports) > 4 {
				presentedReports = presentedReports[len(presentedReports)-4:]
			}
		}
		stateMu.Unlock()
		writer.send(bridgeEvent{Type: "visual_report", ID: id, ReportID: reportID, Report: &checked})
		return nil
	}
	var pendingUserSeq uint64
	var activeModel string
	var approvalCount uint64
	var pendingPrompt string
	var pendingImages []store.ImageAttachment
	var activeImages []store.ImageAttachment
	var specialistCalls []store.SpecialistCall
	toolStarts := make(map[string]bool)
	toolFinishes := make(map[string]bool)
	toolStartedAt := make(map[string]time.Time)
	mcpCatalog := make(map[string]mcpToolDisplay)
	mcpCalls := make(map[string]mcpToolDisplay)
	recordToolStart := func(id, name, arguments string) error {
		if id != "" && toolStarts[id] {
			return nil
		}
		body := map[string]any{"tool_name": name}
		action := toolActivityAction(name, arguments)
		body["activity_kind"], body["activity_action"] = action.Kind, action.Action
		if action.Count > 0 {
			body["activity_count"] = action.Count
		}
		if preview := toolActivityPreview(name, arguments); preview != "" {
			body["preview"] = preview
		}
		meta, isMCP := mcpCatalog[name]
		if isMCP {
			body["mcp_server"] = meta.Server
			body["mcp_tool"] = meta.Tool
		}
		if arguments != "" {
			digest := sha256.Sum256([]byte(arguments))
			body["arguments_sha256"] = hex.EncodeToString(digest[:])
		}
		if _, err := recordEvent("tool_proposed", "agent", id, body); err != nil {
			return err
		}
		if id != "" {
			toolStarts[id] = true
			toolStartedAt[id] = time.Now()
			if isMCP {
				mcpCalls[id] = meta
			}
		}
		if isMCP {
			stateMu.Lock()
			turnID := pendingID
			stateMu.Unlock()
			if turnID != "" {
				writer.send(bridgeEvent{Type: "mcp_tool", ID: turnID, ToolCallID: id, MCPServer: meta.Server, MCPTool: meta.Tool, Status: "running"})
			}
		}
		return nil
	}
	recordToolFinish := func(id, status string, errorCode ...string) error {
		if id != "" && toolFinishes[id] {
			return nil
		}
		body := map[string]any{"status": status}
		if len(errorCode) > 0 && errorCode[0] != "" {
			body["error_code"] = errorCode[0]
		}
		if started, ok := toolStartedAt[id]; ok {
			body["duration_ms"] = time.Since(started).Milliseconds()
		}
		if _, err := recordEvent("tool_finished", "tool", id, body); err != nil {
			return err
		}
		if id != "" {
			toolFinishes[id] = true
		}
		if meta, ok := mcpCalls[id]; ok {
			stateMu.Lock()
			turnID := pendingID
			stateMu.Unlock()
			if turnID != "" {
				writer.send(bridgeEvent{Type: "mcp_tool", ID: turnID, ToolCallID: id, MCPServer: meta.Server, MCPTool: meta.Tool, Status: status})
			}
			delete(mcpCalls, id)
		}
		return nil
	}
	commands := newBridgeCommandGate()
	defer commands.close()
	approvals := &bridgeApprovalGate{}
	questions := &bridgeQuestionGate{}
	defer questions.close()
	finished := make(chan error, 1)
	ready := make(chan struct{})
	var taskCommands atomic.Bool
	var hooks *chatHooks
	hooks = &chatHooks{
		AgentRuntime: runtimeName,
		UISession:    uiSession,
		PresentUI:    emitUI,
		TakeUIAction: func() *agent.UIUserAction {
			stateMu.Lock()
			defer stateMu.Unlock()
			action := pendingUIAction
			pendingUIAction = nil
			return action
		},
		RecordUIExecution: func(recordCtx context.Context, record store.ExecutionRecord) error {
			if conversationStore == nil {
				return nil
			}
			_, event, err := conversationStore.AppendExecution(recordCtx, conversationID, record)
			if err != nil {
				return err
			}
			stateMu.Lock()
			id := pendingID
			stateMu.Unlock()
			writer.send(bridgeEvent{Type: "execution", ID: id, Activity: &event})
			return nil
		},
		PresentReport: emitReport,
		CommandRunner: func(commandCtx context.Context, kind, target, command string) (store.ExecutionRecord, error) {
			if !taskCommands.Load() {
				record := store.ExecutionRecord{Command: command, Target: target, WorkingDirectory: target, NextDirectory: target, Actor: "agent"}
				if kind == "local" {
					workspace, err := code.Open(target)
					if err != nil {
						return record, err
					}
					if err := authorizeToolAction(commandCtx, lakeID, target, "lake_code_run", "execute", target, "code-run", command, hooks.Approve); err != nil {
						return record, err
					}
					result, err := workspace.Run(commandCtx, command)
					record.Stdout, record.Stderr, record.ExitCode = result.Stdout, result.Stderr, result.ExitCode
					return record, err
				}
				if conversationStore == nil {
					return record, errors.New("远程工作区未配置")
				}
				result, err := (remote.Service{Store: conversationStore, Approve: hooks.Approve, Actor: "agent"}).Run(commandCtx, target, command)
				record.Stdout, record.Stderr, record.ExitCode = result.Stdout, result.Stderr, result.ExitCode
				if result.Unknown {
					record.Status = "unknown"
				}
				return record, err
			}
			stateMu.Lock()
			turnID := pendingID
			stateMu.Unlock()
			return commands.request(commandCtx, kind, target, command, func(id string) {
				writer.send(bridgeEvent{Type: "command_proposed", ID: turnID, ToolCallID: id, Kind: kind, Path: target, Command: command})
			})
		},
		PreparePrompt: func(prompt string) (string, error) {
			if conversationStore == nil {
				return prompt, nil
			}
			return conversationStore.WithExecutionContext(ctx, conversationID, prompt)
		},
		ReportReviewOnly: func() bool {
			stateMu.Lock()
			defer stateMu.Unlock()
			return pendingReviewOnly
		},
		AskUser: func(questionCtx context.Context, input agent.UserQuestionInput) (agent.UserQuestionAnswer, error) {
			stateMu.Lock()
			turnID := pendingID
			stateMu.Unlock()
			return questions.requestAnswer(questionCtx, turnID, input, func(request agent.UserQuestionRequest) error {
				body, _ := json.Marshal(request.Questions)
				if _, err := recordEvent("question_asked", "agent", request.ID, map[string]any{"question_id": request.ID, "questions_json": string(body)}); err != nil {
					return err
				}
				writer.send(bridgeEvent{Type: "question", ID: turnID, Question: &request})
				return nil
			})
		},
		InitialTurns:      initialTurns,
		ProjectPath:       projectPath,
		RemoteWorkspaceID: remoteWorkspaceID,
		ConversationID:    conversationID,
		OnSummary: func(summary *agent.ContextSummary) error {
			if conversationStore == nil {
				return nil
			}
			if err := conversationStore.SaveConversationSummary(ctx, conversationID, store.ConversationSummaryInput{
				ThroughSeq: summary.ThroughSeq, Text: summary.Text, SourceEventIDs: summary.SourceEventIDs, TokenEstimate: summary.TokenEstimate, TaskState: summary.TaskState,
			}); err != nil {
				return err
			}
			_, err := recordEvent("summary_created", "agent", "", map[string]any{"through_seq": summary.ThroughSeq, "token_estimate": summary.TokenEstimate})
			return err
		},
		TakeImages: func() []store.ImageAttachment {
			stateMu.Lock()
			defer stateMu.Unlock()
			images := pendingImages
			pendingImages = nil
			return images
		},
		OnReady: func(model string) {
			activeModel = model
			writer.send(bridgeEvent{Type: "ready", Model: model})
			close(ready)
		},
		OnUsage: func(usage lakemodel.UsageSnapshot) error {
			if usage.Calls == 0 {
				return nil
			}
			_, err := recordEvent("model_usage", "model", "", map[string]any{
				"input_tokens":  usage.TotalInputTokens(),
				"output_tokens": usage.OutputTokens + usage.EstimatedOutputTokens,
				"estimated":     usage.EstimatedCalls > 0,
			})
			return err
		},
		OnToolProposed: recordToolStart,
		OnToolFinished: func(id, _ string, status string) error {
			return recordToolFinish(id, status)
		},
		OnToolResult: func(id, name, content string) error {
			return recordToolFinish(id, toolActivityStatus(content), presentationErrorCode(name, content))
		},
		OnMCPTools: func(items []mcpToolDisplay) {
			for _, item := range items {
				mcpCatalog[item.Name] = item
			}
		},
		OnAssistantStep: func(content string) error {
			text := strings.TrimSpace(content)
			if text == "" {
				return nil
			}
			runes := []rune(text)
			if len(runes) > 2048 {
				text = string(runes[:2048]) + "…"
			}
			if _, err := recordEvent("assistant_progress", "assistant", "", map[string]any{"preview": text}); err != nil {
				return err
			}
			stateMu.Lock()
			id := pendingID
			stateMu.Unlock()
			if id != "" {
				writer.send(bridgeEvent{Type: "assistant_step", ID: id, Text: text})
			}
			return nil
		},
		OnProgress: func(label string) {
			stateMu.Lock()
			id := pendingID
			stateMu.Unlock()
			if id != "" {
				writer.send(bridgeEvent{Type: "progress", ID: id, Label: label})
			}
		},
		OnSpecialist: func(call store.SpecialistCall) {
			stateMu.Lock()
			id := pendingID
			if id != "" {
				found := false
				for i := range specialistCalls {
					if specialistCalls[i].ID == call.ID {
						specialistCalls[i] = call
						found = true
						break
					}
				}
				if !found {
					specialistCalls = append(specialistCalls, call)
				}
			}
			stateMu.Unlock()
			if id != "" {
				var eventErr error
				if call.Stage == "delegated" {
					eventErr = recordToolStart(call.ID, "lake_"+call.Kind+"_agent", "")
				} else if call.Stage == "completed" || call.Stage == "failed" {
					eventErr = recordToolFinish(call.ID, call.Stage)
				}
				if eventErr == nil {
					_, eventErr = recordEvent("specialist", "specialist", call.ID, map[string]any{"name": call.Kind, "status": call.Stage})
				}
				if eventErr != nil {
					writer.send(bridgeEvent{Type: "error", ID: id, Error: fmt.Sprintf("保存专员事件失败: %v", eventErr)})
				}
				writer.send(bridgeEvent{Type: "specialist", ID: id, Specialist: &call})
			}
		},
		OnWorkflow: func(step workflow.Progress) {
			stateMu.Lock()
			id := pendingID
			var trace store.SpecialistCall
			if id != "" {
				traceID := "workflow-" + step.RunID
				for index := range specialistCalls {
					if specialistCalls[index].ID == traceID {
						trace = workflowTrace(specialistCalls[index], step)
						specialistCalls[index] = trace
						break
					}
				}
				if trace.ID == "" {
					trace = workflowTrace(store.SpecialistCall{}, step)
					specialistCalls = append(specialistCalls, trace)
				}
			}
			stateMu.Unlock()
			if id != "" {
				payload := map[string]any{"run_id": step.RunID, "name": step.Name, "status": step.Status, "step_name": step.StepName, "step_status": step.StepStatus, "completed": step.Completed, "total": step.Total}
				if step.Planning != nil {
					encoded, _ := json.Marshal(step.Planning)
					payload["planning_json"] = string(encoded)
				}
				if _, err := recordEvent("workflow", "workflow", step.RunID, payload); err != nil {
					writer.send(bridgeEvent{Type: "error", ID: id, Error: fmt.Sprintf("保存工作流事件失败: %v", err)})
				}
				writer.send(bridgeEvent{Type: "specialist", ID: id, Specialist: &trace})
				label := fmt.Sprintf("工作流 %s · %d/%d", step.Name, step.Completed, step.Total)
				if step.StepName != "" {
					label += " · " + step.StepName + "：" + step.StepStatus
				}
				if step.Status == "planning" || step.Planning != nil {
					label = step.Message
				}
				writer.send(bridgeEvent{Type: "workflow", ID: id, Label: label, Workflow: &step})
			}
		},
		OnTurn: func(prompt, answer string, turnErr error, sessions []operate.SSHSessionStatus) (store.ConversationTurn, error) {
			stateMu.Lock()
			id := pendingID
			userSeq := pendingUserSeq
			originalPrompt := pendingPrompt
			reports := append([]string(nil), presentedReports...)
			uis := append([]string(nil), presentedUI...)
			images := activeImages
			specialists := append([]store.SpecialistCall(nil), specialistCalls...)
			unfinished := make(map[string]mcpToolDisplay)
			for callID := range toolStarts {
				if !toolFinishes[callID] {
					unfinished[callID] = mcpCalls[callID]
				}
			}
			pendingID = ""
			pendingReviewOnly = false
			pendingUIAction = nil
			presentedUI = nil
			presentedReports = nil
			pendingUserSeq = 0
			clear(toolStarts)
			clear(toolFinishes)
			clear(toolStartedAt)
			clear(mcpCalls)
			pendingPrompt = ""
			pendingImages = nil
			activeImages = nil
			specialistCalls = nil
			stateMu.Unlock()
			for callID, meta := range unfinished {
				activity, err := recordEvent("tool_finished", "tool", callID, map[string]any{"status": "unknown"})
				if err != nil {
					writer.send(bridgeEvent{Type: "error", ID: id, Error: fmt.Sprintf("保存工具调用状态失败: %v", err)})
				} else if activity.Sequence > 0 {
					writer.send(bridgeEvent{Type: "activity", ID: id, Activity: &activity})
				}
				if meta.Server != "" {
					writer.send(bridgeEvent{Type: "mcp_tool", ID: id, ToolCallID: callID, MCPServer: meta.Server, MCPTool: meta.Tool, Status: "failed"})
				}
			}
			event := bridgeEvent{Type: "result", ID: id, Text: strings.TrimSpace(capture.String()), Sessions: sessions, Specialists: specialists}
			capture.Reset()
			if turnErr != nil {
				event.Error = turnErr.Error()
			}
			var saved store.ConversationTurn
			var saveErr error
			if conversationStore != nil && id != "" {
				if originalPrompt == "" {
					originalPrompt = prompt
				}
				saved, saveErr = conversationStore.AppendConversationTurnWithDetailsAndUserEvent(ctx, conversationID, originalPrompt, withUIContext(withVisualReportContext(answer, reports), uis), event.Text, event.Error, images, specialists, userSeq)
				if saveErr != nil {
					event.Error = fmt.Sprintf("保存会话失败: %v", saveErr)
				} else if turnErr != nil {
					_, saveErr = recordEvent("run_failed", "agent", "", map[string]any{"reason": turnErr.Error()})
				} else {
					_, saveErr = recordEvent("answer_finished", "agent", "", map[string]any{"status": "completed"})
				}
				if saveErr == nil {
					enabled, memoryErr := conversationStore.MemoryEnabled(ctx, lakeID)
					if memoryErr == nil && enabled {
						for _, fact := range agent.ExtractMemoryFacts(originalPrompt, projectID) {
							_, memoryErr = conversationStore.AddMemoryFact(ctx, store.MemoryFactInput{LakeID: lakeID, ProjectID: fact.ProjectID, SourceConversationID: conversationID, SourceEventSeq: saved.UserEventSeq, Text: fact.Text})
							if memoryErr != nil {
								break
							}
						}
					}
					if memoryErr != nil {
						writer.send(bridgeEvent{Type: "error", ID: id, Error: fmt.Sprintf("保存记忆失败: %v", memoryErr)})
					}
				}
			}
			if saveErr != nil {
				event.Error = fmt.Sprintf("保存会话失败: %v", saveErr)
			}
			writer.send(event)
			return saved, saveErr
		},
		Approve: func(kind, path, command string) (bool, error) {
			stateMu.Lock()
			id := pendingID
			approvalCount++
			callID := fmt.Sprintf("%s-approval-%d", id, approvalCount)
			stateMu.Unlock()
			digest := sha256.Sum256([]byte(command))
			if _, err := recordEvent("tool_proposed", "agent", callID, map[string]any{"tool_name": kind, "target": path, "arguments_sha256": hex.EncodeToString(digest[:])}); err != nil {
				return false, err
			}
			approved, err := approvals.request(ctx, id, kind, path, command, writer.send)
			outcome := "denied"
			if approved {
				outcome = "approved"
			}
			if err != nil {
				outcome = "interrupted"
			}
			_, recordErr := recordEvent("tool_decision", "user", callID, map[string]any{"outcome": outcome})
			if err != nil {
				return false, err
			}
			return approved, recordErr
		},
	}
	go func() {
		finished <- runChatWithHooks(ctx, nil, root, chatInput, &capture, io.Discard, hooks)
	}()
	select {
	case <-ready:
	case err := <-finished:
		writer.send(bridgeEvent{Type: "fatal", Error: err.Error()})
		return err
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 16*1024*1024)
	for scanner.Scan() {
		var request bridgeRequest
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			writer.send(bridgeEvent{Type: "error", Error: "无效的 JSON 请求"})
			continue
		}
		if request.Version != 0 && request.Version != 1 {
			writer.send(bridgeEvent{Type: "error", ID: request.ID, Error: "不支持的协议版本；当前支持版本 1"})
			continue
		}
		switch request.Type {
		case "hello":
			if request.Version != 1 {
				writer.send(bridgeEvent{Type: "error", ID: request.ID, Error: "hello 请求需要协议版本 1"})
				continue
			}
			taskCommands.Store(request.TaskCommands && conversationID != "")
			writer.send(bridgeEvent{Type: "hello", ID: request.ID})
		case "ask", "ui_action", "workflow_run", "workflow_v2_run", "specialist_resume":
			if request.Type != "ui_action" {
				request.UIAction = nil
			}
			if request.Type == "ui_action" {
				if request.UIAction == nil {
					writer.send(bridgeEvent{Type: "error", ID: request.ID, Error: "界面操作不能为空"})
					continue
				}
				snapshot, err := uiSession.CheckAction(*request.UIAction)
				if err != nil {
					writer.send(bridgeEvent{Type: "error", ID: request.ID, Error: err.Error()})
					continue
				}
				request.Prompt = "动态界面：" + uiActionLabel(snapshot, request.UIAction.SourceComponentID)
				request.Images = nil
				request.ExecutionRefs = nil
			}
			if request.ID == "" || (request.Type == "ask" && strings.TrimSpace(request.Prompt) == "" && len(request.Images) == 0) {
				writer.send(bridgeEvent{Type: "error", ID: request.ID, Error: "提问需要 id 和 prompt"})
				continue
			}
			if request.Type == "workflow_run" && (request.Workflow == nil || strings.TrimSpace(request.Workflow.Name) == "") {
				writer.send(bridgeEvent{Type: "error", ID: request.ID, Error: "工作流运行需要名称和目标参数"})
				continue
			}
			if request.Type == "workflow_v2_run" && (request.WorkflowV2 == nil || (request.WorkflowV2.DefinitionID == "" && request.WorkflowV2.RunID == "")) {
				writer.send(bridgeEvent{Type: "error", ID: request.ID, Error: "v2 运行需要定义或运行 ID"})
				continue
			}
			if request.Type == "specialist_resume" && (request.SpecialistResume == nil || request.SpecialistResume.TaskID == "") {
				writer.send(bridgeEvent{Type: "error", ID: request.ID, Error: "恢复需要专员任务 ID"})
				continue
			}
			if request.Prompt == "" && (request.Type == "workflow_v2_run" || request.Type == "specialist_resume") {
				request.Prompt = "恢复或运行任务"
			}
			if err := store.ValidateImages(request.Images); err != nil {
				writer.send(bridgeEvent{Type: "error", ID: request.ID, Error: err.Error()})
				continue
			}
			if request.Type == "ask" && strings.TrimSpace(request.Prompt) == "" {
				request.Prompt = "请分析这些图片"
			}
			if request.Type == "workflow_run" && strings.TrimSpace(request.Prompt) == "" {
				request.Prompt = "运行工作流「" + request.Workflow.Name + "」"
			}
			if len(request.ExecutionRefs) > 0 {
				var err error
				request.Prompt, err = store.AddExecutionReferences(request.Prompt, request.ExecutionRefs)
				if err == nil && conversationStore != nil {
					_, err = conversationStore.WithExecutionContext(ctx, conversationID, request.Prompt)
				}
				if err != nil || conversationStore == nil {
					writer.send(bridgeEvent{Type: "error", ID: request.ID, Error: "执行引用无效或不属于当前会话"})
					continue
				}
			}
			stateMu.Lock()
			busy := pendingID != ""
			if !busy {
				pendingID = request.ID
				pendingReviewOnly = request.Type == "ask" && request.ReviewOnly
				pendingUIAction = request.UIAction
				pendingPrompt = request.Prompt
				pendingImages = request.Images
				activeImages = request.Images
			}
			stateMu.Unlock()
			if busy {
				writer.send(bridgeEvent{Type: "error", ID: request.ID, Error: "上一轮对话仍在进行"})
				continue
			}
			preview := []rune(request.Prompt)
			truncated := len(preview) > 2048
			if truncated {
				preview = preview[:2048]
			}
			userEvent, err := recordEvent("user", "user", "", map[string]any{"preview": string(preview), "truncated": truncated})
			if err == nil {
				_, err = recordEvent("run_started", "agent", "", map[string]any{"model": activeModel})
			}
			if err == nil && request.UIAction != nil {
				body, _ := json.Marshal(request.UIAction.Context)
				digest := sha256.Sum256(body)
				_, err = recordEvent("ui_action", "user", "", map[string]any{"surface_id": request.UIAction.SurfaceID, "component_id": request.UIAction.SourceComponentID, "name": request.UIAction.Name, "context_sha256": hex.EncodeToString(digest[:])})
			}
			if err != nil {
				stateMu.Lock()
				pendingID, pendingPrompt, pendingImages, activeImages = "", "", nil, nil
				pendingReviewOnly = false
				pendingUIAction = nil
				stateMu.Unlock()
				writer.send(bridgeEvent{Type: "error", ID: request.ID, Error: fmt.Sprintf("保存运行事件失败: %v", err)})
				continue
			}
			stateMu.Lock()
			pendingUserSeq = userEvent.Sequence
			stateMu.Unlock()
			prompt := strings.ReplaceAll(strings.ReplaceAll(request.Prompt, "\r", " "), "\n", " ")
			if request.Type == "workflow_run" {
				payload, err := json.Marshal(request.Workflow)
				if err != nil {
					return err
				}
				prompt = "/workflow-run " + string(payload)
			}
			if request.Type == "workflow_v2_run" {
				payload, _ := json.Marshal(request.WorkflowV2)
				prompt = "/workflow-v2-run " + string(payload)
			}
			if request.Type == "specialist_resume" {
				payload, _ := json.Marshal(request.SpecialistResume)
				prompt = "/specialist-resume " + string(payload)
			}
			if _, err := fmt.Fprintln(chatWriter, prompt); err != nil {
				return err
			}
		case "command_result":
			if request.CommandReply == nil || !commands.respond(request.ID, *request.CommandReply) {
				writer.send(bridgeEvent{Type: "error", ID: request.ID, Error: "没有对应的待执行命令"})
			}
		case "approve":
			if !approvals.respond(request.ID, request.Approved) {
				writer.send(bridgeEvent{Type: "error", ID: request.ID, Error: "没有待批准的操作"})
			}
		case "question_answer":
			err := questions.respond(request.ID, request.QuestionID, agent.UserQuestionAnswer{Answers: request.Answers}, func(question agent.UserQuestionRequest, answer agent.UserQuestionAnswer) error {
				body, _ := json.Marshal(answer.Answers)
				if _, err := recordEvent("question_answered", "user", question.ID, map[string]any{"question_id": question.ID, "answers_json": string(body)}); err != nil {
					return err
				}
				writer.send(bridgeEvent{Type: "question_answered", ID: request.ID, QuestionID: question.ID, Answers: answer.Answers})
				return nil
			})
			if err != nil {
				writer.send(bridgeEvent{Type: "question_error", ID: request.ID, QuestionID: request.QuestionID, Error: err.Error()})
			}
		case "close":
			commands.close()
			questions.close()
			approvals.close()
			_ = chatWriter.Close()
			return <-finished
		default:
			writer.send(bridgeEvent{Type: "error", ID: request.ID, Error: "未知请求类型"})
		}
	}
	if err := scanner.Err(); err != nil {
		_ = chatWriter.CloseWithError(err)
		return err
	}
	commands.close()
	approvals.close()
	questions.close()
	_ = chatWriter.Close()
	err := <-finished
	if err != nil && !errors.Is(err, io.EOF) {
		writer.send(bridgeEvent{Type: "fatal", Error: err.Error()})
		return err
	}
	return nil
}
