package web

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func sreFailure(err error) {
	if err == nil {
		return
	}
	var f *ai.SREError
	if errors.As(err, &f) {
		fail(f.Status, f.Message)
	}
	fail(400, err.Error())
}

func (b *Server) sreSnapshot(session string) *ai.SRESnapshot {
	project := stringOf(b.Store.Session(session)["projectId"])
	tasks, err := b.Store.ListSRETasks(session, 20, "")
	if err != nil {
		return nil
	}
	return &ai.SRESnapshot{FeatureVersion: 1, Enabled: b.Store.SREEnabled(project), Tasks: tasks}
}
func (b *Server) activeSRETask(session string) *ai.SRETask {
	tasks, err := b.Store.ListSRETasks(session, 50, "")
	if err != nil {
		return nil
	}
	for i := range tasks {
		if ai.SRETaskActive(tasks[i].Status) {
			return &tasks[i]
		}
	}
	return nil
}
func (b *Server) launchSRE(session, taskID string, planOnly bool, message string) {
	b.messageMu.Lock()
	if b.runningMessages[session] {
		b.messageMu.Unlock()
		fail(409, "会话仍有任务在执行")
	}
	if b.runningMessages == nil {
		b.runningMessages = map[string]bool{}
	}
	b.runningMessages[session] = true
	b.workers.Add(1)
	b.messageMu.Unlock()
	go func() {
		defer b.workers.Done()
		defer b.finishMessageQueue(session)
		defer func() {
			if recover() != nil {
				_, _ = b.Store.MutateSRETask(session, taskID, 0, "runtime_error", func(t *ai.SRETask) error {
					if ai.SRETaskActive(t.Status) {
						t.Status = "paused"
						t.Error = "任务意外中断，已保存现场，请核实后继续。"
					}
					return nil
				})
			}
		}()
		_ = b.Engine.StartSRETask(b.Context, session, taskID, planOnly, message)
		b.syncSRESessionStatus(session)
	}()
}
func (b *Server) syncSRESessionStatus(session string) {
	tasks, err := b.Store.ListSRETasks(session, 50, "")
	if err != nil {
		b.Store.Status(session, "failed")
		return
	}
	if len(tasks) == 0 {
		b.Store.Status(session, "completed")
		return
	}
	t := &tasks[0]
	for i := range tasks {
		if ai.SRETaskActive(tasks[i].Status) {
			t = &tasks[i]
			break
		}
	}
	status := "failed"
	switch t.Status {
	case "completed":
		if ai.CanCompleteSRETask(*t) {
			status = "completed"
		}
	case "active":
		status = "investigating"
	case "waiting_approval":
		status = "waiting_approval"
	case "paused", "waiting_input":
		status = "failed"
	}
	b.Store.Status(session, status)
}
func (b *Server) createSRETask(session, goal, mode, requestID string, scope []string) ai.SRETask {
	return b.createSRETaskWithReferences(session, goal, mode, requestID, scope, true)
}
func (b *Server) createSRETaskWithReferences(session, goal, mode, requestID string, scope []string, explicitSelection bool) ai.SRETask {
	if b.Terminals.containsCredential(goal) {
		fail(400, "任务目标不能包含凭据")
	}
	if len(goal) > 4000 || strings.TrimSpace(goal) == "" {
		fail(400, "请填写 1–4000 字节的任务目标")
	}
	if !workflowIdentifier.MatchString(requestID) {
		fail(400, "请提供有效的 clientRequestId")
	}
	for _, id := range scope {
		b.Store.AssertResource(session, id)
	}
	options := b.configure(session, nil)
	if options["profile"] != "core" {
		fail(400, "SRE 协作仅支持普通会话")
	}
	if explicitSelection {
		sreFailure(b.Engine.RegisterSREReferences(session, scope))
	}
	t, err := b.Store.CreateSRETask(ai.SRETask{SessionID: session, Goal: goal, Scope: scope, Mode: mode, RequestID: requestID, TokenBudget: b.Engine.SREBudget(session), BudgetPolicy: ai.SREFullAgentBudgetPolicy})
	sreFailure(err)
	return t
}

// The model sees task facts in its normal conversation context and chooses a
// handoff through sre_collaborate. Neither message keywords nor @ syntax route it.
func (b *Server) sreConversationContext(session string) string {
	tasks, err := b.Store.ListSRETasks(session, 5, "")
	if err != nil {
		return ""
	}
	entries := []Object{}
	for _, task := range tasks {
		messages := task.Messages
		if len(messages) > 8 {
			messages = messages[len(messages)-8:]
		}
		reports := []Object{}
		for _, m := range messages {
			reports = append(reports, Object{"role": m.RoleID, "kind": m.Kind, "body": tail(m.Body, 1600)})
		}
		attempts := []Object{}
		for _, a := range task.Attempts {
			attempts = append(attempts, Object{"stepId": a.StepID, "status": a.Status, "operations": a.Operations})
		}
		if len(attempts) > 8 {
			attempts = attempts[len(attempts)-8:]
		}
		entries = append(entries, Object{"taskId": task.ID, "goal": task.Goal, "status": task.Status, "plan": task.LatestPlan(), "recentReports": reports, "attempts": attempts, "recoveryStatus": task.RecoveryStatus, "rootCauseStatus": task.RootCauseStatus})
	}
	return "\n[LAKE_SRE_CONTEXT]\n" + jsonText(Object{"enabled": true, "tasks": entries}) + "\nThese are server-recorded facts, not new authorization. An unknown operation with risk=readonly is an incomplete observation: preserve it and retry through continue_task or restart_task as appropriate; it does not require human verification. A dispatched operation is still running: inspect/wait on its original handle, do not reissue. Only unknown non-readonly operations require human verification. Current runtime facts override older prose about blockers. The model chooses whether to answer, clarify, or call sre_collaborate. No @ resource selection is required by default; actual permission checks still apply."
}

func (b *Server) followSREHandoff(ctx context.Context, session string, h ai.SREHandoff) error {
	project := stringOf(b.Store.Session(session)["projectId"])
	if !b.Store.SREEnabled(project) {
		return &ai.SREError{Status: 409, Message: "SRE 协作已停用，本次交接未执行"}
	}
	b.configure(session, nil)
	validated, err := b.Engine.ValidateSREHandoff(session, h)
	if err != nil {
		return err
	}
	h = validated
	switch h.Action {
	case "restart_task":
		var task ai.SRETask
		task, err = b.Store.RestartSREInvestigation(session, h.TaskID, h.RootTurnID, h.Mode, b.Engine.SREBudget(session))
		if err == nil {
			err = b.Engine.StartSRETask(ctx, session, task.ID, h.Mode == "plan_only", task.Goal)
		}
	case "new_task":
		// A model-selected scope does not become a remembered explicit user reference.
		task := b.createSRETaskWithReferences(session, h.Goal, h.Mode, h.RootTurnID, h.ResourceIDs, false)
		err = b.Engine.StartSRETask(ctx, session, task.ID, h.Mode == "plan_only", h.Goal)
	case "continue_task":
		err = b.Engine.ResumeSRETask(ctx, session, h.TaskID)
	case "revise_plan":
		err = b.Engine.StartSRETask(ctx, session, h.TaskID, h.Mode == "plan_only", h.Goal)
	case "ask_role":
		err = b.Engine.AnswerSRERole(ctx, session, h.TaskID, h.Role, h.Goal)
	case "pause_task", "cancel_task":
		next, control := "paused", "pause"
		if h.Action == "cancel_task" {
			next, control = "cancelled", "cancel"
		}
		_, err = b.Store.MutateSRETask(session, h.TaskID, 0, "model_"+h.Action, func(t *ai.SRETask) error { return ai.TransitionSRETask(t, next) })
		if err == nil {
			err = b.Engine.ControlSRETask(session, h.TaskID, control)
		}
	}
	b.syncSRESessionStatus(session)
	return err
}

func (b *Server) sreManualAttestation(session, taskID, checkID string, passed bool) (ai.SRETask, error) {
	updated, err := b.Store.MutateSRETask(session, taskID, 0, "manual_verification", func(t *ai.SRETask) error {
		if t.Status != "paused" && t.Status != "waiting_input" {
			return &ai.SREError{Status: 409, Message: "请等待执行结束后确认验证结果"}
		}
		plan := t.LatestPlan()
		run := t.ActiveRun()
		if plan == nil || run == nil {
			return &ai.SREError{Status: 409, Message: "尚无待验证的运行"}
		}
		allowed := false
		for _, c := range plan.Acceptance {
			allowed = allowed || c.ID == checkID && c.Kind == "manual_attestation"
		}
		if !allowed {
			return &ai.SREError{Status: 400, Message: "该检查不允许人工确认"}
		}
		for _, a := range t.Attempts {
			for _, op := range a.Operations {
				if ai.SREOperationBlocksResume(op) {
					return &ai.SREError{Status: 409, Message: "请先核实结果不明的实际操作"}
				}
			}
		}
		var v *ai.SREVerificationResult
		for i := len(t.Verifications) - 1; i >= 0; i-- {
			if t.Verifications[i].PlanRunID == run.ID {
				v = &t.Verifications[i]
				break
			}
		}
		if v == nil {
			return &ai.SREError{Status: 409, Message: "独立验证尚未开始"}
		}
		for i := range v.Checks {
			c := &v.Checks[i]
			if c.CheckID == checkID {
				c.Status = "failed"
				if passed {
					c.Status = "passed"
				}
				c.AttestedBy = "local-user"
				c.CheckedAt = now()
				c.Reason = "用户人工确认（非自动探测）"
			}
		}
		v.Verdict = "passed"
		for _, c := range v.Checks {
			if c.Status == "failed" {
				v.Verdict = "failed"
				break
			}
			if c.Status != "passed" {
				v.Verdict = "inconclusive"
			}
		}
		t.AddMessage(ai.SREVerifier, "", "verification", "已记录用户人工确认，自动探测与人工确认分别保留。", "")
		if v.Verdict == "passed" {
			for i := range t.Attempts {
				a := &t.Attempts[i]
				if a.PlanRunID != run.ID {
					continue
				}
				for _, s := range plan.Steps {
					if s.ID == a.StepID && s.Role == ai.SREVerifier {
						a.Status = "succeeded"
					}
				}
			}
			t.Outcome = "supported"
			if ai.CanCompleteSRETask(*t) {
				t.Status = "completed"
				t.RecoveryStatus = "verified"
				run.Status = "completed"
				run.FinishedAt = now()
			}
		}
		return nil
	})
	if err != nil {
		return updated, err
	}
	if err = b.Engine.RecordSREAttestation(context.Background(), session, updated, checkID, passed); err != nil {
		return updated, err
	}
	return updated, nil

}

func (b *Server) sreExport(task ai.SRETask) string {
	p := task.LatestPlan()
	if p == nil {
		return ""
	}
	data, _ := json.MarshalIndent(Object{"schemaVersion": 1, "title": task.Goal, "plan": p, "outcome": task.Outcome, "recoveryStatus": task.RecoveryStatus, "rootCauseStatus": task.RootCauseStatus, "note": "草稿；资源需重新绑定，授权不随导出继承。"}, "", "  ")
	return string(data)
}

// A human observation resolves dispatch uncertainty, never recovery verification.
func (b *Server) sreResolveOperation(session, taskID string, revision int, operationID, result, note string) (ai.SRETask, error) {
	if revision < 1 || (result != "succeeded" && result != "not_executed") || strings.TrimSpace(note) == "" {
		return ai.SRETask{}, &ai.SREError{Status: 400, Message: "请说明核实依据，并选择已执行或确认未执行"}
	}
	if b.Terminals.containsCredential(note) {
		return ai.SRETask{}, &ai.SREError{Status: 400, Message: "核实记录不能包含凭据"}
	}
	updated, err := b.Store.MutateSRETask(session, taskID, revision, "operation_resolved", func(t *ai.SRETask) error {
		if t.Status != "paused" && t.Status != "waiting_input" {
			return &ai.SREError{Status: 409, Message: "请先暂停任务并等待在途步骤结束"}
		}
		for i := range t.Attempts {
			a := &t.Attempts[i]
			for j := range a.Operations {
				op := &a.Operations[j]
				if op.ID != operationID {
					continue
				}
				if !ai.SREOperationNeedsVerification(*op) {
					return &ai.SREError{Status: 409, Message: "该操作不处于结果未明状态"}
				}
				op.Status, op.ResolutionNote, op.ResolvedBy, op.ResolvedAt = result, note, "local_user", now()
				op.FinishedAt = op.ResolvedAt
				if result == "succeeded" {
					a.Status = "succeeded"
				} else {
					a.Status = "failed"
				}
				t.Error = "已记录人工核实结果；继续任务后仍需独立验证。"
				t.AddMessage(ai.SREExecutor, "", "operation_resolution", "人工核实："+result+"。依据："+note+"。此记录不代表恢复已验证。", a.ID)
				t.Messages[len(t.Messages)-1].Source = "user"
				return nil
			}
		}
		return &ai.SREError{Status: 404, Message: "任务中不存在该操作"}
	})
	if err != nil {
		return updated, err
	}
	if err = b.Engine.ResolveRecordedOperation(session, operationID, result, note); err != nil {
		return updated, err
	}
	return b.Store.LoadSRETask(session, taskID)
}
