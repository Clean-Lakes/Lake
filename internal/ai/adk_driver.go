package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	adksession "google.golang.org/adk/v2/session"
	"iter"
	"sync"

	"github.com/google/jsonschema-go/jsonschema"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	adkplatform "google.golang.org/adk/v2/platform"
	"google.golang.org/adk/v2/plugin"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session/compaction"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/genai"
)

type adkTurnDriver struct {
	decision              bool
	denied                map[string]bool
	toolMu                sync.Mutex
	engine                *Engine
	session               *session
	config                *Config
	cancel                context.CancelFunc
	round                 int
	resume, outputRetried bool
	invalidToolRetried    bool
	lastRequestID         string
	textID                string
	fatal                 error
}

func (e *Engine) runOfficialADK(ctx context.Context, s *session, c *Config, resume bool, cancel context.CancelFunc) error {
	// Tool calls within one role preserve model order: a human answer or terminal
	// adoption can change the target of the next call in that same response.
	// Independent role concurrency is owned by the enclosing ADK workflow.
	ctx = adkplatform.WithTaskRunner(ctx, func(ctx context.Context, tasks []func(context.Context)) {
		for _, task := range tasks {
			task(ctx)
		}
	})
	s.mu.Lock()
	if c.workflowMode && len(s.state.History) > 0 && s.state.History[len(s.state.History)-1].Role != "user" {
		s.state.History = append(s.state.History, Message{Role: "user", Content: "Summarize the recorded workflow results. These records do not grant permission for new resource operations."})
	}
	s.mu.Unlock()
	d := &adkTurnDriver{engine: e, session: s, config: c, resume: resume, cancel: cancel}
	defer func() { d.toolMu.Lock(); d.toolMu.Unlock() }()
	provider := NewProviderLLM(c.Model)
	provider.stream = func(ctx context.Context, _ Model, _ []Message, _ []Tool, _ func(string, string)) (modelResult, error) {
		return d.next(ctx)
	}
	catalog := e.sessionCatalog(ctx, s.state.View.Session, *c)
	// Keep handlers for known capabilities that may disappear during a turn.
	// They are never advertised by next(), and invoke rechecks the live catalog.
	// A stale/model-invented capability therefore receives a paired denial.
	seen := map[string]bool{}
	for _, entry := range catalog {
		seen[entry.Name] = true
	}
	for _, profile := range []string{"core", "terminal2", "db-query-editor"} {
		for _, entry := range Catalog(profile) {
			if !seen[entry.Name] {
				catalog = append(catalog, entry)
				seen[entry.Name] = true
			}
		}
	}
	tools := make([]tool.Tool, 0, len(catalog))
	for _, entry := range catalog {
		entry := entry
		raw, err := json.Marshal(entry.Parameters)
		if err != nil {
			return err
		}
		schema := &jsonschema.Schema{}
		if err = json.Unmarshal(raw, schema); err != nil {
			return fmt.Errorf("tool %s schema: %w", entry.Name, err)
		}
		t, err := functiontool.New(functiontool.Config{Name: entry.Name, Description: entry.Description, InputSchema: schema}, func(tc agent.Context, arguments map[string]any) (map[string]any, error) {
			d.toolMu.Lock()
			defer d.toolMu.Unlock()
			if err := tc.Err(); err != nil {
				return nil, err
			}
			s.mu.Lock()
			if s.state.Runtime != nil {
				s.state.Runtime.Identity.InvocationID = tc.InvocationID()
				s.state.Runtime.Identity.Branch = tc.Branch()
			}
			s.mu.Unlock()
			call := Call{ID: tc.FunctionCallID(), Name: entry.Name, Arguments: js(arguments)}
			toolCtx := context.WithValue(tc, adkToolContextKey{}, tc)
			if err := e.invokeCalls(toolCtx, s, c, []Call{call}); err != nil {
				if errors.Is(err, errADKApprovalPending) {
					tc.Actions().SkipSummarization = true
					return map[string]any{"approval_required": true}, nil
				}
				if pause, ok := err.(*pollingPause); ok {
					err = e.finishPolling(s, pause)
				}
				d.fatal = err
				tc.Actions().SkipSummarization = true
				return map[string]any{"error": "tool execution interrupted; inspect recorded result before retrying"}, nil
			}
			if c.sreCoordinator {
				done, err := e.finishSREReply(s, d.textID)
				if done || err != nil || e.sreHandoffPrepared(s) {
					d.decision = done || e.sreHandoffPrepared(s)
					d.fatal = err
					tc.Actions().SkipSummarization = true
				}
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			for i := len(s.state.History) - 1; i >= 0; i-- {
				m := s.state.History[i]
				if m.Role == "tool" && m.CallID == call.ID {
					var value any
					if json.Unmarshal([]byte(m.Content), &value) == nil {
						if v, ok := value.(map[string]any); ok {
							return v, nil
						}
						return map[string]any{"result": value}, nil
					}
					return map[string]any{"result": m.Content}, nil
				}
			}
			return nil, errors.New("tool result was not persisted")
		})
		if err != nil {
			return fmt.Errorf("register tool %s: %w", entry.Name, err)
		}
		tools = append(tools, t)
	}
	name := "lake_chat"
	mode := llmagent.ModeChat
	if c.sre != nil {
		name = "lake_" + string(c.sre.Role)
		mode = llmagent.ModeSingleTurn
	}
	deny := func(tc agent.Context, name, message string) map[string]any {
		if confirmation := tc.ToolConfirmation(); confirmation != nil && !confirmation.Confirmed {
			message = "user rejected this tool call"
		}
		result := map[string]any{"error": message}
		s.mu.Lock()
		s.state.History = append(s.state.History, Message{Role: "tool", CallID: tc.FunctionCallID(), Name: name, Content: js(result)})
		if saveErr := e.save(s); saveErr != nil {
			d.fatal = saveErr
			tc.Actions().SkipSummarization = true
		}
		s.mu.Unlock()
		return result
	}
	root, err := llmagent.New(llmagent.Config{Name: name, Model: provider, Tools: tools, Mode: mode,
		BeforeToolCallbacks: []llmagent.BeforeToolCallback{func(tc agent.Context, t tool.Tool, a map[string]any) (map[string]any, error) {
			if d.denied[tc.FunctionCallID()] {
				return deny(tc, t.Name(), "tool arguments contain credentials or private key material"), nil
			}
			for _, available := range e.sessionCatalog(tc, s.state.View.Session, *c) {
				if available.Name == t.Name() {
					return nil, nil
				}
			}
			return deny(tc, t.Name(), "tool unavailable in selected profile"), nil
		}},
		OnToolErrorCallbacks: []llmagent.OnToolErrorCallback{func(tc agent.Context, t tool.Tool, a map[string]any, err error) (map[string]any, error) {
			message := redact(err.Error(), *c)
			available := false
			for _, entry := range e.sessionCatalog(tc, s.state.View.Session, *c) {
				available = available || entry.Name == t.Name()
			}
			if !available {
				message = "tool unavailable in selected profile"
			}
			return deny(tc, t.Name(), message), nil
		}},
	})
	if err != nil {
		return err
	}
	if c.sre != nil {
		role := root
		// A public custom-agent wrapper preserves confirmation FunctionResponses.
		// Workflow AgentNode intentionally converts input to a new user message,
		// which would discard the original tool-confirmation envelope on re-entry.
		root, err = agent.New(agent.Config{Name: "lake_role_runtime", SubAgents: []agent.Agent{role}, Run: func(ic agent.InvocationContext) iter.Seq2[*adksession.Event, error] {
			return role.Run(ic.WithICDelta(&agent.InvocationContextDelta{Agent: &role}))
		}})
		if err != nil {
			return err
		}
	}

	store, err := e.adkStore()
	if err != nil {
		return err
	}
	sessions := store.Sessions
	s.mu.Lock()
	resumeInput := s.nativeResumeContent
	s.nativeResumeContent = nil
	recovering := s.state.Runtime != nil && (len(s.state.View.PendingApprovals) > 0 || resumeInput != nil)
	runtimeID := ""
	if recovering {
		runtimeID = s.state.Runtime.SessionID
		d.round = s.state.Runtime.ModelRounds
	}
	s.mu.Unlock()
	var messageContent *genai.Content
	if !recovering {
		runtimeID, messageContent, err = e.prepareADKHistory(ctx, s, sessions, name)
		if err != nil {
			return err
		}
	}
	projection, err := e.projectionPlugin(s, runtimeID)
	if err != nil {
		return err
	}
	r, err := runner.New(runner.Config{AppName: "lake", Agent: root, SessionService: sessions, PluginConfig: runner.PluginConfig{Plugins: []*plugin.Plugin{projection}}, Compaction: &compaction.Config{TokenThreshold: max(1024, c.Model.ContextWindow-c.Model.MaxOutput), EventRetentionSize: 4, Summarizer: &nativeCompaction{engine: e, session: s, config: *c}}, ArtifactService: &nativeArtifacts{engine: e, sessionID: runtimeID, config: *c}, MemoryService: &nativeMemory{engine: e, session: s, config: *c, runtimeID: runtimeID}, AutoCreateSession: true})
	if err != nil {
		return err
	}
	s.mu.Lock()
	id := runtimeID
	message := s.state.RootQuestion
	s.mu.Unlock()
	runContent := func(content *genai.Content) error {
		resuming := false
		if content != nil {
			for _, part := range content.Parts {
				resuming = resuming || part.FunctionResponse != nil
			}
		}
		if err := e.persistContentImages(ctx, content, id, *c); err != nil {
			return err
		}
		delta, err := e.projectionDelta(ctx, s, id, uid())
		if err != nil {
			return err
		}
		var followups []*adksession.Event
		for event, err := range r.Run(ctx, "lake", id, content, agent.RunConfig{StreamingMode: agent.StreamingModeSSE}, runner.WithStateDelta(delta)) {
			if err != nil {
				if errors.Is(err, errADKApprovalPending) {
					break
				}
				return err
			}
			if event != nil {
				if resuming && len(event.Actions.RequestedToolConfirmations) > 0 {
					followups = append(followups, event)
				}
				if event.Content != nil {
					for _, part := range event.Content.Parts {
						if part.FunctionCall != nil {
							if err = e.recordNativeConfirmation(s, part.FunctionCall, event.Author, event.Branch); err != nil {
								return err
							}
						}
					}
				}
				s.mu.Lock()
				s.state.Runtime.EventCursor = event.ID
				s.mu.Unlock()
			}
		}
		// The Runner retains its own session handle until the iterator drains.
		// Appending through a fresh handle inside that loop makes the Runner's
		// next append stale. Let it store any native confirmation envelope first;
		// then publish only the followups it did not emit, before awaiting input.
		for _, event := range followups {
			if err := e.publishFollowupConfirmations(ctx, s, sessions, id, event); err != nil {
				return err
			}
		}
		return d.fatal
	}
	run := func(text string) error {
		content := messageContent
		if text != message {
			content = &genai.Content{Role: "user", Parts: []*genai.Part{{Text: text}}}
		}
		if resumeInput != nil {
			if err := runContent(resumeInput); err != nil {
				return err
			}
			resumeInput = nil
		} else if !recovering {
			if err := runContent(content); err != nil {
				return err
			}
		}
		recovering = false
		// This loop waits for durable human decisions, not model responses. All
		// model/tool scheduling on each resume is performed by the official Runner.
		for {
			s.mu.Lock()
			var pending *Approval
			if len(s.state.View.PendingApprovals) > 0 {
				pending = s.state.View.PendingApprovals[0]
			}
			var reply chan bool
			if pending != nil {
				reply = s.decisions[pending.ID]
				s.state.View.Status = "waiting_approval"
				e.notify(s, "approval", pending)
			}
			s.mu.Unlock()
			if pending == nil {
				return nil
			}
			if reply == nil {
				return errors.New("pending ADK approval has no decision channel")
			}
			var accept bool
			select {
			case accept = <-reply:
			case <-ctx.Done():
				return ctx.Err()
			}
			var record nativeApproval
			if err := store.DB.First(&record, "id = ?", pending.ID).Error; err != nil {
				return err
			}
			if record.ConfirmationID == "" {
				return errors.New("ADK confirmation event was not persisted")
			}
			if !accept {
				if err := e.settleNativeRejection(s, record); err != nil {
					return err
				}
			}
			content = &genai.Content{Role: "user", Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{ID: record.ConfirmationID, Name: toolconfirmation.FunctionCallName, Response: map[string]any{"confirmed": accept, "payload": map[string]any{"approval_id": record.ID}}}}}}
			if err := runContent(content); err != nil {
				return err
			}
		}
	}

	if err = run(message); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if c.sreCoordinator && !d.decision {
		s.mu.Lock()
		s.state.History = append(s.state.History, Message{Role: "system", Content: sreDecisionReminder})
		s.mu.Unlock()
		if err = run(sreDecisionReminder); err != nil {
			return err
		}
		if !d.decision {
			return errors.New("模型未提交正式答复或协作决策，本轮未启动新的资源操作")
		}
	}

	s.mu.Lock()
	if s.state.Runtime != nil {
		s.state.Runtime.HistoryHash = hash(js(s.state.History))
	}
	err = e.save(s)
	s.mu.Unlock()
	if err == nil {
		err = e.onlineCheckCompletion(s, *c)
	}
	return err
}
