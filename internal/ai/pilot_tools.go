package ai

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

func pilotChoiceTool() Tool {
	operation := objectSchema(map[string]any{"id": stringSchema(), "title": stringSchema(), "tool": stringSchema(), "arguments": map[string]any{"type": "object", "additionalProperties": true}, "dependsOn": arraySchema(stringSchema())}, "id", "title", "tool", "arguments")
	direction := objectSchema(map[string]any{"id": stringSchema(), "title": stringSchema(), "reason": stringSchema(), "recommended": map[string]any{"type": "boolean"}, "operations": arraySchema(operation)}, "id", "title", "reason", "operations")
	return Tool{Name: "pilot_offer_directions", Description: "For the CURRENT assigned step, propose 1..3 meaningful directions with exact tool names/arguments and dependency IDs. This does not execute a resource operation or approve changes. In guided Lake Pilot, wait for the user's direction/command choice; in automatic mode use the recommended direction. Do not change the plan or invent commands whose parameters depend on observations not yet collected. All chosen resource operations still require their normal permissions and approvals.", Parameters: objectSchema(map[string]any{"directions": arraySchema(direction)}, "directions")}
}

func pilotFingerprint(name string, args map[string]any) string { return hash(name + js(args)) }

func (e *Engine) offerPilotDirections(ctx context.Context, s *session, c Config, call Call) (any, error) {
	if c.sre == nil || c.sre.Pilot == nil || c.sre.NoTools || e.worker == nil || e.sreRepository == nil {
		return nil, errors.New("Lake Pilot choices belong to an active specialist step")
	}
	var input struct {
		Directions []PilotDirection `json:"directions"`
	}
	if err := decodeSREJSON(call.Arguments, &input); err != nil {
		return nil, err
	}
	if len(input.Directions) < 1 || len(input.Directions) > 3 {
		return nil, errors.New("provide 1..3 concrete directions")
	}
	choice := &PilotChoice{SessionID: e.worker.parentID, TaskID: c.sre.TaskID, PlanRevisionID: c.sre.PlanRevisionID, StepID: c.sre.Step.ID, AttemptID: c.sre.AttemptID, Role: c.sre.Role, Directions: input.Directions}
	names := map[string]Tool{}
	s.mu.Lock()
	sessionID := s.state.View.Session
	s.mu.Unlock()
	for _, tool := range e.sessionCatalog(ctx, sessionID, c) {
		names[tool.Name] = tool
	}
	directions, recommended := map[string]bool{}, 0
	for directionIndex := range choice.Directions {
		direction := &choice.Directions[directionIndex]
		if !identifier.MatchString(direction.ID) || directions[direction.ID] || strings.TrimSpace(direction.Title) == "" || len(direction.Title) > 200 || len(direction.Reason) > 2000 || len(direction.Operations) < 1 || len(direction.Operations) > 12 {
			return nil, errors.New("invalid Pilot direction")
		}
		directions[direction.ID] = true
		if direction.Recommended {
			recommended++
		}
		seen := map[string]bool{}
		for operationIndex := range direction.Operations {
			operation := &direction.Operations[operationIndex]
			tool, available := names[operation.Tool]
			if !identifier.MatchString(operation.ID) || seen[operation.ID] || strings.TrimSpace(operation.Title) == "" || len(operation.Title) > 300 || !available || operation.Tool == "pilot_offer_directions" || pilotInternalTool(operation.Tool) {
				return nil, errors.New("invalid Pilot operation")
			}
			if err := validateTool(tool, operation.Arguments); err != nil {
				return nil, err
			}
			risk, _, policyErr := e.policy(ctx, sessionID, c, operation.Tool, operation.Arguments)
			if policyErr != nil {
				return nil, policyErr
			}
			// Session operations use the existing opaque write/approval path.
			if sessionTool(operation.Tool) {
				risk = "write"
			}
			if err := pilotRoleAllowed(c, risk); err != nil {
				return nil, err
			}
			operation.Risk = risk
			for _, dep := range operation.DependsOn {
				if !seen[dep] {
					return nil, errors.New("Pilot dependencies must refer to an earlier operation in this direction")
				}
			}
			seen[operation.ID] = true
		}
	}
	if recommended > 1 {
		return nil, errors.New("recommend at most one direction")
	}
	var safeChoice PilotChoice
	if json.Unmarshal(safeJSON([]byte(js(choice)), c), &safeChoice) != nil || js(safeChoice) != js(choice) {
		return nil, errors.New("Pilot 候选包含需要隐藏的信息，请通过已配置的资源凭据执行")
	}
	task, loadErr := e.sreRepository.LoadSRETask(choice.SessionID, choice.TaskID)
	if loadErr != nil {
		return nil, loadErr
	}
	delegated := false
	if task.Pilot != nil {
		for i := len(task.Pilot.Decisions) - 1; i >= 0; i-- {
			previous := task.Pilot.Decisions[i]
			if previous.PlanRevisionID == choice.PlanRevisionID && previous.StepID == choice.StepID && previous.AttemptID == choice.AttemptID {
				delegated = previous.Selection.Level == "step"
				break
			}
		}
	}
	if c.sre.Pilot.AutoAdvance || delegated {
		direction := choice.Directions[0]
		for _, value := range choice.Directions {
			if value.Recommended {
				direction = value
				break
			}
		}
		return map[string]any{"selection": PilotSelection{Level: "direction", DirectionID: direction.ID}, "direction": direction, "automatic": true}, nil
	}
	return e.askQuestion(ctx, s, call, choice)
}

func pilotInternalTool(name string) bool {
	switch name {
	case "pilot_offer_directions", "sre_team_read", "sre_team_update", "ask_user_question", "todo_read", "todo_write", "read_evidence", "read_tool_result", "read_session_context", "load_skill", "list_assets", "list_resource_groups", "list_mcp_servers", "list_project_memories", "read_project_memory", "list_workflows", "get_workflow_run", "schedule_list", "task_output", "shell_output", "wait_shell", "read_terminal_screen":
		return true
	}
	return false
}

func pilotSelection(req *QuestionRequest, answers map[string][]string) (PilotSelection, []PilotOperationCandidate, error) {
	if req.Pilot == nil || len(req.Questions) != 1 {
		return PilotSelection{}, nil, errors.New("Pilot choice expired")
	}
	values := answers[req.Questions[0].ID]
	var selection PilotSelection
	if len(answers) != 1 || len(values) != 1 || len(values[0]) > 4000 || json.Unmarshal([]byte(values[0]), &selection) != nil {
		return selection, nil, errors.New("submit a concrete Pilot selection")
	}
	if selection.Level == "step" || selection.Level == "cancel" {
		if selection.DirectionID != "" || len(selection.OperationIDs) != 0 {
			return selection, nil, errors.New("invalid step delegation")
		}
		return selection, nil, nil
	}
	var direction *PilotDirection
	for i := range req.Pilot.Directions {
		if req.Pilot.Directions[i].ID == selection.DirectionID {
			direction = &req.Pilot.Directions[i]
		}
	}
	if direction == nil || selection.Level != "direction" && selection.Level != "command" {
		return selection, nil, errors.New("Pilot direction unavailable")
	}
	if selection.Level == "direction" {
		if len(selection.OperationIDs) > 0 {
			return selection, nil, errors.New("direction selection cannot replace the operation set")
		}
		return selection, direction.Operations, nil
	}
	selected := map[string]bool{}
	for _, id := range selection.OperationIDs {
		if selected[id] {
			return selection, nil, errors.New("duplicate Pilot operation")
		}
		selected[id] = true
	}
	operations := []PilotOperationCandidate{}
	for _, operation := range direction.Operations {
		if selected[operation.ID] {
			for _, dep := range operation.DependsOn {
				if !selected[dep] {
					return selection, nil, errors.New("Pilot operation dependency missing")
				}
			}
			operations = append(operations, operation)
		}
	}
	if len(operations) == 0 || len(operations) != len(selected) {
		return selection, nil, errors.New("Pilot operation unavailable")
	}
	return selection, operations, nil
}

func (e *Engine) recordPilotSelection(req *QuestionRequest, answers map[string][]string) error {
	if req.Pilot == nil {
		return nil
	}
	selection, operations, err := pilotSelection(req, answers)
	if err != nil {
		return err
	}
	if e.sreRepository == nil {
		return errors.New("Pilot task repository unavailable")
	}
	choice := req.Pilot
	_, err = e.sreRepository.MutateSRETask(choice.SessionID, choice.TaskID, 0, "pilot_choice", func(task *SRETask) error {
		if task.Pilot == nil || task.LatestPlan() == nil || task.LatestPlan().ID != choice.PlanRevisionID || !SRETaskActive(task.Status) {
			return errors.New("Pilot plan or task is no longer active")
		}
		for _, old := range task.Pilot.Decisions {
			if old.RequestID == req.ID {
				if js(old.Selection) != js(selection) {
					return errors.New("Pilot choice already decided")
				}
				return nil
			}
		}
		owned := false
		for _, attempt := range task.Attempts {
			owned = owned || attempt.ID == choice.AttemptID && attempt.StepID == choice.StepID
		}
		if !owned {
			return errors.New("Pilot step attempt expired")
		}
		decision := PilotChoiceDecision{RequestID: req.ID, PlanRevisionID: choice.PlanRevisionID, StepID: choice.StepID, AttemptID: choice.AttemptID, Selection: selection, Operations: operations, CreatedAt: timestamp()}
		for _, operation := range operations {
			decision.Fingerprints = append(decision.Fingerprints, pilotFingerprint(operation.Tool, operation.Arguments))
		}
		task.Pilot.Decisions = append(task.Pilot.Decisions, decision)
		return nil
	})
	return err
}

func (e *Engine) checkPilotCall(c Config, call Call, args map[string]any) error {
	if c.sre == nil || c.sre.Pilot == nil || c.sre.NoTools || pilotInternalTool(call.Name) {
		return nil
	}
	if e.sreRepository == nil || e.worker == nil {
		return errors.New("Pilot execution context unavailable")
	}
	task, err := e.sreRepository.LoadSRETask(e.worker.parentID, c.sre.TaskID)
	if err != nil {
		return err
	}
	if task.Pilot == nil || task.LatestPlan() == nil || task.LatestPlan().ID != c.sre.PlanRevisionID || task.Status != "active" && task.Status != "waiting_approval" {
		return errors.New("Pilot plan changed or paused; choose from the current active plan")
	}
	if task.Pilot.AutoAdvance {
		return nil
	}
	fingerprint := pilotFingerprint(call.Name, args)
	for i := len(task.Pilot.Decisions) - 1; i >= 0; i-- {
		decision := task.Pilot.Decisions[i]
		if decision.PlanRevisionID != c.sre.PlanRevisionID || decision.StepID != c.sre.Step.ID || decision.AttemptID != c.sre.AttemptID {
			continue
		}
		if decision.Selection.Level == "step" {
			return nil
		}
		if decision.Selection.Level == "cancel" {
			return errors.New("Pilot selection was cancelled; stop this step without executing")
		}
		for _, operation := range decision.Operations {
			if fingerprint == pilotFingerprint(operation.Tool, operation.Arguments) {
				for _, dep := range operation.DependsOn {
					var required *PilotOperationCandidate
					for i := range decision.Operations {
						if decision.Operations[i].ID == dep {
							required = &decision.Operations[i]
						}
					}
					completed := false
					if required != nil {
						for _, attempt := range task.Attempts {
							if attempt.ID != decision.AttemptID {
								continue
							}
							for _, result := range attempt.Operations {
								var actual map[string]any
								_ = json.Unmarshal([]byte(result.Call.Arguments), &actual)
								completed = completed || result.Status == "succeeded" && pilotFingerprint(result.Call.Name, actual) == pilotFingerprint(required.Tool, required.Arguments)
							}
						}
					}
					if !completed {
						return errors.New("Pilot operation dependency has not completed")
					}
				}
				return nil
			}
		}
		break
	}
	return errors.New("Lake Pilot is waiting for a direction or command selection; call pilot_offer_directions before resource execution")
}

func pilotRoleAllowed(c Config, risk string) error {
	if c.sre == nil || c.sre.Pilot == nil || risk == "readonly" {
		return nil
	}
	if c.sre.Role != SREExecutor {
		return errors.New("this Lake Pilot specialist is read-only; hand proposed changes to the executor")
	}
	return nil
}

func pilotAttemptError(task SRETask, attempt SREStepAttempt, step SREPlanStep) error {
	if task.Pilot == nil {
		return nil
	}
	var decision *PilotChoiceDecision
	for i := len(task.Pilot.Decisions) - 1; i >= 0; i-- {
		if task.Pilot.Decisions[i].StepID == step.ID && task.Pilot.Decisions[i].AttemptID == attempt.ID {
			decision = &task.Pilot.Decisions[i]
			break
		}
	}
	if decision != nil && decision.Selection.Level == "cancel" {
		return errors.New("用户暂不执行本步骤，已保留现场")
	}
	if decision != nil {
		for _, chosen := range decision.Operations {
			completed := false
			for _, operation := range attempt.Operations {
				var args map[string]any
				_ = json.Unmarshal([]byte(operation.Call.Arguments), &args)
				completed = completed || operation.Status == "succeeded" && pilotFingerprint(operation.Call.Name, args) == pilotFingerprint(chosen.Tool, chosen.Arguments)
			}
			if !completed {
				return errors.New("所选检查尚未全部完成，不能将本步骤标记完成")
			}
		}
	}
	if step.Kind == "observe" || step.Kind == "act" {
		for _, operation := range attempt.Operations {
			if operation.Status == "succeeded" {
				return nil
			}
		}
		return errors.New("当前步骤没有实际完成的检查或操作，不能只凭回复标记完成")
	}
	return nil
}
