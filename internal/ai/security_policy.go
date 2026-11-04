package ai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

type securityProjectPolicyRow struct {
	ProjectID              string `gorm:"primaryKey"`
	StoreID, RecoveryEpoch string
	Revision               int64
	Mode, Data             string
	Confirmed              bool
}

func (securityProjectPolicyRow) TableName() string { return "security_project_policies" }

type securityTaskGrantRow struct {
	ID                                   string `gorm:"primaryKey"`
	TaskID, GoalID, ProjectID, SessionID string `gorm:"index"`
	StoreID, RecoveryEpoch               string
	Revision, RemainingUses              int64
	ExpiresAt                            time.Time `gorm:"index"`
	Revoked                              bool
	Data                                 string
}

func (securityTaskGrantRow) TableName() string { return "security_task_grants" }

type securityResourceRevisionRow struct {
	ProjectID                                       string `gorm:"primaryKey"`
	ResourceID                                      string `gorm:"primaryKey"`
	StoreID, RecoveryEpoch, ConnectionDigest, State string
	ConnectionRevision                              int64
	Local                                           bool
	Kind, MetadataDigest, CredentialIDs, ChangeID   string
	ConnectionIdentity                              string
}

func (securityResourceRevisionRow) TableName() string { return "security_resource_revisions" }

type securityTaskEnvelopeRow struct {
	TaskID                       string `gorm:"primaryKey"`
	StoreID, RecoveryEpoch, Data string
	Revision                     int64
}

func (securityTaskEnvelopeRow) TableName() string { return "security_task_envelopes" }

type securityDecisionRow struct {
	ID                                                   string `gorm:"primaryKey"`
	OperationID                                          string `gorm:"uniqueIndex"`
	StoreID, RecoveryEpoch, TaskID, ProjectID, SessionID string
	DescriptorDigest, Effect, ReasonCode, Authorities    string
	GrantUses                                            string
	Refunded                                             bool
	At                                                   time.Time
}

func (securityDecisionRow) TableName() string { return "security_decisions" }

type securityLegacySessionPolicyRow struct {
	SessionID                                       string `gorm:"primaryKey"`
	ProjectID, StoreID, RecoveryEpoch, Source, Data string
	Revision                                        int64
}

func (securityLegacySessionPolicyRow) TableName() string { return "security_legacy_session_policies" }

func securityPolicyModels() []any {
	return []any{&securityProjectPolicyRow{}, &securityTaskGrantRow{}, &securityResourceRevisionRow{}, &securityTaskEnvelopeRow{}, &securityDecisionRow{}, &securityLegacySessionPolicyRow{}}
}

func decodeSecurityJSON(raw string, out any) error {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("security: trailing authority data")
	}
	return nil
}

type SecurityPolicyAction struct {
	ActorID, ActionID, ProjectID string
	ExpectedRevision             int64
}

func validPolicyAction(a SecurityPolicyAction) bool {
	return strings.TrimSpace(a.ActorID) != "" && len(a.ActorID) <= 256 && strings.TrimSpace(a.ActionID) != "" && len(a.ActionID) <= 256 && a.ProjectID != "" && a.ExpectedRevision >= 0
}

func securityActionReplay(tx *gorm.DB, storeID, epoch, actor, action, request string, result any) (bool, error) {
	var event securityAuthorityEvent
	err := tx.First(&event, "action_key = ?", hash(storeID+"\x00"+epoch+"\x00"+actor+"\x00"+action)).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if event.RequestHash != hash(request) {
		return false, security.ErrConflict
	}
	return true, json.Unmarshal([]byte(event.Result), result)
}

func securityActionRecord(tx *gorm.DB, storeID, epoch, actor, action, kind, object, request string, before, after int64, result any, now time.Time, projectIDs ...string) error {
	projectID := ""
	if len(projectIDs) == 1 {
		projectID = projectIDs[0]
	} else {
		var fields map[string]json.RawMessage
		if json.Unmarshal([]byte(js(result)), &fields) == nil {
			_ = json.Unmarshal(fields["ProjectID"], &projectID)
			if projectID == "" {
				_ = json.Unmarshal(fields["projectId"], &projectID)
			}
		}
	}
	return tx.Create(&securityAuthorityEvent{ID: uid(), ActionKey: hash(storeID + "\x00" + epoch + "\x00" + actor + "\x00" + action), RequestHash: hash(request), StoreID: storeID, RecoveryEpoch: epoch, ActorID: actor, ActionID: action, Kind: kind, ObjectID: object, BeforeRevision: before, AfterRevision: after, Result: js(result), At: now, ProjectID: projectID}).Error
}

func putSecurityProjectPolicy(tx *gorm.DB, storeID, epoch string, a SecurityPolicyAction, p security.ProjectPolicy, now time.Time) (security.ProjectPolicy, error) {
	if !validPolicyAction(a) || now.IsZero() || storeID == "" || epoch == "" || p.ProjectID != a.ProjectID || p.SchemaVersion != 1 || p.Mode != "restricted" && p.Mode != "compatible" && p.Mode != "legacy" {
		return p, errSecurityAction
	}
	request := js(struct {
		Kind   string
		Action SecurityPolicyAction
		Policy security.ProjectPolicy
	}{"policy.put", a, p})
	var replay security.ProjectPolicy
	if ok, err := securityActionReplay(tx, storeID, epoch, a.ActorID, a.ActionID, request, &replay); ok || err != nil {
		return replay, err
	}
	for _, r := range p.Rules {
		if !security.KnownCapability(r.Capability) || r.Effect != security.EffectAllow && r.Effect != security.EffectAsk && r.Effect != security.EffectDeny {
			return p, errSecurityAction
		}
		if r.Effect == security.EffectAsk && r.Confirmation != security.ConfirmSingle && r.Confirmation != security.ConfirmTask && r.Confirmation != security.ConfirmEither {
			return p, errSecurityAction
		}
	}
	var old securityProjectPolicyRow
	err := tx.First(&old, "project_id = ?", a.ProjectID).Error
	create := errors.Is(err, gorm.ErrRecordNotFound)
	if err != nil && !create {
		return p, err
	}
	if create && a.ExpectedRevision != 0 || !create && (old.Revision != a.ExpectedRevision || old.StoreID != storeID || old.RecoveryEpoch != epoch) {
		return p, security.ErrConflict
	}
	p.StoreID, p.RecoveryEpoch, p.Revision, p.Confirmed = storeID, epoch, a.ExpectedRevision+1, true
	row := securityProjectPolicyRow{ProjectID: p.ProjectID, StoreID: storeID, RecoveryEpoch: epoch, Revision: p.Revision, Mode: p.Mode, Confirmed: true, Data: js(p)}
	if create {
		err = tx.Create(&row).Error
	} else {
		changed := tx.Model(&securityProjectPolicyRow{}).Where("project_id = ? AND revision = ?", p.ProjectID, a.ExpectedRevision).Updates(map[string]any{"store_id": storeID, "recovery_epoch": epoch, "revision": row.Revision, "mode": row.Mode, "confirmed": true, "data": row.Data})
		err = changed.Error
		if err == nil && changed.RowsAffected != 1 {
			err = security.ErrConflict
		}
	}
	if err != nil {
		return p, err
	}
	return p, securityActionRecord(tx, storeID, epoch, a.ActorID, a.ActionID, "policy.put", p.ProjectID, request, a.ExpectedRevision, p.Revision, p, now)
}

func loadSecurityPolicy(tx *gorm.DB, projectID, storeID, epoch string) (security.ProjectPolicy, error) {
	var row securityProjectPolicyRow
	if err := tx.First(&row, "project_id = ? AND store_id = ? AND recovery_epoch = ? AND confirmed = ?", projectID, storeID, epoch, true).Error; err != nil {
		return security.ProjectPolicy{}, err
	}
	var policy security.ProjectPolicy
	if err := decodeSecurityJSON(row.Data, &policy); err != nil {
		return policy, err
	}
	if policy.Revision != row.Revision || policy.StoreID != row.StoreID || policy.RecoveryEpoch != row.RecoveryEpoch || policy.ProjectID != row.ProjectID || policy.Mode != row.Mode || !policy.Confirmed {
		return policy, security.ErrConflict
	}
	return policy, nil
}

type SecurityTaskGrantAction struct {
	BackgroundPolicy      string
	Action                SecurityTaskAction
	ExpectedGrantRevision int64
	Grant                 security.TaskGrant
}

func issueSecurityTaskGrant(tx *gorm.DB, storeID, epoch string, in SecurityTaskGrantAction, now time.Time) (security.TaskGrant, error) {
	a, g := in.Action, in.Grant
	if !validSecurityAction(a) || a.TaskID == "" || a.ExpectedRevision < 1 || in.ExpectedGrantRevision != 0 || g.ID != "" || now.IsZero() {
		return g, errSecurityAction
	}
	request := js(struct {
		Kind  string
		Input SecurityTaskGrantAction
	}{"grant.issue", in})
	var replay security.TaskGrant
	if ok, err := securityActionReplay(tx, storeID, epoch, a.ActorID, a.ActionID, request, &replay); ok || err != nil {
		return replay, err
	}
	var row securityTaskRow
	if err := tx.First(&row, "id = ? AND goal_id = ? AND project_id = ? AND session_id = ?", a.TaskID, a.GoalID, a.ProjectID, a.SessionID).Error; err != nil {
		return g, err
	}
	task := row.task()
	background := in.BackgroundPolicy
	if background == "" {
		background = row.BackgroundPolicy
	}
	if background == "" {
		background = "foreground_only"
	}
	if background != "foreground_only" && background != "monitored_background" {
		return g, errSecurityAction
	}

	if task.Validate(now) != nil || task.State != security.TaskActive || task.StateRevision != a.ExpectedRevision || task.StoreID != storeID || task.RecoveryEpoch != epoch || !g.ExpiresAt.After(now) || g.ExpiresAt.After(task.ExpiresAt) || g.ExpiresAt.Sub(now) > 4*time.Hour || g.RemainingUses < 1 || g.RemainingUses > 10000 || len(g.Capabilities) == 0 || !securityGrantTargetShape(g) || g.ParentAuthorityID != "" {
		return g, errSecurityAction
	}
	if len(g.AllowedChildScopes) > 64 {
		return g, errSecurityAction
	}
	for _, scope := range g.AllowedChildScopes {
		var binding securityTaskBinding
		if scope == "" {
			return g, errSecurityAction
		}
		scopeErr := tx.First(&binding, "task_id = ? AND scope_id = ? AND store_id = ? AND recovery_epoch = ?", task.ID, scope, storeID, epoch).Error
		if errors.Is(scopeErr, gorm.ErrRecordNotFound) {
			allowed, err := securityTaskAllowsFutureChildScope(tx, task.ID, scope, storeID, epoch)
			if err != nil {
				return g, err
			}
			if !allowed {
				return g, errSecurityAction
			}
			continue
		}
		if scopeErr != nil {
			return g, scopeErr
		}
		if binding.State != "active" || !binding.LeaseUntil.After(now) {
			return g, errExecutionOwner
		}
	}
	policy, err := loadSecurityPolicy(tx, a.ProjectID, storeID, epoch)
	if err != nil {
		return g, err
	}
	for i, r := range g.Resources {
		if !slices.Contains(policy.ResourceIDs, r.ID) || policy.DenyLocal && r.Local {
			return g, errSecurityAction
		}
		var current securityResourceRevisionRow
		if err := tx.First(&current, "project_id = ? AND resource_id = ? AND store_id = ? AND recovery_epoch = ?", a.ProjectID, r.ID, storeID, epoch).Error; err != nil {
			return g, err
		}
		if current.State != "ready" || current.ConnectionRevision != r.ConnectionRevision || current.ConnectionDigest != r.ConnectionDigest || current.Local != r.Local || r.State != "ready" {
			return g, security.ErrConflict
		}
		if r.ConnectionIdentity != "" && r.ConnectionIdentity != current.ConnectionIdentity {
			return g, security.ErrConflict
		}
		g.Resources[i].ConnectionIdentity = current.ConnectionIdentity
	}
	proof := security.ProofStructured
	if len(g.CommandProfiles) > 0 {
		proof = security.ProofCommandProfile
	}
	for _, profile := range g.CommandProfiles {
		if !security.ValidateCommandProfileScope(profile) {
			return g, errSecurityAction
		}
	}
	if slices.Contains(g.Capabilities, "service.restart") && len(g.ServiceIDs) == 0 {
		return g, errSecurityAction
	}
	for _, capability := range g.Capabilities {
		if !security.TaskGrantable(capability, proof) {
			return g, errSecurityAction
		}
		resourceIDs := []string{}
		for _, resource := range g.Resources {
			resourceIDs = append(resourceIDs, resource.ID)
		}
		if len(resourceIDs) == 0 {
			resourceIDs = []string{""}
		}
		for _, resourceID := range resourceIDs {
			rule, matched := security.ResolveCapabilityRule(policy.Rules, capability, resourceID)
			if !matched || !(rule.Effect == security.EffectAllow || rule.Effect == security.EffectAsk && rule.Grantable && (rule.Confirmation == security.ConfirmTask || rule.Confirmation == security.ConfirmEither)) || !security.GrantLimitsFitRule(g.Limits, rule, capability) {
				return g, errSecurityAction
			}
		}
	}
	g.ID, g.TaskID, g.GoalID, g.ProjectID, g.SessionID, g.StoreID, g.RecoveryEpoch, g.Revision, g.Revoked = uid(), task.ID, task.GoalID, task.ProjectID, task.SessionID, storeID, epoch, 1, false
	g.CreatedAt = now
	g.BackgroundPolicy = background
	if err = freezeSecurityGrantCommandTargets(tx, storeID, epoch, a.ProjectID, &g, false); err != nil {
		return g, err
	}
	var existingEnvelope securityTaskEnvelopeRow
	err = tx.First(&existingEnvelope, "task_id = ?", task.ID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		ids := make([]string, 0, len(g.Resources))
		for _, r := range g.Resources {
			ids = append(ids, r.ID)
		}
		envelope := security.TaskEnvelope{CommandTargetRevisions: slices.Clone(g.CommandTargetRevisions), BudgetGrantIDs: []string{g.ID}, Revision: 1, Resources: slices.Clone(g.Resources), ResourceIDs: ids, Capabilities: slices.Clone(g.Capabilities), CommandProfiles: slices.Clone(g.CommandProfiles), ServiceIDs: slices.Clone(g.ServiceIDs), Limits: g.Limits, BackgroundPolicy: background}
		if err = tx.Create(&securityTaskEnvelopeRow{TaskID: task.ID, StoreID: storeID, RecoveryEpoch: epoch, Revision: 1, Data: js(envelope)}).Error; err != nil {
			return g, err
		}
	} else if err != nil {
		return g, err
	} else {
		var envelope security.TaskEnvelope
		if err = decodeSecurityJSON(existingEnvelope.Data, &envelope); err != nil {
			return g, err
		}
		if existingEnvelope.StoreID != storeID || existingEnvelope.RecoveryEpoch != epoch || envelope.Revision != existingEnvelope.Revision || !security.GrantWithinEnvelope(g, envelope) {
			return g, errors.New("security: explicit task scope expansion required")
		}
		oldBackground := envelope.BackgroundPolicy
		if oldBackground == "" {
			oldBackground = "foreground_only"
		}
		if background != oldBackground {
			return g, errors.New("security: background consent requires explicit envelope change")
		}
		envelope.BudgetGrantIDs = append(envelope.BudgetGrantIDs, g.ID)
		envelope.Revision++
		if err = tx.Model(&securityTaskEnvelopeRow{}).Where("task_id = ? AND revision = ?", task.ID, existingEnvelope.Revision).Updates(map[string]any{"revision": envelope.Revision, "data": js(envelope)}).Error; err != nil {
			return g, err
		}
	}
	oldBackground := row.BackgroundPolicy
	if oldBackground == "" {
		oldBackground = "foreground_only"
	}
	if oldBackground != background {
		changed := tx.Model(&securityTaskRow{}).Where("id = ? AND state_revision = ? AND state = ?", row.ID, a.ExpectedRevision, security.TaskActive).Updates(map[string]any{"background_policy": background, "state_revision": gorm.Expr("state_revision + 1")})
		if changed.Error != nil {
			return g, changed.Error
		}
		if changed.RowsAffected != 1 {
			return g, security.ErrConflict
		}
	}
	g.CreatedAt = now
	g.BackgroundPolicy = background
	grantRow := securityTaskGrantRow{ID: g.ID, TaskID: g.TaskID, GoalID: g.GoalID, ProjectID: g.ProjectID, SessionID: g.SessionID, StoreID: storeID, RecoveryEpoch: epoch, Revision: 1, RemainingUses: g.RemainingUses, ExpiresAt: g.ExpiresAt, Data: js(g)}
	if err = tx.Create(&grantRow).Error; err != nil {
		return g, err
	}
	return g, securityActionRecord(tx, storeID, epoch, a.ActorID, a.ActionID, "grant.issue", g.ID, request, 0, 1, g, now)
}

func revokeSecurityTaskGrant(tx *gorm.DB, storeID, epoch string, a SecurityTaskAction, grantID string, expectedGrantRevision int64, now time.Time) error {
	if !validSecurityAction(a) || grantID == "" || expectedGrantRevision < 1 {
		return errSecurityAction
	}
	request := js(struct {
		Kind     string
		Action   SecurityTaskAction
		Grant    string
		Revision int64
	}{"grant.revoke", a, grantID, expectedGrantRevision})
	var replay bool
	if ok, err := securityActionReplay(tx, storeID, epoch, a.ActorID, a.ActionID, request, &replay); ok || err != nil {
		return err
	}
	result := tx.Model(&securityTaskGrantRow{}).Where("id = ? AND task_id = ? AND goal_id = ? AND project_id = ? AND session_id = ? AND store_id = ? AND recovery_epoch = ? AND revision = ?", grantID, a.TaskID, a.GoalID, a.ProjectID, a.SessionID, storeID, epoch, expectedGrantRevision).Updates(map[string]any{"revoked": true, "revision": expectedGrantRevision + 1})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return security.ErrConflict
	}
	return securityActionRecord(tx, storeID, epoch, a.ActorID, a.ActionID, "grant.revoke", grantID, request, expectedGrantRevision, expectedGrantRevision+1, true, now, a.ProjectID)
}

func (e *Engine) PutSecurityProjectPolicy(ctx context.Context, a SecurityPolicyAction, p security.ProjectPolicy) (out security.ProjectPolicy, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		if guardErr := raiseSecurityPolicyReaderGuard(tx, storeID, epoch); guardErr != nil {
			return guardErr
		}
		out, err = putSecurityProjectPolicy(tx, storeID, epoch, a, p, time.Now().UTC())
		return err
	})
	return out, err
}

func raiseSecurityPolicyReaderGuard(tx *gorm.DB, storeID, epoch string) error {
	result := tx.Exec("UPDATE security_schema_meta SET minimum_reader_version = MAX(minimum_reader_version, ?) WHERE id = 1 AND store_id = ? AND recovery_epoch = ? AND migration_state = ? AND schema_version = ?", security.ReaderVersion, storeID, epoch, "ready", security.SchemaVersion)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return errors.New("security: reader guard binding required before authoritative policy")
	}
	return nil
}
func (e *Engine) IssueSecurityTaskGrant(ctx context.Context, in SecurityTaskGrantAction) (out security.TaskGrant, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		out, err = issueSecurityTaskGrant(tx, storeID, epoch, in, time.Now().UTC())
		return err
	})
	return out, err
}
func (e *Engine) RevokeSecurityTaskGrant(ctx context.Context, a SecurityTaskAction, grantID string, revision int64) error {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		return revokeSecurityTaskGrant(tx, storeID, epoch, a, grantID, revision, time.Now().UTC())
	})
}

type SecurityTaskGrantExpansion struct {
	BackgroundPolicy                                string
	Action                                          SecurityTaskAction
	GrantID                                         string
	ExpectedGrantRevision, ExpectedEnvelopeRevision int64
	DesiredScope                                    security.TaskGrant
	AdditionalUses                                  int64
	ExpiresAt                                       time.Time // zero preserves the original absolute expiry
	ConfirmedChangeDigest                           string
}

type SecurityTaskGrantChange struct {
	Digest                        string
	BeforeGrant, AfterGrant       security.TaskGrant
	BeforeEnvelope, AfterEnvelope security.TaskEnvelope
}

func previewSecurityTaskGrantExpansion(tx *gorm.DB, storeID, epoch string, in SecurityTaskGrantExpansion, now time.Time) (SecurityTaskGrantChange, error) {
	var out SecurityTaskGrantChange
	a := in.Action
	if !validSecurityAction(a) || a.TaskID == "" || a.ExpectedRevision < 1 || in.GrantID == "" || in.ExpectedGrantRevision < 1 || in.ExpectedEnvelopeRevision < 1 || in.AdditionalUses < 0 || in.AdditionalUses > 10000 {
		return out, errSecurityAction
	}
	var task securityTaskRow
	if err := tx.First(&task, "id = ? AND goal_id = ? AND project_id = ? AND session_id = ?", a.TaskID, a.GoalID, a.ProjectID, a.SessionID).Error; err != nil {
		return out, err
	}
	if task.task().Validate(now) != nil || task.State != security.TaskActive || task.StateRevision != a.ExpectedRevision || task.StoreID != storeID || task.RecoveryEpoch != epoch {
		return out, security.ErrConflict
	}
	var row securityTaskGrantRow
	if err := tx.First(&row, "id = ? AND task_id = ? AND store_id = ? AND recovery_epoch = ?", in.GrantID, a.TaskID, storeID, epoch).Error; err != nil {
		return out, err
	}
	if row.Revision != in.ExpectedGrantRevision || row.Revoked || !row.ExpiresAt.After(now) {
		return out, security.ErrConflict
	}
	var grant security.TaskGrant
	if err := decodeSecurityJSON(row.Data, &grant); err != nil {
		return out, err
	}
	if grant.ID != row.ID || grant.TaskID != task.ID || grant.GoalID != task.GoalID || grant.ProjectID != task.ProjectID || grant.SessionID != task.SessionID || grant.StoreID != storeID || grant.RecoveryEpoch != epoch {
		return out, security.ErrConflict
	}
	grant.Revision, grant.RemainingUses, grant.ExpiresAt = row.Revision, row.RemainingUses, row.ExpiresAt
	out.BeforeGrant = grant
	grant.Resources, grant.Capabilities, grant.CommandProfiles, grant.ServiceIDs, grant.Limits = in.DesiredScope.Resources, in.DesiredScope.Capabilities, in.DesiredScope.CommandProfiles, in.DesiredScope.ServiceIDs, in.DesiredScope.Limits
	grant.RemainingUses += in.AdditionalUses
	if !in.ExpiresAt.IsZero() {
		grant.ExpiresAt = in.ExpiresAt
	}
	if grant.RemainingUses < 1 || grant.RemainingUses > 10000 || grant.ExpiresAt.After(task.ExpiresAt) || grant.CreatedAt.IsZero() || grant.ExpiresAt.Sub(grant.CreatedAt) > 4*time.Hour || !grant.ExpiresAt.After(now) || !securityGrantTargetShape(grant) || len(grant.Capabilities) == 0 {
		return out, errSecurityAction
	}
	policy, err := loadSecurityPolicy(tx, a.ProjectID, storeID, epoch)
	if err != nil {
		return out, err
	}
	proof := security.ProofStructured
	if len(grant.CommandProfiles) > 0 {
		proof = security.ProofCommandProfile
	}
	for _, profile := range grant.CommandProfiles {
		if !security.ValidateCommandProfileScope(profile) {
			return out, errSecurityAction
		}
	}
	if slices.Contains(grant.Capabilities, "service.restart") && len(grant.ServiceIDs) == 0 {
		return out, errSecurityAction
	}
	for i, resource := range grant.Resources {
		if !slices.Contains(policy.ResourceIDs, resource.ID) || policy.DenyLocal && resource.Local {
			return out, errSecurityAction
		}
		var current securityResourceRevisionRow
		if err = tx.First(&current, "project_id = ? AND resource_id = ? AND store_id = ? AND recovery_epoch = ?", a.ProjectID, resource.ID, storeID, epoch).Error; err != nil {
			return out, err
		}
		if current.State != "ready" || resource.State != "ready" || current.ConnectionRevision != resource.ConnectionRevision || current.ConnectionDigest != resource.ConnectionDigest || current.Local != resource.Local {
			return out, security.ErrConflict
		}
		if resource.ConnectionIdentity != "" && resource.ConnectionIdentity != current.ConnectionIdentity {
			return out, security.ErrConflict
		}
		grant.Resources[i].ConnectionIdentity = current.ConnectionIdentity
		for _, capability := range grant.Capabilities {
			if !security.TaskGrantable(capability, proof) {
				return out, errSecurityAction
			}
			rule, matched := security.ResolveCapabilityRule(policy.Rules, capability, resource.ID)
			if !matched || !(rule.Effect == security.EffectAllow || rule.Effect == security.EffectAsk && rule.Grantable && (rule.Confirmation == security.ConfirmTask || rule.Confirmation == security.ConfirmEither)) || !security.GrantLimitsFitRule(grant.Limits, rule, capability) {
				return out, errSecurityAction
			}
		}
	}
	if len(grant.Resources) == 0 {
		for _, capability := range grant.Capabilities {
			rule, matched := security.ResolveCapabilityRule(policy.Rules, capability, "")
			if !security.TaskGrantable(capability, proof) || !matched || !(rule.Effect == security.EffectAllow || rule.Effect == security.EffectAsk && rule.Grantable && (rule.Confirmation == security.ConfirmTask || rule.Confirmation == security.ConfirmEither)) || !security.GrantLimitsFitRule(grant.Limits, rule, capability) {
				return out, errSecurityAction
			}
		}
	}
	var envelope securityTaskEnvelopeRow
	if err = tx.First(&envelope, "task_id = ? AND store_id = ? AND recovery_epoch = ?", task.ID, storeID, epoch).Error; err != nil {
		return out, err
	}
	if envelope.Revision != in.ExpectedEnvelopeRevision {
		return out, security.ErrConflict
	}
	if err = decodeSecurityJSON(envelope.Data, &out.BeforeEnvelope); err != nil {
		return out, err
	}
	if out.BeforeEnvelope.Revision != envelope.Revision {
		return out, security.ErrConflict
	}
	ids := make([]string, 0, len(grant.Resources))
	for _, resource := range grant.Resources {
		ids = append(ids, resource.ID)
	}
	if err = freezeSecurityGrantCommandTargets(tx, storeID, epoch, a.ProjectID, &grant, true); err != nil {
		return out, err
	}
	grant.Revision++
	out.AfterGrant = grant
	background := in.BackgroundPolicy
	if background == "" {
		background = out.BeforeEnvelope.BackgroundPolicy
	}
	if background == "" {
		background = "foreground_only"
	}
	if background != "foreground_only" && background != "monitored_background" {
		return out, errSecurityAction
	}
	budgetIDs := slices.Clone(out.BeforeEnvelope.BudgetGrantIDs)
	if !slices.Contains(budgetIDs, grant.ID) {
		budgetIDs = append(budgetIDs, grant.ID)
	}
	out.AfterEnvelope = security.TaskEnvelope{CommandTargetRevisions: slices.Clone(grant.CommandTargetRevisions), BudgetGrantIDs: budgetIDs, Revision: envelope.Revision + 1, Resources: slices.Clone(grant.Resources), ResourceIDs: ids, Capabilities: grant.Capabilities, CommandProfiles: grant.CommandProfiles, ServiceIDs: grant.ServiceIDs, Limits: grant.Limits, BackgroundPolicy: background}
	out.AfterGrant.BackgroundPolicy = background
	out.Digest = hash(js(out))
	return out, nil
}

func expandSecurityTaskGrant(tx *gorm.DB, storeID, epoch string, in SecurityTaskGrantExpansion, now time.Time) (security.TaskGrant, error) {
	request := js(struct {
		Kind  string
		Input SecurityTaskGrantExpansion
	}{"grant.expand", in})
	a := in.Action
	var replay security.TaskGrant
	if ok, err := securityActionReplay(tx, storeID, epoch, a.ActorID, a.ActionID, request, &replay); ok || err != nil {
		return replay, err
	}
	change, err := previewSecurityTaskGrantExpansion(tx, storeID, epoch, in, now)
	if err != nil {
		return security.TaskGrant{}, err
	}
	if in.ConfirmedChangeDigest == "" || in.ConfirmedChangeDigest != change.Digest {
		return security.TaskGrant{}, errors.New("security: confirm the exact scope, budget and expiry changes")
	}
	g := change.AfterGrant
	result := tx.Model(&securityTaskGrantRow{}).Where("id = ? AND revision = ? AND revoked = ?", g.ID, in.ExpectedGrantRevision, false).Updates(map[string]any{"revision": g.Revision, "remaining_uses": g.RemainingUses, "expires_at": g.ExpiresAt, "data": js(g)})
	if result.Error != nil {
		return g, result.Error
	}
	if result.RowsAffected != 1 {
		return g, security.ErrConflict
	}
	result = tx.Model(&securityTaskEnvelopeRow{}).Where("task_id = ? AND revision = ?", g.TaskID, in.ExpectedEnvelopeRevision).Updates(map[string]any{"revision": change.AfterEnvelope.Revision, "data": js(change.AfterEnvelope)})
	if result.Error != nil {
		return g, result.Error
	}
	if result.RowsAffected != 1 {
		return g, security.ErrConflict
	}
	if change.BeforeEnvelope.BackgroundPolicy != change.AfterEnvelope.BackgroundPolicy {
		result = tx.Model(&securityTaskRow{}).Where("id = ? AND state_revision = ? AND state = ?", g.TaskID, a.ExpectedRevision, security.TaskActive).Updates(map[string]any{"background_policy": change.AfterEnvelope.BackgroundPolicy, "state_revision": gorm.Expr("state_revision + 1")})
		if result.Error != nil {
			return g, result.Error
		}
		if result.RowsAffected != 1 {
			return g, security.ErrConflict
		}
	}
	return g, securityActionRecord(tx, storeID, epoch, a.ActorID, a.ActionID, "grant.expand", g.ID, request, in.ExpectedGrantRevision, g.Revision, g, now)
}

func (e *Engine) PreviewSecurityTaskGrantExpansion(ctx context.Context, in SecurityTaskGrantExpansion) (out SecurityTaskGrantChange, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		out, err = previewSecurityTaskGrantExpansion(tx, storeID, epoch, in, time.Now().UTC())
		return err
	})
	return out, err
}
func (e *Engine) ExpandSecurityTaskGrant(ctx context.Context, in SecurityTaskGrantExpansion) (out security.TaskGrant, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		out, err = expandSecurityTaskGrant(tx, storeID, epoch, in, time.Now().UTC())
		return err
	})
	return out, err
}

// RecordLegacySessionPolicy captures the effective seven settings once per
// session. Another session's settings and project defaults cannot overwrite it.
func recordLegacySessionPolicy(tx *gorm.DB, storeID, epoch, projectID, sessionID, source string, p Permissions) error {
	if sessionID == "" || source != "web" && source != "standalone" {
		return errSecurityAction
	}
	var old securityLegacySessionPolicyRow
	err := tx.First(&old, "session_id = ?", sessionID).Error
	if err == nil {
		if old.ProjectID != projectID || old.StoreID != storeID || old.RecoveryEpoch != epoch {
			return security.ErrConflict
		}
		// A transport change does not replace the original migration source
		// or its authority. Identical effective settings may cross entrypoints;
		// changing them requires the existing explicit revisioned host action.
		if old.Source != source {
			if old.Data != js(p) {
				return security.ErrConflict
			}
			return nil
		}
		// Before any project activation this is a capture of the host's real
		// current settings. Once active only a separate explicit CAS action may
		// change the confirmed migration snapshot.
		var configured int64
		if err := tx.Model(&securityProjectPolicyRow{}).Where("project_id = ? AND store_id = ? AND recovery_epoch = ?", projectID, storeID, epoch).Count(&configured).Error; err != nil {
			return err
		}
		if configured == 0 && old.Data != js(p) {
			result := tx.Model(&securityLegacySessionPolicyRow{}).Where("session_id = ? AND revision = ?", sessionID, old.Revision).Updates(map[string]any{"data": js(p), "revision": old.Revision + 1})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return security.ErrConflict
			}
		}
		return nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	return tx.Create(&securityLegacySessionPolicyRow{SessionID: sessionID, ProjectID: projectID, StoreID: storeID, RecoveryEpoch: epoch, Source: source, Revision: 1, Data: js(p)}).Error
}

func (e *Engine) CaptureSecurityLegacyPolicy(ctx context.Context, projectID, sessionID, source string, c Config) error {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	permissions := DefaultPermissions()
	if c.Permissions != nil {
		permissions = *c.Permissions
	} else {
		permissions.SilentTerminalCreation = true
	}
	return e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		return recordLegacySessionPolicy(tx, storeID, epoch, projectID, sessionID, source, permissions)
	})
}

func (e *Engine) LegacySecurityPermissions(ctx context.Context, projectID, sessionID string) (Permissions, error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return Permissions{}, err
	}
	row, _, err := effectiveLegacyPolicyTx(db.WithContext(ctx), projectID, sessionID, storeID, epoch)
	if err != nil {
		return Permissions{}, err
	}
	var permissions Permissions
	err = json.Unmarshal([]byte(row.Data), &permissions)
	return permissions, err
}

func (e *Engine) SecurityProjectPolicy(ctx context.Context, projectID string) (security.ProjectPolicy, error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return security.ProjectPolicy{}, err
	}
	var row securityProjectPolicyRow
	if err = db.WithContext(ctx).First(&row, "project_id = ? AND store_id = ? AND recovery_epoch = ?", projectID, storeID, epoch).Error; err != nil {
		return security.ProjectPolicy{}, err
	}
	var policy security.ProjectPolicy
	if err = decodeSecurityJSON(row.Data, &policy); err != nil {
		return policy, err
	}
	if policy.ProjectID != projectID || policy.Revision != row.Revision {
		return policy, security.ErrConflict
	}
	policy.Confirmed = row.Confirmed
	return policy, nil
}

func (e *Engine) SecurityTasks(ctx context.Context, projectID, sessionID string) ([]security.SecurityTask, error) {
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		return nil, err
	}
	var rows []securityTaskRow
	if err = db.WithContext(ctx).Where("project_id = ? AND session_id = ?", projectID, sessionID).Order("created_at DESC,id DESC").Limit(100).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]security.SecurityTask, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.task())
	}
	return out, nil
}

func (e *Engine) SecurityTaskForManagement(ctx context.Context, projectID, sessionID, taskID string) (security.SecurityTask, error) {
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		return security.SecurityTask{}, err
	}
	var row securityTaskRow
	err = db.WithContext(ctx).First(&row, "id = ? AND project_id = ? AND session_id = ?", taskID, projectID, sessionID).Error
	return row.task(), err
}

func (e *Engine) SecurityTaskGrants(ctx context.Context, projectID, sessionID, taskID string) ([]security.TaskGrant, error) {
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		return nil, err
	}
	var rows []securityTaskGrantRow
	if err = db.WithContext(ctx).Where("project_id = ? AND session_id = ? AND task_id = ?", projectID, sessionID, taskID).Order("id").Limit(100).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]security.TaskGrant, 0, len(rows))
	for _, row := range rows {
		var grant security.TaskGrant
		if err = decodeSecurityJSON(row.Data, &grant); err != nil {
			return nil, err
		}
		grant.Revision, grant.Revoked, grant.RemainingUses, grant.ExpiresAt = row.Revision, row.Revoked, row.RemainingUses, row.ExpiresAt
		out = append(out, grant)
	}
	return out, nil
}

type SecurityAuditEvent struct {
	Sequence                               int64 `json:"sequence"`
	ID, ProjectID, Kind, ObjectID, ActorID string
	BeforeRevision, AfterRevision          int64
	At                                     time.Time
}
type SecurityAuditPage struct {
	StoreID, RecoveryEpoch string
	NextCursor             int64
	Events                 []SecurityAuditEvent
}

func (e *Engine) SecurityAudit(ctx context.Context, projectID, expectedEpoch string, after int64, limit int) (SecurityAuditPage, error) {
	db, storeID, epoch, err := e.securityTaskDB()
	out := SecurityAuditPage{StoreID: storeID, RecoveryEpoch: epoch, Events: []SecurityAuditEvent{}}
	if err != nil {
		return out, err
	}
	if after < 0 || limit < 1 || limit > 200 || after > 0 && expectedEpoch != epoch {
		return out, errSecurityAction
	}
	query := db.WithContext(ctx).Table("security_authority_events").Select("rowid AS sequence,id,project_id,kind,object_id,actor_id,before_revision,after_revision,at").Where("rowid > ?", after)
	if projectID != "" {
		query = query.Where("project_id = ?", projectID)
	}
	err = query.Order("rowid").Limit(limit).Scan(&out.Events).Error
	out.NextCursor = after
	if len(out.Events) > 0 {
		out.NextCursor = out.Events[len(out.Events)-1].Sequence
	}
	return out, err
}

func (e *Engine) SecurityTaskEnvelope(ctx context.Context, projectID, sessionID, taskID string) (*security.TaskEnvelope, error) {
	if _, err := e.SecurityTaskForManagement(ctx, projectID, sessionID, taskID); err != nil {
		return nil, err
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return nil, err
	}
	var row securityTaskEnvelopeRow
	err = db.WithContext(ctx).First(&row, "task_id = ? AND store_id = ? AND recovery_epoch = ?", taskID, storeID, epoch).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var envelope security.TaskEnvelope
	if err = decodeSecurityJSON(row.Data, &envelope); err != nil {
		return nil, err
	}
	if envelope.Revision != row.Revision {
		return nil, security.ErrConflict
	}
	return &envelope, nil
}

func securityGrantTargetShape(grant security.TaskGrant) bool {
	if len(grant.Resources) > 0 {
		return true
	}
	if len(grant.CommandProfiles) > 0 || len(grant.ServiceIDs) > 0 || len(grant.Capabilities) == 0 || len(grant.Limits.NetworkTargets) == 0 {
		return false
	}
	for _, capability := range grant.Capabilities {
		if capability != "network.fetch" {
			return false
		}
	}
	return true
}
