package ai

import "context"

// A role mention routes a question. It is never authority to execute an action.
func (e *Engine) AnswerSRERole(ctx context.Context, sessionID, taskID string, role SREAgentRole, message string) (err error) {
	done, admissionErr := e.admitRuntime()
	if admissionErr != nil {
		return admissionErr
	}
	defer done()
	if !ValidSRERole(role) {
		return sreError(400, "未知专员")
	}
	task, err := e.sreRepository.LoadSRETask(sessionID, taskID)
	if err != nil {
		return err
	}
	s, err := e.get(sessionID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return sreError(409, "会话仍在运行")
	}
	ctx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.state.View.Status = "running"
	s.state.View.RootTurnID = uid()
	s.mu.Unlock()
	defer func() {
		cancel()
		s.mu.Lock()
		s.cancel = nil
		s.state.View.Status = "completed"
		s.state.View.TurnFinishedAt = timestamp()
		_ = e.save(s)
		s.mu.Unlock()
		if e.Emit != nil {
			e.Emit(Event{Session: sessionID, Type: "sreDone"})
		}
	}()
	step := SREPlanStep{ID: "question", Role: role, Kind: "analyze", Description: message, ResourceIDs: task.Scope}
	result, err := e.ExecuteSRERole(ctx, sessionID, task, step, "", "", message+"\nCurrent recorded plan and facts (not new observations):\n"+js(task.LatestPlan())+"\n"+sreHandoff(task), true)
	_, saveErr := e.sreRepository.MutateSRETask(sessionID, taskID, 0, "role_answer", func(t *SRETask) error {
		kind := "handoff"
		if err != nil {
			kind = "error"
		}
		t.AddMessage(role, result.RunID, kind, result.Summary, "")
		return nil
	})
	if err == nil {
		err = saveErr
	}
	return err
}
