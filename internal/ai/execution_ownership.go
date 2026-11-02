package ai

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

const (
	ExecutionOwnerLease     = 15 * time.Second
	ExecutionOwnerHeartbeat = 5 * time.Second
)

var errExecutionOwner = errors.New("security: execution owner missing, expired or fenced")

// ExecutionOwner is host-internal context. It cannot grant an operation: a
// dispatch must additionally check current goal/step, gate, policy and grant in
// the same transaction that validates this token and inserts nativeOperation.
type ExecutionOwner struct {
	BindingID, TaskID, GoalID, SessionID, RootTurnID, ScopeID string
	StoreID, RecoveryEpoch, OwnerID, OwnerKind                string
	ExecutionRevision, Generation                             int64
	LeaseUntil                                                time.Time
}

func bindingOwner(b securityTaskBinding) ExecutionOwner {
	return ExecutionOwner{BindingID: b.ID, TaskID: b.TaskID, GoalID: b.GoalID, SessionID: b.SessionID, RootTurnID: b.RootTurnID, ScopeID: b.ScopeID, StoreID: b.StoreID, RecoveryEpoch: b.RecoveryEpoch, OwnerID: b.OwnerID, OwnerKind: b.OwnerKind, ExecutionRevision: b.ExecutionRevision, Generation: b.OwnerGeneration, LeaseUntil: b.LeaseUntil}
}

func operationOwnerScope(op nativeOperation) (string, bool) {
	var identity RunIdentity
	if op.Identity == "" || json.Unmarshal([]byte(op.Identity), &identity) != nil || identity.SessionID == "" || identity.RootTurnID == "" || identity.SessionID != op.SessionID || identity.RootTurnID != op.RootTurnID {
		return "", false
	}
	return identity.ScopeID, true
}

// Original RunIdentity already includes the host-owned child scope. Until the
// explicit owner-binding column is present, use that immutable identity rather
// than assuming a process owner/generation identifies one parallel branch.
func ownedOperationIDs(tx *gorm.DB, owner ExecutionOwner) ([]string, error) {
	var operations []nativeOperation
	if err := tx.Where("security_task_id = ? AND root_turn_id = ? AND owner_id = ? AND owner_generation = ? AND status IN ?", owner.TaskID, owner.RootTurnID, owner.OwnerID, owner.Generation, []string{"dispatched", "unknown"}).Find(&operations).Error; err != nil {
		return nil, err
	}
	var ids []string
	for _, op := range operations {
		if scope, ok := operationOwnerScope(op); ok && scope == owner.ScopeID {
			ids = append(ids, op.ID)
		}
	}
	return ids, nil
}

func acquireExecutionOwner(tx *gorm.DB, bindingID, ownerID, kind string, expectedGeneration int64, now time.Time) (ExecutionOwner, error) {
	if bindingID == "" || ownerID == "" || len(ownerID) > 256 || now.IsZero() || expectedGeneration < 0 || kind != "agent" {
		return ExecutionOwner{}, errExecutionOwner
	}
	var b securityTaskBinding
	if err := tx.First(&b, "id = ?", bindingID).Error; err != nil {
		return ExecutionOwner{}, err
	}
	var row securityTaskRow
	if err := tx.First(&row, "id = ?", b.TaskID).Error; err != nil {
		return ExecutionOwner{}, err
	}
	if err := securityTaskGoalCurrent(tx, row); err != nil {
		return ExecutionOwner{}, err
	}
	task := row.task()
	if err := task.Validate(now); err != nil {
		return ExecutionOwner{}, err
	}
	if err := validateSecurityTaskAncestors(tx, task, now); err != nil {
		return ExecutionOwner{}, err
	}
	if task.State != security.TaskActive || b.State != "active" || b.StoreID != task.StoreID || b.RecoveryEpoch != task.RecoveryEpoch || b.ExecutionRevision != task.ExecutionRevision || b.OwnerGeneration != expectedGeneration {
		return ExecutionOwner{}, errExecutionOwner
	}
	if b.OwnerID != "" && b.LeaseUntil.After(now) {
		return ExecutionOwner{}, errExecutionOwner
	}
	deadline := now.Add(ExecutionOwnerLease)
	if task.ExpiresAt.Before(deadline) {
		deadline = task.ExpiresAt
	}
	generation := b.OwnerGeneration + 1
	result := tx.Model(&securityTaskBinding{}).Where("id = ? AND owner_generation = ? AND state = ? AND (owner_id = '' OR lease_until <= ?)", b.ID, expectedGeneration, "active", now).Updates(map[string]any{"owner_id": ownerID, "owner_kind": kind, "owner_generation": generation, "lease_until": deadline, "updated_at": now})
	if result.Error != nil {
		return ExecutionOwner{}, result.Error
	}
	if result.RowsAffected != 1 {
		return ExecutionOwner{}, errExecutionOwner
	}
	b.OwnerID, b.OwnerKind, b.OwnerGeneration, b.LeaseUntil = ownerID, kind, generation, deadline
	return bindingOwner(b), nil
}

// ValidateExecutionOwner must be called in the dispatch transaction. Looking at
// token.LeaseUntil alone is insufficient after revocation, pause or a new turn.
func ValidateExecutionOwner(tx *gorm.DB, owner ExecutionOwner, now time.Time) error {
	if owner.OwnerID == "" || owner.Generation < 1 || owner.OwnerKind != "agent" || now.IsZero() || !owner.LeaseUntil.After(now) {
		return errExecutionOwner
	}
	var b securityTaskBinding
	if err := tx.First(&b, "id = ?", owner.BindingID).Error; err != nil {
		return err
	}
	if b.State != "active" || b.TaskID != owner.TaskID || b.GoalID != owner.GoalID || b.SessionID != owner.SessionID || b.RootTurnID != owner.RootTurnID || b.ScopeID != owner.ScopeID || b.StoreID != owner.StoreID || b.RecoveryEpoch != owner.RecoveryEpoch || b.OwnerID != owner.OwnerID || b.OwnerKind != "agent" || b.OwnerGeneration != owner.Generation || b.ExecutionRevision != owner.ExecutionRevision || !b.LeaseUntil.After(now) {
		return errExecutionOwner
	}
	var row securityTaskRow
	if err := tx.First(&row, "id = ?", owner.TaskID).Error; err != nil {
		return err
	}
	if err := securityTaskGoalCurrent(tx, row); err != nil {
		return err
	}
	task := row.task()
	if err := task.Validate(now); err != nil {
		return err
	}
	if err := validateSecurityTaskAncestors(tx, task, now); err != nil {
		return err
	}
	if task.State != security.TaskActive || task.GoalID != owner.GoalID || task.SessionID != owner.SessionID || task.StoreID != owner.StoreID || task.RecoveryEpoch != owner.RecoveryEpoch || task.ExecutionRevision != owner.ExecutionRevision {
		return errExecutionOwner
	}
	if owner.ScopeID != "" {
		var parent securityTaskBinding
		if err := tx.Where("task_id = ? AND root_turn_id = ? AND scope_id = '' AND state = ? AND execution_revision = ?", owner.TaskID, owner.RootTurnID, "active", owner.ExecutionRevision).First(&parent).Error; err != nil {
			return errExecutionOwner
		}
	}
	return nil
}

// Refresh only the lease of the same live generation; never revive a fence or
// adopt a replacement owner when a worker waited before its initial bind.
func refreshExecutionOwnerLease(tx *gorm.DB, owner ExecutionOwner, now time.Time) (ExecutionOwner, error) {
	var row securityTaskBinding
	if err := tx.First(&row, "id = ?", owner.BindingID).Error; err != nil {
		return owner, err
	}
	if row.OwnerID != owner.OwnerID || row.OwnerGeneration != owner.Generation {
		return owner, errExecutionOwner
	}
	owner.LeaseUntil = row.LeaseUntil
	return owner, ValidateExecutionOwner(tx, owner, now)
}

func renewExecutionOwner(tx *gorm.DB, owner ExecutionOwner, now time.Time) (ExecutionOwner, error) {
	if err := ValidateExecutionOwner(tx, owner, now); err != nil {
		return owner, err
	}
	var task securityTaskRow
	if err := tx.First(&task, "id = ?", owner.TaskID).Error; err != nil {
		return owner, err
	}
	deadline := now.Add(ExecutionOwnerLease)
	if task.ExpiresAt.Before(deadline) {
		deadline = task.ExpiresAt
	}
	result := tx.Model(&securityTaskBinding{}).Where("id = ? AND owner_id = ? AND owner_generation = ? AND lease_until > ? AND state = ?", owner.BindingID, owner.OwnerID, owner.Generation, now, "active").Updates(map[string]any{"lease_until": deadline, "updated_at": now})
	if result.Error != nil {
		return owner, result.Error
	}
	if result.RowsAffected != 1 {
		return owner, errExecutionOwner
	}
	// The original operation ledger carries the same ownership snapshot. Do not
	// refresh command/grant/task deadlines while maintaining this heartbeat.
	ids, err := ownedOperationIDs(tx, owner)
	if err != nil {
		return owner, err
	}
	if len(ids) > 0 {
		if err := tx.Model(&nativeOperation{}).Where("id IN ?", ids).Update("owner_lease_until", deadline).Error; err != nil {
			return owner, err
		}
	}
	owner.LeaseUntil = deadline
	return owner, nil
}

func fenceExecutionOwner(tx *gorm.DB, owner ExecutionOwner, now time.Time) error {
	if owner.BindingID == "" || owner.OwnerID == "" || owner.Generation < 1 || now.IsZero() {
		return errExecutionOwner
	}
	result := tx.Model(&securityTaskBinding{}).Where("id = ? AND owner_id = ? AND owner_generation = ?", owner.BindingID, owner.OwnerID, owner.Generation).Updates(map[string]any{"state": "fenced", "owner_generation": gorm.Expr("owner_generation + 1"), "lease_until": now, "updated_at": now})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return errExecutionOwner
	}
	ids, err := ownedOperationIDs(tx, owner)
	if err != nil {
		return err
	}
	filtered := ids[:0]
	for _, id := range ids {
		var op nativeOperation
		if err := tx.First(&op, "id = ?", id).Error; err != nil {
			return err
		}
		monitored, err := operationHasValidMonitor(tx, op, now)
		if err != nil {
			return err
		}
		if !monitored {
			filtered = append(filtered, id)
		}
	}
	ids = filtered
	if len(ids) == 0 {
		return nil
	}
	return tx.Model(&nativeOperation{}).Where("id IN ?", ids).Updates(map[string]any{"orphan_state": "orphaned", "owner_lease_until": now}).Error
}

func (e *Engine) AcquireExecutionOwner(ctx context.Context, taskID, rootTurnID, scopeID, ownerID string, executionRevision, expectedGeneration int64) (out ExecutionOwner, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		b, err := bindSecurityTaskTurn(tx, taskID, storeID, epoch, rootTurnID, scopeID, executionRevision, time.Now().UTC())
		if err != nil {
			return err
		}
		out, err = acquireExecutionOwner(tx, b.ID, ownerID, "agent", expectedGeneration, time.Now().UTC())
		return err
	})
	return out, err
}

func (e *Engine) RenewExecutionOwner(ctx context.Context, owner ExecutionOwner) (out ExecutionOwner, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	if owner.StoreID != storeID || owner.RecoveryEpoch != epoch {
		return out, errExecutionOwner
	}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error { out, err = renewExecutionOwner(tx, owner, time.Now().UTC()); return err })
	return out, err
}

func (e *Engine) FenceExecutionOwner(ctx context.Context, owner ExecutionOwner) error {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	if owner.StoreID != storeID || owner.RecoveryEpoch != epoch {
		return errExecutionOwner
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error { return fenceExecutionOwner(tx, owner, time.Now().UTC()) })
}
