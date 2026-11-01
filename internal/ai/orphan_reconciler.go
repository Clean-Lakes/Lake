package ai

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

var ErrUnresolvedResourceEffect = errors.New("security: unresolved operation blocks conflicting resource writes")

// ExecutionCleanup contains only the original, durable operation and handle.
// It is not a command channel. The host chooses a registered adapter from the
// original tool/configuration identity; models cannot supply cleanup methods.
type ExecutionCleanup struct {
	OperationID, Tool, ResourceID, Handle string
	ResourceConnectionRevision            int64
	DescriptorDigest                      string
	Resources                             []security.ResourceRevision
	OwnerID                               string
	OwnerGeneration                       int64
}

type CancellationObservation string

const (
	CancellationRequested   CancellationObservation = "requested"
	CancellationConfirmed   CancellationObservation = "confirmed"
	CancellationUnsupported CancellationObservation = "unsupported"
	CancellationUnknown     CancellationObservation = "unknown"
)

type OrphanObservation struct {
	Stopped bool
	// EffectsKnown requires a trusted adapter to establish actual effects, not
	// merely that its connection or local process has stopped.
	EffectsKnown bool
	Status       string
	Evidence     string
}

// Cancellation must be idempotent for a registered handle. It may be retried
// after interruption. Observation must not execute new agent commands.
type OrphanCleanupAdapter interface {
	Cancel(context.Context, ExecutionCleanup) (CancellationObservation, error)
	Observe(context.Context, ExecutionCleanup) (OrphanObservation, error)
}

type OrphanAdapterResolver func(tool, resourceID string) OrphanCleanupAdapter

func orphanedExecution(tx *gorm.DB, op nativeOperation, storeID, epoch string, now time.Time) (bool, error) {
	if op.OwnerKind == "human" {
		return false, nil
	}
	if op.SecurityTaskID != "" {
		monitored, err := operationHasValidMonitor(tx, op, now)
		if err != nil {
			return false, err
		}
		if monitored {
			return false, nil
		}
	}
	if op.OwnerKind != "agent" || op.GoalID == "" || op.StepID == "" || op.AttemptID == "" || op.SecurityTaskID == "" || op.OwnerID == "" || op.OwnerGeneration < 1 || op.StoreID != storeID || op.RecoveryEpoch != epoch || !op.OwnerLeaseUntil.After(now) {
		return true, nil
	}
	scopeID, scopeKnown := operationOwnerScope(op)
	if !scopeKnown {
		return true, nil
	}
	var row securityTaskRow
	err := tx.First(&row, "id = ?", op.SecurityTaskID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	valid, err := runningOperationAuthorityValid(tx, op, now)
	if err != nil {
		return false, err
	}
	if !valid {
		return true, nil
	}
	task := row.task()
	if task.Validate(now) != nil || task.State == security.TaskPaused || task.State.Terminal() || task.StoreID != storeID || task.RecoveryEpoch != epoch || task.ExecutionRevision != op.ExecutionRevision || task.GoalID != op.GoalID || task.SessionID != op.SessionID || task.ProjectID != op.ProjectID {
		return true, nil
	}
	if err := validateSecurityTaskAncestors(tx, task, now); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) || errors.Is(err, security.ErrTaskBinding) || errors.Is(err, security.ErrTaskExpired) || errors.Is(err, security.ErrTaskEnded) {
			return true, nil
		}
		return false, err
	}
	if scopeID != "" {
		var parent securityTaskBinding
		err := tx.Where("task_id = ? AND root_turn_id = ? AND scope_id = '' AND state = ? AND execution_revision = ?", op.SecurityTaskID, op.RootTurnID, "active", op.ExecutionRevision).First(&parent).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return true, nil
		}
		if err != nil {
			return false, err
		}
	}
	var binding securityTaskBinding
	err = tx.Where("task_id = ? AND root_turn_id = ? AND scope_id = ? AND owner_id = ? AND owner_generation = ? AND execution_revision = ? AND state = ? AND lease_until > ?", op.SecurityTaskID, op.RootTurnID, scopeID, op.OwnerID, op.OwnerGeneration, op.ExecutionRevision, "active", now).First(&binding).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return true, nil
	}
	return false, err
}

// A running job retains the authority actually consumed at dispatch, not every
// candidate grant seen during preparation. Consuming the last use is not a
// revocation; expiry, explicit revoke, epoch and policy revisions still apply.
func runningOperationAuthorityValid(tx *gorm.DB, op nativeOperation, now time.Time) (bool, error) {
	if op.SecurityDescriptor == "" || op.DescriptorDigest == "" {
		return false, nil
	}
	var descriptor security.PreparedOperation
	if json.Unmarshal([]byte(op.SecurityDescriptor), &descriptor) != nil {
		return false, nil
	}
	digest, err := security.OperationDigest(descriptor)
	if err != nil || digest != op.DescriptorDigest || descriptor.ID != op.ID || descriptor.TaskID != op.SecurityTaskID || descriptor.ProjectID != op.ProjectID || descriptor.GoalID != op.GoalID || descriptor.SessionID != op.SessionID || descriptor.RootTurnID != op.RootTurnID || descriptor.StoreID != op.StoreID || descriptor.RecoveryEpoch != op.RecoveryEpoch || descriptor.Tool != op.Tool || descriptor.CallID != op.CallID || descriptor.ArgumentsDigest != op.ArgsHash || descriptor.GoalRevision != op.GoalRevision || descriptor.PlanRevision != op.PlanRevision || descriptor.StepID != op.StepID || descriptor.StepRevision != op.StepRevision || descriptor.AttemptID != op.AttemptID || descriptor.OwnerID != op.OwnerID || descriptor.OwnerGeneration != op.OwnerGeneration || descriptor.ExecutionRevision != op.ExecutionRevision {
		return false, nil
	}
	scope, known := operationOwnerScope(op)
	if !known || scope != descriptor.ChildScopeID {
		return false, nil
	}
	if op.ResourceID != "" {
		matched := false
		for _, resource := range descriptor.Resources {
			if resource.ID == op.ResourceID && (op.ResourceConnectionRevision == 0 || op.ResourceConnectionRevision == resource.ConnectionRevision) {
				matched = true
			}
		}
		if !matched {
			return false, nil
		}
	}
	var goalRow nativeWorkGoal
	if err = tx.First(&goalRow, "id = ? AND session_id = ?", op.GoalID, op.SessionID).Error; errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	var goal WorkGoal
	if decodeWorkGoal(goalRow, &goal) != nil || goal.closure == nil || goal.Status == "paused" || workTerminal(goal.Status) || goal.closure.ProjectID != op.ProjectID || goal.closure.GoalRevision != op.GoalRevision || goal.closure.PlanRevision != op.PlanRevision || goal.closure.Steps[op.StepID].Revision != op.StepRevision || goal.closure.ActiveAttempts[op.StepID] != op.AttemptID {
		return false, nil
	}
	var decision securityDecisionRow
	err = tx.First(&decision, "operation_id = ?", op.ID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if decision.Effect != string(security.EffectAllow) || decision.DescriptorDigest != digest || decision.TaskID != op.SecurityTaskID || decision.StoreID != op.StoreID || decision.RecoveryEpoch != op.RecoveryEpoch {
		return false, nil
	}
	var policy securityProjectPolicyRow
	err = tx.First(&policy, "project_id = ?", descriptor.ProjectID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !policy.Confirmed || policy.StoreID != op.StoreID || policy.RecoveryEpoch != op.RecoveryEpoch || policy.Revision != descriptor.PolicyRevision {
		return false, nil
	}
	if valid, err := runningParentAuthorityValid(tx, descriptor, now); err != nil || !valid {
		return false, err
	}
	if valid, err := runningCatalogAuthorityValid(tx, descriptor); err != nil || !valid {
		return false, err
	}
	if err := ValidateSecurityScheduleTaskSource(tx, op.SecurityTaskID, op.StoreID, op.RecoveryEpoch, now); err != nil {
		return false, nil
	}
	var authorities []security.AuthoritySource
	if json.Unmarshal([]byte(decision.Authorities), &authorities) != nil || len(authorities) == 0 {
		return false, nil
	}
	for _, authority := range authorities {
		switch authority.Kind {
		case "project":
			if authority.ID != policy.ProjectID || authority.Revision != policy.Revision {
				return false, nil
			}
		case "task_grant", "task_budget":
			var grant securityTaskGrantRow
			err = tx.First(&grant, "id = ?", authority.ID).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return false, nil
			}
			if err != nil {
				return false, err
			}
			if grant.Revoked || grant.Revision != authority.Revision || !grant.ExpiresAt.After(now) || grant.StoreID != op.StoreID || grant.RecoveryEpoch != op.RecoveryEpoch || grant.TaskID != op.SecurityTaskID || grant.GoalID != op.GoalID || grant.ProjectID != op.ProjectID || grant.SessionID != op.SessionID {
				return false, nil
			}
		case "single_approval":
			var approval nativeApproval
			err = tx.First(&approval, "id = ?", authority.ID).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return false, nil
			}
			if err != nil {
				return false, err
			}
			if approval.Status != "consumed" || !approval.Accepted || approval.StoreID != op.StoreID || approval.RecoveryEpoch != op.RecoveryEpoch || approval.SecurityTaskID != op.SecurityTaskID || approval.DescriptorDigest != digest || approval.RootTurnID != op.RootTurnID || approval.SessionID != op.SessionID {
				return false, nil
			}
		default:
			return false, nil
		}
	}
	return true, nil
}

// MarkOrphanedExecutions is the transaction-only discovery/fencing phase. It
// never performs network calls, kills a process or changes execution results.
func MarkOrphanedExecutions(tx *gorm.DB, storeID, epoch string, now time.Time, limit int) ([]nativeOperation, error) {
	if storeID == "" || epoch == "" || now.IsZero() || limit < 1 || limit > 1000 {
		return nil, errSecurityAction
	}
	var operations []nativeOperation
	if err := tx.Where("(status IN ? OR (orphan_state <> '' AND risk_resolved_at IS NULL)) AND (closure_state IS NULL OR closure_state <> ?)", []string{"dispatched", "unknown"}, "reconciled").Order("id").Limit(limit).Find(&operations).Error; err != nil {
		return nil, err
	}
	return markOrphanedBatch(tx, storeID, epoch, now, operations)
}

func markOrphanedBatch(tx *gorm.DB, storeID, epoch string, now time.Time, operations []nativeOperation) ([]nativeOperation, error) {
	var orphaned []nativeOperation
	for _, op := range operations {
		if pending, err := securityRecoveryOperationPendingTx(tx, op); err != nil {
			return nil, err
		} else if pending {
			continue
		}
		orphan, err := orphanedExecution(tx, op, storeID, epoch, now)
		if err != nil {
			return nil, err
		}
		if !orphan {
			continue
		}
		if op.OrphanState == "" {
			state := "orphaned"
			scopeID, scopeKnown := operationOwnerScope(op)
			if op.OwnerKind != "agent" || !scopeKnown || op.GoalID == "" || op.StepID == "" || op.AttemptID == "" || op.SecurityTaskID == "" {
				state = "manual_review"
			}
			result := tx.Model(&nativeOperation{}).Where("id = ? AND (orphan_state IS NULL OR orphan_state = '')", op.ID).Updates(map[string]any{"orphan_state": state})
			if result.Error != nil {
				return nil, result.Error
			}
			if result.RowsAffected != 1 {
				continue
			}
			op.OrphanState = state
			if err = tx.Create(&nativeEvidence{OperationID: op.ID, SessionID: op.SessionID, CallID: op.CallID, Tool: op.Tool, Status: "orphaned", Data: js(map[string]any{"reason": "execution ownership unavailable", "owner_generation": op.OwnerGeneration}), At: now}).Error; err != nil {
				return nil, err
			}
			if op.SecurityTaskID != "" && op.OwnerID != "" && op.OwnerGeneration > 0 {
				query := tx.Model(&securityTaskBinding{}).Where("task_id = ? AND root_turn_id = ? AND owner_id = ? AND owner_generation = ?", op.SecurityTaskID, op.RootTurnID, op.OwnerID, op.OwnerGeneration)
				if scopeKnown {
					query = query.Where("scope_id = ?", scopeID)
				}
				if err = query.Updates(map[string]any{"state": "fenced", "owner_generation": gorm.Expr("owner_generation + 1"), "lease_until": now, "updated_at": now}).Error; err != nil {
					return nil, err
				}
				if err = tx.Model(&securityTaskBinding{}).Where("task_id = ? AND kind = ? AND execution_id = ? AND state = ?", op.SecurityTaskID, "monitor", op.ID, "monitoring").Updates(map[string]any{"state": "fenced", "owner_generation": gorm.Expr("owner_generation + 1"), "lease_until": now, "updated_at": now}).Error; err != nil {
					return nil, err
				}
			}
		}
		orphaned = append(orphaned, op)
	}
	return orphaned, nil
}

// CheckResourceWriteBlock reads the original operation ledger. Unknown resource
// identity is a global write conflict, not permission to guess a display target.
// Reads and safe cleanup are evaluated independently by their own authority.
func CheckResourceWriteBlock(tx *gorm.DB, resourceID string) error {
	var operations []nativeOperation
	query := tx.Select("id", "resource_id", "security_descriptor", "descriptor_digest", "store_id", "recovery_epoch", "security_task_id", "goal_id", "session_id", "root_turn_id").Where("(status IN ? OR (orphan_state <> '' AND risk_resolved_at IS NULL)) AND (closure_state IS NULL OR closure_state <> ?) AND (risk IS NULL OR risk <> ?)", []string{"dispatched", "unknown"}, "reconciled", "readonly")
	if err := query.Find(&operations).Error; err != nil {
		return err
	}
	if resourceID == "" && len(operations) > 0 {
		return ErrUnresolvedResourceEffect
	}
	for _, op := range operations {
		if op.ResourceID == resourceID && op.ResourceID != "" {
			return ErrUnresolvedResourceEffect
		}
		if op.SecurityDescriptor == "" {
			if op.ResourceID == "" {
				return ErrUnresolvedResourceEffect
			}
			continue
		}
		var descriptor security.PreparedOperation
		if json.Unmarshal([]byte(op.SecurityDescriptor), &descriptor) != nil {
			return ErrUnresolvedResourceEffect
		}
		digest, err := security.OperationDigest(descriptor)
		if err != nil || digest != op.DescriptorDigest || descriptor.ID != op.ID || descriptor.GoalID != op.GoalID || descriptor.SessionID != op.SessionID || descriptor.RootTurnID != op.RootTurnID || descriptor.TaskID != op.SecurityTaskID || descriptor.StoreID != op.StoreID || descriptor.RecoveryEpoch != op.RecoveryEpoch || len(descriptor.Resources) == 0 {
			return ErrUnresolvedResourceEffect
		}
		if descriptor.Proof == security.ProofOpaque {
			return ErrUnresolvedResourceEffect
		}
		for _, resource := range descriptor.Resources {
			if resource.ID == resourceID {
				return ErrUnresolvedResourceEffect
			}
		}
	}
	return nil
}

// ReconcileOrphanedExecutions must be driven at startup and every heartbeat by
// the Home owner. DB locks are released before any cancellation/observation I/O.
// Legacy/unowned handles are reported but never automatically cancelled.
func ReconcileOrphanedExecutions(ctx context.Context, db *gorm.DB, storeID, epoch string, now time.Time, resolver OrphanAdapterResolver) error {
	if storeID == "" || epoch == "" || now.IsZero() {
		return errSecurityAction
	}
	// Keyset traversal prevents a page of healthy long-lived jobs from hiding
	// later orphaned jobs. Each page is short; no DB lock survives cleanup I/O.
	after := ""
	for {
		var operations []nativeOperation
		var last string
		var count int
		if err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var page []nativeOperation
			if err := tx.Where("id > ? AND (status IN ? OR (orphan_state <> '' AND risk_resolved_at IS NULL)) AND (closure_state IS NULL OR closure_state <> ?)", after, []string{"dispatched", "unknown"}, "reconciled").Order("id").Limit(1000).Find(&page).Error; err != nil {
				return err
			}
			count = len(page)
			if count == 0 {
				return nil
			}
			last = page[count-1].ID
			var err error
			operations, err = markOrphanedBatch(tx, storeID, epoch, now, page)
			return err
		}); err != nil {
			return err
		}
		if err := reconcileOrphanBatch(ctx, db, now, resolver, operations); err != nil {
			return err
		}
		if count < 1000 {
			return nil
		}
		after = last
	}
}

func reconcileOrphanBatch(ctx context.Context, db *gorm.DB, now time.Time, resolver OrphanAdapterResolver, operations []nativeOperation) error {
	for _, op := range operations {
		if err := ctx.Err(); err != nil {
			return err
		}
		var recoveryLinked bool
		if err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var err error
			recoveryLinked, err = securityRecoveryOperationPendingTx(tx, op)
			return err
		}); err != nil {
			return err
		}
		if recoveryLinked {
			continue
		}
		if op.OwnerKind != "agent" || op.Handle == "" || op.GoalID == "" || op.StepID == "" || op.AttemptID == "" || op.SecurityTaskID == "" || op.OwnerID == "" || op.OwnerGeneration < 1 {
			continue
		}
		if _, known := operationOwnerScope(op); !known {
			continue
		}
		var adapter OrphanCleanupAdapter
		if resolver != nil {
			adapter = resolver(op.Tool, op.ResourceID)
		}
		if adapter == nil {
			continue
		}
		cleanup := ExecutionCleanup{OperationID: op.ID, Tool: op.Tool, ResourceID: op.ResourceID, Handle: op.Handle, OwnerID: op.OwnerID, OwnerGeneration: op.OwnerGeneration, ResourceConnectionRevision: op.ResourceConnectionRevision, DescriptorDigest: op.DescriptorDigest}
		var descriptor security.PreparedOperation
		if op.SecurityDescriptor != "" && json.Unmarshal([]byte(op.SecurityDescriptor), &descriptor) == nil {
			if digest, err := security.OperationDigest(descriptor); err == nil && digest == op.DescriptorDigest {
				cleanup.Resources = descriptor.Resources
			}
		}
		if op.CancellationState != string(CancellationConfirmed) && op.CancellationState != string(CancellationUnsupported) && (op.CancelRequestedAt == nil || !op.CancelRequestedAt.Add(ExecutionOwnerHeartbeat).After(now)) {
			claimed := db.WithContext(ctx).Model(&nativeOperation{}).Where("id = ? AND (cancel_requested_at IS NULL OR cancel_requested_at <= ?) AND (closure_state IS NULL OR closure_state <> ?)", op.ID, now.Add(-ExecutionOwnerHeartbeat), "reconciled").Updates(map[string]any{"cancel_requested_at": now, "cancellation_state": string(CancellationRequested)})
			if claimed.Error != nil {
				return claimed.Error
			}
			if claimed.RowsAffected == 1 {
				state, err := adapter.Cancel(ctx, cleanup)
				if err != nil {
					state = CancellationUnknown
				}
				switch state {
				case CancellationRequested, CancellationConfirmed, CancellationUnsupported, CancellationUnknown:
				default:
					state = CancellationUnknown
				}
				if err = db.WithContext(ctx).Model(&nativeOperation{}).Where("id = ? AND cancel_requested_at = ?", op.ID, now).Update("cancellation_state", string(state)).Error; err != nil {
					return err
				}
			}
		}
		observation, err := adapter.Observe(ctx, cleanup)
		if err != nil || !observation.Stopped || !observation.EffectsKnown || observation.Evidence == "" {
			continue
		}
		switch observation.Status {
		case "succeeded", "failed", "not_executed":
		default:
			continue
		}
		// Proof is kept on nativeEvidence; original unknown/failed status and
		// handles remain available. Reconciliation only closes the risk.
		if err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			result := tx.Model(&nativeOperation{}).Where("id = ? AND owner_id = ? AND owner_generation = ? AND (closure_state IS NULL OR closure_state <> ?)", op.ID, op.OwnerID, op.OwnerGeneration, "reconciled").Updates(map[string]any{"closure_state": "reconciled", "orphan_state": "reconciled", "risk_resolved_at": now})
			if result.Error != nil || result.RowsAffected == 0 {
				return result.Error
			}
			// Adapter output may contain credentials or private remote text. The
			// audit records a digest and the typed observation, never raw output.
			return tx.Create(&nativeEvidence{OperationID: op.ID, SessionID: op.SessionID, CallID: op.CallID, Tool: op.Tool, Status: "reconciled", Data: js(map[string]any{"observed_status": observation.Status, "proof_digest": hash(observation.Evidence), "stopped": true, "effects_known": true}), At: now}).Error
		}); err != nil {
			return err
		}
	}
	return nil
}
