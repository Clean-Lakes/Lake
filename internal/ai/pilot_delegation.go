package ai

import "errors"

func pilotLatestDecision(policy *PilotTaskPolicy, plan, step, attempt string) *PilotChoiceDecision {
	if policy == nil {
		return nil
	}
	for i := len(policy.Decisions) - 1; i >= 0; i-- {
		d := &policy.Decisions[i]
		if d.PlanRevisionID == plan && d.StepID == step && d.AttemptID == attempt {
			return d
		}
	}
	return nil
}

func pilotExecutionMode(task SRETask, plan, step, attempt string) string {
	if task.Pilot == nil {
		return "legacy"
	}
	if d := pilotLatestDecision(task.Pilot, plan, step, attempt); d != nil {
		switch d.Selection.Level {
		case "command", "direction", "step", "cancel":
			return d.Selection.Level
		}
	}
	if task.Pilot.AutoAdvance {
		return "automatic"
	}
	return "guided"
}

func (e *Engine) activePilotTask(c Config) (SRETask, error) {
	if c.sre == nil || c.sre.Pilot == nil || c.sre.NoTools || e.worker == nil || e.sreRepository == nil {
		return SRETask{}, errors.New("Pilot execution context unavailable")
	}
	task, err := e.sreRepository.LoadSRETask(e.worker.parentID, c.sre.TaskID)
	if err != nil {
		return task, err
	}
	if task.Pilot == nil || task.LatestPlan() == nil || task.LatestPlan().ID != c.sre.PlanRevisionID || (task.Status != "active" && task.Status != "waiting_approval") {
		return task, errors.New("Pilot plan changed or paused; use the current active step")
	}
	for _, a := range task.Attempts {
		if a.ID == c.sre.AttemptID && a.StepID == c.sre.Step.ID {
			return task, nil
		}
	}
	return task, errors.New("Pilot step attempt expired")
}

func pilotDecisionOperations(task SRETask, decision *PilotChoiceDecision) []PilotOperationCandidate {
	if decision.Selection.Level == "direction" {
		for i := len(task.Pilot.DirectionBatches) - 1; i >= 0; i-- {
			batch := task.Pilot.DirectionBatches[i]
			if batch.DecisionID == decision.RequestID && batch.DirectionID == decision.Selection.DirectionID {
				return batch.Operations
			}
		}
	}
	return decision.Operations
}

func (e *Engine) savePilotDirectionBatch(choice *PilotChoice, decision *PilotChoiceDecision, direction PilotDirection) error {
	_, err := e.sreRepository.MutateSRETask(choice.SessionID, choice.TaskID, 0, "pilot_direction_batch", func(task *SRETask) error {
		current := pilotLatestDecision(task.Pilot, choice.PlanRevisionID, choice.StepID, choice.AttemptID)
		if task.LatestPlan() == nil || task.LatestPlan().ID != choice.PlanRevisionID || (task.Status != "active" && task.Status != "waiting_approval") || current == nil || current.Direction == nil || current.RequestID != decision.RequestID || current.Selection.Level != "direction" || current.Selection.DirectionID != direction.ID {
			return errors.New("Pilot direction delegation expired")
		}
		if current.Direction != nil && (current.Direction.Title != direction.Title || current.Direction.Reason != direction.Reason) {
			return errors.New("Keep the selected direction's original title and purpose; changing direction requires a new user choice")
		}
		batch := PilotDirectionBatch{ID: hash(current.RequestID + js(direction.Operations)), DecisionID: current.RequestID, DirectionID: direction.ID, Operations: direction.Operations, CreatedAt: timestamp()}
		for _, old := range task.Pilot.DirectionBatches {
			if old.ID == batch.ID {
				return nil
			}
		}
		task.Pilot.DirectionBatches = append(task.Pilot.DirectionBatches, batch)
		return nil
	})
	return err
}

func pilotRolePolicyContext(task SRETask, c Config) map[string]any {
	policy := map[string]any{"mode": pilotExecutionMode(task, c.sre.PlanRevisionID, c.sre.Step.ID, c.sre.AttemptID), "step_id": c.sre.Step.ID, "notice": "Command selection is exact. Direction delegation allows new validated command batches under the SAME direction ID, title and purpose via pilot_offer_directions, without another user choice. Step/automatic delegation allows changing directions and commands within your assigned role, targets and permissions. After a failed read, either report failure or obtain a real alternative sample and use pilot_read_recovery to link the replacement. Never clear unknown changes or claim recovery without normal independent verification."}
	if d := pilotLatestDecision(task.Pilot, c.sre.PlanRevisionID, c.sre.Step.ID, c.sre.AttemptID); d != nil {
		policy["direction"] = d.Direction
		policy["direction_id"] = d.Selection.DirectionID
	}
	return policy
}
