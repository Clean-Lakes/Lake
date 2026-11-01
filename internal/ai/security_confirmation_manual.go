package ai

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"gorm.io/gorm"
)

const securityManualAcceptLabel = "我已核实，全部条件均满足"
const securityManualRejectLabel = "尚未满足，保留未完成状态"

type securityManualWorkProposal struct {
	GoalID, StepID, AttemptID, CriteriaHash, PlanDigest, OperationsDigest, QuestionDigest string
	ExpectedRevision, GoalRevision, PlanRevision, StepRevision                            int64
	CriteriaIDs                                                                           []string
}

func manualQuestionOperationsDigestTx(tx *gorm.DB, attemptID string) (string, error) {
	var operations []nativeOperation
	if err := tx.Select("id", "session_id", "goal_id", "step_id", "attempt_id", "security_task_id", "root_turn_id", "goal_revision", "plan_revision", "step_revision", "status", "descriptor_digest", "owner_id", "owner_generation", "store_id", "recovery_epoch", "orphan_state", "closure_state", "risk_resolved_at").Where("attempt_id = ?", attemptID).Order("id").Find(&operations).Error; err != nil {
		return "", err
	}
	if len(operations) == 0 {
		return "", errors.New("original execution results required for human question")
	}
	for _, op := range operations {
		if op.Status != "succeeded" {
			return "", errors.New("only settled successful executions can be manually verified")
		}
	}
	return hash(js(operations)), nil
}

func manualQuestionProposalMatches(goal WorkGoal, stepID string, proposal securityManualWorkProposal) bool {
	if goal.closure == nil {
		return false
	}
	step, exists := goal.closure.Steps[stepID]
	return exists && step.VerificationMode == "manual" && proposal.GoalID == goal.ID && proposal.StepID == stepID && proposal.AttemptID == goal.closure.ActiveAttempts[stepID] && proposal.GoalRevision == goal.closure.GoalRevision && proposal.PlanRevision == goal.closure.PlanRevision && proposal.StepRevision == step.Revision && proposal.CriteriaHash == hash(js(step.Criteria)) && proposal.PlanDigest == securityWorkPlanDigest(goal)
}

func manualQuestionAnswerAccepted(row securityConfirmationQuestionRow, proposal securityManualWorkProposal) bool {
	var answers map[string][]string
	return row.Kind == "manual_work_verification" && row.QuestionDigest == proposal.QuestionDigest && json.Unmarshal([]byte(row.Answers), &answers) == nil && len(answers) == 1 && len(answers["manual_acceptance"]) == 1 && answers["manual_acceptance"][0] == securityManualAcceptLabel
}

func validateQuestionWorkAcceptanceTx(tx *gorm.DB, goal WorkGoal, stepID, questionID, originMessageID string, expected int64, criteriaIDs []string) error {
	var row securityConfirmationQuestionRow
	if err := tx.First(&row, "question_id = ? AND status = ? AND session_id = ? AND goal_id = ?", questionID, "answered", goal.SessionID, goal.ID).Error; err != nil {
		return err
	}
	var proposal securityManualWorkProposal
	if decodeSecurityJSON(row.Data, &proposal) != nil || !manualQuestionProposalMatches(goal, stepID, proposal) || !manualQuestionAnswerAccepted(row, proposal) || proposal.ExpectedRevision != expected || row.SourceMessageID != originMessageID || row.ProjectID != goal.closure.ProjectID || !time.Now().UTC().Before(row.ExpiresAt) || !slices.Equal(proposal.CriteriaIDs, criteriaIDs) {
		return errWorkConflict
	}
	var storeID, epoch string
	if err := tx.Raw("SELECT store_id,recovery_epoch FROM security_schema_meta WHERE id=1").Row().Scan(&storeID, &epoch); err != nil {
		return err
	}
	if row.StoreID != storeID || row.RecoveryEpoch != epoch {
		return errWorkConflict
	}
	digest, err := manualQuestionOperationsDigestTx(tx, proposal.AttemptID)
	if err != nil {
		return err
	}
	if digest != proposal.OperationsDigest {
		return errWorkConflict
	}
	return nil
}

func currentQuestionWorkAcceptanceTx(tx *gorm.DB, goal WorkGoal, stepID string, record workAcceptanceRecord) bool {
	if record.SourceInteractionID == "" || record.ActionID != "question:"+record.SourceInteractionID || record.Actor != "local-user" {
		return false
	}
	var row securityConfirmationQuestionRow
	if tx.First(&row, "question_id = ? AND status = ? AND session_id = ? AND goal_id = ?", record.SourceInteractionID, "manual_verified", goal.SessionID, goal.ID).Error != nil {
		return false
	}
	var proposal securityManualWorkProposal
	if decodeSecurityJSON(row.Data, &proposal) != nil || !manualQuestionProposalMatches(goal, stepID, proposal) || !manualQuestionAnswerAccepted(row, proposal) || record.SourceMessageID != row.SourceMessageID || record.ProgressRevision != proposal.ExpectedRevision || record.CriteriaHash != proposal.CriteriaHash || record.AttemptID != proposal.AttemptID {
		return false
	}
	digest, err := manualQuestionOperationsDigestTx(tx, proposal.AttemptID)
	return err == nil && digest == proposal.OperationsDigest
}

func (e *Engine) recordQuestionWorkAcceptance(sessionID, questionID string) (string, error) {
	store, err := e.adkStore()
	if err != nil {
		return "", err
	}
	var row securityConfirmationQuestionRow
	if err = store.DB.First(&row, "question_id = ? AND session_id = ?", questionID, sessionID).Error; err != nil {
		return "", err
	}
	var proposal securityManualWorkProposal
	if decodeSecurityJSON(row.Data, &proposal) != nil {
		return "", errWorkConflict
	}
	return e.recordHumanWorkAcceptance(sessionID, proposal.GoalID, proposal.StepID, "local-user", "question:"+questionID, row.SourceMessageID, "question", questionID, proposal.ExpectedRevision, proposal.CriteriaIDs, "用户在原生问答中核实全部条件；原始问题 "+questionID)
}

// Only the existing work_update completion path invokes this after automatic
// verification left a successful attempt's manual contract insufficient.
func (e *Engine) askManualSecurityWorkVerification(ctx context.Context, s *session, c Config, call Call, goal WorkGoal, stepID string) (string, error) {
	if goal.closure == nil {
		return "", errors.New("manual acceptance contract required")
	}
	step, exists := goal.closure.Steps[stepID]
	if !exists || step.VerificationMode != "manual" {
		return "", errors.New("manual verification is not configured")
	}
	if ctx.Value(adkToolContextKey{}) == nil || e.worker != nil || e.workParent != nil {
		return "", errors.New("original user question context required")
	}
	store, err := e.adkStore()
	if err != nil {
		return "", err
	}
	proposal := securityManualWorkProposal{GoalID: goal.ID, StepID: stepID, AttemptID: goal.closure.ActiveAttempts[stepID], CriteriaHash: hash(js(step.Criteria)), PlanDigest: securityWorkPlanDigest(goal), ExpectedRevision: goal.Revision, GoalRevision: goal.closure.GoalRevision, PlanRevision: goal.closure.PlanRevision, StepRevision: step.Revision}
	var attempt workExecutionAttempt
	if err = store.DB.First(&attempt, "id = ? AND session_id = ? AND goal_id = ? AND step_id = ? AND state = ?", proposal.AttemptID, goal.SessionID, goal.ID, stepID, "succeeded").Error; err != nil {
		return "", err
	}
	proposal.OperationsDigest, err = manualQuestionOperationsDigestTx(store.DB, proposal.AttemptID)
	if err != nil {
		return "", err
	}
	for _, criterion := range step.Criteria {
		proposal.CriteriaIDs = append(proposal.CriteriaIDs, criterion.ID)
	}
	slices.Sort(proposal.CriteriaIDs)
	title := ""
	for _, item := range goal.Items {
		if item.ID == stepID {
			title = item.Title
			break
		}
	}
	reason := "目标：" + goal.Title + "\n当前步骤：" + title + "\n原资源绑定：" + js([]any{goal.Binding, goal.ResourceBindings}) + "\n请结合已显示的原始执行结果逐项核实以下条件。只有你确认全部满足才会记录人工验收；此答复不授予任何操作权限，也不解除未知副作用。\n" + js(step.Criteria)
	if len(reason) > 1900 || redact(reason, c) != reason {
		return "", errors.New("manual conditions cannot be fully displayed safely; use the authenticated detailed verification action")
	}
	qs := []UserQuestion{{ID: "manual_acceptance", Title: "核实当前步骤的实际结果", Reason: reason, Options: []QuestionOption{{Label: securityManualAcceptLabel, Description: "提交独立人工验收记录，绑定当前步骤、尝试和全部条件。"}, {Label: securityManualRejectLabel, Description: "保留原执行记录和未完成条件，不修改资源权限。"}}}}
	proposal.QuestionDigest = hash(js(qs))
	s.mu.Lock()
	rootID, sourceID, live := s.state.View.RootTurnID, s.state.SecuritySourceMessageID, s.cancel != nil
	s.mu.Unlock()
	if !live || sourceID == "" {
		return "", errors.New("original live human interaction required")
	}
	binding := &securityConfirmationQuestionContext{Row: securityConfirmationQuestionRow{Kind: "manual_work_verification", ProjectID: goal.closure.ProjectID, SessionID: goal.SessionID, RootTurnID: rootID, SourceMessageID: sourceID, GoalID: goal.ID, CallID: call.ID, Data: js(proposal), ExpiresAt: time.Now().UTC().Add(15 * time.Minute)}}
	questionCall := call
	questionCall.Arguments = js(map[string]any{"questions": qs})
	if _, err = e.askQuestion(withSecurityConfirmationQuestion(ctx, binding), s, questionCall); err != nil {
		return "", err
	}
	return e.recordQuestionWorkAcceptance(goal.SessionID, binding.QuestionID)
}
