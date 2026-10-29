package ai

import (
	"context"
	"encoding/json"
	"errors"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/workflowagent"
	"google.golang.org/adk/v2/runner"
	adksession "google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/workflow"
	"google.golang.org/genai"
	"os"
	"path/filepath"
)

func (e *Engine) flushWorkOutbox(ctx context.Context) error {
	owner := e.workOwner()
	owner.workOutboxMu.Lock()
	defer owner.workOutboxMu.Unlock()
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	var rows []nativeWorkOutbox
	if err = store.DB.Where("delivered = ?", false).Order("revision ASC").Limit(100).Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		sessionID := "work_" + row.GoalID
		got, err := store.Sessions.Get(ctx, &adksession.GetRequest{AppName: "lake_work", UserID: "lake", SessionID: sessionID})
		if errors.Is(err, adksession.ErrNotFound) {
			created, createErr := store.Sessions.Create(ctx, &adksession.CreateRequest{AppName: "lake_work", UserID: "lake", SessionID: sessionID})
			if createErr != nil {
				return createErr
			}
			got = &adksession.GetResponse{Session: created.Session}
			err = nil
		}
		if err != nil {
			return err
		}
		// A stable event ID plus state watermark make crash replay idempotent.
		seen, _ := got.Session.State().Get("work_revision")
		if num(seen, 0) < int(row.Revision) {
			event := adksession.NewEvent(ctx, "work-transition")
			event.ID = row.ID
			event.Author = "lake_work"
			event.Actions.StateDelta = map[string]any{"work_revision": row.Revision, "work_goal": objJSON(row.Data)}
			if err = store.Sessions.AppendEvent(ctx, got.Session, event); err != nil {
				return err
			}
		}
		var goal WorkGoal
		if err = json.Unmarshal([]byte(row.Data), &goal); err != nil {
			return err
		}
		if err = e.publishWorkReport(ctx, goal); err != nil {
			continue
		}
		if err = store.DB.Model(&nativeWorkOutbox{}).Where("id = ?", row.ID).Update("delivered", true).Error; err != nil {
			return err
		}
		if e.Emit != nil {
			e.Emit(Event{Session: row.SessionID, Type: "workUpdate", Data: map[string]any{"goalId": row.GoalID}})
		}
	}
	return nil
}

func (e *Engine) resumeWorkGoal(ctx context.Context, row nativeWorkGoal, g WorkGoal, c Config) (err error) {
	// Credentials and permissions are live; the requested resource binding is
	// frozen. Switching foreground terminals must never retarget old work.
	if g.Binding.ResourceIdentity != "" {
		resource, lookupErr := asset(c, g.Binding.AssetRef)
		if lookupErr != nil || hash(js(resource)) != g.Binding.ResourceIdentity {
			g.Status = "blocked"
			g.Summary = "原资源绑定已变化，接续已暂停；未切换到其他资源"
			return e.writeWorkGoal(&row, &g, false)
		}
	}
	c.Runtime, c.AssetRef, c.Container, c.TerminalID = g.Binding.Runtime, g.Binding.AssetRef, g.Binding.Container, g.Binding.TerminalID
	owner, err := e.get(g.SessionID)
	if err != nil {
		return err
	}
	owner.mu.Lock()
	if owner.cancel != nil || owner.finalizing {
		owner.mu.Unlock()
		return nil
	}
	work, cancel := context.WithCancel(ctx)
	owner.cancel = cancel
	e.workActive.Store(g.ID, cancel)
	owner.mu.Unlock()
	defer func() { e.workActive.Delete(g.ID); cancel(); owner.mu.Lock(); owner.cancel = nil; owner.mu.Unlock() }()
	row.WaitState = "resuming"
	if err = e.writeWorkGoal(&row, &g, false); err != nil {
		return err
	}
	var checkpoint nativeProjection
	if err = json.Unmarshal([]byte(row.Checkpoint), &checkpoint); err != nil {
		return err
	}
	dir := filepath.Join(e.Dir, "work-goals", g.ID)
	child, err := newEngine(dir, e.Bridge, nil, e)
	if err != nil {
		return err
	}
	defer func() {
		child.Shutdown()
		// All canonical events and operation evidence live in the owner store.
		// Only discard this private cache after successful terminal persistence;
		// interrupted or failed persistence retains its recovery material.
		if err == nil && identifier.MatchString(g.ID) {
			if _, final, loadErr := e.workRow(g.SessionID, g.ID); loadErr == nil && workTerminal(final.Status) {
				_ = os.RemoveAll(dir)
			}
		}
	}()
	child.ModelActivity = e.ModelActivity
	child.NaturalMemory = e.NaturalMemory
	child.Emit = func(event Event) {
		if e.Emit != nil && event.Type != "delta" {
			e.Emit(Event{Session: g.SessionID, Type: "workUpdate", Data: map[string]any{"goalId": g.ID}})
		}
	}
	child.modelSlots = e.modelSlots
	cs := &session{state: State{SupplementIDs: checkpoint.SupplementIDs, Config: c, History: checkpoint.History, Runtime: checkpoint.Runtime, View: checkpoint.View, RootQuestion: checkpoint.RootQuestion, TargetScope: checkpoint.Scope, ReferencedAssetIDs: checkpoint.References, WorkGoalID: g.ID, QuestionDecisions: g.UserDecisions}}
	cs.state.Config.targetScope = cloneTargetScope(checkpoint.Scope)
	cs.state.Config.ReferencedAssets = validRemembered(c, checkpoint.References)
	cs.state.View.Status = "running"
	cs.state.View.TurnFinishedAt = ""
	cs.state.Config.MaxSteps = g.RoundLimit
	child.sessions[g.SessionID] = cs
	// Replace the intermediate response in the provider projection; ADK merges
	// the original long-running FunctionResponse by its original ID.
	observations, observationErr := e.workObservationPayload(g)
	if observationErr != nil {
		return observationErr
	}
	result := map[string]any{"observations": observations, "goal": g, "source": "host_external_observation", "notice": "Read-only result, not permission to replay a change or approve a new one."}
	for i := range cs.state.History {
		m := &cs.state.History[i]
		if m.Role == "tool" && m.CallID == row.WaitCallID {
			m.Content = js(result)
		}
	}
	cs.nativeResumeContent = &genai.Content{Role: "user", Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{ID: row.WaitCallID, Name: "work_wait", Response: result}}}}
	if err = child.runWorkInput(work, g.ID, row.WaitCallID, result); err != nil {
		return err
	}
	cs.cancel = cancel
	err = child.runOfficialADK(work, cs, &cs.state.Config, false, cancel)
	if work.Err() != nil {
		return work.Err()
	}
	if err != nil {
		current, goal, loadErr := e.workRow(g.SessionID, g.ID)
		if loadErr == nil && !workTerminal(goal.Status) {
			goal.Status = "blocked"
			goal.Summary = "接续未完成，原操作未重放"
			_ = e.writeWorkGoal(&current, &goal, false)
		}
	}
	if saveErr := child.workCheckpoint(cs); err == nil {
		err = saveErr
	}
	if persistErr := child.persistNativeProjection(context.WithoutCancel(work), cs); err == nil {
		err = persistErr
	}
	cs.cancel = nil
	return err
}

// work_wait uses a separate official machine-input checkpoint. It never passes
// an external event through a human confirmation endpoint.
func (e *Engine) runWorkInput(ctx context.Context, goalID, callID string, result map[string]any) error {
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	rerun := true
	node := workflow.NewDynamicNode("external_event", func(ac agent.Context, _ any, emit func(*adksession.Event) error) (any, error) {
		return workflow.ResumeOrRequestInput(ac, emit, adksession.RequestInput{InterruptID: callID, Message: "等待外部任务结果", Payload: map[string]any{"source": "machine", "goalId": goalID}})
	}, workflow.NodeConfig{RerunOnResume: &rerun})
	return runMachineInput(ctx, store.Sessions, node, goalID, callID, result)
}

func runMachineInput(ctx context.Context, service adksession.Service, node workflow.Node, goalID, callID string, result map[string]any) error {
	root, err := workflowagent.New(workflowagent.Config{Name: "lake_work_input", Edges: workflow.Chain(workflow.Start, node)})
	if err != nil {
		return err
	}
	r, err := runner.New(runner.Config{AppName: "lake_work_input", Agent: root, SessionService: service, AutoCreateSession: true})
	if err != nil {
		return err
	}
	content := genai.NewContentFromText("Wait for the original external task", "user")
	if result != nil {
		content = &genai.Content{Role: "user", Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{ID: callID, Name: workflow.WorkflowInputFunctionCallName, Response: result}}}}
	}
	// Each wait in a multi-stage goal needs its own Workflow checkpoint. A
	// previously completed node must not stand in for a later external wait.
	checkpointID := goalID + "_" + hash(callID)[:16]
	for _, err := range r.Run(ctx, "lake", checkpointID, content, agent.RunConfig{}) {
		if err != nil && !errors.Is(err, workflow.ErrNodeInterrupted) {
			return err
		}
	}
	return nil
}
