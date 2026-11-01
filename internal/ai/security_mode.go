package ai

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

type securityRuntimeModeRow struct {
	ID                           int `gorm:"primaryKey"`
	StoreID, RecoveryEpoch, Mode string
	Revision                     int64
}

func (securityRuntimeModeRow) TableName() string { return "security_runtime_mode" }

type SecurityModeAction struct {
	ActorID          string `json:"-"`
	ActionID         string `json:"actionId"`
	ExpectedRevision int64  `json:"expectedRevision"`
	Mode             string `json:"mode"`
	ConfirmedDigest  string `json:"confirmedDigest"`
}
type SecurityModeStatus struct {
	Mode         string                       `json:"mode"`
	Revision     int64                        `json:"revision"`
	Digest       string                       `json:"digest"`
	Precondition string                       `json:"precondition"`
	Coverage     SecurityEnforcementReadiness `json:"coverage"`
}

func securityRuntimeModeTx(tx *gorm.DB, storeID, epoch string) (securityRuntimeModeRow, error) {
	var row securityRuntimeModeRow
	err := tx.First(&row, "id = 1").Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return securityRuntimeModeRow{ID: 1, StoreID: storeID, RecoveryEpoch: epoch, Mode: "legacy"}, nil
	}
	if err != nil {
		return row, err
	}
	if row.StoreID != storeID || row.RecoveryEpoch != epoch || row.Revision < 1 || row.Mode != "shadow" && row.Mode != "enforced" {
		return row, errors.New("security: runtime mode requires recovery confirmation")
	}
	return row, nil
}

// Host project identities come from the actual catalog, never request fields.
// The digest commits the complete policies, legacy classification and resource
// revisions checked again in the activation transaction under the Home barrier.
func securityModeSnapshotTx(tx *gorm.DB, storeID, epoch string, projects []string) (string, string, error) {
	ids := slices.Clone(projects)
	slices.Sort(ids)
	if len(ids) > 10000 || len(slices.Compact(slices.Clone(ids))) != len(ids) {
		return "", "", errSecurityAction
	}
	var manifest []any
	reason := "READY"
	for _, project := range ids {
		if project == "" {
			return "", "", errSecurityAction
		}
		var row securityProjectPolicyRow
		err := tx.First(&row, "project_id = ?", project).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			reason = "PROJECT_POLICY_CONFIRMATION_REQUIRED"
			manifest = append(manifest, []any{project, "missing"})
			continue
		}
		if err != nil {
			return "", "", err
		}
		manifest = append(manifest, row)
		policy, err := loadSecurityPolicy(tx, project, storeID, epoch)
		if err != nil {
			reason = "PROJECT_POLICY_CONFIRMATION_REQUIRED"
			continue
		}
		for _, id := range policy.ResourceIDs {
			var resource securityResourceRevisionRow
			if err = tx.First(&resource, "project_id = ? AND resource_id = ?", project, id).Error; err != nil {
				return "", "", err
			}
			manifest = append(manifest, []any{project, id, resource.StoreID, resource.RecoveryEpoch, resource.ConnectionRevision, resource.ConnectionDigest, resource.State})
			if resource.StoreID != storeID || resource.RecoveryEpoch != epoch || resource.State != "ready" {
				reason = "CATALOG_CONFIRMATION_REQUIRED"
			}
		}
	}
	var scopes []securitySessionTargetRow
	if err := tx.Order("session_id").Find(&scopes).Error; err != nil {
		return "", "", err
	}
	for _, scope := range scopes {
		manifest = append(manifest, []any{scope.SessionID, scope.Revision, scope.StoreID, scope.RecoveryEpoch, scope.LegacyState, scope.PendingResolution})
		if scope.StoreID != storeID || scope.RecoveryEpoch != epoch || scope.LegacyState == "legacy_unclassified" || scope.PendingResolution != "" && scope.PendingResolution != "null" {
			reason = "LEGACY_SCOPE_CONFIRMATION_REQUIRED"
		}
	}
	var legacy []securityLegacySessionPolicyRow
	if err := tx.Order("session_id").Find(&legacy).Error; err != nil {
		return "", "", err
	}
	for _, policy := range legacy {
		manifest = append(manifest, policy)
		if policy.StoreID != storeID || policy.RecoveryEpoch != epoch {
			reason = "LEGACY_POLICY_CONFIRMATION_REQUIRED"
		}
	}
	var unresolved []nativeOperation
	if err := tx.Where(securityUnresolvedOperationPredicate(map[string]bool{"orphan_state": true, "closure_state": true, "cancellation_state": true, "cancel_requested_at": true, "risk_resolved_at": true})).Order("id").Find(&unresolved).Error; err != nil {
		return "", "", err
	}
	for _, op := range unresolved {
		manifest = append(manifest, []any{op.ID, op.Status, op.OrphanState, op.ClosureState, op.CancellationState, op.CancelRequestedAt, op.RiskResolvedAt, op.DescriptorDigest})
		var descriptor security.PreparedOperation
		decodeErr := json.Unmarshal([]byte(op.SecurityDescriptor), &descriptor)
		digest, digestErr := security.OperationDigest(descriptor)
		if decodeErr != nil || digestErr != nil || digest != op.DescriptorDigest || descriptor.ID != op.ID || descriptor.TaskID != op.SecurityTaskID || descriptor.GoalID != op.GoalID || descriptor.SessionID != op.SessionID || descriptor.RootTurnID != op.RootTurnID || descriptor.StoreID != storeID || descriptor.RecoveryEpoch != epoch || descriptor.Proof == security.ProofOpaque || len(descriptor.Resources) == 0 {
			reason = "UNCLASSIFIED_OPERATION_EFFECTS"
			continue
		}
		if current, err := currentWorkOperationResourcesTx(tx, op); err != nil {
			return "", "", err
		} else if !current {
			reason = "UNCLASSIFIED_OPERATION_EFFECTS"
		}
	}
	return hash(js([]any{storeID, epoch, ids, manifest})), reason, nil
}

func (e *Engine) SecurityMode(ctx context.Context, projects []string) (out SecurityModeStatus, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	out.Coverage = SecurityEnforcementStatus()
	err = e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		row, err := securityRuntimeModeTx(tx, storeID, epoch)
		if err != nil {
			return err
		}
		out.Mode, out.Revision = row.Mode, row.Revision
		out.Digest, out.Precondition, err = securityModeSnapshotTx(tx, storeID, epoch, projects)
		return err
	})
	return out, err
}

func (e *Engine) SetSecurityMode(ctx context.Context, action SecurityModeAction, projects []string) (out SecurityModeStatus, err error) {
	if action.ActorID == "" || action.ActionID == "" || len(action.ActionID) > 256 || action.ExpectedRevision < 0 || action.Mode != "shadow" && action.Mode != "enforced" {
		return out, errSecurityAction
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	readiness, _ := currentSecurityEnforcementReadiness()
	if action.Mode == "enforced" && !readiness.Ready {
		return out, errors.New("security: " + readiness.Reason)
	}
	err = e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		if replay, err := securityActionReplay(tx, storeID, epoch, action.ActorID, action.ActionID, js(action), &out); replay || err != nil {
			return err
		}
		row, err := securityRuntimeModeTx(tx, storeID, epoch)
		if err != nil {
			return err
		}
		if row.Revision != action.ExpectedRevision || row.Mode == "enforced" && action.Mode != "enforced" {
			return security.ErrConflict
		}
		digest, reason, err := securityModeSnapshotTx(tx, storeID, epoch, projects)
		if err != nil {
			return err
		}
		if digest != action.ConfirmedDigest || action.Mode == "enforced" && reason != "READY" {
			return errors.New("security: confirm the current complete activation snapshot: " + reason)
		}
		if action.Mode == "enforced" {
			if err = raiseSecurityPolicyReaderGuard(tx, storeID, epoch); err != nil {
				return err
			}
		}
		before := row.Revision
		row.Revision++
		row.Mode = action.Mode
		if err = tx.Save(&row).Error; err != nil {
			return err
		}
		out = SecurityModeStatus{Mode: row.Mode, Revision: row.Revision, Digest: digest, Precondition: reason, Coverage: readiness}
		return securityActionRecord(tx, storeID, epoch, action.ActorID, action.ActionID, "mode.set", "home", js(action), before, row.Revision, out, time.Now().UTC())
	})
	return out, err
}

func activateRecoveredSecurityModeTx(tx *gorm.DB, storeID, epoch string) error {
	var previous securityRuntimeModeRow
	if err := tx.First(&previous, "id = 1").Error; err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	return tx.Save(&securityRuntimeModeRow{ID: 1, StoreID: storeID, RecoveryEpoch: epoch, Mode: "enforced", Revision: previous.Revision + 1}).Error
}

// Called only by the trusted host after a new project's catalog commit. It
// never rewrites an existing policy, deny, migration snapshot or task grant.
func (e *Engine) InitializeSecurityProject(ctx context.Context, projectID string) error {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		mode, err := securityRuntimeModeTx(tx, storeID, epoch)
		if err != nil {
			return err
		}
		if mode.Mode != "enforced" {
			return nil
		}
		var count int64
		if err = tx.Model(&securityProjectPolicyRow{}).Where("project_id = ?", projectID).Count(&count).Error; err != nil || count > 0 {
			return err
		}
		var resources []securityResourceRevisionRow
		if err = tx.Where("project_id = ? AND store_id = ? AND recovery_epoch = ? AND state = ?", projectID, storeID, epoch, "ready").Order("resource_id").Find(&resources).Error; err != nil {
			return err
		}
		policy := security.ProjectPolicy{ProjectID: projectID, SchemaVersion: security.SchemaVersion, Mode: "restricted"}
		for _, resource := range resources {
			policy.ResourceIDs = append(policy.ResourceIDs, resource.ResourceID)
		}
		caps := []string{"local.execute", "command.diagnostics", "service.restart"}
		for _, name := range security.RegisteredTools() {
			spec, _ := security.LookupTool(name)
			caps = append(caps, spec.Capabilities...)
		}
		slices.Sort(caps)
		caps = slices.Compact(caps)
		for _, capability := range caps {
			rule := security.Rule{Capability: capability, Effect: security.EffectAsk, Confirmation: security.ConfirmSingle}
			if slices.Contains([]string{"resource.list", "resource.resolve", "session.read", "task.read", "task.control"}, capability) {
				rule.Effect = security.EffectAllow
			}
			if security.TaskGrantable(capability, security.ProofStructured) || security.TaskGrantable(capability, security.ProofCommandProfile) {
				rule.Grantable = true
				rule.Confirmation = security.ConfirmEither
			}
			policy.Rules = append(policy.Rules, rule)
		}
		_, err = putSecurityProjectPolicy(tx, storeID, epoch, SecurityPolicyAction{ActorID: "host", ActionID: "default-project:" + projectID, ProjectID: projectID}, policy, time.Now().UTC())
		return err
	})
}

func (e *Engine) recordSecurityShadowCall(ctx context.Context, s *session, c Config, call Call, legacyAllowed bool) {
	if e.securityHome() == nil {
		return
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return
	}
	s.mu.Lock()
	sessionID, rootID := s.state.View.Session, s.state.View.RootTurnID
	s.mu.Unlock()
	_ = e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		mode, err := securityRuntimeModeTx(tx, storeID, epoch)
		if err != nil || mode.Mode != "shadow" {
			return err
		}
		// Old executions have no trustworthy goal/step/attempt/owner tuple. Do
		// not invent those identities just to obtain a positive shadow verdict.
		comparison := map[string]any{"tool": call.Name, "legacyExecutionSucceeded": legacyAllowed, "comparison": "missing_task_binding", "managedEffect": "deny", "reasonCode": security.ReasonGoalBindingRequired}
		action := "shadow:" + hash(sessionID+"\x00"+rootID+"\x00"+call.ID)
		if replay, err := securityActionReplay(tx, storeID, epoch, "host", action, js(comparison), &map[string]any{}); replay || err != nil {
			return err
		}
		return securityActionRecord(tx, storeID, epoch, "host", action, "shadow.compare", call.ID, js(comparison), 0, 0, comparison, time.Now().UTC(), configSecurityProject(c))
	})
}
