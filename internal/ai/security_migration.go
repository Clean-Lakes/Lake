package ai

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

type LegacyScopeEvidence struct {
	SourceActionID              string
	ExplicitRestriction         bool
	NavigationOnly              bool
	InferredOnly                bool
	DenyLocal                   bool
	MissingReferenceRestriction bool
	PersistedReferenceIDs       []string
}

// Directory IDs or an empty scope do not prove an explicit restriction.
// Evidence must be recovered from a real persisted user action, not model text.
func ClassifyLegacyScope(scope *TargetScope, evidence LegacyScopeEvidence) string {
	if evidence.MissingReferenceRestriction {
		return "legacy_unclassified"
	}
	if scope == nil {
		return "none"
	}
	if evidence.SourceActionID == "" || evidence.ExplicitRestriction && (evidence.NavigationOnly || evidence.InferredOnly) {
		return "legacy_unclassified"
	}
	if evidence.ExplicitRestriction {
		return "explicit_restriction"
	}
	if evidence.NavigationOnly || evidence.InferredOnly {
		return "navigation"
	}
	return "legacy_unclassified"
}

type SecurityTargetSnapshot struct {
	ResourceIDs     []string `json:"resourceIds"`
	Source          string   `json:"source"`
	SourceMessageID string   `json:"sourceMessageId"`
	Revision        int64    `json:"revision"`
}

type SecurityPendingTarget struct {
	Reason          string   `json:"reason"`
	SourceMessageID string   `json:"sourceMessageId"`
	CandidateIDs    []string `json:"candidateIds"`
}

type SecuritySessionTarget struct {
	ProjectID   string                  `json:"projectId"`
	SessionID   string                  `json:"sessionId"`
	Revision    int64                   `json:"revision"`
	Current     *SecurityTargetSnapshot `json:"currentTarget"`
	Pending     *SecurityPendingTarget  `json:"pendingResolution"`
	LegacyState string                  `json:"legacyState"`
}

type securitySessionTargetRow struct {
	SessionID                         string `gorm:"primaryKey"`
	ProjectID, StoreID, RecoveryEpoch string
	Revision                          int64
	CurrentTarget, PendingResolution  string
	LegacyState                       string
	LegacyDenyLocal                   bool
	LegacyBoundaryID                  string
}

func (securitySessionTargetRow) TableName() string { return "security_session_targets" }

type securityBoundaryRow struct {
	ID                                    string `gorm:"primaryKey"`
	ProjectID, SessionID, TaskID          string
	OwnerKind, Provenance, SourceActionID string
	StoreID, RecoveryEpoch                string
	Revision                              int64
	ResourceIDs                           string
	DenyLocal                             bool
	RestrictResources                     bool
}

func (securityBoundaryRow) TableName() string { return "security_boundaries" }

type SecurityScopeAction struct {
	ActorID, ActionID, ProjectID, SessionID, SourceMessageID string
	ExpectedRevision                                         int64
}

type SecurityTargetUpdate struct {
	Action      SecurityScopeAction
	ResourceIDs []string
	Source      string
	Pending     *SecurityPendingTarget
}

type SecurityBoundary struct {
	ID                string   `json:"id"`
	ProjectID         string   `json:"projectId"`
	SessionID         string   `json:"sessionId"`
	TaskID            string   `json:"taskId,omitempty"`
	OwnerKind         string   `json:"ownerKind"`
	Provenance        string   `json:"provenance"`
	Revision          int64    `json:"revision"`
	ResourceIDs       []string `json:"resourceIds"`
	DenyLocal         bool     `json:"denyLocal"`
	RestrictResources bool     `json:"restrictResources"`
}

type SecurityBoundaryUpdate struct {
	Action      SecurityScopeAction
	BoundaryID  string
	ResourceIDs []string
	DenyLocal   bool
}

type SecurityMigrationResolution struct {
	Action           SecurityScopeAction
	TargetIDs        []string
	BoundaryDecision string // navigation or explicit_restriction
}

func validateScopeAction(a SecurityScopeAction) error {
	if strings.TrimSpace(a.ActorID) == "" || len(a.ActorID) > 256 || strings.TrimSpace(a.ActionID) == "" || len(a.ActionID) > 256 || a.ProjectID == "" || a.SessionID == "" || a.SourceMessageID == "" || a.ExpectedRevision < 0 {
		return errSecurityAction
	}
	return nil
}

func scopeIDs(ids, visible []string) ([]string, error) {
	if len(ids) > 1000 {
		return nil, errSecurityAction
	}
	allowed := map[string]bool{}
	for _, id := range visible {
		allowed[id] = true
	}
	seen := map[string]bool{}
	out := []string{}
	for _, id := range ids {
		if id == "" || !allowed[id] {
			return nil, errors.New("security: target unavailable")
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out, nil
}

func scopeActionReplay(tx *gorm.DB, storeID, epoch string, a SecurityScopeAction, request string, result any) (bool, error) {
	var event securityAuthorityEvent
	key := hash(storeID + "\x00" + epoch + "\x00" + a.ActorID + "\x00" + a.ActionID)
	err := tx.First(&event, "action_key = ?", key).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if event.RequestHash != hash(request) {
		return false, security.ErrConflict
	}
	if err = json.Unmarshal([]byte(event.Result), result); err != nil {
		return false, err
	}
	return true, nil
}

func recordScopeAction(tx *gorm.DB, storeID, epoch string, a SecurityScopeAction, kind, object, request string, before, after int64, result any, now time.Time) error {
	return tx.Create(&securityAuthorityEvent{ProjectID: a.ProjectID, ID: uid(), ActionKey: hash(storeID + "\x00" + epoch + "\x00" + a.ActorID + "\x00" + a.ActionID), RequestHash: hash(request), StoreID: storeID, RecoveryEpoch: epoch, ActorID: a.ActorID, ActionID: a.ActionID, Kind: kind, ObjectID: object, BeforeRevision: before, AfterRevision: after, Result: js(result), At: now}).Error
}

func readSecurityTarget(tx *gorm.DB, projectID, sessionID string) (securitySessionTargetRow, SecuritySessionTarget, error) {
	var row securitySessionTargetRow
	out := SecuritySessionTarget{ProjectID: projectID, SessionID: sessionID}
	err := tx.First(&row, "session_id = ?", sessionID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return row, out, nil
	}
	if err != nil {
		return row, out, err
	}
	if row.ProjectID != projectID {
		return row, out, errSecurityAction
	}
	out.Revision, out.LegacyState = row.Revision, row.LegacyState
	if row.CurrentTarget != "" {
		if err = json.Unmarshal([]byte(row.CurrentTarget), &out.Current); err != nil {
			return row, out, err
		}
	}
	if row.PendingResolution != "" {
		if err = json.Unmarshal([]byte(row.PendingResolution), &out.Pending); err != nil {
			return row, out, err
		}
	}
	return row, out, nil
}

func updateSecurityTarget(tx *gorm.DB, storeID, epoch string, in SecurityTargetUpdate, visible []string, now time.Time) (SecuritySessionTarget, error) {
	var out SecuritySessionTarget
	if err := validateScopeAction(in.Action); err != nil {
		return out, err
	}
	request := js(in)
	if ok, err := scopeActionReplay(tx, storeID, epoch, in.Action, request, &out); ok || err != nil {
		return out, err
	}
	row, out, err := readSecurityTarget(tx, in.Action.ProjectID, in.Action.SessionID)
	if err != nil {
		return out, err
	}
	if out.Revision != in.Action.ExpectedRevision {
		return out, security.ErrConflict
	}
	if row.LegacyState == "legacy_unclassified" {
		return out, errors.New("security: legacy scope confirmation required")
	}
	ids, err := scopeIDs(in.ResourceIDs, visible)
	if err != nil {
		return out, err
	}
	before := out.Revision
	out.Revision++
	if in.Pending != nil {
		if in.Pending.SourceMessageID != in.Action.SourceMessageID || in.Pending.Reason == "" {
			return out, errSecurityAction
		}
		candidates, err := scopeIDs(in.Pending.CandidateIDs, visible)
		if err != nil {
			return out, err
		}
		out.Pending = &SecurityPendingTarget{Reason: in.Pending.Reason, SourceMessageID: in.Pending.SourceMessageID, CandidateIDs: candidates}
	} else {
		if len(ids) == 0 {
			return out, errSecurityAction
		}
		switch in.Source {
		case "explicit_selection", "user_reference", "user_address", "confirmed_candidate", "inherited":
		default:
			return out, errSecurityAction
		}
		out.Current = &SecurityTargetSnapshot{ResourceIDs: ids, Source: in.Source, SourceMessageID: in.Action.SourceMessageID, Revision: out.Revision}
		out.Pending = nil
	}
	row.SessionID, row.ProjectID, row.StoreID, row.RecoveryEpoch = out.SessionID, out.ProjectID, storeID, epoch
	row.Revision, row.CurrentTarget, row.PendingResolution = out.Revision, js(out.Current), js(out.Pending)
	if before == 0 {
		err = tx.Create(&row).Error
	} else {
		result := tx.Model(&securitySessionTargetRow{}).Where("session_id = ? AND revision = ?", row.SessionID, before).Select("*").Updates(&row)
		err = result.Error
		if err == nil && result.RowsAffected != 1 {
			err = security.ErrConflict
		}
	}
	if err != nil {
		return out, err
	}
	return out, recordScopeAction(tx, storeID, epoch, in.Action, "target.update", out.SessionID, request, before, out.Revision, out, now)
}

func resolveLegacyScope(tx *gorm.DB, storeID, epoch string, in SecurityMigrationResolution, visible []string, now time.Time) (SecuritySessionTarget, error) {
	var out SecuritySessionTarget
	if err := validateScopeAction(in.Action); err != nil {
		return out, err
	}
	request := js(in)
	if ok, err := scopeActionReplay(tx, storeID, epoch, in.Action, request, &out); ok || err != nil {
		return out, err
	}
	row, out, err := readSecurityTarget(tx, in.Action.ProjectID, in.Action.SessionID)
	if err != nil {
		return out, err
	}
	if row.LegacyState != "legacy_unclassified" || out.Revision != in.Action.ExpectedRevision {
		return out, security.ErrConflict
	}
	ids, err := scopeIDs(in.TargetIDs, visible)
	if err != nil {
		return out, err
	}
	if in.BoundaryDecision != "navigation" && in.BoundaryDecision != "explicit_restriction" {
		return out, errSecurityAction
	}
	if out.Pending != nil && out.Pending.Reason == "LEGACY_REFERENCED_RESOURCES_CONFIRMATION_REQUIRED" && in.BoundaryDecision != "explicit_restriction" {
		return out, errors.New("security: saved referenced-resource restriction requires explicit membership confirmation")
	}
	if len(ids) == 0 && in.BoundaryDecision == "navigation" {
		return out, errors.New("security: select a target before removing the legacy restriction")
	}
	before := out.Revision
	out.Revision++
	out.LegacyState = in.BoundaryDecision
	out.Pending = nil
	if len(ids) > 0 {
		out.Current = &SecurityTargetSnapshot{ResourceIDs: ids, Source: "confirmed_candidate", SourceMessageID: in.Action.SourceMessageID, Revision: out.Revision}
	} else {
		out.Current = nil
	}
	if in.BoundaryDecision == "explicit_restriction" || row.LegacyDenyLocal {
		boundary := securityBoundaryRow{ID: uid(), ProjectID: row.ProjectID, SessionID: row.SessionID, OwnerKind: "session", Provenance: "explicit_restriction", SourceActionID: in.Action.ActionID, StoreID: storeID, RecoveryEpoch: epoch, Revision: 1, ResourceIDs: js(ids), DenyLocal: row.LegacyDenyLocal, RestrictResources: in.BoundaryDecision == "explicit_restriction"}
		if row.LegacyBoundaryID != "" {
			var prior securityBoundaryRow
			if err = tx.First(&prior, "id = ? AND session_id = ? AND project_id = ? AND owner_kind = ?", row.LegacyBoundaryID, row.SessionID, row.ProjectID, "session").Error; err != nil {
				return out, err
			}
			boundary.ID, boundary.Revision = prior.ID, prior.Revision+1
			if err = tx.Model(&securityBoundaryRow{}).Where("id = ? AND revision = ?", prior.ID, prior.Revision).Select("*").Updates(&boundary).Error; err != nil {
				return out, err
			}
		} else if err = tx.Create(&boundary).Error; err != nil {
			return out, err
		}
		row.LegacyBoundaryID = boundary.ID
	}
	result := tx.Model(&securitySessionTargetRow{}).Where("session_id = ? AND revision = ? AND legacy_state = ?", row.SessionID, before, "legacy_unclassified").Updates(map[string]any{"legacy_state": out.LegacyState, "revision": out.Revision, "current_target": js(out.Current), "pending_resolution": js(out.Pending), "store_id": storeID, "recovery_epoch": epoch, "legacy_boundary_id": row.LegacyBoundaryID})
	if result.Error != nil {
		return out, result.Error
	}
	if result.RowsAffected != 1 {
		return out, security.ErrConflict
	}
	return out, recordScopeAction(tx, storeID, epoch, in.Action, "migration.resolve", out.SessionID, request, before, out.Revision, out, now)
}

func updateSecurityBoundary(tx *gorm.DB, storeID, epoch string, in SecurityBoundaryUpdate, visible []string, now time.Time) (SecurityBoundary, error) {
	var out SecurityBoundary
	if err := validateScopeAction(in.Action); err != nil {
		return out, err
	}
	request := js(in)
	if ok, err := scopeActionReplay(tx, storeID, epoch, in.Action, request, &out); ok || err != nil {
		return out, err
	}
	var row securityBoundaryRow
	if err := tx.First(&row, "id = ? AND session_id = ? AND project_id = ?", in.BoundaryID, in.Action.SessionID, in.Action.ProjectID).Error; err != nil {
		return out, err
	}
	if row.OwnerKind != "session" && row.OwnerKind != "task" {
		return out, errors.New("security: project and parent boundaries cannot be changed here")
	}
	if row.Revision != in.Action.ExpectedRevision || row.StoreID != storeID || row.RecoveryEpoch != epoch {
		return out, security.ErrConflict
	}
	ids, err := scopeIDs(in.ResourceIDs, visible)
	if err != nil {
		return out, err
	}
	before := row.Revision
	out = SecurityBoundary{ID: row.ID, ProjectID: row.ProjectID, SessionID: row.SessionID, TaskID: row.TaskID, OwnerKind: row.OwnerKind, Provenance: row.Provenance, Revision: before + 1, ResourceIDs: ids, DenyLocal: in.DenyLocal, RestrictResources: row.RestrictResources}
	result := tx.Model(&securityBoundaryRow{}).Where("id = ? AND revision = ?", row.ID, before).Updates(map[string]any{"resource_ids": js(ids), "deny_local": in.DenyLocal, "revision": out.Revision, "source_action_id": in.Action.ActionID})
	if result.Error != nil {
		return out, result.Error
	}
	if result.RowsAffected != 1 {
		return out, security.ErrConflict
	}
	return out, recordScopeAction(tx, storeID, epoch, in.Action, "boundary.update", out.ID, request, before, out.Revision, out, now)
}

func stageLegacySecurityScope(tx *gorm.DB, storeID, epoch, projectID, sessionID string, scope *TargetScope, evidence LegacyScopeEvidence, now time.Time) error {
	if storeID == "" || epoch == "" || projectID == "" || sessionID == "" || now.IsZero() {
		return errSecurityAction
	}
	if evidence.MissingReferenceRestriction {
		var count int64
		if err := tx.Model(&securityBoundaryRow{}).Where("project_id = ? AND session_id = ? AND store_id = ? AND recovery_epoch = ? AND restrict_resources = ? AND provenance <> ? AND source_action_id <> ''", projectID, sessionID, storeID, epoch, true, "legacy_unclassified").Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			evidence.MissingReferenceRestriction = false
		}
	}
	ids := []string{}
	if scope != nil {
		ids = append(ids, scope.ResourceIDs...)
	} else if evidence.MissingReferenceRestriction {
		ids = append(ids, evidence.PersistedReferenceIDs...)
	}
	sort.Strings(ids)
	compact := ids[:0]
	for _, id := range ids {
		if id != "" && (len(compact) == 0 || compact[len(compact)-1] != id) {
			compact = append(compact, id)
		}
	}
	ids = compact
	pendingReason := "LEGACY_SCOPE_CONFIRMATION_REQUIRED"
	if evidence.MissingReferenceRestriction {
		pendingReason = "LEGACY_REFERENCED_RESOURCES_CONFIRMATION_REQUIRED"
	}
	var existing securitySessionTargetRow
	err := tx.First(&existing, "session_id = ?", sessionID).Error
	if err == nil {
		if existing.ProjectID != projectID {
			return errSecurityAction
		}
		if existing.LegacyState == "none" && evidence.MissingReferenceRestriction {
			if existing.StoreID != storeID || existing.RecoveryEpoch != epoch {
				return security.ErrConflict
			}
			pending := js(&SecurityPendingTarget{Reason: pendingReason, CandidateIDs: ids})
			updated := tx.Model(&securitySessionTargetRow{}).Where("session_id = ? AND revision = ? AND legacy_state = ?", sessionID, existing.Revision, "none").Updates(map[string]any{"legacy_state": "legacy_unclassified", "pending_resolution": pending, "revision": existing.Revision + 1, "legacy_deny_local": existing.LegacyDenyLocal || evidence.DenyLocal})
			if updated.Error != nil {
				return updated.Error
			}
			if updated.RowsAffected != 1 {
				return security.ErrConflict
			}
			key := hash(storeID + "\x00" + epoch + "\x00legacy-reference-repair\x00" + sessionID + "\x00" + js(existing.Revision))
			return tx.Create(&securityAuthorityEvent{ProjectID: projectID, ID: uid(), ActionKey: key, RequestHash: hash(js(evidence)), StoreID: storeID, RecoveryEpoch: epoch, ActorID: "runtime-migration", ActionID: key, Kind: "scope.reclassify", ObjectID: sessionID, BeforeRevision: existing.Revision, AfterRevision: existing.Revision + 1, Result: js(map[string]any{"classification": "legacy_unclassified"}), At: now}).Error
		}
		return nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	classification := ClassifyLegacyScope(scope, evidence)
	row := securitySessionTargetRow{SessionID: sessionID, ProjectID: projectID, StoreID: storeID, RecoveryEpoch: epoch, Revision: 1, LegacyState: classification, LegacyDenyLocal: evidence.DenyLocal}
	if classification == "legacy_unclassified" {
		row.PendingResolution = js(&SecurityPendingTarget{Reason: pendingReason, SourceMessageID: evidence.SourceActionID, CandidateIDs: ids})
	} else if len(ids) > 0 {
		row.CurrentTarget = js(&SecurityTargetSnapshot{ResourceIDs: ids, Source: "inherited", SourceMessageID: evidence.SourceActionID, Revision: 1})
	}
	if classification == "explicit_restriction" || evidence.DenyLocal {
		row.LegacyBoundaryID = uid()
		if err = tx.Create(&securityBoundaryRow{ID: row.LegacyBoundaryID, ProjectID: projectID, SessionID: sessionID, OwnerKind: "session", Provenance: "explicit_restriction", SourceActionID: evidence.SourceActionID, StoreID: storeID, RecoveryEpoch: epoch, Revision: 1, ResourceIDs: js(ids), DenyLocal: evidence.DenyLocal, RestrictResources: classification == "explicit_restriction"}).Error; err != nil {
			return err
		}
	}
	if err = tx.Create(&row).Error; err != nil {
		return err
	}
	key := hash(storeID + "\x00" + epoch + "\x00legacy-scope\x00" + sessionID)
	return tx.Create(&securityAuthorityEvent{ProjectID: projectID, ID: uid(), ActionKey: key, RequestHash: hash(js(evidence) + js(scope)), StoreID: storeID, RecoveryEpoch: epoch, ActorID: "runtime-migration", ActionID: key, Kind: "scope.classify", ObjectID: sessionID, AfterRevision: 1, Result: js(map[string]any{"classification": classification}), At: now}).Error
}

func (e *Engine) MigrateSecuritySessionScope(ctx context.Context, projectID, sessionID string, scope *TargetScope, evidence LegacyScopeEvidence) error {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		return stageLegacySecurityScope(tx, storeID, epoch, projectID, sessionID, scope, evidence, time.Now().UTC())
	})
}

func (e *Engine) SecurityBoundaries(ctx context.Context, projectID, sessionID string) ([]SecurityBoundary, error) {
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		return nil, err
	}
	var rows []securityBoundaryRow
	if err = db.WithContext(ctx).Where("project_id = ? AND session_id = ?", projectID, sessionID).Order("id").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]SecurityBoundary, 0, len(rows))
	for _, row := range rows {
		var ids []string
		if err = json.Unmarshal([]byte(row.ResourceIDs), &ids); err != nil {
			return nil, err
		}
		out = append(out, SecurityBoundary{ID: row.ID, ProjectID: row.ProjectID, SessionID: row.SessionID, TaskID: row.TaskID, OwnerKind: row.OwnerKind, Provenance: row.Provenance, Revision: row.Revision, ResourceIDs: ids, DenyLocal: row.DenyLocal, RestrictResources: row.RestrictResources})
	}
	return out, nil
}

func (e *Engine) SecurityTarget(ctx context.Context, projectID, sessionID string) (out SecuritySessionTarget, err error) {
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	_, out, err = readSecurityTarget(db.WithContext(ctx), projectID, sessionID)
	return out, err
}
func (e *Engine) UpdateSecurityTarget(ctx context.Context, in SecurityTargetUpdate, visibleIDs []string) (out SecuritySessionTarget, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		out, err = updateSecurityTarget(tx, storeID, epoch, in, visibleIDs, time.Now().UTC())
		return err
	})
	return out, err
}
func (e *Engine) ResolveLegacyScope(ctx context.Context, in SecurityMigrationResolution, visibleIDs []string) (out SecuritySessionTarget, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		out, err = resolveLegacyScope(tx, storeID, epoch, in, visibleIDs, time.Now().UTC())
		return err
	})
	return out, err
}
func (e *Engine) UpdateSecurityBoundary(ctx context.Context, in SecurityBoundaryUpdate, visibleIDs []string) (out SecurityBoundary, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		out, err = updateSecurityBoundary(tx, storeID, epoch, in, visibleIDs, time.Now().UTC())
		return err
	})
	return out, err
}
