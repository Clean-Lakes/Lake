package ai

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// bindCatalogParentRestriction accepts only an actual host worker relation.
// A model cannot introduce a parent, substitute an owner or broaden role assets.
func (e *Engine) bindCatalogParentRestriction(ctx context.Context, execution SecurityExecutionContext, c Config) error {
	if e.worker == nil || e.worker.parent == nil || e.worker.runID != execution.Owner.ScopeID || execution.Owner.ScopeID == "" {
		return errExecutionOwner
	}
	parent, err := e.worker.parent.CurrentSecurityExecution(ctx, e.worker.parentID)
	if err != nil {
		return err
	}
	if !parent.Managed || parent.Task.ID != execution.Task.ID || parent.Owner.ScopeID != "" || parent.Owner.RootTurnID != execution.Owner.RootTurnID {
		return errExecutionOwner
	}
	roles := []string{}
	profileExecutor := false
	for _, tool := range e.sessionCatalog(ctx, execution.SessionID, c) {
		if spec, ok := security.LookupTool(tool.Name); ok {
			roles = append(roles, spec.Capabilities...)
			if spec.CommandProfileAllowed && (tool.Name == "shell" || tool.Name == "terminal_execute_command") {
				profileExecutor = true
			}
		}
	}
	if profileExecutor && c.sre != nil && c.sre.Role == SREExecutor {
		roles = append(roles, "service.restart")
	}
	ids := []string{}
	for _, asset := range c.Assets {
		ids = append(ids, asset.ID)
		if asset.Kind == "local" || asset.Kind == "database" && str(asset.Settings["driver"]) == "sqlite" || asset.Kind == "docker" && str(asset.Settings["ssh_asset_ref"]) == "" && strings.HasPrefix(str(asset.Settings["endpoint"]), "unix://") {
			roles = append(roles, "local.execute")
		}
	}
	slices.Sort(roles)
	roles = slices.Compact(roles)
	slices.Sort(ids)
	ids = slices.Compact(ids)
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			now := time.Now().UTC()
			if err := ValidateExecutionOwner(tx, parent.Owner, now); err != nil {
				return err
			}
			if err := ValidateExecutionOwner(tx, execution.Owner, now); err != nil {
				return err
			}
			tuple := security.PreparedOperation{Actor: "child", ProjectID: execution.ProjectID, SessionID: execution.SessionID, TaskID: execution.Task.ID, StoreID: storeID, RecoveryEpoch: epoch, GoalID: execution.GoalID, GoalRevision: execution.GoalRevision, PlanRevision: execution.PlanRevision, StepID: execution.StepID, StepRevision: execution.StepRevision, AttemptID: execution.AttemptID, RootTurnID: execution.Owner.RootTurnID, ChildScopeID: execution.Owner.ScopeID}
			ready, err := securityCanonicalStepReady(tx, tuple, false)
			if err != nil {
				return err
			}
			if !ready {
				return security.ErrConflict
			}
			policy, err := loadSecurityPolicy(tx, execution.ProjectID, storeID, epoch)
			if err != nil {
				return err
			}
			row := securityParentRestrictionRow{ProjectID: execution.ProjectID, SessionID: execution.SessionID, GoalID: execution.GoalID, GoalRevision: execution.GoalRevision, PlanRevision: execution.PlanRevision, StepID: execution.StepID, StepRevision: execution.StepRevision, AttemptID: execution.AttemptID, TaskID: execution.Task.ID, ScopeID: execution.Owner.ScopeID, StoreID: storeID, RecoveryEpoch: epoch, ParentOwner: js(parent.Owner), ResourceIDs: js(ids), RoleCapabilities: js(roles), AuthorityKind: "project_policy", AuthorityID: execution.ProjectID, AuthorityRevision: policy.Revision, Revision: 1}
			var old securityParentRestrictionRow
			err = tx.First(&old, "task_id = ? AND scope_id = ?", row.TaskID, row.ScopeID).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return tx.Create(&row).Error
			}
			if err != nil {
				return err
			}
			// The relation is immutable for the scope lifetime; policy/config changes
			// require a new host scope, never silently refresh a pending approval.
			if !securityParentScopeMatches(old, tuple) || old.StoreID != row.StoreID || old.RecoveryEpoch != row.RecoveryEpoch || old.ResourceIDs != row.ResourceIDs || old.RoleCapabilities != row.RoleCapabilities || old.AuthorityRevision != row.AuthorityRevision {
				return security.ErrConflict
			}
			var previous ExecutionOwner
			if decodeSecurityJSON(old.ParentOwner, &previous) != nil || previous.BindingID != parent.Owner.BindingID || previous.OwnerID != parent.Owner.OwnerID || previous.Generation != parent.Owner.Generation {
				return errExecutionOwner
			}
			return nil
		})
	})
}

func loadCatalogParentRestriction(tx *gorm.DB, o security.PreparedOperation, now time.Time) (out security.ParentRestriction, err error) {
	var row securityParentRestrictionRow
	if err = tx.First(&row, "task_id = ? AND scope_id = ? AND store_id = ? AND recovery_epoch = ?", o.TaskID, o.ChildScopeID, o.StoreID, o.RecoveryEpoch).Error; err != nil {
		return out, err
	}
	if !securityParentScopeMatches(row, o) {
		return out, security.ErrConflict
	}
	ready, readyErr := securityCanonicalStepReady(tx, o, false)
	if readyErr != nil {
		return out, readyErr
	}
	if !ready {
		return out, security.ErrConflict
	}
	if row.AuthorityKind != "project_policy" || row.AuthorityID != o.ProjectID || o.Actor != "child" || o.ChildScopeID == "" {
		return out, security.ErrConflict
	}
	var owner ExecutionOwner
	if err = decodeSecurityJSON(row.ParentOwner, &owner); err != nil {
		return out, err
	}
	var binding securityTaskBinding
	if err = tx.First(&binding, "id = ?", owner.BindingID).Error; err != nil {
		return out, err
	}
	owner.LeaseUntil = binding.LeaseUntil
	if owner.ScopeID != "" || owner.TaskID != o.TaskID || owner.RootTurnID != o.RootTurnID || owner.ExecutionRevision != o.ExecutionRevision {
		return out, errExecutionOwner
	}
	if err = ValidateExecutionOwner(tx, owner, now); err != nil {
		return out, err
	}
	policy, err := loadSecurityPolicy(tx, o.ProjectID, o.StoreID, o.RecoveryEpoch)
	if err != nil {
		return out, err
	}
	if policy.Revision != row.AuthorityRevision {
		return out, security.ErrConflict
	}
	var task securityTaskRow
	if err = tx.First(&task, "id = ?", o.TaskID).Error; err != nil {
		return out, err
	}
	var ids, roles []string
	if err = decodeSecurityJSON(row.ResourceIDs, &ids); err != nil {
		return out, err
	}
	if err = decodeSecurityJSON(row.RoleCapabilities, &roles); err != nil {
		return out, err
	}
	boundary := security.ExecutionBoundary{ID: "scope:" + row.ScopeID, Revision: row.Revision, ResourceIDs: ids}
	out = security.ParentRestriction{SharedTaskScope: true, ScopeID: row.ScopeID, OwnerBindingID: owner.BindingID, OwnerGeneration: owner.Generation, Task: task.task(), Boundary: &boundary, RoleCapabilities: roles, AuthorityValid: true, AuthorityID: "project:" + row.AuthorityID, AuthorityRevision: row.AuthorityRevision}
	return out, nil
}

func runningParentAuthorityValid(tx *gorm.DB, o security.PreparedOperation, now time.Time) (bool, error) {
	if o.Actor != "child" {
		return len(o.Parents) == 0, nil
	}
	parent, err := loadCatalogParentRestriction(tx, o, now)
	if err != nil {
		return false, err
	}
	return slices.Equal(o.Parents, security.FreezeParentBindings([]security.ParentRestriction{parent})), nil
}

func securityParentScopeMatches(row securityParentRestrictionRow, o security.PreparedOperation) bool {
	return row.GoalID != "" && row.GoalRevision > 0 && row.PlanRevision > 0 && row.StepRevision > 0 && row.AttemptID != "" && row.ProjectID == o.ProjectID && row.SessionID == o.SessionID && row.GoalID == o.GoalID && row.GoalRevision == o.GoalRevision && row.PlanRevision == o.PlanRevision && row.StepID == o.StepID && row.StepRevision == o.StepRevision && row.AttemptID == o.AttemptID && row.TaskID == o.TaskID && row.ScopeID == o.ChildScopeID && row.StoreID == o.StoreID && row.RecoveryEpoch == o.RecoveryEpoch
}
