package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// WorkClosureContract is stored separately from WorkGoal.Data. Existing clients
// retain exactly the same WorkGoal projection; private versions and verification
// records are available through authenticated management/work_read adapters.
type WorkClosureContract struct {
	ProjectID      string                      `json:"projectId"`
	GoalRevision   int64                       `json:"goalRevision"`
	PlanRevision   int64                       `json:"planRevision"`
	Steps          map[string]WorkStepContract `json:"steps"`
	ActiveAttempts map[string]string           `json:"activeAttempts"`
}

type WorkStepContract struct {
	VerificationMode string                         `json:"verificationMode,omitempty"`
	Revision         int64                          `json:"revision"`
	Required         bool                           `json:"required"`
	Criteria         []security.AcceptanceCriterion `json:"criteria"`
}

type workContractRevision struct {
	ID                         string `gorm:"primaryKey"`
	SessionID                  string `gorm:"uniqueIndex:work_contract_action"`
	ActionID                   string `gorm:"uniqueIndex:work_contract_action"`
	GoalID                     string `gorm:"index"`
	GoalRevision, PlanRevision int64
	Actor, RequestHash, Data   string
	At                         time.Time
}

type workExecutionAttempt struct {
	ID                                            string `gorm:"primaryKey"`
	SessionID, ProjectID                          string
	GoalID                                        string `gorm:"index"`
	GoalRevision, PlanRevision                    int64
	StepID                                        string `gorm:"index"`
	StepRevision                                  int64
	SecurityTaskID, RootTurnID, RetryOf, Strategy string
	State, ClosureState                           string
	Revision                                      int64
	CreatedAt                                     time.Time
}

type workAcceptanceRecord struct {
	ID                                                  string `gorm:"primaryKey"`
	SessionID, ProjectID                                string
	GoalID                                              string `gorm:"index"`
	GoalRevision, PlanRevision                          int64
	StepID, AttemptID, Scope                            string
	StepRevision, ProgressRevision                      int64
	State                                               string
	VerifierVersion, CriteriaHash, Results, EvidenceIDs string
	Actor, ActionID, SourceMessageID, RequestHash       string
	SourceKind, SourceInteractionID                     string
	At                                                  time.Time
}

type workCoverageLink struct {
	ID                                string `gorm:"primaryKey"`
	FailedAttemptID                   string `gorm:"uniqueIndex:work_coverage_pair"`
	ReplacementAttemptID              string `gorm:"uniqueIndex:work_coverage_pair"`
	AcceptanceID, CriteriaIDs, Reason string
	At                                time.Time
}

func workClosureModels() []any {
	return []any{&workContractRevision{}, &workExecutionAttempt{}, &workAcceptanceRecord{}, &workCoverageLink{}}
}

func decodeWorkGoal(row nativeWorkGoal, goal *WorkGoal) error {
	if err := json.Unmarshal([]byte(row.Data), goal); err != nil {
		return err
	}
	if row.ClosureContract == "" {
		return nil
	}
	var contract WorkClosureContract
	if err := json.Unmarshal([]byte(row.ClosureContract), &contract); err != nil {
		return err
	}
	if contract.GoalRevision != row.GoalRevision || contract.PlanRevision != row.PlanRevision || contract.GoalRevision < 1 || contract.PlanRevision < 1 {
		return errors.New("invalid work contract revision")
	}
	goal.closure = &contract
	return nil
}

func loadWorkGoalTx(tx *gorm.DB, sessionID, goalID string, expected int64) (nativeWorkGoal, WorkGoal, error) {
	var row nativeWorkGoal
	var goal WorkGoal
	if err := rejectSuperReadOnlyGoalTx(tx, goalID); err != nil {
		return row, goal, err
	}
	if isSuperArchiveGoal(goalID) {
		return row, goal, errors.New("superagent: imported SRE archive is read-only")
	}
	if err := tx.First(&row, "id = ? AND session_id = ?", goalID, sessionID).Error; err != nil {
		return row, goal, err
	}
	if expected != row.Revision {
		return row, goal, errWorkConflict
	}
	return row, goal, decodeWorkGoal(row, &goal)
}

// The same Home barrier serializes trusted closure changes with restore and
// dispatch. A Home-less Engine is limited to legacy in-process callers/tests.
func (e *Engine) workMutation(db *gorm.DB, fn func(*gorm.DB) error) error {
	if e.securityHome() != nil {
		return e.withSecurityDispatchBarrier(func() error { return db.Transaction(fn) })
	}
	return db.Transaction(fn)
}

func closureBinding(goal WorkGoal, stepID string) security.ClosureBinding {
	b := security.ClosureBinding{SessionID: goal.SessionID, GoalID: goal.ID, StepID: stepID}
	if c := goal.closure; c != nil {
		b.ProjectID, b.GoalRevision, b.PlanRevision = c.ProjectID, c.GoalRevision, c.PlanRevision
		b.StepRevision = c.Steps[stepID].Revision
	}
	return b
}

// ConfigureWorkAcceptance is a host control action, deliberately not an agent
// tool. The authenticated caller must identify the actual actor/action. Changes
// retain old contract versions and evidence; no model summary can call this API.
func (e *Engine) ConfigureWorkAcceptance(sessionID, goalID, projectID, actor, actionID string, expected int64, steps map[string]WorkStepContract) error {
	if err := e.CheckSecurityRuntime(); err != nil {
		return err
	}
	if strings.TrimSpace(actor) == "" || actionID == "" || len(actionID) > 200 {
		return errors.New("trusted work action required")
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	requestHash := hash(js([]any{goalID, projectID, expected, steps}))
	return e.workMutation(store.DB, func(tx *gorm.DB) error {
		var previous workContractRevision
		lookup := tx.First(&previous, "session_id = ? AND action_id = ?", sessionID, actionID)
		if lookup.Error == nil {
			if previous.Actor != actor || previous.RequestHash != requestHash {
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
		if workTerminal(goal.Status) || len(goal.Items) == 0 || len(steps) != len(goal.Items) {
			return errors.New("active complete work plan required")
		}
		// Contract edits never legitimize a side effect which is still unknown.
		if unresolved, err := workUnresolvedTx(tx, goalID, ""); err != nil || unresolved {
			if err != nil {
				return err
			}
			return errors.New("unresolved work operations require reconciliation")
		}
		contract := WorkClosureContract{ProjectID: projectID, GoalRevision: 1, PlanRevision: 1, Steps: map[string]WorkStepContract{}, ActiveAttempts: map[string]string{}}
		if goal.closure != nil {
			if goal.closure.ProjectID != projectID {
				return errors.New("work project cannot change")
			}
			contract.GoalRevision = goal.closure.GoalRevision + 1
			contract.PlanRevision = goal.closure.PlanRevision + 1
		}
		required := false
		for i := range goal.Items {
			item := &goal.Items[i]
			step, exists := steps[item.ID]
			if !exists || security.ValidateCriteria(step.Criteria) != nil {
				return errors.New("every work step needs valid acceptance criteria")
			}
			if step.VerificationMode != "" && step.VerificationMode != "automatic" && step.VerificationMode != "manual" {
				return errors.New("unknown acceptance verification mode")
			}
			if current, checkErr := currentWorkCriteriaTx(tx, projectID, sessionID, step.Criteria); checkErr != nil || !current {
				if checkErr != nil {
					return checkErr
				}
				return errors.New("acceptance target connection changed or is unavailable")
			}
			// Operation success alone is insufficient for a business contract.
			for _, c := range step.Criteria {
				if c.Method == "operation_succeeded" {
					return errors.New("acceptance requires observed result criteria")
				}
			}
			step.Revision = 1
			if goal.closure != nil {
				step.Revision = goal.closure.Steps[item.ID].Revision + 1
			}
			contract.Steps[item.ID] = step
			required = required || step.Required
			item.Status, item.EvidenceIDs, item.Reason = "pending", nil, "验收契约已更新，需按当前版本核实"
		}
		if !required {
			return errors.New("at least one required work step is required")
		}
		goal.closure, goal.ActiveItemID, goal.Status = &contract, "", "running"
		history := workContractRevision{ID: uid(), SessionID: sessionID, GoalID: goalID, ActionID: actionID, Actor: actor, RequestHash: requestHash, GoalRevision: contract.GoalRevision, PlanRevision: contract.PlanRevision, Data: js(contract), At: time.Now().UTC()}
		if err = tx.Create(&history).Error; err != nil {
			return err
		}
		if h := e.securityHome(); h != nil {
			if err = fenceSecurityGoalRevisionTx(tx, h.control.StoreID, h.control.RecoveryEpoch, projectID, sessionID, goalID, contract.GoalRevision, actor, actionID, time.Now().UTC()); err != nil {
				return err
			}
		}
		return writeWorkGoalTx(tx, &row, &goal, false)
	})
}

// BeginWorkAttempt binds a retry to the original versioned step. Its operations
// stay in native_operations; this row never duplicates operation results.
func (e *Engine) BeginWorkAttempt(sessionID, goalID, stepID, taskID, rootTurnID, retryOf, strategy string, expected int64) (string, error) {
	return e.beginWorkAttempt(context.Background(), sessionID, goalID, stepID, taskID, rootTurnID, retryOf, strategy, expected)
}

func (e *Engine) beginWorkAttempt(ctx context.Context, sessionID, goalID, stepID, taskID, rootTurnID, retryOf, strategy string, expected int64) (string, error) {
	if err := e.CheckSecurityRuntime(); err != nil {
		return "", err
	}
	store, err := e.adkStore()
	if err != nil {
		return "", err
	}
	id := uid()
	err = e.workMutation(store.DB, func(tx *gorm.DB) error {
		if err := checkSuperContextTx(ctx, tx); err != nil {
			return err
		}
		row, goal, err := loadWorkGoalTx(tx, sessionID, goalID, expected)
		if err != nil {
			return err
		}
		if goal.closure == nil || goal.Status != "running" || taskID == "" || rootTurnID == "" {
			return errors.New("active versioned work and execution task required")
		}
		if _, err = verifySecurityTaskTx(tx, taskID, sessionID, goalID, rootTurnID, time.Now().UTC()); err != nil {
			return err
		}
		step, exists := goal.closure.Steps[stepID]
		if !exists {
			return errors.New("work step does not exist")
		}
		found := false
		for i := range goal.Items {
			if goal.Items[i].ID == stepID {
				if !workItemReady(goal.Items, goal.Items[i]) {
					return errors.New("work dependencies are not accepted")
				}
				goal.Items[i].Status = "running"
				found = true
			}
		}
		if !found {
			return errors.New("work step does not exist")
		}
		if unresolved, err := workUnresolvedTx(tx, goalID, stepID); err != nil || unresolved {
			if err != nil {
				return err
			}
			return errors.New("unknown or running prior attempt must be reconciled")
		}
		if current := goal.closure.ActiveAttempts[stepID]; current != "" && retryOf != current {
			return errors.New("retry must reference the preceding attempt")
		}
		if retryOf != "" {
			var prior workExecutionAttempt
			if err = tx.First(&prior, "id = ? AND goal_id = ? AND step_id = ? AND session_id = ?", retryOf, goalID, stepID, sessionID).Error; err != nil {
				return err
			}
			if prior.State != "failed" && prior.State != "not_executed" && prior.ClosureState != "reconciled" {
				return errors.New("prior attempt has no safe retry result")
			}
		}
		attempt := workExecutionAttempt{ID: id, SessionID: sessionID, ProjectID: goal.closure.ProjectID, GoalID: goalID, GoalRevision: goal.closure.GoalRevision, PlanRevision: goal.closure.PlanRevision, StepID: stepID, StepRevision: step.Revision, SecurityTaskID: taskID, RootTurnID: rootTurnID, RetryOf: retryOf, Strategy: utf8Prefix(strategy, 2000), State: "prepared", ClosureState: "open", Revision: 1, CreatedAt: time.Now().UTC()}
		if err = tx.Create(&attempt).Error; err != nil {
			return err
		}
		goal.closure.ActiveAttempts[stepID], goal.ActiveItemID = id, stepID
		return writeWorkGoalTx(tx, &row, &goal, false)
	})
	return id, err
}

func workUnresolvedTx(tx *gorm.DB, goalID, stepID string) (bool, error) {
	query := tx.Model(&nativeOperation{}).Where("goal_id = ?", goalID)
	if stepID != "" {
		query = query.Where("step_id = ?", stepID)
	}
	var count int64
	err := query.Where("(((status NOT IN ? OR status IS NULL) AND risk_resolved_at IS NULL) OR (orphan_state NOT IN ? AND orphan_state IS NOT NULL) OR (cancel_requested_at IS NOT NULL AND cancellation_state NOT IN ? AND risk_resolved_at IS NULL))", []string{"succeeded", "failed", "not_executed", "cancelled"}, []string{"", "resolved", "reconciled"}, []string{"stopped", "not_running", "resolved"}).Count(&count).Error
	return count != 0, err
}

func (e *Engine) VerifyWorkStep(sessionID, goalID, stepID string, expected int64) (string, error) {
	return e.verifyWorkStep(context.Background(), sessionID, goalID, stepID, expected)
}

func (e *Engine) verifyWorkStep(ctx context.Context, sessionID, goalID, stepID string, expected int64) (string, error) {
	if err := e.CheckSecurityRuntime(); err != nil {
		return "", err
	}
	store, err := e.adkStore()
	if err != nil {
		return "", err
	}
	id := uid()
	err = e.workMutation(store.DB, func(tx *gorm.DB) error {
		if err := checkSuperContextTx(ctx, tx); err != nil {
			return err
		}
		row, goal, err := loadWorkGoalTx(tx, sessionID, goalID, expected)
		if err != nil {
			return err
		}
		if goal.closure == nil || workTerminal(goal.Status) || goal.Status == "paused" {
			return errors.New("active versioned work required")
		}
		step, exists := goal.closure.Steps[stepID]
		attemptID := goal.closure.ActiveAttempts[stepID]
		if !exists || attemptID == "" {
			return errors.New("work attempt required")
		}
		var attempt workExecutionAttempt
		if err = tx.First(&attempt, "id = ? AND session_id = ? AND goal_id = ? AND step_id = ?", attemptID, sessionID, goalID, stepID).Error; err != nil {
			return err
		}
		binding := closureBinding(goal, stepID)
		if attempt.GoalRevision != binding.GoalRevision || attempt.PlanRevision != binding.PlanRevision || attempt.StepRevision != binding.StepRevision {
			return errWorkConflict
		}
		var operations []nativeOperation
		if err = tx.Where("attempt_id = ?", attemptID).Find(&operations).Error; err != nil {
			return err
		}
		var evidence []security.Evidence
		attemptState := "succeeded"
		if len(operations) == 0 {
			attemptState = "not_executed"
		}
		for _, op := range operations {
			if op.SessionID != sessionID || op.GoalID != goalID || op.StepID != stepID || op.GoalRevision != binding.GoalRevision || op.PlanRevision != binding.PlanRevision || op.StepRevision != binding.StepRevision || op.SecurityTaskID != attempt.SecurityTaskID || op.RootTurnID != attempt.RootTurnID || op.OwnerID == "" || op.OwnerGeneration < 1 {
				return errors.New("operation binding mismatch")
			}
			if op.Status == "unknown" || op.Status == "dispatched" {
				attemptState = "unknown"
			} else if op.Status != "succeeded" && attemptState != "unknown" {
				attemptState = "failed"
			}
			var proofs []nativeEvidence
			if step.VerificationMode == "manual" || !qualifiedAcceptanceOperation(op) {
				continue
			}
			if err = tx.Where("operation_id = ? AND session_id = ? AND status = ?", op.ID, sessionID, "completed").Find(&proofs).Error; err != nil {
				return err
			}
			for _, proof := range proofs {
				evidence = append(evidence, security.Evidence{ID: strconv.FormatUint(proof.ID, 10), OperationID: op.ID, AttemptID: attemptID, Target: op.ResourceID, ConnectionRevision: op.ResourceConnectionRevision, SourceDigest: security.ObservationSourceDigest(op.Tool, op.ArgsHash, op.ResourceID, op.ResourceConnectionRevision), Status: op.Status, Binding: binding, ObservedAt: proof.At, Data: json.RawMessage(proof.Data)})
			}
		}
		unresolved, err := workUnresolvedTx(tx, goalID, stepID)
		if err != nil {
			return err
		}
		current, err := currentWorkCriteriaTx(tx, goal.closure.ProjectID, goal.SessionID, step.Criteria)
		if err != nil {
			return err
		}
		unresolved = unresolved || !current
		now := time.Now().UTC()
		state, results := security.VerifyStep(security.StepVerification{Binding: binding, AttemptID: attemptID, Criteria: step.Criteria, Evidence: evidence, Unresolved: unresolved || attemptState != "succeeded", Now: now})
		var refs []string
		for _, result := range results {
			refs = append(refs, result.EvidenceIDs...)
		}
		record := workAcceptanceRecord{ID: id, SessionID: sessionID, ProjectID: binding.ProjectID, GoalID: goalID, GoalRevision: binding.GoalRevision, PlanRevision: binding.PlanRevision, StepID: stepID, StepRevision: binding.StepRevision, AttemptID: attemptID, Scope: "step", ProgressRevision: goal.Revision, State: string(state), VerifierVersion: security.VerifierVersion, CriteriaHash: hash(js(step.Criteria)), Results: js(results), EvidenceIDs: js(refs), At: now}
		if err = tx.Create(&record).Error; err != nil {
			return err
		}
		if err = tx.Model(&workExecutionAttempt{}).Where("id = ? AND revision = ?", attemptID, attempt.Revision).Updates(map[string]any{"state": attemptState, "revision": attempt.Revision + 1}).Error; err != nil {
			return err
		}
		for i := range goal.Items {
			if goal.Items[i].ID == stepID {
				goal.Items[i].Status = "blocked"
				if state == security.AcceptancePass {
					goal.Items[i].Status = "completed"
				}
				goal.Items[i].EvidenceIDs = refs
			}
		}
		goal.Status, goal.ActiveItemID = "running", ""
		return writeWorkGoalTx(tx, &row, &goal, false)
	})
	return id, err
}

func acceptedStepsTx(tx *gorm.DB, goal WorkGoal) ([]security.GoalStepAcceptance, error) {
	if goal.closure == nil {
		return nil, errors.New("acceptance contract required")
	}
	steps := make([]security.GoalStepAcceptance, 0, len(goal.Items))
	for _, item := range goal.Items {
		contract, exists := goal.closure.Steps[item.ID]
		if !exists {
			return nil, errors.New("work contract does not cover current plan")
		}
		state := security.AcceptanceInsufficient
		var record workAcceptanceRecord
		err := tx.Where("goal_id = ? AND session_id = ? AND goal_revision = ? AND plan_revision = ? AND step_id = ? AND step_revision = ? AND attempt_id = ? AND scope = ?", goal.ID, goal.SessionID, goal.closure.GoalRevision, goal.closure.PlanRevision, item.ID, contract.Revision, goal.closure.ActiveAttempts[item.ID], "step").Order("at DESC, rowid DESC").First(&record).Error
		if err == nil && record.CriteriaHash == hash(js(contract.Criteria)) && item.Status == "completed" {
			state, err = currentWorkAcceptanceTx(tx, goal, item.ID, record)
			if err != nil {
				return nil, err
			}
		} else if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, err
		}
		current, checkErr := currentWorkCriteriaTx(tx, goal.closure.ProjectID, goal.SessionID, contract.Criteria)
		if checkErr != nil {
			return nil, checkErr
		}
		if !current {
			state = security.AcceptanceInsufficient
		}
		steps = append(steps, security.GoalStepAcceptance{ID: item.ID, Required: contract.Required, DependsOn: item.DependsOn, State: state, Binding: closureBinding(goal, item.ID)})
	}
	return steps, nil
}

func currentWorkCriteriaTx(tx *gorm.DB, projectID, sessionID string, criteria []security.AcceptanceCriterion) (bool, error) {
	for _, criterion := range criteria {
		if criterion.Method == "human_verified" && criterion.TargetKind == security.TargetSession {
			if criterion.Target != sessionID {
				return false, nil
			}
			continue
		}
		if criterion.Method == "human_verified" && criterion.TargetKind == security.TargetProject {
			if criterion.Target != projectID {
				return false, nil
			}
			continue
		}
		var resource securityResourceRevisionRow
		err := tx.First(&resource, "project_id = ? AND resource_id = ?", projectID, criterion.Target).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if resource.State != "ready" || resource.ConnectionRevision != criterion.ConnectionRevision {
			return false, nil
		}
	}
	return true, nil
}

func requireGoalAcceptanceTx(tx *gorm.DB, row nativeWorkGoal, goal WorkGoal) error {
	steps, err := acceptedStepsTx(tx, goal)
	if err != nil {
		return err
	}
	unresolved, err := workUnresolvedTx(tx, goal.ID, "")
	if err != nil {
		return err
	}
	uncovered, err := workUncoveredAttemptsTx(tx, goal)
	if err != nil {
		return err
	}
	unresolved = unresolved || uncovered
	if security.VerifyGoal(closureBinding(goal, ""), steps, unresolved) != security.AcceptancePass {
		return errors.New("目标验收未通过或仍有未决副作用")
	}
	var count int64
	if err = tx.Model(&workAcceptanceRecord{}).Where("goal_id = ? AND session_id = ? AND goal_revision = ? AND plan_revision = ? AND scope = ? AND state = ?", goal.ID, goal.SessionID, row.GoalRevision, row.PlanRevision, "goal", "pass").Count(&count).Error; err != nil {
		return err
	}
	if count == 0 {
		return errors.New("目标需要逐条件验收，模型总结不能完成目标")
	}
	return nil
}

func workUncoveredAttemptsTx(tx *gorm.DB, goal WorkGoal) (bool, error) {
	if goal.closure == nil {
		return true, nil
	}
	var count int64
	err := tx.Model(&workExecutionAttempt{}).Where("goal_id = ? AND session_id = ? AND goal_revision = ? AND state IN ? AND closure_state NOT IN ?", goal.ID, goal.SessionID, goal.closure.GoalRevision, []string{"failed", "not_executed"}, []string{"covered", "reconciled"}).Count(&count).Error
	return count > 0, err
}

func (e *Engine) VerifyWorkGoal(sessionID, goalID string, expected int64) (string, error) {
	return e.verifyWorkGoal(context.Background(), sessionID, goalID, expected)
}

func (e *Engine) verifyWorkGoal(ctx context.Context, sessionID, goalID string, expected int64) (string, error) {
	if err := e.CheckSecurityRuntime(); err != nil {
		return "", err
	}
	store, err := e.adkStore()
	if err != nil {
		return "", err
	}
	id := uid()
	err = e.workMutation(store.DB, func(tx *gorm.DB) error {
		if err := checkSuperContextTx(ctx, tx); err != nil {
			return err
		}
		row, goal, err := loadWorkGoalTx(tx, sessionID, goalID, expected)
		if err != nil {
			return err
		}
		if workTerminal(goal.Status) || goal.Status == "paused" {
			return errors.New("active work required")
		}
		steps, err := acceptedStepsTx(tx, goal)
		if err != nil {
			return err
		}
		unresolved, err := workUnresolvedTx(tx, goalID, "")
		if err != nil {
			return err
		}
		uncovered, err := workUncoveredAttemptsTx(tx, goal)
		if err != nil {
			return err
		}
		unresolved = unresolved || uncovered
		state := security.VerifyGoal(closureBinding(goal, ""), steps, unresolved)
		record := workAcceptanceRecord{ID: id, SessionID: sessionID, ProjectID: goal.closure.ProjectID, GoalID: goalID, GoalRevision: goal.closure.GoalRevision, PlanRevision: goal.closure.PlanRevision, Scope: "goal", ProgressRevision: expected, State: string(state), VerifierVersion: security.VerifierVersion, Results: js(steps), At: time.Now().UTC()}
		if err = tx.Create(&record).Error; err != nil {
			return err
		}
		if state == security.AcceptancePass {
			goal.Status = "completed"
		} else {
			goal.Status = "blocked"
		}
		return writeWorkGoalTx(tx, &row, &goal, false)
	})
	return id, err
}

func (e *Engine) CoverWorkAttempt(sessionID, goalID, failedID, replacementID, acceptanceID, reason string, expected int64) error {
	if err := e.CheckSecurityRuntime(); err != nil {
		return err
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	return e.workMutation(store.DB, func(tx *gorm.DB) error {
		row, goal, err := loadWorkGoalTx(tx, sessionID, goalID, expected)
		if err != nil {
			return err
		}
		var failed, replacement workExecutionAttempt
		for id, dst := range map[string]*workExecutionAttempt{failedID: &failed, replacementID: &replacement} {
			if err = tx.First(dst, "id = ? AND goal_id = ? AND session_id = ?", id, goalID, sessionID).Error; err != nil {
				return err
			}
		}
		var accepted workAcceptanceRecord
		if err = tx.First(&accepted, "id = ? AND goal_id = ? AND session_id = ? AND attempt_id = ? AND scope = ?", acceptanceID, goalID, sessionID, replacementID, "step").Error; err != nil {
			return err
		}
		binding := func(a workExecutionAttempt) security.ClosureBinding {
			return security.ClosureBinding{ProjectID: a.ProjectID, SessionID: a.SessionID, GoalID: a.GoalID, GoalRevision: a.GoalRevision, PlanRevision: a.PlanRevision, StepID: a.StepID, StepRevision: a.StepRevision}
		}
		unresolved, err := workUnresolvedTx(tx, goalID, failed.StepID)
		if err != nil {
			return err
		}
		contractEqual := goal.closure != nil && goal.closure.GoalRevision == failed.GoalRevision && goal.closure.Steps[failed.StepID].Revision == failed.StepRevision && accepted.CriteriaHash == hash(js(goal.closure.Steps[failed.StepID].Criteria))
		if !security.CanCover(security.ClosureAttempt{ID: failedID, Binding: binding(failed), State: failed.State, ClosureState: failed.ClosureState}, security.ClosureAttempt{ID: replacementID, Binding: binding(replacement), State: replacement.State}, security.AcceptanceState(accepted.State), contractEqual, unresolved) {
			return errors.New("attempts are not safely equivalent")
		}
		var results []security.CriterionResult
		if err = json.Unmarshal([]byte(accepted.Results), &results); err != nil {
			return err
		}
		var criteria []string
		for _, result := range results {
			if result.State != security.AcceptancePass {
				return errors.New("coverage criterion is not accepted")
			}
			criteria = append(criteria, result.CriterionID)
		}
		link := workCoverageLink{ID: hash(fmt.Sprintf("%s\x00%s\x00%s", failedID, replacementID, acceptanceID)), FailedAttemptID: failedID, ReplacementAttemptID: replacementID, AcceptanceID: acceptanceID, CriteriaIDs: js(criteria), Reason: utf8Prefix(reason, 2000), At: time.Now().UTC()}
		if err = tx.Create(&link).Error; err != nil {
			return err
		}
		if err = tx.Model(&workExecutionAttempt{}).Where("id = ? AND revision = ?", failedID, failed.Revision).Updates(map[string]any{"closure_state": "covered", "revision": failed.Revision + 1}).Error; err != nil {
			return err
		}
		return writeWorkGoalTx(tx, &row, &goal, false)
	})
}
