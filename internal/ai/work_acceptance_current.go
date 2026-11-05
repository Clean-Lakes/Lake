package ai

import (
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func currentWorkOperationResourcesTx(tx *gorm.DB, op nativeOperation) (bool, error) {
	var descriptor security.PreparedOperation
	if json.Unmarshal([]byte(op.SecurityDescriptor), &descriptor) != nil {
		return false, nil
	}
	digest, err := security.OperationDigest(descriptor)
	if err != nil || digest != op.DescriptorDigest || descriptor.ID != op.ID || descriptor.Tool != op.Tool || descriptor.CallID != op.CallID || descriptor.ProjectID != op.ProjectID || descriptor.SessionID != op.SessionID || descriptor.GoalID != op.GoalID || descriptor.TaskID != op.SecurityTaskID || descriptor.RootTurnID != op.RootTurnID || descriptor.StepID != op.StepID || descriptor.AttemptID != op.AttemptID || descriptor.GoalRevision != op.GoalRevision || descriptor.PlanRevision != op.PlanRevision || descriptor.StepRevision != op.StepRevision || descriptor.StoreID != op.StoreID || descriptor.RecoveryEpoch != op.RecoveryEpoch || descriptor.OwnerID != op.OwnerID || descriptor.OwnerGeneration != op.OwnerGeneration || descriptor.ArgumentsDigest != op.ArgsHash {
		return false, nil
	}
	if op.ResourceID != "" {
		found := false
		for _, resource := range descriptor.Resources {
			if resource.ID == op.ResourceID && resource.ConnectionRevision == op.ResourceConnectionRevision {
				found = true
			}
		}
		if !found {
			return false, nil
		}
	}
	for _, resource := range descriptor.Resources {
		var current securityResourceRevisionRow
		err = tx.First(&current, "project_id = ? AND resource_id = ?", descriptor.ProjectID, resource.ID).Error
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return false, nil
			}
			return false, err
		}
		if current.State != "ready" || current.ConnectionRevision != resource.ConnectionRevision || current.ConnectionDigest != resource.ConnectionDigest || current.StoreID != descriptor.StoreID || current.RecoveryEpoch != descriptor.RecoveryEpoch {
			return false, nil
		}
	}
	if op.Tool == "read_referenced_task_evidence" {
		return currentReferencedTaskReadTx(tx, op)
	}
	return true, nil
}

func (e *Engine) currentManualWorkStepAccepted(goal WorkGoal, stepID string) (accepted bool, err error) {
	store, err := e.adkStore()
	if err != nil {
		return false, err
	}
	err = e.workMutation(store.DB, func(tx *gorm.DB) error {
		_, current, err := loadWorkGoalTx(tx, goal.SessionID, goal.ID, goal.Revision)
		if err != nil {
			return err
		}
		if current.closure == nil || current.closure.Steps[stepID].VerificationMode != "manual" {
			return nil
		}
		unresolved, err := workUnresolvedTx(tx, goal.ID, stepID)
		if err != nil || unresolved {
			return err
		}
		steps, err := acceptedStepsTx(tx, current)
		if err != nil {
			return err
		}
		for _, step := range steps {
			if step.ID == stepID && step.State == security.AcceptancePass {
				accepted = true
			}
		}
		return nil
	})
	return accepted, err
}

// A historical pass is evidence to revalidate, never a permanent success bit.
// Goal aggregation checks the exact original observations and current freshness.
func currentWorkAcceptanceTx(tx *gorm.DB, goal WorkGoal, stepID string, record workAcceptanceRecord) (security.AcceptanceState, error) {
	if record.State != "pass" {
		return security.AcceptanceState(record.State), nil
	}
	step := goal.closure.Steps[stepID]
	binding := closureBinding(goal, stepID)
	var attempt workExecutionAttempt
	if err := tx.First(&attempt, "id = ? AND session_id = ? AND goal_id = ? AND step_id = ?", record.AttemptID, goal.SessionID, goal.ID, stepID).Error; err != nil {
		return security.AcceptanceInsufficient, err
	}
	if attempt.GoalRevision != binding.GoalRevision || attempt.PlanRevision != binding.PlanRevision || attempt.StepRevision != binding.StepRevision || attempt.State != "succeeded" {
		return security.AcceptanceInsufficient, nil
	}
	now := time.Now().UTC()
	if record.At.IsZero() || record.At.After(now) {
		return security.AcceptanceInsufficient, nil
	}
	manual := step.VerificationMode == "manual"
	if manual {
		if record.VerifierVersion != "human/1" || record.Actor == "" || record.ActionID == "" || record.SourceMessageID == "" {
			return security.AcceptanceInsufficient, nil
		}
		if record.SourceKind == "question" {
			if !currentQuestionWorkAcceptanceTx(tx, goal, stepID, record) {
				return security.AcceptanceInsufficient, nil
			}
		} else if record.SourceKind != "" && record.SourceKind != "user_action" {
			return security.AcceptanceInsufficient, nil
		}
		for _, criterion := range step.Criteria {
			if criterion.MaxAgeSeconds > 0 && now.Sub(record.At) > time.Duration(criterion.MaxAgeSeconds)*time.Second {
				return security.AcceptanceInsufficient, nil
			}
		}
	} else if record.VerifierVersion != security.VerifierVersion {
		return security.AcceptanceInsufficient, nil
	}
	var refs []string
	if !manual && json.Unmarshal([]byte(record.EvidenceIDs), &refs) != nil {
		return security.AcceptanceInsufficient, nil
	}
	allowed := map[string]bool{}
	for _, id := range refs {
		allowed[id] = true
	}
	var operations []nativeOperation
	if err := tx.Where("attempt_id = ?", attempt.ID).Find(&operations).Error; err != nil {
		return security.AcceptanceInsufficient, err
	}
	if len(operations) == 0 {
		return security.AcceptanceInsufficient, nil
	}
	if step.VerificationMode == "tool_results" {
		state, _, err := verifyWorkToolResultsTx(tx, goal, stepID, attempt, operations, allowed)
		return state, err
	}
	var evidence []security.Evidence
	for _, op := range operations {
		if op.Status != "succeeded" || op.GoalID != goal.ID || op.SessionID != goal.SessionID || op.StepID != stepID || op.GoalRevision != binding.GoalRevision || op.PlanRevision != binding.PlanRevision || op.StepRevision != binding.StepRevision || op.SecurityTaskID != attempt.SecurityTaskID || op.RootTurnID != attempt.RootTurnID || op.OwnerID == "" || op.OwnerGeneration < 1 {
			return security.AcceptanceInsufficient, nil
		}
		if current, err := currentWorkOperationResourcesTx(tx, op); err != nil || !current {
			if err != nil {
				return security.AcceptanceInsufficient, err
			}
			return security.AcceptanceInsufficient, nil
		}
		if manual {
			continue
		}
		if !qualifiedAcceptanceOperation(op) {
			continue
		}
		var proofs []nativeEvidence
		if err := tx.Where("operation_id = ? AND session_id = ? AND status = ?", op.ID, goal.SessionID, "completed").Find(&proofs).Error; err != nil {
			return security.AcceptanceInsufficient, err
		}
		for _, proof := range proofs {
			id := strconv.FormatUint(proof.ID, 10)
			if !allowed[id] {
				continue
			}
			evidence = append(evidence, security.Evidence{ID: id, OperationID: op.ID, AttemptID: attempt.ID, Target: op.ResourceID, ConnectionRevision: op.ResourceConnectionRevision, SourceDigest: security.ObservationSourceDigest(op.Tool, op.ArgsHash, op.ResourceID, op.ResourceConnectionRevision), Status: op.Status, Binding: binding, ObservedAt: proof.At, Data: json.RawMessage(proof.Data)})
		}
	}
	if manual {
		return security.AcceptancePass, nil
	}
	state, _ := security.VerifyStep(security.StepVerification{Binding: binding, AttemptID: attempt.ID, Criteria: step.Criteria, Evidence: evidence, Now: now})
	return state, nil
}
