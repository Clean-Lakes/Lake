package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// SecurityPermit is an in-process handle. It cannot be constructed from JSON,
// serialized into model state, or reused to register a second operation.
type SecurityPermit struct {
	operation security.PreparedOperation
	digest    string
	owner     ExecutionOwner
	prepared  *SecurityPreparedOperation
}

func (p *SecurityPermit) Descriptor() (security.PreparedOperation, error) {
	if p == nil || p.digest == "" {
		return security.PreparedOperation{}, errors.New("security: permit required")
	}
	return security.CanonicalOperation(p.operation)
}

type securityPermitError struct{ Decision security.Decision }

func (e *securityPermitError) Error() string { return "security: " + string(e.Decision.ReasonCode) }

// withSecurityDispatchBarrier must enclose the original native-operation
// transaction. Restore/RotateRecoveryEpoch take the same Home mutex. Obtain
// adkStore before entering: lazy storage initialization also checks this mutex.
func (e *Engine) withSecurityDispatchBarrier(fn func() error) error {
	h := e.securityHome()
	if h == nil {
		return errors.New("security: explicit Home owner required")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.readOnly {
		return errors.New("security: execution owner unavailable")
	}
	control, err := ReadSecurityControl(h.Home)
	if err != nil {
		return err
	}
	if control.StoreID != h.control.StoreID || control.RecoveryEpoch != h.control.RecoveryEpoch || control.RuntimeRoot != h.control.RuntimeRoot || control.Gate != "open" || !control.StoreReady {
		return errors.New("security: recovery gate or identity mismatch")
	}
	return fn()
}

func securityOperationGoalReady(tx *gorm.DB, o security.PreparedOperation) (bool, error) {
	if o.Actor == "child" {
		var scope securityParentRestrictionRow
		if err := tx.First(&scope, "task_id = ? AND scope_id = ? AND store_id = ? AND recovery_epoch = ?", o.TaskID, o.ChildScopeID, o.StoreID, o.RecoveryEpoch).Error; err != nil {
			return false, err
		}
		if !securityParentScopeMatches(scope, o) {
			return false, nil
		}
	}
	return securityCanonicalStepReady(tx, o, o.Actor != "child")
}

func securityCanonicalStepReady(tx *gorm.DB, o security.PreparedOperation, requireSelected bool) (bool, error) {
	var row nativeWorkGoal
	if err := tx.First(&row, "id = ? AND session_id = ?", o.GoalID, o.SessionID).Error; err != nil {
		return false, err
	}
	var goal WorkGoal
	if err := decodeWorkGoal(row, &goal); err != nil {
		return false, err
	}
	goalReady := goal.Status == "running"
	if !requireSelected {
		goalReady = slices.Contains([]string{"running", "blocked", "waiting_user", "waiting_external"}, goal.Status)
	}
	if goal.closure == nil || !goalReady || requireSelected && goal.ActiveItemID != o.StepID || goal.closure.ProjectID != o.ProjectID || goal.closure.GoalRevision != o.GoalRevision || goal.closure.PlanRevision != o.PlanRevision {
		return false, nil
	}
	step, exists := goal.closure.Steps[o.StepID]
	if !exists || step.Revision != o.StepRevision || goal.closure.ActiveAttempts[o.StepID] != o.AttemptID {
		return false, nil
	}
	ready := false
	for _, item := range goal.Items {
		if item.ID == o.StepID && item.Status == "running" && workItemReady(goal.Items, item) {
			ready = true
		}
	}
	if !ready {
		return false, nil
	}
	var attempt workExecutionAttempt
	if err := tx.First(&attempt, "id = ? AND goal_id = ? AND step_id = ? AND security_task_id = ? AND root_turn_id = ?", o.AttemptID, o.GoalID, o.StepID, o.TaskID, o.RootTurnID).Error; err != nil {
		return false, err
	}
	return (attempt.State == "prepared" || attempt.State == "running") && attempt.SessionID == o.SessionID && attempt.ProjectID == o.ProjectID && attempt.GoalRevision == o.GoalRevision && attempt.PlanRevision == o.PlanRevision && attempt.StepRevision == o.StepRevision, nil
}

func securityReadOnlyCapability(capability string) bool {
	switch capability {
	case "resource.list", "resource.resolve", "file.read", "db.read", "cluster.read", "cluster.logs", "terminal.read", "command.diagnostics", "memory.read", "artifact.read", "session.read", "task.read", "workflow.read", "schedule.read", "mcp.discover", "network.fetch", "network.search":
		return true
	}
	return false
}

func loadSecurityEvaluation(tx *gorm.DB, o security.PreparedOperation, owner ExecutionOwner, now time.Time, ignoreOperationID ...string) (result security.EvaluationInput, returnedErr error) {
	phase := "owner binding"
	defer func() {
		if returnedErr != nil {
			returnedErr = fmt.Errorf("security evaluation %s: %w", phase, returnedErr)
		}
	}()
	in := security.EvaluationInput{Now: now, StoreID: owner.StoreID, RecoveryEpoch: owner.RecoveryEpoch, GateOpen: true, Operation: o, Owner: security.ExecutionOwner{ID: owner.OwnerID, Generation: owner.Generation, LeaseUntil: owner.LeaseUntil}}
	// Heartbeats renew a live generation without changing prepared descriptors.
	// Its actual current lease, not the preparation-time deadline, is authoritative.
	// An expired owner cannot renew, and a takeover changes generation, so this
	// refresh cannot resurrect a lost or fenced execution owner.
	var currentBinding securityTaskBinding
	if err := tx.First(&currentBinding, "id = ?", owner.BindingID).Error; err != nil {
		return in, err
	}
	if currentBinding.OwnerID != owner.OwnerID || currentBinding.OwnerGeneration != owner.Generation {
		return in, errExecutionOwner
	}
	owner.LeaseUntil = currentBinding.LeaseUntil
	in.Owner.LeaseUntil = currentBinding.LeaseUntil
	if err := ValidateExecutionOwner(tx, owner, now); err != nil {
		return in, err
	}
	if owner.TaskID != o.TaskID || owner.GoalID != o.GoalID || owner.SessionID != o.SessionID || owner.RootTurnID != o.RootTurnID || owner.ScopeID != o.ChildScopeID || owner.ExecutionRevision != o.ExecutionRevision {
		return in, errExecutionOwner
	}
	phase = "task"
	var task securityTaskRow
	if err := tx.First(&task, "id = ?", o.TaskID).Error; err != nil {
		return in, err
	}
	in.Task = task.task()
	if err := ValidateSecurityScheduleTaskSource(tx, o.TaskID, o.StoreID, o.RecoveryEpoch, now); err != nil {
		return in, err
	}
	phase = "current catalog"
	if err := applyCurrentCatalogSnapshot(tx, o, &in); err != nil {
		return in, err
	}
	var err error
	phase = "policy"
	in.Policy, err = loadSecurityPolicy(tx, o.ProjectID, o.StoreID, o.RecoveryEpoch)
	if err != nil {
		return in, err
	}
	phase = "goal contract"
	in.GoalReady, err = securityOperationGoalReady(tx, o)
	if err != nil {
		return in, err
	}
	in.RootTurnCurrent, in.ChildScopeCurrent = true, true // validated live owner binding above
	phase = "resource revision"
	for _, resource := range o.Resources {
		var row securityResourceRevisionRow
		if err = tx.First(&row, "project_id = ? AND resource_id = ? AND store_id = ? AND recovery_epoch = ?", o.ProjectID, resource.ID, o.StoreID, o.RecoveryEpoch).Error; err != nil {
			return in, err
		}
		in.Resources = append(in.Resources, security.ResourceRevision{ID: row.ResourceID, ConnectionRevision: row.ConnectionRevision, ConnectionDigest: row.ConnectionDigest, State: row.State, Local: row.Local, ConnectionIdentity: row.ConnectionIdentity})
	}
	if o.CommandProfileID != "" {
		if len(in.Resources) != 1 {
			return in, security.ErrConflict
		}
		target, err := loadSecurityCommandTarget(tx, o.ProjectID, in.Resources[0].ID, o.StoreID, o.RecoveryEpoch)
		if err != nil {
			return in, err
		}
		if !target.Enabled {
			return in, security.ErrConflict
		}
		in.CommandTargetRevision = target.Revision
	}
	var target securitySessionTargetRow
	err = tx.First(&target, "session_id = ?", o.SessionID).Error
	if err == nil {
		if target.ProjectID != o.ProjectID || target.StoreID != o.StoreID || target.RecoveryEpoch != o.RecoveryEpoch {
			return in, security.ErrConflict
		}
		in.TargetRevision = target.Revision
		var pending *SecurityPendingTarget
		if target.PendingResolution != "" {
			if err = json.Unmarshal([]byte(target.PendingResolution), &pending); err != nil {
				return in, err
			}
		}
		if len(o.Resources) > 0 && (pending != nil || target.LegacyState == "legacy_unclassified") {
			return in, errors.New("security: target resolution required")
		}
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return in, err
	}
	var boundaries []securityBoundaryRow
	if err = tx.Where("project_id = ? AND (session_id = '' OR session_id = ?) AND (task_id = '' OR task_id = ?)", o.ProjectID, o.SessionID, o.TaskID).Find(&boundaries).Error; err != nil {
		return in, err
	}
	for _, row := range boundaries {
		if row.StoreID != o.StoreID || row.RecoveryEpoch != o.RecoveryEpoch || row.Provenance == "legacy_unclassified" {
			return in, security.ErrConflict
		}
		var ids []string
		if err = json.Unmarshal([]byte(row.ResourceIDs), &ids); err != nil {
			return in, err
		}
		b := security.ExecutionBoundary{ID: row.ID, OwnerID: row.OwnerKind, Source: row.Provenance, Revision: row.Revision, ResourceIDs: ids, DenyLocal: row.DenyLocal}
		if !row.RestrictResources {
			// A local-only boundary does not restrict resource identity. Use the
			// frozen operation resources while retaining its deny-local constraint.
			b.ResourceIDs = nil
			for _, resource := range o.Resources {
				b.ResourceIDs = append(b.ResourceIDs, resource.ID)
			}
		}
		in.Boundaries = append(in.Boundaries, b)
	}
	var envelope securityTaskEnvelopeRow
	err = tx.First(&envelope, "task_id = ?", o.TaskID).Error
	if err == nil {
		if envelope.StoreID != o.StoreID || envelope.RecoveryEpoch != o.RecoveryEpoch {
			return in, security.ErrConflict
		}
		var value security.TaskEnvelope
		if err = decodeSecurityJSON(envelope.Data, &value); err != nil {
			return in, err
		}
		if value.Revision != envelope.Revision {
			return in, security.ErrConflict
		}
		in.Envelope = &value
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return in, err
	}
	// Child adapters must supply persisted role/parent authority bindings before
	// they can be enabled. Missing bindings deliberately reject, never inherit an
	// unrestricted parent snapshot or silently require a fabricated child grant.
	phase = "parent restriction"
	if o.Actor == "child" {
		parent, parentErr := loadCatalogParentRestriction(tx, o, now)
		if parentErr != nil {
			return in, parentErr
		}
		in.Parents = []security.ParentRestriction{parent}
	}
	if task.ParentTaskID != "" {
		return in, errors.New("security: child authority adapter not integrated")
	}
	var grants []securityTaskGrantRow
	if err = tx.Where("task_id = ? AND store_id = ? AND recovery_epoch = ?", o.TaskID, o.StoreID, o.RecoveryEpoch).Find(&grants).Error; err != nil {
		return in, err
	}
	for _, row := range grants {
		var g security.TaskGrant
		if err = decodeSecurityJSON(row.Data, &g); err != nil {
			return in, err
		}
		if g.ID != row.ID || g.TaskID != row.TaskID || g.GoalID != row.GoalID || g.SessionID != row.SessionID || g.ProjectID != row.ProjectID || g.StoreID != row.StoreID || g.RecoveryEpoch != row.RecoveryEpoch {
			return in, security.ErrConflict
		}
		if g.ParentAuthorityID != "" {
			return in, errors.New("security: parent authority adapter not integrated")
		}
		g.Revision, g.RemainingUses, g.Revoked, g.ExpiresAt = row.Revision, row.RemainingUses, row.Revoked, row.ExpiresAt
		in.Grants = append(in.Grants, g)
	}
	// Read the original native approval table. Missing fields in an old row stay
	// zero and cannot match the new descriptor. There is no second approval store.
	var approvals []struct {
		ID, StoreID, RecoveryEpoch, SecurityTaskID, SessionID, RootTurnID, ScopeID, DescriptorDigest, Status string
		ExecutionRevision                                                                                    int64
		CreatedAt, ExpiresAt                                                                                 time.Time
		Accepted, EnvelopeException                                                                          bool
	}
	if err = tx.Table("native_approvals").Where("session_id = ? AND root_turn_id = ? AND call_id = ? AND status = ? AND accepted = ?", o.SessionID, o.RootTurnID, o.CallID, "authorized", true).Find(&approvals).Error; err != nil {
		return in, err
	}
	for _, a := range approvals {
		in.Approvals = append(in.Approvals, security.SingleApproval{ID: a.ID, StoreID: a.StoreID, RecoveryEpoch: a.RecoveryEpoch, TaskID: a.SecurityTaskID, SessionID: a.SessionID, RootTurnID: a.RootTurnID, ChildScopeID: a.ScopeID, DescriptorDigest: a.DescriptorDigest, ExecutionRevision: a.ExecutionRevision, CreatedAt: a.CreatedAt, ExpiresAt: a.ExpiresAt, Authorized: true, EnvelopeException: a.EnvelopeException})
	}
	mutating := securityOperationMayMutate(o)
	if mutating && !security.PureTaskControl(o) {
		if err = CheckSecurityRecoveryWriteBlocks(tx, securityCatalogResources(o.Resources)); err != nil {
			return in, err
		}
		blockQuery := tx
		if len(ignoreOperationID) == 1 && ignoreOperationID[0] == o.ID {
			blockQuery = tx.Where("id <> ?", o.ID)
		}
		ids := securityCatalogResources(o.Resources)
		if len(ids) == 0 {
			ids = []string{""}
		}
		for _, id := range ids {
			if err = CheckResourceWriteBlock(blockQuery, id); err != nil {
				return in, err
			}
		}
	}

	if in.Policy.Mode == "legacy" {
		legacy, source, err := effectiveLegacyPolicyTx(tx, o.ProjectID, o.SessionID, o.StoreID, o.RecoveryEpoch)
		if err != nil {
			return in, err
		}
		in.LegacyPolicySourceID = source
		in.LegacyPolicyRevision = legacy.Revision
	}
	if err = applyLegacySessionPolicyTx(tx, &in); err != nil {
		return in, err
	}
	return in, nil
}

// AcquireSecurityPermitTx re-evaluates and consumes authority in the caller's
// original native-operation transaction. The caller MUST insert nativeOperation
// before committing, under withSecurityDispatchBarrier. A rollback restores
// approval, budget and audit together; a returned permit alone is not dispatch.
func AcquireSecurityPermitTx(tx *gorm.DB, o security.PreparedOperation, owner ExecutionOwner, now time.Time) (*SecurityPermit, error) {
	canonical, err := security.CanonicalOperation(o)
	if err != nil {
		return nil, err
	}
	in, err := loadSecurityEvaluation(tx, canonical, owner, now)
	if err != nil {
		return nil, err
	}
	decision := security.Evaluate(in)
	if decision.Effect != security.EffectAllow {
		return nil, &securityPermitError{Decision: decision}
	}
	grants, approvals := []string{}, []string{}
	for _, a := range decision.Authorities {
		if a.Kind == "task_grant" || a.Kind == "task_budget" {
			grants = append(grants, a.ID)
		}
		if a.Kind == "single_approval" {
			approvals = append(approvals, a.ID)
		}
	}
	slices.Sort(grants)
	grants = slices.Compact(grants)
	slices.Sort(approvals)
	approvals = slices.Compact(approvals)
	for _, id := range grants {
		var revision int64
		for _, ref := range canonical.GrantRevisions {
			if ref.ID == id {
				revision = ref.Revision
			}
		}
		result := tx.Model(&securityTaskGrantRow{}).Where("id = ? AND revision = ? AND revoked = ? AND remaining_uses > ? AND expires_at > ? AND recovery_epoch = ?", id, revision, false, 0, now, canonical.RecoveryEpoch).Update("remaining_uses", gorm.Expr("remaining_uses - 1"))
		if result.Error != nil {
			return nil, result.Error
		}
		if result.RowsAffected != 1 {
			return nil, security.ErrConflict
		}
	}
	for _, id := range approvals {
		result := tx.Model(&nativeApproval{}).Where("id = ? AND status = ? AND accepted = ? AND expires_at > ?", id, "authorized", true, now).Update("status", "consumed")
		if result.Error != nil {
			return nil, result.Error
		}
		if result.RowsAffected != 1 {
			return nil, security.ErrConflict
		}
		if err = tx.Create(&nativeEvidence{OperationID: canonical.ID, SessionID: canonical.SessionID, CallID: canonical.CallID, Tool: canonical.Tool, Status: "approved", Data: js(map[string]any{"approval_id": id, "descriptor_hash": decision.DescriptorDigest}), At: now}).Error; err != nil {
			return nil, err
		}
	}
	row := securityDecisionRow{ID: uid(), OperationID: canonical.ID, StoreID: canonical.StoreID, RecoveryEpoch: canonical.RecoveryEpoch, TaskID: canonical.TaskID, ProjectID: canonical.ProjectID, SessionID: canonical.SessionID, DescriptorDigest: decision.DescriptorDigest, Effect: string(decision.Effect), ReasonCode: string(decision.ReasonCode), Authorities: js(decision.Authorities), GrantUses: js(grants), At: now}
	if err = tx.Create(&row).Error; err != nil {
		return nil, err
	}
	return &SecurityPermit{operation: canonical, digest: decision.DescriptorDigest, owner: owner}, nil
}

// RefundSecurityPermitTx is only for a committed, original not_executed result.
// Unknown/failed/cancel-requested results never return the shared use budget.
func RefundSecurityPermitTx(tx *gorm.DB, operationID string) error {
	var op nativeOperation
	if err := tx.First(&op, "id = ?", operationID).Error; err != nil {
		return err
	}
	if op.Status != "not_executed" {
		return errors.New("security: only proven not_executed can refund")
	}
	var decision securityDecisionRow
	if err := tx.First(&decision, "operation_id = ?", operationID).Error; err != nil {
		return err
	}
	if decision.Refunded {
		return nil
	}
	var grants []string
	if err := json.Unmarshal([]byte(decision.GrantUses), &grants); err != nil {
		return err
	}
	result := tx.Model(&securityDecisionRow{}).Where("id = ? AND refunded = ?", decision.ID, false).Update("refunded", true)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return security.ErrConflict
	}
	for _, id := range grants {
		if err := tx.Model(&securityTaskGrantRow{}).Where("id = ? AND store_id = ? AND recovery_epoch = ?", id, decision.StoreID, decision.RecoveryEpoch).Update("remaining_uses", gorm.Expr("remaining_uses + 1")).Error; err != nil {
			return err
		}
	}
	return nil
}

func (e *Engine) securityPolicyConfigured(projectID string) (bool, error) {
	// Empty project identities cannot be configured through the trusted policy
	// API. Standalone legacy/library helpers need not bootstrap a store to ask.
	if projectID == "" && e.securityHome() == nil {
		return false, nil
	}
	store, err := e.adkStore()
	if err != nil {
		return false, err
	}
	var count int64
	err = store.DB.Model(&securityProjectPolicyRow{}).Where("project_id = ?", projectID).Count(&count).Error
	if err == nil && e.securityHome() != nil {
		h := e.securityHome()
		h.mu.Lock()
		storeID, epoch := h.control.StoreID, h.control.RecoveryEpoch
		h.mu.Unlock()
		mode, modeErr := securityRuntimeModeTx(store.DB, storeID, epoch)
		if modeErr != nil {
			return false, modeErr
		}
		if mode.Mode == "enforced" && count == 0 {
			return false, errors.New("security: enforced Home requires a confirmed project policy")
		}
	}
	return count > 0, err
}

func securityPermitContext(ctx context.Context, p *SecurityPermit) context.Context {
	return context.WithValue(ctx, securityPermitContextKey{}, p)
}

type securityPermitContextKey struct{}

func requireSecurityPermit(ctx context.Context, operationID string) (*SecurityPermit, error) {
	p, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	if p == nil || p.operation.ID != operationID || p.digest == "" {
		return nil, fmt.Errorf("security: permit required")
	}
	return p, nil
}

// ValidateSecurityPermitAtIO verifies the already-consumed authority immediately
// before handoff. It never consumes a second approval or another grant use.
func (e *Engine) ValidateSecurityPermitAtIO(ctx context.Context, projectID, sessionID string) error {
	return e.validateSecurityPermitAtIO(ctx, projectID, sessionID, nil)
}

func (e *Engine) validateSecurityPermitAtIO(ctx context.Context, projectID, sessionID string, capture func(SecurityCatalogView) error) error {
	permit, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	if permit == nil || permit.digest == "" || permit.operation.ProjectID != projectID || permit.operation.SessionID != sessionID {
		return errors.New("security: original registered permit required")
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	if permit.operation.StoreID != storeID || permit.operation.RecoveryEpoch != epoch {
		return security.ErrConflict
	}
	return e.withSecurityDispatchBarrier(func() error {
		var latestCatalog SecurityCatalogView
		checkErr := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			if err := checkSuperContextTx(ctx, tx); err != nil {
				return err
			}
			now := time.Now().UTC()
			o := permit.operation
			digest, err := security.OperationDigest(o)
			if err != nil || digest != permit.digest {
				return security.ErrConflict
			}
			var operation nativeOperation
			if err = tx.First(&operation, "id = ? AND status = ?", o.ID, "dispatched").Error; err != nil {
				return err
			}
			if operation.DescriptorDigest != digest || operation.SecurityDescriptor == "" || operation.StoreID != storeID || operation.RecoveryEpoch != epoch || operation.SessionID != sessionID || operation.GoalID != o.GoalID || operation.SecurityTaskID != o.TaskID || operation.OwnerID != o.OwnerID || operation.OwnerGeneration != o.OwnerGeneration || operation.OrphanState != "" && operation.RiskResolvedAt == nil {
				return security.ErrConflict
			}
			var registered security.PreparedOperation
			if err = decodeSecurityJSON(operation.SecurityDescriptor, &registered); err != nil {
				return err
			}
			registeredDigest, err := security.OperationDigest(registered)
			if err != nil || registeredDigest != digest {
				return security.ErrConflict
			}
			var record securityDecisionRow
			if err = tx.First(&record, "operation_id = ? AND descriptor_digest = ? AND effect = ?", o.ID, digest, string(security.EffectAllow)).Error; err != nil {
				return err
			}
			if record.Refunded || record.StoreID != storeID || record.RecoveryEpoch != epoch {
				return security.ErrConflict
			}
			var sources []security.AuthoritySource
			if err = decodeSecurityJSON(record.Authorities, &sources); err != nil {
				return err
			}
			if len(sources) == 0 {
				return errors.New("security: original authority evidence missing")
			}
			bound, err := e.bindCurrentCatalogSnapshot(ctx, tx, o)
			if err != nil {
				return err
			}
			if value, ok := bound.Get("lake_security_catalog"); ok {
				latestCatalog, _ = value.(SecurityCatalogView)
			}
			input, err := loadSecurityEvaluation(bound, o, permit.owner, now, o.ID)
			if err != nil {
				return err
			}
			usedGrants, usedApprovals := map[string]bool{}, map[string]bool{}
			for _, source := range sources {
				switch source.Kind {
				case "project":
					if source.ID != projectID || source.Revision != input.Policy.Revision {
						return security.ErrConflict
					}
				case "task_grant", "task_budget":
					var grant securityTaskGrantRow
					if err = tx.First(&grant, "id = ?", source.ID).Error; err != nil {
						return err
					}
					if grant.Revoked || grant.Revision != source.Revision || !grant.ExpiresAt.After(now) || grant.StoreID != storeID || grant.RecoveryEpoch != epoch {
						return security.ErrConflict
					}
					usedGrants[source.ID] = true
				case "single_approval":
					var approval nativeApproval
					if err = tx.First(&approval, "id = ?", source.ID).Error; err != nil {
						return err
					}
					if approval.Status != "consumed" || !approval.Accepted || approval.StoreID != storeID || approval.RecoveryEpoch != epoch || approval.SecurityTaskID != o.TaskID || approval.DescriptorDigest != digest || approval.SessionID != sessionID || approval.RootTurnID != o.RootTurnID || approval.ScopeID != o.ChildScopeID {
						return security.ErrConflict
					}
					var proofs []nativeEvidence
					if err = tx.Where("operation_id = ? AND status = ?", o.ID, "approved").Find(&proofs).Error; err != nil {
						return err
					}
					matched := false
					for _, proof := range proofs {
						data := objJSON(proof.Data)
						if data["approval_id"] == source.ID && data["descriptor_hash"] == digest {
							matched = true
						}
					}
					if !matched {
						return errors.New("security: approval was not consumed by this operation")
					}
					input.Approvals = append(input.Approvals, security.SingleApproval{ID: approval.ID, StoreID: storeID, RecoveryEpoch: epoch, TaskID: approval.SecurityTaskID, SessionID: approval.SessionID, RootTurnID: approval.RootTurnID, ChildScopeID: approval.ScopeID, DescriptorDigest: digest, ExecutionRevision: approval.ExecutionRevision, CreatedAt: approval.CreatedAt, ExpiresAt: approval.ExpiresAt, Authorized: true, EnvelopeException: approval.EnvelopeException})
					usedApprovals[source.ID] = true
				default:
					return errors.New("security: unsupported original authority source")
				}
			}
			grants := input.Grants[:0]
			for _, grant := range input.Grants {
				if usedGrants[grant.ID] {
					grant.RemainingUses++
					grants = append(grants, grant)
				}
			}
			input.Grants = grants
			approvals := input.Approvals[:0]
			for _, approval := range input.Approvals {
				if usedApprovals[approval.ID] {
					approvals = append(approvals, approval)
				}
			}
			input.Approvals = approvals
			if decision := security.Evaluate(input); decision.Effect != security.EffectAllow {
				return &securityPermitError{Decision: decision}
			}
			return nil
		})
		if checkErr != nil {
			return checkErr
		}
		if capture != nil {
			return capture(latestCatalog)
		}
		return nil
	})
}
