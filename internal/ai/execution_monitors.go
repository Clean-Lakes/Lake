package ai

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

var errExecutionMonitor = errors.New("security: original execution has no valid monitor authority")

// AcquireExecutionMonitorTx transfers observation responsibility only. It does
// not transfer the agent's execution authority, rewrite its original owner, or
// allow a model to dispatch through this token.
func AcquireExecutionMonitorTx(tx *gorm.DB, operationID string, authorizer ExecutionOwner, now time.Time) (ExecutionOwner, error) {
	if err := ValidateExecutionOwner(tx, authorizer, now); err != nil {
		return ExecutionOwner{}, err
	}
	var op nativeOperation
	if err := tx.First(&op, "id = ?", operationID).Error; err != nil {
		return ExecutionOwner{}, err
	}
	scope, known := operationOwnerScope(op)
	if !known || op.OwnerKind != "agent" || op.Handle == "" || op.SecurityTaskID != authorizer.TaskID || op.GoalID != authorizer.GoalID || op.SessionID != authorizer.SessionID || op.RootTurnID != authorizer.RootTurnID || authorizer.ScopeID != "" && scope != authorizer.ScopeID || op.OrphanState != "" || op.ClosureState == "reconciled" || op.Status != "dispatched" && op.Status != "unknown" {
		return ExecutionOwner{}, errExecutionMonitor
	}
	var task securityTaskRow
	if err := tx.First(&task, "id = ?", authorizer.TaskID).Error; err != nil {
		return ExecutionOwner{}, err
	}
	if task.BackgroundPolicy != "monitored_background" {
		return ExecutionOwner{}, errExecutionMonitor
	}
	valid, err := runningOperationAuthorityValid(tx, op, now)
	if err != nil {
		return ExecutionOwner{}, err
	}
	if !valid {
		return ExecutionOwner{}, errExecutionMonitor
	}
	var existing securityTaskBinding
	err = tx.First(&existing, "task_id = ? AND kind = ? AND execution_id = ?", task.ID, "monitor", op.ID).Error
	if err == nil {
		owner := bindingOwner(existing)
		if _, err := validateExecutionMonitor(tx, owner, now); err != nil {
			return owner, err
		}
		return owner, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return ExecutionOwner{}, err
	}
	deadline, err := executionMonitorDeadline(tx, op, task, now)
	if err != nil {
		return ExecutionOwner{}, err
	}
	b := securityTaskBinding{ID: uid(), TaskID: task.ID, Kind: "monitor", ExecutionID: op.ID, SessionID: op.SessionID, GoalID: op.GoalID, RootTurnID: op.RootTurnID, ScopeID: "monitor:" + op.ID, StoreID: task.StoreID, RecoveryEpoch: task.RecoveryEpoch, ExecutionRevision: task.ExecutionRevision, State: "monitoring", OwnerID: uid(), OwnerKind: "monitor", OwnerGeneration: 1, LeaseUntil: deadline, CreatedAt: now, UpdatedAt: now}
	if err = tx.Create(&b).Error; err != nil {
		return ExecutionOwner{}, err
	}
	if err = tx.Create(&nativeEvidence{OperationID: op.ID, SessionID: op.SessionID, CallID: op.CallID, Tool: op.Tool, Status: "monitor_attached", Data: js(map[string]any{"binding_id": b.ID, "owner_generation": b.OwnerGeneration, "background_policy": "monitored_background"}), At: now}).Error; err != nil {
		return ExecutionOwner{}, err
	}
	return bindingOwner(b), nil
}

func executionMonitorDeadline(tx *gorm.DB, op nativeOperation, task securityTaskRow, now time.Time) (time.Time, error) {
	deadline := now.Add(ExecutionOwnerLease)
	if task.ExpiresAt.Before(deadline) {
		deadline = task.ExpiresAt
	}
	var decision securityDecisionRow
	if err := tx.First(&decision, "operation_id = ?", op.ID).Error; err != nil {
		return deadline, err
	}
	var sources []security.AuthoritySource
	if err := json.Unmarshal([]byte(decision.Authorities), &sources); err != nil {
		return deadline, err
	}
	for _, source := range sources {
		if source.Kind == "task_grant" || source.Kind == "task_budget" {
			var grant securityTaskGrantRow
			if err := tx.First(&grant, "id = ?", source.ID).Error; err != nil {
				return deadline, err
			}
			if grant.ExpiresAt.Before(deadline) {
				deadline = grant.ExpiresAt
			}
		}
	}
	if !deadline.After(now) {
		return deadline, errExecutionMonitor
	}
	return deadline, nil
}

func validateExecutionMonitor(tx *gorm.DB, owner ExecutionOwner, now time.Time) (nativeOperation, error) {
	var op nativeOperation
	if owner.OwnerKind != "monitor" || owner.BindingID == "" || owner.Generation < 1 || !owner.LeaseUntil.After(now) {
		return op, errExecutionMonitor
	}
	var binding securityTaskBinding
	if err := tx.First(&binding, "id = ?", owner.BindingID).Error; err != nil {
		return op, err
	}
	if binding.Kind != "monitor" || binding.State != "monitoring" || binding.OwnerKind != "monitor" || binding.OwnerID != owner.OwnerID || binding.OwnerGeneration != owner.Generation || binding.TaskID != owner.TaskID || binding.SessionID != owner.SessionID || binding.GoalID != owner.GoalID || binding.RootTurnID != owner.RootTurnID || binding.ScopeID != owner.ScopeID || binding.StoreID != owner.StoreID || binding.RecoveryEpoch != owner.RecoveryEpoch || binding.ExecutionRevision != owner.ExecutionRevision || !binding.LeaseUntil.After(now) {
		return op, errExecutionMonitor
	}
	if err := tx.First(&op, "id = ? AND security_task_id = ?", binding.ExecutionID, owner.TaskID).Error; err != nil {
		return op, err
	}
	if op.OrphanState != "" || op.ClosureState == "reconciled" || op.Status != "dispatched" && op.Status != "unknown" {
		return op, errExecutionMonitor
	}
	var task securityTaskRow
	if err := tx.First(&task, "id = ?", owner.TaskID).Error; err != nil {
		return op, err
	}
	if task.BackgroundPolicy != "monitored_background" || task.task().Validate(now) != nil || task.State == security.TaskPaused || task.StoreID != owner.StoreID || task.RecoveryEpoch != owner.RecoveryEpoch || task.ExecutionRevision != owner.ExecutionRevision {
		return op, errExecutionMonitor
	}
	if err := validateSecurityTaskAncestors(tx, task.task(), now); err != nil {
		return op, errExecutionMonitor
	}
	var goal nativeWorkGoal
	if err := tx.First(&goal, "id = ? AND session_id = ?", owner.GoalID, owner.SessionID).Error; err != nil {
		return op, err
	}
	if workTerminal(goal.Status) || goal.Status == "paused" {
		return op, errExecutionMonitor
	}
	valid, err := runningOperationAuthorityValid(tx, op, now)
	if err != nil {
		return op, err
	}
	if !valid {
		return op, errExecutionMonitor
	}
	return op, nil
}

func CloseCompletedExecutionMonitorTx(tx *gorm.DB, owner ExecutionOwner, now time.Time) error {
	if owner.OwnerKind != "monitor" {
		return errExecutionMonitor
	}
	var binding securityTaskBinding
	if err := tx.First(&binding, "id = ? AND owner_id = ? AND owner_generation = ? AND state = ?", owner.BindingID, owner.OwnerID, owner.Generation, "monitoring").Error; err != nil {
		return err
	}
	var op nativeOperation
	if err := tx.First(&op, "id = ?", binding.ExecutionID).Error; err != nil {
		return err
	}
	if op.OrphanState != "" || op.Status != "succeeded" && op.Status != "failed" && op.Status != "not_executed" {
		return errExecutionMonitor
	}
	updated := tx.Model(&securityTaskBinding{}).Where("id = ? AND owner_generation = ? AND state = ?", binding.ID, owner.Generation, "monitoring").Updates(map[string]any{"state": "closed", "owner_generation": gorm.Expr("owner_generation + 1"), "lease_until": now, "updated_at": now})
	if updated.Error != nil {
		return updated.Error
	}
	if updated.RowsAffected != 1 {
		return errExecutionMonitor
	}
	return tx.Create(&nativeEvidence{OperationID: op.ID, SessionID: op.SessionID, CallID: op.CallID, Tool: op.Tool, Status: "monitor_closed", Data: js(map[string]any{"binding_id": binding.ID, "operation_status": op.Status}), At: now}).Error
}

func RenewExecutionMonitorTx(tx *gorm.DB, owner ExecutionOwner, now time.Time) (ExecutionOwner, error) {
	op, err := validateExecutionMonitor(tx, owner, now)
	if err != nil {
		return owner, err
	}
	var task securityTaskRow
	if err = tx.First(&task, "id = ?", owner.TaskID).Error; err != nil {
		return owner, err
	}
	deadline, err := executionMonitorDeadline(tx, op, task, now)
	if err != nil {
		return owner, err
	}
	updated := tx.Model(&securityTaskBinding{}).Where("id = ? AND owner_id = ? AND owner_generation = ? AND lease_until > ? AND state = ?", owner.BindingID, owner.OwnerID, owner.Generation, now, "monitoring").Updates(map[string]any{"lease_until": deadline, "updated_at": now})
	if updated.Error != nil {
		return owner, updated.Error
	}
	if updated.RowsAffected != 1 {
		return owner, errExecutionMonitor
	}
	owner.LeaseUntil = deadline
	return owner, nil
}

func operationHasValidMonitor(tx *gorm.DB, op nativeOperation, now time.Time) (bool, error) {
	var binding securityTaskBinding
	err := tx.First(&binding, "task_id = ? AND kind = ? AND execution_id = ? AND state = ?", op.SecurityTaskID, "monitor", op.ID, "monitoring").Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	_, err = validateExecutionMonitor(tx, bindingOwner(binding), now)
	if errors.Is(err, errExecutionMonitor) || errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	return err == nil, err
}

func taskHasValidMonitor(tx *gorm.DB, taskID string, now time.Time) (bool, error) {
	var bindings []securityTaskBinding
	if err := tx.Where("task_id = ? AND kind = ? AND state = ?", taskID, "monitor", "monitoring").Find(&bindings).Error; err != nil {
		return false, err
	}
	for _, binding := range bindings {
		if _, err := validateExecutionMonitor(tx, bindingOwner(binding), now); err == nil {
			return true, nil
		} else if !errors.Is(err, errExecutionMonitor) && !errors.Is(err, gorm.ErrRecordNotFound) {
			return false, err
		}
	}
	return false, nil
}
