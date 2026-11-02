package ai

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// Only implemented, host-registered observation adapters qualify automatically.
// A matching JSON value from arbitrary Shell, raw SQL or MCP is insufficient.
func qualifiedAcceptanceOperation(op nativeOperation) bool {
	var descriptor security.PreparedOperation
	if json.Unmarshal([]byte(op.SecurityDescriptor), &descriptor) != nil {
		return false
	}
	digest, err := security.OperationDigest(descriptor)
	if err != nil || digest != op.DescriptorDigest || descriptor.ID != op.ID || descriptor.Tool != op.Tool || descriptor.ArgumentsDigest != op.ArgsHash || descriptor.SessionID != op.SessionID || descriptor.GoalID != op.GoalID || descriptor.StepID != op.StepID || descriptor.AttemptID != op.AttemptID || descriptor.TaskID != op.SecurityTaskID {
		return false
	}
	if _, qualified := SecurityReadVerifierProfile(descriptor); qualified {
		return true
	}
	if descriptor.Proof == security.ProofCommandProfile && descriptor.CommandProfileVersion == security.CommandProfileVersion {
		return slices.Contains([]string{"disk_usage", "process_snapshot", "service_status", "service_logs"}, descriptor.CommandProfileID)
	}
	return descriptor.Proof == security.ProofStructured && slices.Contains([]string{"read", "ls", "observe_logs"}, descriptor.Tool) && len(descriptor.Resources) == 1 && descriptor.Resources[0].Local && descriptor.Scope.FileRoot != "" && descriptor.Scope.FileRootIdentity != "" && descriptor.Scope.FileIdentity != ""
}

// RecordHumanWorkAcceptance is a trusted host action, never a model tool or an
// approved flag. The HTTP/question adapter authenticates the actor and original
// human action. It cannot reconcile unknown effects or change an auto contract.
func (e *Engine) RecordHumanWorkAcceptance(sessionID, goalID, stepID, actor, actionID, sourceMessageID string, expected int64, criteriaIDs []string, note string) (string, error) {
	return e.recordHumanWorkAcceptance(sessionID, goalID, stepID, actor, actionID, sourceMessageID, "user_action", "", expected, criteriaIDs, note)
}

func (e *Engine) recordHumanWorkAcceptance(sessionID, goalID, stepID, actor, actionID, sourceMessageID, sourceKind, sourceInteractionID string, expected int64, criteriaIDs []string, note string) (string, error) {
	if err := e.CheckSecurityRuntime(); err != nil {
		return "", err
	}
	if actor == "" || len(actor) > 256 || actionID == "" || len(actionID) > 256 || sourceMessageID == "" || len(note) > 4000 {
		return "", errors.New("trusted human verification action required")
	}
	if sourceKind != "user_action" && sourceKind != "question" || sourceKind == "question" && (sourceInteractionID == "" || actor != "local-user" || actionID != "question:"+sourceInteractionID) {
		return "", errors.New("original human interaction required")
	}
	s, err := e.get(sessionID)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	config := s.state.Config
	s.mu.Unlock()
	for _, secret := range append(append([]string(nil), config.AuthSecrets...), config.Model.Key) {
		if secret != "" && strings.Contains(note, secret) {
			return "", errors.New("verification notes cannot contain credentials")
		}
	}
	criteriaIDs = append([]string(nil), criteriaIDs...)
	slices.Sort(criteriaIDs)
	requestHash := hash(js([]any{goalID, stepID, sourceMessageID, expected, criteriaIDs, note, sourceKind, sourceInteractionID}))
	id := hash("human-acceptance\x00" + sessionID + "\x00" + actor + "\x00" + actionID)
	store, err := e.adkStore()
	if err != nil {
		return "", err
	}
	err = e.workMutation(store.DB, func(tx *gorm.DB) error {
		var prior workAcceptanceRecord
		lookup := tx.First(&prior, "id = ?", id)
		if lookup.Error == nil {
			if prior.Actor != actor || prior.ActionID != actionID || prior.RequestHash != requestHash {
				return errWorkConflict
			}
			return nil
		}
		if !errors.Is(lookup.Error, gorm.ErrRecordNotFound) {
			return lookup.Error
		}
		row, goal, err := loadWorkGoalTx(tx, sessionID, goalID, expected)
		if err != nil {
			return err
		}
		if goal.closure == nil || workTerminal(goal.Status) {
			return errors.New("open versioned work goal required")
		}
		contract, exists := goal.closure.Steps[stepID]
		if !exists || contract.VerificationMode != "manual" {
			return errors.New("step is not configured for human verification")
		}
		if sourceKind == "question" {
			if err = validateQuestionWorkAcceptanceTx(tx, goal, stepID, sourceInteractionID, sourceMessageID, expected, criteriaIDs); err != nil {
				return err
			}
		}
		attemptID := goal.closure.ActiveAttempts[stepID]
		var attempt workExecutionAttempt
		if attemptID == "" {
			return errors.New("canonical execution attempt required before verification")
		}
		if err = tx.First(&attempt, "id = ? AND session_id = ? AND goal_id = ? AND step_id = ?", attemptID, sessionID, goalID, stepID).Error; err != nil {
			return err
		}
		if attempt.GoalRevision != goal.closure.GoalRevision || attempt.PlanRevision != goal.closure.PlanRevision || attempt.StepRevision != contract.Revision || attempt.State != "succeeded" {
			return errors.New("verify original execution attempts before human acceptance")
		}
		var operations []nativeOperation
		if err = tx.Where("attempt_id = ?", attemptID).Find(&operations).Error; err != nil {
			return err
		}
		if len(operations) == 0 {
			return errors.New("original execution results required")
		}
		for _, op := range operations {
			if current, checkErr := currentWorkOperationResourcesTx(tx, op); checkErr != nil || !current {
				if checkErr != nil {
					return checkErr
				}
				return errors.New("original execution target connection changed")
			}
			if op.Status != "succeeded" || op.SessionID != sessionID || op.GoalID != goalID || op.StepID != stepID || op.SecurityTaskID != attempt.SecurityTaskID || op.RootTurnID != attempt.RootTurnID || op.GoalRevision != attempt.GoalRevision || op.PlanRevision != attempt.PlanRevision || op.StepRevision != attempt.StepRevision || op.OwnerID == "" || op.OwnerGeneration < 1 {
				return errors.New("original execution is not successfully settled")
			}
		}
		if current, err := currentWorkCriteriaTx(tx, goal.closure.ProjectID, sessionID, contract.Criteria); err != nil || !current {
			if err != nil {
				return err
			}
			return errWorkConflict
		}
		if unresolved, err := workUnresolvedTx(tx, goalID, ""); err != nil || unresolved {
			if err != nil {
				return err
			}
			return errors.New("unresolved effects must be reconciled before human acceptance")
		}
		var required []string
		var results []security.CriterionResult
		for _, criterion := range contract.Criteria {
			required = append(required, criterion.ID)
			results = append(results, security.CriterionResult{CriterionID: criterion.ID, State: security.AcceptancePass})
		}
		slices.Sort(required)
		if !slices.Equal(required, criteriaIDs) {
			return errors.New("human verification must identify every current condition exactly once")
		}
		found := false
		for i := range goal.Items {
			if goal.Items[i].ID == stepID {
				if !workItemReady(goal.Items, goal.Items[i]) {
					return errors.New("required dependencies have not passed")
				}
				goal.Items[i].Status = "completed"
				goal.Items[i].Reason = redact(note, config)
				found = true
			}
		}
		if !found {
			return errors.New("work step missing")
		}
		record := workAcceptanceRecord{ID: id, SessionID: sessionID, ProjectID: goal.closure.ProjectID, GoalID: goalID, GoalRevision: goal.closure.GoalRevision, PlanRevision: goal.closure.PlanRevision, StepID: stepID, StepRevision: contract.Revision, AttemptID: goal.closure.ActiveAttempts[stepID], Scope: "step", ProgressRevision: expected, State: "pass", VerifierVersion: "human/1", CriteriaHash: hash(js(contract.Criteria)), Results: js(results), Actor: actor, ActionID: actionID, SourceMessageID: sourceMessageID, SourceKind: sourceKind, SourceInteractionID: sourceInteractionID, RequestHash: requestHash, At: time.Now().UTC()}
		if err = tx.Create(&record).Error; err != nil {
			return err
		}
		if err = e.appendNativeEvidence(tx, &nativeEvidence{SessionID: sessionID, Status: "human_verified", Data: js(map[string]any{"acceptance_id": id, "goal_id": goalID, "step_id": stepID, "actor": actor, "action_id": actionID, "source_message_id": sourceMessageID, "source_kind": sourceKind, "source_interaction_id": sourceInteractionID, "note": redact(note, config)}), At: time.Now().UTC()}); err != nil {
			return err
		}
		if sourceKind == "question" {
			changed := tx.Model(&securityConfirmationQuestionRow{}).Where("question_id = ? AND status = ?", sourceInteractionID, "answered").Updates(map[string]any{"status": "manual_verified", "revision": gorm.Expr("revision + 1")})
			if changed.Error != nil {
				return changed.Error
			}
			if changed.RowsAffected != 1 {
				return errWorkConflict
			}
		}
		if goal.Status != "paused" {
			goal.Status = "running"
		}
		goal.ActiveItemID = ""
		return writeWorkGoalTx(tx, &row, &goal, false)
	})
	if err != nil {
		return "", err
	}
	return id, nil
}
