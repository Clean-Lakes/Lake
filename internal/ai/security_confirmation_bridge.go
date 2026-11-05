package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

const securityPlanConfirmLabel = "确认计划并继续"
const securityWorkConfirmLabel = "确认步骤，完成后由我逐项验收"
const securityWorkRejectLabel = "暂不确认，需要调整"

type securityWorkConfirmationProposal struct {
	GoalID, PlanDigest                  string
	ExpectedRevision, SelectionRevision int64
	TaskDeadline                        time.Time
	Steps                               map[string]WorkStepContract
}

func securityWorkPlanDigest(goal WorkGoal) string {
	type item struct {
		ID, Title string
		DependsOn []string
	}
	items := make([]item, 0, len(goal.Items))
	for _, step := range goal.Items {
		items = append(items, item{step.ID, step.Title, append([]string(nil), step.DependsOn...)})
	}
	return hash(js([]any{goal.ID, goal.SessionID, goal.Title, goal.UserText, append([]WorkBinding(nil), goal.ResourceBindings...), goal.Binding, items}))
}

// Called only after work_begin has persisted a proposed plan. The existing
// question widget confirms requirements/manual acceptance, never permissions.
func (e *Engine) confirmSecurityWorkProposal(ctx context.Context, s *session, c Config, call Call, goal WorkGoal) (WorkGoal, error) {
	managed, err := e.SecurityProjectManaged(ctx, configSecurityProject(c))
	if err != nil {
		return goal, err
	}
	if !managed || goal.closure != nil {
		return goal, nil
	}
	if e.worker != nil || e.workParent != nil || ctx.Value(adkToolContextKey{}) == nil {
		return goal, errors.New("security: work confirmation requires the original live user turn")
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return goal, err
	}
	s.mu.Lock()
	sessionID, rootID, sourceID := s.state.View.Session, s.state.View.RootTurnID, s.state.SecuritySourceMessageID
	live := s.cancel != nil && s.state.Runtime != nil && s.state.WorkGoalID == goal.ID
	s.mu.Unlock()
	var original nativeWorkGoal
	if err = db.First(&original, "id = ? AND session_id = ?", goal.ID, sessionID).Error; err != nil {
		return goal, err
	}
	if !live || sourceID == "" || original.OriginMessageID != sourceID || goal.OriginRootTurnID != rootID || original.GoalRevision != 0 || goal.Revision != original.Revision {
		return goal, errors.New("security: original unconfirmed work proposal changed")
	}
	proposal := securityWorkConfirmationProposal{GoalID: goal.ID, PlanDigest: securityWorkPlanDigest(goal), ExpectedRevision: goal.Revision, TaskDeadline: goal.DeadlineAt, Steps: map[string]WorkStepContract{}}
	if proposal.TaskDeadline.IsZero() || !proposal.TaskDeadline.After(time.Now().UTC()) {
		return goal, errors.New("security: original task deadline expired")
	}
	var selection securityGoalSelectionRow
	if err = db.First(&selection, "session_id = ?", sessionID).Error; err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return goal, err
	}
	proposal.SelectionRevision = selection.Revision
	toolResults := c.superRole == "worker"
	confirmLabel := securityWorkConfirmLabel
	if toolResults {
		confirmLabel = securityPlanConfirmLabel
	}
	var description strings.Builder
	fmt.Fprintf(&description, "目标：%s\n原始要求可在下方展开查看。\n资源：%s\n", goal.Title, securityWorkResourceSummary(goal, c))
	if toolResults {
		description.WriteString("确认以下任务步骤及依赖。完成后根据实际工具回执自动核对结果。\n")
	} else {
		description.WriteString("确认以下任务步骤及依赖。每一步需要你在结果出现后另行确认，不能由模型总结替代验收。此确认不授予资源或命令权限。\n")
	}
	for i, item := range goal.Items {
		if strings.TrimSpace(item.Title) == "" || item.ID == "" {
			return goal, errors.New("security: complete work steps required")
		}
		fmt.Fprintf(&description, "%d. %s", i+1, item.Title)
		if len(item.DependsOn) > 0 {
			fmt.Fprintf(&description, "；依赖 %s", strings.Join(item.DependsOn, ", "))
		}
		description.WriteByte('\n')
		expected, _ := json.Marshal(item.Title)
		proposal.Steps[item.ID] = WorkStepContract{Required: true, VerificationMode: "manual", Criteria: []security.AcceptanceCriterion{{ID: "manual_" + hash(item.ID)[:16], Method: "human_verified", TargetKind: security.TargetSession, Target: sessionID, SourceDigest: hash("human-work-condition\x00" + proposal.PlanDigest + "\x00" + item.ID), Expected: expected}}}
		if toolResults {
			proposal.Steps[item.ID] = WorkStepContract{Required: true, VerificationMode: "tool_results", Criteria: []security.AcceptanceCriterion{{ID: "result_" + hash(item.ID)[:16], Method: "tool_result", TargetKind: security.TargetSession, Target: sessionID, SourceDigest: hash("work-result\x00" + proposal.PlanDigest + "\x00" + item.ID)}}}
		}
	}
	if toolResults && c.ConversationMode != ModePlan {
		return e.activateAutomaticSecurityWork(ctx, s, c, goal, proposal, sourceID, rootID)
	}
	if len([]rune(description.String())) > 1800 || len(description.String()) > 1900 {
		return goal, errors.New("security: proposed plan is too large for a complete confirmation; split it into a smaller reviewable plan")
	}
	expires := time.Now().UTC().Add(15 * time.Minute)
	if proposal.TaskDeadline.Before(expires) {
		expires = proposal.TaskDeadline
	}
	binding := &securityConfirmationQuestionContext{Source: &QuestionSource{MessageID: sourceID, Text: redact(goal.UserText, c)}, Row: securityConfirmationQuestionRow{Kind: "work_contract", StoreID: storeID, RecoveryEpoch: epoch, ProjectID: configSecurityProject(c), SessionID: sessionID, RootTurnID: rootID, SourceMessageID: sourceID, GoalID: goal.ID, CallID: call.ID, Data: js(proposal), ExpiresAt: expires}}
	questions := []UserQuestion{{ID: "work_contract", Title: "确认任务步骤与验收方式", Reason: redact(description.String(), c), Options: []QuestionOption{{Label: confirmLabel, Description: "只确认任务和验收要求；资源操作仍需当前策略或单独审批。"}, {Label: securityWorkRejectLabel, Description: "保留提案，不创建执行授权。"}}}}
	questionCall := call
	questionCall.Arguments = js(map[string]any{"questions": questions})
	if _, err = e.askQuestion(withSecurityConfirmationQuestion(ctx, binding), s, questionCall); err != nil {
		return goal, err
	}
	var row securityConfirmationQuestionRow
	if err = db.First(&row, "question_id = ?", binding.QuestionID).Error; err != nil {
		return goal, err
	}
	var answers map[string][]string
	if row.Status != "answered" || json.Unmarshal([]byte(row.Answers), &answers) != nil || len(answers["work_contract"]) != 1 || answers["work_contract"][0] != confirmLabel {
		_ = db.Model(&securityConfirmationQuestionRow{}).Where("question_id = ? AND status = ?", row.QuestionID, "answered").Update("status", "rejected").Error
		return goal, errors.New("security: task requirements remain unconfirmed; no execution task was activated")
	}
	if err = e.ConfigureWorkAcceptance(sessionID, goal.ID, row.ProjectID, "local-user", "work-question:"+row.QuestionID, proposal.ExpectedRevision, proposal.Steps); err != nil {
		return goal, err
	}
	return e.activateConfirmedSecurityWork(ctx, s, row, proposal)
}

func securityWorkResourceSummary(goal WorkGoal, c Config) string {
	bindings := append([]WorkBinding(nil), goal.ResourceBindings...)
	if len(bindings) == 0 {
		bindings = append(bindings, goal.Binding)
	}
	names := []string{}
	seen := map[string]bool{}
	for _, binding := range bindings {
		if binding.AssetRef == "" {
			continue
		}
		resource, err := asset(c, binding.AssetRef)
		if err != nil {
			continue
		}
		if seen[resource.ID] {
			continue
		}
		seen[resource.ID] = true
		name := resource.Name
		if resource.SSH != nil {
			name += fmt.Sprintf("（%s:%d）", resource.SSH.Host, resource.SSH.Port)
		}
		names = append(names, redact(name, c))
	}
	if len(names) == 0 {
		if c.superRole == "worker" && len(goal.ResourceBindings) == 0 && goal.Binding.AssetRef == "" {
			return "本任务未绑定主机或其他资产；MCP 和技能按项目权限使用"
		}
		return "执行前仍需核实具体目标"
	}
	return strings.Join(names, "、")
}

func (e *Engine) activateConfirmedSecurityWork(ctx context.Context, s *session, question securityConfirmationQuestionRow, proposal securityWorkConfirmationProposal) (goal WorkGoal, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return goal, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel == nil || s.state.Runtime == nil || s.state.View.RootTurnID != question.RootTurnID || s.state.SecuritySourceMessageID != question.SourceMessageID || s.state.WorkGoalID != question.GoalID {
		return goal, errors.New("security: original live root ended; a new real user turn is required")
	}
	var execution SecurityExecutionContext
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			if err := checkSuperContextTx(ctx, tx); err != nil {
				return err
			}
			var current securityConfirmationQuestionRow
			if err := tx.First(&current, "question_id = ? AND status = ? AND store_id = ? AND recovery_epoch = ?", question.QuestionID, "answered", storeID, epoch).Error; err != nil {
				return err
			}
			if current.Data != js(proposal) || current.Answers != question.Answers || !time.Now().UTC().Before(current.ExpiresAt) {
				return security.ErrConflict
			}
			var history workContractRevision
			if err := tx.First(&history, "session_id = ? AND action_id = ? AND actor = ?", question.SessionID, "work-question:"+question.QuestionID, "local-user").Error; err != nil {
				return err
			}
			var row nativeWorkGoal
			if err := tx.First(&row, "id = ? AND session_id = ?", question.GoalID, question.SessionID).Error; err != nil {
				return err
			}
			if err := decodeWorkGoal(row, &goal); err != nil {
				return err
			}
			if row.ClosureContract != history.Data || goal.closure == nil || securityWorkPlanDigest(goal) != proposal.PlanDigest || goal.Status != "running" {
				return security.ErrConflict
			}
			var selected securityGoalSelectionRow
			lookup := tx.First(&selected, "session_id = ?", question.SessionID).Error
			if lookup != nil && !errors.Is(lookup, gorm.ErrRecordNotFound) {
				return lookup
			}
			if selected.Revision != proposal.SelectionRevision || selected.GoalID != "" && selected.GoalID != question.GoalID || selected.SessionID != "" && (selected.StoreID != storeID || selected.RecoveryEpoch != epoch || selected.ProjectID != question.ProjectID) {
				return security.ErrConflict
			}
			var count int64
			if err := tx.Model(&securityTaskRow{}).Where("session_id = ? AND goal_id = ?", question.SessionID, question.GoalID).Count(&count).Error; err != nil {
				return err
			}
			if count != 0 {
				return errors.New("security: existing task requires its original lifecycle; confirmation cannot refresh its lifetime")
			}
			now := time.Now().UTC()
			task, err := beginSecurityTask(tx, storeID, epoch, SecurityTaskStart{Action: SecurityTaskAction{ActorID: "local-user", ActionID: "work-question-task:" + question.QuestionID, ProjectID: question.ProjectID, SessionID: question.SessionID, GoalID: question.GoalID}, SourceMessageID: question.SourceMessageID, ExpectedGoalRevision: row.GoalRevision, ExpiresAt: proposal.TaskDeadline}, now)
			if err != nil {
				return err
			}
			binding, err := bindSecurityTaskTurn(tx, task.ID, storeID, epoch, question.RootTurnID, "", task.ExecutionRevision, now)
			if err != nil {
				return err
			}
			owner, err := acquireExecutionOwner(tx, binding.ID, uid(), "agent", binding.OwnerGeneration, now)
			if err != nil {
				return err
			}
			newSelection := securityGoalSelectionRow{SessionID: question.SessionID, ProjectID: question.ProjectID, StoreID: storeID, RecoveryEpoch: epoch, GoalID: question.GoalID, SourceMessageID: question.SourceMessageID, GoalRevision: row.GoalRevision, Revision: selected.Revision + 1}
			if err = tx.Save(&newSelection).Error; err != nil {
				return err
			}
			if err = securityActionRecord(tx, storeID, epoch, "local-user", "work-question-select:"+question.QuestionID, "goal.select", question.GoalID, js(proposal), selected.Revision, newSelection.Revision, newSelection, now, question.ProjectID); err != nil {
				return err
			}
			changed := tx.Model(&securityConfirmationQuestionRow{}).Where("question_id = ? AND revision = ? AND status = ?", question.QuestionID, current.Revision, "answered").Updates(map[string]any{"status": "activated", "revision": current.Revision + 1})
			if changed.Error != nil {
				return changed.Error
			}
			if changed.RowsAffected != 1 {
				return security.ErrConflict
			}
			execution = SecurityExecutionContext{Managed: true, ProjectID: question.ProjectID, SessionID: question.SessionID, GoalID: question.GoalID, SourceMessageID: question.SourceMessageID, Task: task, Owner: owner}
			return nil
		})
	})
	if err != nil {
		return goal, err
	}
	s.state.SelectedGoalID, s.state.WorkGoalID, s.state.SecurityTaskID = question.GoalID, question.GoalID, execution.Task.ID
	s.state.Config.securityExecution = &execution
	s.state.PendingGoalIntent = nil
	e.securityOwners.Store(execution.Owner.BindingID, &liveSecurityOwner{owner: execution.Owner})
	if err = e.save(s); err != nil {
		return goal, err
	}
	e.startSecurityLifecycle()
	return goal, nil
}
