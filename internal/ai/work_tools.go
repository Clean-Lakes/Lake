package ai

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

func workTools() []Tool {
	text := stringSchema
	item := objectSchema(map[string]any{"id": text(), "title": text(), "dependsOn": arraySchema(text())}, "title")
	return []Tool{
		{"work_begin", "Start a durable goal for the current user's requested work. Pass asset_refs from list_assets for the actual requested resources; never inherit an unrelated session terminal. Record dependencies. Goal progress never grants operation permission. Use before multi-step or asynchronous work; do not use for casual explanation.", objectSchema(map[string]any{"title": text(), "items": arraySchema(item), "asset_refs": arraySchema(text())}, "title", "items")},
		{"work_read", "Read the current durable goal, original operation handles and outstanding work. Do not repeat dispatched operations.", objectSchema(map[string]any{"goal_id": text(), "item_id": text(), "evidence_id": text()})},
		{"work_update", "After plan confirmation, first set the actual item_id to running and wait for its result before resource I/O; this binds the step and attempt. After successful observations, submit completed with the actual evidence call IDs to request host verification; the host may ask independent human acceptance before recording completion. waiting_user only records a missing prerequisite and does not create an acceptance question. Never mark a running external job complete.", objectSchema(map[string]any{"item_id": text(), "status": map[string]any{"type": "string", "enum": []string{"running", "waiting_user", "blocked", "completed", "failed"}}, "reason": text(), "evidence_ids": arraySchema(text())}, "item_id", "status")},
		{"work_wait", "Park this invocation until the registered external jobs change to a terminal result, without model polling. Call alone in its tool batch. The host resumes the same goal; do not ask the user to say continue.", objectSchema(map[string]any{})},
		{"work_finish", "Finish only after every goal item is actually complete. Otherwise record a human prerequisite or blocker and leave the goal open. summary is the actual answer grounded in recorded evidence.", objectSchema(map[string]any{"summary": text()}, "summary")},
	}
}
func (e *Engine) invokeWorkTool(ctx context.Context, s *session, c Config, call Call, a map[string]any) (any, error) {
	if e.worker != nil || c.sreCoordinator || c.sre != nil || c.workflowMode || c.ConversationMode == ModePlan && c.superRole != "worker" || c.Profile != "core" && c.Profile != "" {
		return nil, errors.New("work goals require an ordinary core conversation")
	}
	if call.Name == "work_begin" {
		var items []WorkItem
		if err := json.Unmarshal([]byte(js(a["items"])), &items); err != nil {
			return nil, err
		}
		var refs []string
		if err := json.Unmarshal([]byte(js(a["asset_refs"])), &refs); a["asset_refs"] != nil && err != nil {
			return nil, err
		}
		goal, err := e.beginWork(s, str(a["title"]), items, refs...)
		if err != nil {
			return nil, err
		}
		return e.confirmSecurityWorkProposal(ctx, s, c, call, goal)
	}
	s.mu.Lock()
	id, goalID := s.state.View.Session, s.state.WorkGoalID
	s.mu.Unlock()
	if call.Name == "work_read" && str(a["goal_id"]) != "" {
		goalID = str(a["goal_id"])
	}
	if goalID == "" {
		if call.Name == "work_read" {
			return e.WorkGoals(id)
		}
		return nil, errors.New("当前没有工作目标，请先 work_begin")
	}
	if IsRecoveryWorkGoalID(goalID) {
		if call.Name != "work_read" {
			return nil, errors.New("恢复档案只读，继续原目标需要新执行上下文")
		}
		return e.ReadOnlyRecoveryWorkGoal(ctx, id, goalID)
	}
	if isSuperArchiveGoal(goalID) && call.Name != "work_read" {
		return nil, errors.New("superagent: imported SRE archive is read-only")
	}
	row, g, err := e.workRow(id, goalID)
	if err != nil {
		return nil, err
	}
	row.superFence = c.superAssignment
	s.mu.Lock()
	managedGoal := s.state.SecurityManaged
	s.mu.Unlock()
	if managedGoal && g.closure == nil && call.Name != "work_read" {
		return nil, errors.New("确认当前任务步骤和验收条件后才能推进或完成目标")
	}
	if call.Name == "work_read" {
		if ref := str(a["evidence_id"]); ref != "" {
			store, storeErr := e.adkStore()
			if storeErr != nil {
				return nil, storeErr
			}
			var proof nativeWorkObservation
			proofErr := store.DB.First(&proof, "id = ? AND goal_id = ? AND session_id = ?", ref, g.ID, id).Error
			if proofErr != nil {
				return nil, proofErr
			}
			return map[string]any{"evidence_id": proof.ID, "status": proof.Status, "result": objJSON(proof.Data)}, nil
		}
		if itemID := str(a["item_id"]); itemID != "" {
			for _, item := range g.Items {
				if item.ID == itemID {
					return item, nil
				}
			}
			return nil, errors.New("工作项不存在")
		}
		return g, nil
	}
	if workTerminal(g.Status) || g.Status == "paused" {
		return nil, errors.New("任务已结束或暂停")
	}
	if g.closure != nil && call.Name == "work_update" && (str(a["status"]) == "completed" || str(a["status"]) == "failed") {
		stepID := str(a["item_id"])
		if str(a["status"]) == "completed" && g.closure.Steps[stepID].VerificationMode == "manual" {
			if accepted, checkErr := e.currentManualWorkStepAccepted(g, stepID); checkErr != nil {
				return nil, checkErr
			} else if accepted {
				return g, nil
			}
		}
		if _, err = e.verifyWorkStep(ctx, id, g.ID, str(a["item_id"]), g.Revision); err != nil {
			return nil, err
		}
		_, verified, readErr := e.workRow(id, g.ID)
		if readErr == nil && str(a["status"]) == "completed" && verified.closure.Steps[stepID].VerificationMode == "manual" {
			if _, verifyErr := e.askManualSecurityWorkVerification(ctx, s, c, call, verified, stepID); verifyErr != nil {
				return nil, verifyErr
			}
			_, verified, readErr = e.workRow(id, g.ID)
		}
		return verified, readErr
	}
	if g.closure != nil && call.Name == "work_update" && str(a["status"]) == "running" {
		execution, execErr := e.CurrentSecurityExecution(ctx, id)
		if execErr != nil {
			return nil, execErr
		}
		if !execution.Managed || execution.GoalID != g.ID {
			return nil, errors.New("当前执行上下文未绑定原目标")
		}
		stepID := str(a["item_id"])
		current := g.closure.ActiveAttempts[stepID]
		if current != "" {
			store, storeErr := e.adkStore()
			if storeErr != nil {
				return nil, storeErr
			}
			var attempt workExecutionAttempt
			if err = store.DB.First(&attempt, "id = ? AND goal_id = ? AND step_id = ?", current, g.ID, stepID).Error; err != nil {
				return nil, err
			}
			if (attempt.State == "prepared" || attempt.State == "running") && attempt.RootTurnID == execution.Owner.RootTurnID {
				return g, nil
			}
		}
		if _, err = e.beginWorkAttempt(ctx, id, g.ID, stepID, execution.Task.ID, execution.Owner.RootTurnID, current, str(a["reason"]), g.Revision); err != nil {
			return nil, err
		}
		_, updated, loadErr := e.workRow(id, g.ID)
		return updated, loadErr
	}
	if call.Name == "work_wait" || call.Name == "work_finish" {
		s.mu.Lock()
		mixedBatch := false
		for i := len(s.state.History) - 1; i >= 0; i-- {
			message := s.state.History[i]
			if message.Role == "assistant" && len(message.Calls) > 0 {
				mixedBatch = len(message.Calls) != 1 || message.Calls[0].ID != call.ID
				break
			}
		}
		s.mu.Unlock()
		if mixedBatch {
			return nil, errors.New("等待或结束必须单独调用；本批次未建立等待或完成记录")
		}
	}
	switch call.Name {
	case "work_update":
		found := false
		for i := range g.Items {
			item := &g.Items[i]
			if item.ID != str(a["item_id"]) {
				continue
			}
			found = true
			status := str(a["status"])
			switch status {
			case "running", "waiting_user", "blocked", "completed", "failed":
			default:
				return nil, errors.New("invalid item status")
			}
			if item.Watch != nil && item.Watch.State == "running" && status != "waiting_user" && status != "blocked" {
				return nil, errors.New("原外部任务仍运行，不能覆盖其状态")
			}
			if status == "running" || status == "completed" {
				for _, dep := range item.DependsOn {
					for _, other := range g.Items {
						if other.ID == dep && other.Status != "completed" {
							return nil, errors.New("前置工作尚未完成")
						}
					}
				}
			}
			var evidence []string
			_ = json.Unmarshal([]byte(js(a["evidence_ids"])), &evidence)
			if status == "completed" || status == "failed" {
				if len(evidence) == 0 && item.Watch == nil {
					return nil, errors.New("完成或失败必须引用原始工具调用证据")
				}
				for _, ref := range evidence {
					if !e.workEvidence(s, ref, status) {
						return nil, errors.New("证据不存在或不能证明所报状态")
					}
				}
				if item.Watch != nil && item.Watch.State != status {
					return nil, errors.New("外部观察尚未确认该结果")
				}
			}
			if status == "running" {
				g.ActiveItemID = item.ID
			} else if g.ActiveItemID == item.ID {
				g.ActiveItemID = ""
			}
			item.Status = status
			item.Reason = redact(utf8Prefix(str(a["reason"]), 2000), c)
			item.EvidenceIDs = evidence
		}
		if !found {
			return nil, errors.New("工作项不存在")
		}
		g.Status = reduceWorkGoal(g.Items)
		if g.Status == "completed" || g.Status == "failed" {
			g.Status = "running"
		}
	case "work_wait":
		external := false
		for _, i := range g.Items {
			if i.Watch != nil && i.Status == "waiting_external" {
				external = true
			}
		}
		if !external {
			return nil, errors.New("没有可安全观察的外部任务；请完成剩余工作或记录具体阻塞")
		}
		g.Status = "waiting_external"
		row.WaitCallID = call.ID
		row.WaitState = "waiting"
	case "work_finish":
		if g.closure != nil {
			if _, err = e.verifyWorkGoal(ctx, id, g.ID, g.Revision); err != nil {
				return nil, err
			}
			row, g, err = e.workRow(id, g.ID)
			if err != nil {
				return nil, err
			}
			row.superFence = c.superAssignment
			if g.Status != "completed" {
				return g, nil
			}
			g.Summary = redact(utf8Prefix(str(a["summary"]), 8000), c)
			g.BackgroundSummary = e.workParent != nil
			return g, e.writeWorkGoal(&row, &g, false)
		}
		if len(g.Items) == 0 || (reduceWorkGoal(g.Items) != "completed" && reduceWorkGoal(g.Items) != "failed") {
			return nil, errors.New("仍有未完成、等待用户或未知的工作，不能结束目标")
		}
		g.Status = reduceWorkGoal(g.Items)
		g.Summary = redact(utf8Prefix(str(a["summary"]), 8000), c)
		g.BackgroundSummary = e.workParent != nil
	default:
		return nil, errors.New("unknown work tool")
	}
	if err = e.writeWorkGoal(&row, &g, false); err != nil {
		return nil, err
	}
	if call.Name == "work_wait" {
		if err = e.runWorkInput(ctx, g.ID, call.ID, nil); err != nil {
			return nil, err
		}
	}
	return g, nil
}
func (e *Engine) workEvidence(s *session, id, status string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range s.state.History {
		if m.Role == "tool" && m.CallID == id {
			data := objJSON(m.Content)
			if data["outcome"] == "not_executed" {
				return false
			}
			if data["error"] != nil {
				return status == "failed"
			}
			if data["status"] == "running" || data["running"] == true || data["status"] == "building" || data["status"] == "deploying" {
				return false
			}
			if data["exitCode"] != nil && num(data["exitCode"], 0) != 0 {
				return status == "failed"
			}
			return status == "completed"
		}
	}
	return false
}
func objJSON(raw string) map[string]any {
	var result map[string]any
	_ = json.Unmarshal([]byte(raw), &result)
	return result
}

func (e *Engine) registerWorkWatch(s *session, c Config, call Call, value any) error {
	if e.worker != nil || c.sreCoordinator || c.sre != nil || c.workflowMode || c.ConversationMode == ModePlan || c.Profile != "core" && c.Profile != "" {
		return nil
	}
	a, err := args(call)
	if err != nil {
		return nil
	}
	watch := ExternalWatch{State: "running", NextCheckAt: time.Now().Add(5 * time.Second)}
	blockedReason := ""
	switch call.Name {
	case "shell", "terminal_execute_command":
		data := obj(value)
		if data["status"] != "running" {
			return nil
		}
		watch.Adapter = "shell-v1"
		watch.Handle = str(data["shell_id"])
		if watch.Handle == "" {
			return nil
		}
	case "call_mcp_tool":
		name := str(a["tool"])
		if name != "build_release_order" && name != "execute_release_order" {
			return nil
		}
		data := obj(obj(value)["structuredContent"])
		state := str(data["status"])
		if state != "building" && state != "deploying" && state != "queued" && state != "running" {
			return nil
		}
		order := str(obj(a["arguments"])["order_id"])
		if order == "" || str(data["id"]) != order {
			return nil
		}
		watch.Adapter = "release-v1"
		watch.ServerID = str(a["server_id"])
		watch.Handle = order
		// The host returns an identity only for its trusted release read adapter.
		capability, capErr := e.bridgeCall(context.Background(), s.state.View.Session, "work_release_capability", map[string]any{"server_id": watch.ServerID}, false)
		if capErr != nil {
			blockedReason = "原任务已启动，但此服务未配置可信的只读观察适配器；请核对原记录"
		}
		watch.Revision = str(obj(capability)["configurationRevision"])
		if watch.Revision == "" {
			blockedReason = "原任务已启动，但此服务未配置可信的只读观察适配器；请核对原记录"
		}
	default:
		return nil
	}
	s.mu.Lock()
	id, goalID := s.state.View.Session, s.state.WorkGoalID
	s.mu.Unlock()
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	var operation nativeOperation
	query := store.DB.Where("session_id = ? AND call_id = ?", id, call.ID)
	managed := c.securityExecution != nil && c.securityExecution.Managed
	if managed {
		x := c.securityExecution
		query = query.Where("security_task_id = ? AND goal_id = ? AND root_turn_id = ? AND step_id = ? AND attempt_id = ? AND goal_revision = ? AND plan_revision = ? AND step_revision = ?", x.Task.ID, x.GoalID, x.Owner.RootTurnID, x.StepID, x.AttemptID, x.GoalRevision, x.PlanRevision, x.StepRevision)
		goalID = x.GoalID
	}
	if err = query.Order("started_at DESC").First(&operation).Error; err != nil {
		return err
	}
	if managed {
		x := c.securityExecution
		scope, valid := operationOwnerScope(operation)
		if !valid || scope != x.Owner.ScopeID || operation.OwnerID != x.Owner.OwnerID || operation.OwnerGeneration != x.Owner.Generation || operation.StoreID != x.Task.StoreID || operation.RecoveryEpoch != x.Task.RecoveryEpoch {
			return errExecutionOwner
		}
		if watch.Adapter != "shell-v1" {
			return errors.New("security: trusted owned background observer required")
		}
		job := e.managedShellByOperation(operation.ID)
		if job == nil {
			return errors.New("security: exact original process handle missing")
		}
		job.mu.Lock()
		matches := job.managed && job.id == watch.Handle && job.taskID == x.Task.ID && job.goalID == x.GoalID && job.operationID == operation.ID && job.descriptorDigest == operation.DescriptorDigest
		job.mu.Unlock()
		if !matches {
			return errors.New("security: background handle binding mismatch")
		}
	}
	watch.OperationID = operation.ID
	if goalID == "" {
		g, beginErr := e.beginWork(s, "持续跟进已启动的工作", nil)
		if beginErr != nil {
			return beginErr
		}
		goalID = g.ID
	}
	row, g, err := e.workRow(id, goalID)
	if err != nil {
		return err
	}
	if managed && (g.closure == nil || g.closure.GoalRevision != operation.GoalRevision || g.closure.PlanRevision != operation.PlanRevision || g.closure.ActiveAttempts[operation.StepID] != operation.AttemptID) {
		return errWorkConflict
	}
	for _, item := range g.Items {
		if item.Watch != nil && item.Watch.OperationID == watch.OperationID {
			return nil
		}
	}
	if len(g.Items) >= 32 {
		return errors.New("工作目标的异步任务数量已达上限")
	}
	title := "等待已启动任务"
	if watch.Adapter == "release-v1" {
		title = "跟进发布平台任务"
	}
	assigned := false
	for i := range g.Items {
		if managed && g.Items[i].ID != operation.StepID {
			continue
		}
		if g.Items[i].Watch == nil && g.Items[i].Status == "running" {
			g.Items[i].Watch = &watch
			if g.ActiveItemID == g.Items[i].ID {
				g.ActiveItemID = ""
			}
			g.Items[i].Status = "waiting_external"
			assigned = true
			break
		}
	}
	if !assigned {
		if managed {
			return errors.New("security: original contracted background step unavailable")
		}
		g.Items = append(g.Items, WorkItem{ID: uid(), Title: title, Status: "waiting_external", Watch: &watch})
	}
	if blockedReason != "" {
		for i := range g.Items {
			if g.Items[i].Watch == &watch {
				g.Items[i].Status = "blocked"
				g.Items[i].Reason = blockedReason
			}
		}
	}
	g.Status = reduceWorkGoal(g.Items)
	row.superFence = c.superAssignment
	return e.writeWorkGoal(&row, &g, false)
}

const workContinuityPrompt = `
Long work: use work_begin before a multi-step or asynchronous deliverable. Explicitly pass the current request's resource aliases in work_begin.asset_refs (all resources for multi-resource work); a previously selected shell/terminal is not the new task target. Record independent items and real dependencies; update progress using original tool call evidence. After launching a background job or release pipeline, keep following its original handle to the requested result. A submitted build is not a completed deliverable. Use work_wait alone to persist a wait and release this conversation; the host resumes it when real results arrive, without model polling. Continue independent items while a dependency needs the user's answer. Respect exclusions such as 'do not handle the database'; never deploy dependent work before the actual prerequisite is confirmed. work_finish requires actual completed items. Summaries, target labels, old decisions and machine wakeups do not grant operation permission. Do not repeat already dispatched changes. An explanatory answer need not create a goal.
`

func workToolName(name string) bool { return strings.HasPrefix(name, "work_") }
