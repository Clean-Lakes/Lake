package ai

import "context"

// One bounded continuation through the SAME official ADK specialist, before the
// business step is closed. It retains the attempt/ledger, normal permissions and
// remaining model-round allowance. It never retries unknown changes or widens
// exact command selection, and it does not create a second execution loop.
func (e *Engine) repairPilotReadCompletion(ctx context.Context, id string, c Config) (remaining int, err error) {
	s, err := e.get(id)
	if err != nil {
		return 0, err
	}
	s.mu.Lock()
	used := 0
	if s.state.Runtime != nil {
		used = s.state.Runtime.ModelRounds
	}
	s.mu.Unlock()
	remaining = max(0, c.MaxSteps-used)
	if c.sre == nil || c.sre.Pilot == nil || c.sre.NoTools || c.sre.Role == SREExecutor || c.sre.Step.Kind == "act" || c.sre.Step.Action != nil || e.worker == nil {
		return remaining, nil
	}
	e.worker.mu.Lock()
	finalizing := e.worker.finalizing
	e.worker.mu.Unlock()
	if finalizing {
		return remaining, nil
	}
	task, err := e.activePilotTask(c)
	if err != nil {
		return remaining, err
	}
	for _, a := range task.Attempts {
		if a.ID == c.sre.AttemptID && a.CompletionRepair != nil && a.CompletionRepair.RoleRunID == e.worker.runID {
			return max(0, a.CompletionRepair.OriginalRemainingRounds-used), nil
		}
	}
	if remaining == 0 {
		return remaining, nil
	}
	mode := pilotExecutionMode(task, c.sre.PlanRevisionID, c.sre.Step.ID, c.sre.AttemptID)
	if mode != "automatic" && mode != "step" && mode != "direction" {
		return remaining, nil
	}
	for _, a := range task.Attempts {
		for _, op := range a.Operations {
			if SREOperationNeedsVerification(op) || (a.ID == c.sre.AttemptID && op.Status == "dispatched") {
				return remaining, nil
			}
		}
	}
	policy := pilotRolePolicyContext(task, c)
	if policy["read_gaps"] == nil {
		return remaining, nil
	}
	repair := c
	repair.MaxSteps = min(8, remaining)
	claimed := false
	_, err = e.sreRepository.MutateSRETask(e.worker.parentID, c.sre.TaskID, 0, "pilot_completion_repair_started", func(t *SRETask) error {
		if t.LatestPlan() == nil || t.LatestPlan().ID != c.sre.PlanRevisionID || (t.Status != "active" && t.Status != "waiting_approval") {
			return sreError(409, "当前步骤已停止，未继续补齐检查。")
		}
		for i := range t.Attempts {
			a := &t.Attempts[i]
			if a.ID != c.sre.AttemptID || a.StepID != c.sre.Step.ID {
				continue
			}
			if a.CompletionRepair != nil {
				return nil
			}
			if a.RoleRunID != e.worker.runID {
				return sreError(409, "专员归属已改变，未继续补齐检查。")
			}
			a.CompletionRepair = &PilotCompletionRepair{RoleRunID: e.worker.runID, MaxRounds: repair.MaxSteps, OriginalRemainingRounds: remaining, StartedAt: timestamp()}
			claimed = true
			return nil
		}
		return sreError(409, "步骤执行记录已过期。")
	})
	if err != nil || !claimed {
		return remaining, err
	}
	if err = e.Configure(id, repair); err != nil {
		return remaining, err
	}
	err = e.ExecuteTurn(ctx, id, TurnInput{UserText: "[PILOT_COMPLETION_REPAIR]\nThe runtime has not accepted the step as complete. Your own attempt still has the following real read gaps: " + js(policy) + "\nContinue THIS same step within its original delegation, role, targets and permissions. Reuse appropriate complete replacement evidence already collected, or obtain a new bounded complete sample and link its operation ID with pilot_read_recovery. Do not repeat completed changes, replay running operations, associate policy-denied proposals, or claim a partial/truncated read is complete. If the gap cannot be resolved safely, explicitly report incomplete. Then return the required evidence-grounded final report. This continuation has at most " + js(repair.MaxSteps) + " model rounds and does not renew your original allowance."})
	s.mu.Lock()
	rounds := 0
	if s.state.Runtime != nil {
		rounds = s.state.Runtime.ModelRounds
	}
	s.mu.Unlock()
	return max(0, remaining-rounds), err
}

func pilotRoleRoundLimit(task SRETask, attemptID, roleRunID string, parentLimit int) int {
	for _, a := range task.Attempts {
		if a.ID != attemptID || a.CompletionRepair == nil {
			continue
		}
		r := a.CompletionRepair
		if r.RoleRunID == roleRunID && r.MaxRounds > 0 && r.MaxRounds <= 8 && r.OriginalRemainingRounds > 0 {
			return min(parentLimit, r.MaxRounds, r.OriginalRemainingRounds)
		}
	}
	return parentLimit
}
