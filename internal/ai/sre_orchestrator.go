package ai

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// StartSRETask owns the parent session while dependency-scheduled roles run.
// Plan revisions are immutable; an interrupted/unknown run is never replayed.
func (e *Engine) StartSRETask(ctx context.Context, sessionID, taskID string, planOnly bool, userText string) (err error) {
	done, admissionErr := e.admitRuntime()
	if admissionErr != nil {
		return admissionErr
	}
	defer done()
	if e.sreRepository == nil {
		return errors.New("此运行端未接入 SRE 任务仓库")
	}
	task, err := e.sreRepository.LoadSRETask(sessionID, taskID)
	if err != nil {
		return err
	}
	if !SRETaskActive(task.Status) {
		return sreError(409, "任务已经结束")
	}
	s, err := e.get(sessionID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return sreError(409, "会话仍有运行中的任务")
	}
	if s.state.Config.Model.Name == "" {
		s.mu.Unlock()
		return sreError(400, "尚未配置模型")
	}
	baseConfig := s.state.Config
	s.mu.Unlock()
	if err := e.prepareOnlineSREContinue(ctx, s, baseConfig, taskID); err != nil {
		return err
	}
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return sreError(409, "会话仍有运行中的任务")
	}
	ctx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.state.View.Status = "running"
	if _, recovering := e.sreRecoveries.Load(sessionID + ":" + taskID); !recovering {
		s.state.View.RootTurnID = uid()
	}
	s.state.RootQuestion = task.Goal
	s.state.View.TurnStartedAt = timestamp()
	s.state.View.TurnFinishedAt = ""
	s.state.View.Turns++
	if s.state.View.StartedAt == "" {
		s.state.View.StartedAt = timestamp()
	}
	err = e.save(s)
	s.mu.Unlock()
	if err != nil {
		cancel()
		s.mu.Lock()
		s.cancel = nil
		s.mu.Unlock()
		return err
	}
	control := &sreTaskControl{cancel: cancel, done: make(chan struct{})}
	control.reason.Store("")
	key := sessionID + ":" + taskID
	e.sreControls.Store(key, control)
	defer func() {
		cancel()
		close(control.done)
		e.sreControls.Delete(key)
		correctionConfig := baseConfig
		correctionConfig.sreCoordinator = false
		correctionConfig.sre = &sreRoleContext{TaskID: taskID}
		if finishErr := e.onlineFinish(s, correctionConfig, err); err == nil && finishErr != nil {
			err = finishErr
		}
		if err != nil {
			_, _ = e.sreRepository.MutateSRETask(sessionID, taskID, 0, "task_paused", func(t *SRETask) error {
				if !SRETaskActive(t.Status) {
					return nil
				}
				t.Status = "paused"
				t.Error = redact(err.Error(), baseConfig)
				if control.reason.Load() == "cancel" {
					t.Status = "cancelled"
				}
				if run := t.ActiveRun(); run != nil && run.Status == "running" {
					run.Status = "paused"
					if t.Status == "cancelled" {
						run.Status = "cancelled"
					}
					run.FinishedAt = timestamp()
				}
				return nil
			})
		}
		s.mu.Lock()
		s.cancel = nil
		s.state.View.Status = sreExecutionStatus(err)
		s.state.View.TurnFinishedAt = timestamp()
		_ = e.save(s)
		s.mu.Unlock()
		if e.Emit != nil {
			e.Emit(Event{Session: sessionID, Type: "sreDone"})
		}
	}()
	if task.BudgetPolicy == "" {
		_, legacyBudget := agentUsageLimits(baseConfig)
		if task.TokenBudget == legacyBudget {
			task, err = e.sreRepository.MutateSRETask(sessionID, taskID, 0, "budget_policy_upgraded", func(t *SRETask) error {
				upgradeSREBudget(t, baseConfig)
				return nil
			})
			if err != nil {
				return err
			}
		}
	}
	if task.LatestPlan() != nil && strings.TrimSpace(userText) != "" {
		plan, roleRun, pe := e.buildSREPlan(ctx, sessionID, task, userText)
		if pe != nil {
			return pe
		}
		expected := task.LatestPlan().Version
		task, err = e.ReviseSREPlan(sessionID, taskID, expected, plan)
		if err != nil {
			return err
		}
		task, err = e.sreRepository.MutateSRETask(sessionID, taskID, 0, "coordinator_replan", func(t *SRETask) error {
			m := &t.Messages[len(t.Messages)-1]
			m.RoleRunID = roleRun
			m.Source = "runtime"
			m.Body = "已根据新要求调整计划。"
			return nil
		})
		if err != nil {
			return err
		}
	}
	if task.LatestPlan() == nil {
		plan, roleRun, pe := e.buildSREPlan(ctx, sessionID, task, userText)
		if pe != nil {
			return pe
		}
		task, err = e.sreRepository.MutateSRETask(sessionID, taskID, 0, "plan_created", func(t *SRETask) error {
			plan.ID = uid()
			plan.TaskID = t.ID
			plan.Version = 1
			plan.CreatedAt = timestamp()
			t.Plans = append(t.Plans, plan)
			t.AddMessage(SRECoordinator, roleRun, "plan", "已明确任务范围，按计划开展调查。", "")
			return nil
		})
		if err != nil {
			return err
		}
	}
	if !planOnly && needsSRECollaborationUpgrade(task) {
		task, err = e.upgradeSRECollaboration(ctx, sessionID, task)
		if err != nil {
			return err
		}
	}
	if planOnly {
		return e.recordSREInput(ctx, sessionID, task, "plan_review", task.LatestPlan().ID, nil)
	}
	if err = e.recordSREInput(ctx, sessionID, task, "plan_review", task.LatestPlan().ID, map[string][]string{"plan_review": {"start"}}); err != nil {
		return err
	}
	run := task.ActiveRun()
	if run == nil || run.Status != "queued" {
		task, err = e.sreRepository.MutateSRETask(sessionID, taskID, 0, "run_started", func(t *SRETask) error { return StartSREPlanRun(t, t.LatestPlan().Version, "") })
		if err != nil {
			return err
		}
	} else {
		task, err = e.sreRepository.MutateSRETask(sessionID, taskID, 0, "run_started", func(t *SRETask) error { t.Status = "active"; t.ActiveRun().Status = "running"; return nil })
		if err != nil {
			return err
		}
	}
	plan := *task.LatestPlan()
	runID := task.ActiveRun().ID
	if err = e.runSREPlanSteps(ctx, sessionID, taskID, runID, plan); err != nil {
		return err
	}

	_, err = e.sreRepository.MutateSRETask(sessionID, taskID, 0, "task_finished", func(t *SRETask) error {
		if t.Status == "waiting_approval" {
			t.Status = "active"
		} // All role loops have settled.
		t.ActiveRun().Status = "completed"
		t.ActiveRun().FinishedAt = timestamp()
		if plan.TaskType == "query" || plan.TaskType == "investigation" {
			t.Outcome = "inconclusive"
			t.RecoveryStatus = "not_applicable"
			t.RootCauseStatus = "unknown"
			return TransitionSRETask(t, "completed")
		}
		if !CanCompleteSRETask(*t) {
			t.Status = "waiting_input"
			t.Error = "操作已结束，但尚未满足恢复验收条件。"
			return nil
		}
		t.Outcome = "supported"
		t.RecoveryStatus = "verified"
		return TransitionSRETask(t, "completed")
	})
	return err
}

func (e *Engine) runSREStep(ctx context.Context, sessionID, taskID, runID string, step SREPlanStep) error {
	task, err := e.sreRepository.LoadSRETask(sessionID, taskID)
	if err != nil {
		return err
	}
	attempt := SREStepAttempt{ID: uid(), PlanRunID: runID, StepID: step.ID, Status: "running", StartedAt: timestamp(), Evidence: []AgentEvidence{}, Operations: []SREOperation{}}
	recovering := false
	for _, previous := range task.Attempts {
		if previous.PlanRunID == runID && previous.StepID == step.ID && previous.RoleRunID != "" && e.hasRecoverableRole(sessionID, previous.RoleRunID) {
			attempt, recovering = previous, true
			ctx = context.WithValue(ctx, sreRoleRecoveryKey{}, sreRoleRecovery{runID: previous.RoleRunID})
			break
		}
	}
	if !recovering {
		task, err = e.sreRepository.MutateSRETask(sessionID, taskID, 0, "step_started", func(t *SRETask) error {
			if t.Status != "active" && t.Status != "waiting_approval" {
				return sreError(409, "任务已暂停或结束")
			}
			t.Attempts = append(t.Attempts, attempt)
			return nil
		})
	}
	if err != nil {
		return err
	}
	prompt := "Original user goal: " + task.Goal + "\nAssigned deliverable: " + step.Description + "\nCompletion conditions: " + js(step.CompletionChecks)
	if step.Role == SRECoordinator {
		prompt += "\nUse these server recorded observations and operation facts for your assigned deliverable. Do not claim recovery unless a runtime verification passed:\n" + sreHandoff(task)
	}
	if step.Role == SREExecutor {
		prompt += "\nExecute this exact frozen operation ONCE; do not change arguments or retry:\n" + js(step.Action)
	}
	var result SRERoleResult
	if step.Role == SREVerifier {
		var verification SREVerificationResult
		verification, err = e.EvaluateVerification(ctx, sessionID, task, runID, attempt.ID, step)
		result = SRERoleResult{RunID: uid(), Summary: sreVerificationSummary(verification)}
		task, _ = e.sreRepository.LoadSRETask(sessionID, taskID)
		for _, a := range task.Attempts {
			if a.ID == attempt.ID {
				result.Evidence = a.Evidence
				result.RunID = a.RoleRunID
			}
		}
	} else {
		result, err = e.ExecuteSRERole(ctx, sessionID, task, step, runID, attempt.ID, prompt, false)
	}
	roleErr := err
	task, err = e.sreRepository.MutateSRETask(sessionID, taskID, 0, "step_finished", func(t *SRETask) error {
		for i := range t.Attempts {
			a := &t.Attempts[i]
			if a.ID != attempt.ID {
				continue
			}
			a.RoleRunID = result.RunID
			a.Result = result.Summary
			a.Report = result.Report
			a.FinishedAt = timestamp()
			a.Evidence = result.Evidence
			a.Status, roleErr = sreAttemptOutcome(*a, step, roleErr)
			if a.Status == "unknown" {
				result.Summary = SREExecutionSummary(*a)
				a.Result = result.Summary
			}
			if roleErr != nil {
				for j := range a.Operations {
					op := &a.Operations[j]
					if op.Status == "prepared" || op.Status == "waiting_approval" {
						op.Status = "not_executed"
						if IsSRERejection(roleErr) {
							op.Status = "rejected"
						}
						op.FinishedAt = timestamp()
					}
				}
			}
			if step.Role == SREExecutor {
				result.Summary = SREExecutionSummary(*a)
				a.Result = result.Summary
				if a.Status == "unknown" && roleErr == nil {
					roleErr = errors.New(result.Summary)
				}
			}
		}
		for _, a := range t.Attempts {
			if a.ID == attempt.ID {
				projectSREAttemptStatus(t, attempt.ID, a.Status)
				break
			}
		}
		kind := map[SREAgentRole]string{SRECoordinator: "summary", SREInvestigator: "finding", SREExecutor: "result", SREVerifier: "verification"}[step.Role]
		if step.Role == SRECoordinator && step.Kind != "summarize" {
			kind = "finding"
		}
		if roleErr != nil {
			kind = "error"
		}
		for i := range t.Messages {
			m := &t.Messages[i]
			if m.AttemptID == attempt.ID && m.Kind == "progress" {
				m.Kind = "status"
				m.Source = "runtime"
				m.Body = "本步工作已完成。"
				if roleErr != nil {
					m.Body = "本步工作未完成。"
				}
				if step.Role == SREExecutor {
					m.Body = result.Summary
				}
				m.RoleRunID = result.RunID
				m.Revision++
			}
		}
		t.AddMessage(step.Role, result.RunID, kind, result.Summary, attempt.ID)
		return nil
	})
	if err != nil {
		return err
	}
	if roleErr != nil {
		return roleErr
	}

	return nil
}

func (e *Engine) ResumeSRETask(ctx context.Context, sessionID, taskID string) error {
	return e.StartSRETask(ctx, sessionID, taskID, false, "")
}

func StartSREPlanRun(t *SRETask, version int, requestID string) error {
	p := t.LatestPlan()
	if p == nil || p.Version != version {
		return sreError(409, "计划版本已变化，请刷新后开始")
	}
	if !SRETaskActive(t.Status) {
		return sreError(409, "任务已经结束")
	}
	for _, a := range t.Attempts {
		for _, op := range a.Operations {
			if SREOperationBlocksResume(op) {
				return sreOperationBlockError(op)
			}
		}
	}
	if r := t.ActiveRun(); r != nil && (r.Status == "running" || r.Status == "queued" || r.Status == "waiting_approval") {
		return sreError(409, "计划仍在执行")
	}
	resumeOf := ""
	if old := t.ActiveRun(); old != nil {
		if old.Status == "paused" && old.PlanRevisionID == p.ID {
			old.Status = "running"
			old.FinishedAt = ""
			t.Status = "active"
			t.Error = ""
			return nil
		}
		resumeOf = old.ID
	}
	newRun := SREPlanRun{ID: uid(), TaskID: t.ID, PlanRevisionID: p.ID, ProfileVersion: t.ProfileVersion, Status: "running", ResumeOfRunID: resumeOf, StartedAt: timestamp()}
	// Revisions never authorize replay of a successful identical write. Carry its
	// recorded fact forward, while all observations and verification run afresh.
	for _, step := range p.Steps {
		if step.Kind != "act" || step.Action == nil {
			continue
		}
		for i := len(t.Attempts) - 1; i >= 0; i-- {
			previous := t.Attempts[i]
			if len(previous.Operations) != 1 {
				continue
			}
			op := previous.Operations[0]
			if op.Status != "succeeded" || op.ResourceID != step.ResourceIDs[0] || op.Call.Name != step.Action.Tool {
				continue
			}
			var arguments map[string]any
			if decodeSREJSON(op.Call.Arguments, &arguments) != nil || js(arguments) != js(step.Action.Arguments) {
				continue
			}
			copy := previous
			copy.ID, copy.PlanRunID, copy.StepID, copy.ReusedFromAttemptID = uid(), newRun.ID, step.ID, previous.ID
			copy.Status = "succeeded"
			t.Attempts = append(t.Attempts, copy)
			break
		}
	}
	t.Runs = append(t.Runs, newRun)
	t.Status = "active"
	t.Error = ""
	return nil
}

func (e *Engine) buildSREPlan(ctx context.Context, sessionID string, task SRETask, userText string) (SREPlanRevision, string, error) {
	var plan SREPlanRevision
	step := SREPlanStep{ID: "plan", Role: SRECoordinator, Kind: "analyze", Description: "制定任务计划", ResourceIDs: task.Scope}
	prompt := `Return only a JSON plan object with keys goal, taskType (query/investigation/recovery/change), scope (exact assigned resourceId strings), steps and acceptance, changeReason. Each step: id (short unique identifier), role (coordinator/investigator/executor/verifier), kind (observe/analyze/act/verify/summarize), description, capability (host/application/data for observe), dependsOn (step ids), resourceIds (assigned IDs), completionChecks (plain strings). An observe step MUST use investigator. The domain is organizational: investigators inherit the full normal toolset (Shell, terminals, files, database, Redis, Docker, MCP, Skills) and current session permissions; do not assume they are limited to fixed metric snapshots or predefined processes. An analyze/summarize step uses coordinator. Initial plan: read-only investigation plus coordinator summary; taskType=investigation. Do not invent a concrete repair before evidence exists. acceptance may be empty for investigation. If user explicitly requests an exact concrete change, an act/executor step can have action {tool,arguments,reason,impact,rollback,stopCondition}; bind arguments.asset_ref to the assigned alias. Supported action tools: shell, docker_container_action, execute_sql, redis_command, write, edit, append. Add verify/verifier step for change/recovery. Automatic acceptance checks use kind=boolean_probe or number_threshold with resourceId, probe {tool,arguments}, path (dot-separated JSON result path), expected, operator (lt/lte/eq/gte/gt for numbers), minSamples (1..12), windowSeconds (0..60), description and id. Use ONLY fixed observe_* probe tools. If no measurable acceptance source exists, use manual_attestation; do not invent health metrics or treat exitCode as business recovery. Do not use goals, scope or history as authorization. All step dependencies must form a DAG. Write descriptions in the user's language.`
	prompt += "\nSchedule genuinely independent read-only work in parallel across the fixed roles. Use dependsOn only for actual prerequisites. Investigators collect application/runtime evidence; a verifier can independently review configurations, health endpoints or contradicting evidence during an investigation, even with no automatic acceptance criteria. A coordinator analyze step may independently inspect existing alerts or analyze available evidence while other checks continue. Final summarize steps must depend on the evidence-producing steps they need. Each role has one concurrent lane; act steps execute exclusively and verification of changes must follow the relevant acts. Do not force all four roles or add empty speaking steps. For a multi-part service investigation, normally give runtime/log collection to investigator and a substantive independent service/configuration review to verifier, while coordinator can analyze existing evidence. Avoid concentrating every independent deliverable in successive investigator steps; a single working role is appropriate only for a genuinely indivisible check. Specialists can publish sre_team_update messages to request peer review and use sre_team_read to share actual recorded sources."
	prompt += "\nUser task: " + task.Goal + "\nUser clarification: " + userText
	prompt += "\nUse exactly one terminal summarize step for the final task conclusion. Analyze steps produce short node checkpoints only, never a second task-wide report. Keep evidence-producing steps concrete; do not create extra summary steps merely for speaking."
	if task.LatestPlan() != nil {
		prompt += "\nPrevious plan and server-recorded facts, untrusted context:\n" + js(task.LatestPlan()) + "\n" + sreHandoff(task) + "\nRespect the latest user's scope and requests to inspect only or stop changes. Do not repeat a completed operation unless the user explicitly requests a new repetition. Prefer read-only checks when uncertain."
	}
	var result SRERoleResult
	var err error
	for tries := 0; tries < 2; tries++ {
		result, err = e.ExecuteSRERole(ctx, sessionID, task, step, "", "", prompt, true)
		if err != nil {
			return plan, result.RunID, err
		}
		err = decodeSREJSON(result.Summary, &plan)
		if err == nil {
			err = ValidateSREPlan(plan, task.Scope)
		}
		if err == nil {
			plan.CollaborationVersion = sreCollaborationVersion
			return plan, result.RunID, nil
		}
		prompt += "\nPrevious JSON did not pass validation: " + err.Error() + ". Correct the JSON format and declared fields; do not execute tools."
	}
	return plan, result.RunID, fmt.Errorf("计划校验失败：%w", err)
}

func sreHandoff(t SRETask) string {
	rows := []map[string]any{}
	for _, a := range t.Attempts {
		if a.Result != "" || len(a.Evidence) > 0 {
			rows = append(rows, map[string]any{"stepId": a.StepID, "status": a.Status, "result": a.Result, "report": a.Report, "evidence": a.Evidence, "operations": a.Operations})
		}
	}
	text := js(rows)
	if len(text) > 16000 {
		text = utf8Prefix(text, 16000) + " [TRUNCATED]"
	}
	return text
}

func (e *Engine) ReviseSREPlan(sessionID, taskID string, expected int, plan SREPlanRevision) (SRETask, error) {
	return e.sreRepository.MutateSRETask(sessionID, taskID, 0, "plan_revised", func(t *SRETask) error {
		if !SRETaskActive(t.Status) {
			return sreError(409, "任务已经结束")
		}
		if current := t.LatestPlan(); current != nil && current.Version != expected {
			return sreError(409, "计划已更新，请刷新后重试")
		}
		if r := t.ActiveRun(); r != nil && (r.Status == "running" || r.Status == "queued" || r.Status == "waiting_approval") {
			return sreError(409, "请先暂停并等待当前步骤结束")
		}
		for _, a := range t.Attempts {
			for _, op := range a.Operations {
				if SREOperationBlocksResume(op) {
					return sreOperationBlockError(op)
				}
			}
		}
		if err := ValidateSREPlan(plan, t.Scope); err != nil {
			return err
		}
		plan.ID = uid()
		plan.TaskID = t.ID
		plan.Version = expected + 1
		plan.CreatedAt = timestamp()
		t.Plans = append(t.Plans, plan)
		if r := t.ActiveRun(); r != nil {
			r.Status = "superseded"
			r.FinishedAt = timestamp()
		}
		t.Status = "draft"
		t.Error = ""
		t.AddMessage(SRECoordinator, "", "plan_revision", "用户修订了计划，待开始。", "")
		t.Messages[len(t.Messages)-1].Source = "user"
		return nil
	})
}

func sreVerificationSummary(v SREVerificationResult) string {
	if v.ID == "" {
		return "验证尚未形成有效结果。"
	}
	if len(v.Checks) == 0 && v.ReviewSummary != "" {
		return v.ReviewSummary
	}
	parts := []string{}
	for _, c := range v.Checks {
		label := map[string]string{"passed": "通过", "failed": "未通过", "inconclusive": "无法确认"}[c.Status]
		parts = append(parts, c.CheckID+"："+label+"，"+c.Reason)
	}
	return strings.Join(parts, "\n")
}
