package ai

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/workflowagent"
	"google.golang.org/adk/v2/runner"
	adksession "google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/workflow"
	"google.golang.org/genai"
)

// Each human question has an independent official workflow input checkpoint.
// The enclosing LlmAgent tool waits in process; after a crash its original
// function response is reconstructed without executing any resource tool.
func (e *Engine) runNativeQuestion(ctx context.Context, req *QuestionRequest, answers map[string][]string, configs ...Config) error {
	var c Config
	if len(configs) > 0 {
		c = configs[0]
	}
	raw, _ := json.Marshal(req.Questions)
	var safeQuestions []UserQuestion
	_ = json.Unmarshal(safeJSON(raw, c), &safeQuestions)
	if answers != nil {
		raw, _ = json.Marshal(answers)
		_ = json.Unmarshal(safeJSON(raw, c), &answers)
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	rerun := true
	node := workflow.NewDynamicNode("human_answer", func(ac agent.Context, _ any, emit func(*adksession.Event) error) (any, error) {
		return workflow.ResumeOrRequestInput(ac, emit, adksession.RequestInput{InterruptID: req.ID, Message: "请回答会话问题", Payload: safeQuestions})
	}, workflow.NodeConfig{RerunOnResume: &rerun})
	root, err := workflowagent.New(workflowagent.Config{Name: "lake_human_input", Edges: workflow.Chain(workflow.Start, node)})
	if err != nil {
		return err
	}
	r, err := runner.New(runner.Config{AppName: "lake_input", Agent: root, SessionService: store.Sessions, AutoCreateSession: true})
	if err != nil {
		return err
	}
	content := &genai.Content{Role: "user", Parts: []*genai.Part{{Text: "Wait for the human answer"}}}
	if answers != nil {
		content = &genai.Content{Role: "user", Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{ID: req.ID, Name: workflow.WorkflowInputFunctionCallName, Response: map[string]any{"answers": answers}}}}}
	}
	for _, err := range r.Run(ctx, "lake", req.RuntimeSessionID, content, agent.RunConfig{}) {
		if err != nil && !errors.Is(err, workflow.ErrNodeInterrupted) {
			return err
		}
	}
	return nil
}

func (e *Engine) recoverQuestionReply(s *session, req *QuestionRequest, answers map[string][]string) error {
	if req.Call == nil || req.RuntimeSessionID == "" || s.state.Runtime == nil {
		return errors.New("question expired")
	}
	if s.state.Config.Model.Name == "" {
		return errors.New("model not configured for recovery")
	}
	if err := e.runNativeQuestion(context.Background(), req, answers, s.state.Config); err != nil {
		return err
	}
	if err := prepareQuestionResponse(s, req, answers); err != nil {
		return err
	}
	work, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	c := s.state.Config
	c.targetScope = cloneTargetScope(s.state.TargetScope)
	c.ReferencedAssets = validRemembered(c, s.state.ReferencedAssetIDs)
	if err := e.saveHumanInputState(s); err != nil {
		cancel()
		s.cancel = nil
		return err
	}
	e.runMu.Lock()
	if e.runtimeClosed {
		e.runMu.Unlock()
		cancel()
		s.cancel = nil
		return errors.New("runtime closed")
	}
	e.runs.Add(1)
	e.runMu.Unlock()
	go func() { defer e.runs.Done(); _ = e.resumeNativeApproval(work, s, c, cancel) }()
	return nil
}

// The durable marker distinguishes SDK-backed waits from legacy history.
func nativeQuestionReady(req *QuestionRequest) bool {
	return req != nil && req.Call != nil && req.RuntimeSessionID != ""
}

func prepareQuestionResponse(s *session, req *QuestionRequest, answers map[string][]string) error {
	key := hash(s.state.View.RootTurnID + js(req.Questions))
	if s.state.QuestionDecisions == nil {
		s.state.QuestionDecisions = map[string]map[string][]string{}
	}
	s.state.QuestionDecisions[key] = answers
	// Pair all calls from the interrupted batch. Only the question has a result;
	// other calls are explicitly not executed and must be chosen afresh.
	paired := map[string]bool{}
	for _, message := range s.state.History {
		if message.Role == "tool" {
			paired[message.CallID] = true
		}
	}
	content := &genai.Content{Role: "user"}
	var replies []Message
	for _, message := range s.state.History {
		for _, call := range message.Calls {
			if paired[call.ID] {
				continue
			}
			value := map[string]any{"error": "not_executed: process restarted before this call completed; inspect recorded operations before choosing a new action"}
			if call.ID == req.Call.ID {
				value = questionResult(req.Questions, answers, false)
			}
			replies = append(replies, Message{Role: "tool", CallID: call.ID, Name: call.Name, Content: js(value)})
			content.Parts = append(content.Parts, &genai.Part{FunctionResponse: &genai.FunctionResponse{ID: call.ID, Name: call.Name, Response: value}})
		}
	}
	if len(content.Parts) == 0 {
		return errors.New("question call already settled")
	}
	s.state.History = append(s.state.History, replies...)
	s.nativeResumeContent = content
	s.state.View.Question = nil
	s.questionReply = nil
	return nil
}

func (e *Engine) AgentQuestionReply(parentID, runID, requestID string, answers map[string][]string) error {
	if w, err := e.ownedWorker(parentID, runID); err == nil {
		return w.child.ReplyQuestion(runID, requestID, answers)
	}
	e.agentMu.Lock()
	if w := e.agentWorkers[runID]; w != nil && w.parentID == parentID {
		e.agentMu.Unlock()
		return w.child.ReplyQuestion(runID, requestID, answers)
	}
	defer e.agentMu.Unlock()
	parent, err := e.get(parentID)
	if err != nil {
		return err
	}
	parent.mu.Lock()
	var run AgentRun
	for _, r := range parent.state.View.AgentRuns {
		if r.ID == runID && r.SessionID == parentID {
			run = r
		}
	}
	c := parent.state.Config
	parent.mu.Unlock()
	if run.SRETaskID == "" || run.Question == nil || run.Question.ID != requestID || !e.hasRecoverableRole(parentID, runID) {
		return errors.New("question outside current role")
	}
	child, err := New(filepath.Join(e.Dir, "children", parentID), nil, nil)
	if err != nil {
		return err
	}
	child.worker = &agentWorker{parent: e, parentID: parentID, runID: runID}
	defer child.Shutdown()
	s, err := child.get(runID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	req := s.state.View.Question
	if !nativeQuestionReady(req) || req.ID != requestID || req.Answers != nil {
		return errors.New("question expired")
	}
	if err = validateQuestionAnswers(req, answers); err != nil {
		return err
	}
	req.Answers = answers
	s.state.Config = c
	if err = child.save(s); err != nil {
		return err
	}
	return e.queueRoleRecovery(parentID, run.SRETaskID, runID)
}

// SRE's existing plan-review and manual-attestation UI routes resolve these
// official workflow waits; their business revision/ownership checks stay in place.
func (e *Engine) recordSREInput(ctx context.Context, sessionID string, task SRETask, kind, key string, answers map[string][]string) error {
	s, err := e.get(sessionID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	id := "sre_input_" + hash(sessionID+task.ID+kind+key)
	req := &QuestionRequest{ID: id, RuntimeSessionID: id, Questions: []UserQuestion{{ID: kind, Title: "SRE 人工审阅", Reason: task.Goal}}}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	_, lookup := store.Sessions.Get(ctx, &adksession.GetRequest{AppName: "lake_input", UserID: "lake", SessionID: id})
	if errors.Is(lookup, adksession.ErrNotFound) {
		if kind == "plan_review" && answers != nil {
			return nil
		}
		if err = e.runNativeQuestion(ctx, req, nil, c); err != nil {
			return err
		}
	} else if lookup != nil {
		return lookup
	}
	if answers != nil {
		return e.runNativeQuestion(ctx, req, answers, c)
	}
	return nil
}
func (e *Engine) RecordSREAttestation(ctx context.Context, sessionID string, task SRETask, checkID string, passed bool) error {
	run := task.ActiveRun()
	if run == nil {
		return errors.New("no plan run for attestation")
	}
	answer := "failed"
	if passed {
		answer = "passed"
	}
	return e.recordSREInput(ctx, sessionID, task, "manual_attestation", run.ID+checkID, map[string][]string{"manual_attestation": {answer}})
}
