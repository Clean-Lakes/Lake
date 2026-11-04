package ai

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

type SecurityRecoveryMapping struct {
	Action       SecurityRecoveryAction `json:"action"`
	ImpactID     string                 `json:"impactId"`
	RecordDigest string                 `json:"recordDigest"`
	ResourceIDs  []string               `json:"resourceIds"`
}

func verifiedRecoveryDescriptor(row securityRecoveryImpactRow) (security.PreparedOperation, error) {
	var descriptor security.PreparedOperation
	if row.Descriptor == "" || row.DescriptorDigest == "" {
		return descriptor, errors.New("security: original operation has no trusted frozen descriptor; external trusted reconciliation is required")
	}
	if err := decodeSecurityJSON(row.Descriptor, &descriptor); err != nil {
		return descriptor, err
	}
	digest, err := security.OperationDigest(descriptor)
	if err != nil || digest != row.DescriptorDigest || descriptor.ID != row.OperationID || descriptor.RegistryVersion != security.RegistryVersion {
		return descriptor, errors.New("security: original operation descriptor binding mismatch")
	}
	entry, exists := security.LookupTool(descriptor.Tool)
	if !exists || descriptor.TargetKind != entry.TargetKind || descriptor.Proof == security.ProofOpaque {
		return descriptor, errors.New("security: opaque or unregistered effects do not prove a finite recovery impact scope")
	}
	if descriptor.Proof == security.ProofCommandProfile {
		if !entry.CommandProfileAllowed || !security.ValidateCommandProfileScope(security.CommandProfileScope{ID: descriptor.CommandProfileID, Version: descriptor.CommandProfileVersion, ArgumentsDigest: descriptor.CommandArgumentsDigest}) {
			return descriptor, errors.New("security: original command profile is not verifiable")
		}
	} else if descriptor.Proof != security.ProofStructured || entry.Proof != security.ProofStructured {
		return descriptor, errors.New("security: original structured effect proof unavailable")
	}
	return descriptor, nil
}

type recoveryCatalogIdentity struct{ project, kind, config string }

func recoveryCatalogResource(path, id string) (recoveryCatalogIdentity, error) {
	var result recoveryCatalogIdentity
	db, err := openSecurityReadOnly(path)
	if err != nil {
		return result, err
	}
	defer db.Close()
	err = db.QueryRow(`SELECT r.projectId,r.kind,COALESCE(c.config,'{}') FROM resources r LEFT JOIN resourceConnections c ON c.resourceId=r.id WHERE r.id=?`, id).Scan(&result.project, &result.kind, &result.config)
	if err != nil {
		return result, errors.New("security: original/current asset identity unavailable")
	}
	var config any
	decoder := json.NewDecoder(strings.NewReader(result.config))
	decoder.UseNumber()
	if decoder.Decode(&config) != nil {
		return result, errors.New("security: invalid asset configuration in recovery catalog")
	}
	// Canonicalize only in memory for equality. Never persist or hash connection
	// secrets; authority/audit uses the original host's reference digest instead.
	data, err := json.Marshal(config)
	if err != nil {
		return result, err
	}
	result.config = string(data)
	return result, nil
}

func confirmRecoveryResource(tx *gorm.DB, home string, journal securityRestoreJournal, impact securityRecoveryImpactRow, descriptor security.PreparedOperation, resource security.ResourceRevision) error {
	if !identifier.MatchString(resource.ID) || resource.ConnectionRevision < 1 || resource.State != "ready" {
		return errors.New("security: original resource binding is not stable")
	}
	sourceDir := filepath.Join(home, "security", "recoveries", journal.After.RecoveryID, impact.Source)
	sourceCatalog, err := recoveryCatalogResource(filepath.Join(sourceDir, "lake-web.sqlite"), resource.ID)
	if err != nil {
		return err
	}
	currentCatalog, err := recoveryCatalogResource(filepath.Join(filepath.Dir(journal.After.RuntimeRoot), "lake-web.sqlite"), resource.ID)
	if err != nil {
		return err
	}
	if sourceCatalog != currentCatalog || sourceCatalog.project != descriptor.ProjectID {
		return errors.New("security: original and current asset connection identities differ; keep recovery gate closed")
	}
	sourceDB, err := openSecurityReadOnlyMode(filepath.Join(sourceDir, "adk", "sessions.sqlite"), true)
	if err != nil {
		return err
	}
	defer sourceDB.Close()
	var revision int64
	var digest, state, store, epoch string
	var local bool
	err = sourceDB.QueryRow(`SELECT connection_revision,connection_digest,state,store_id,recovery_epoch,local FROM security_resource_revisions WHERE project_id=? AND resource_id=?`, descriptor.ProjectID, resource.ID).Scan(&revision, &digest, &state, &store, &epoch, &local)
	if err != nil || revision != resource.ConnectionRevision || digest != resource.ConnectionDigest || state != "ready" || store != descriptor.StoreID || epoch != descriptor.RecoveryEpoch || local != resource.Local {
		return errors.New("security: original resource revision proof unavailable")
	}
	var current securityResourceRevisionRow
	if err = tx.First(&current, "project_id = ? AND resource_id = ?", descriptor.ProjectID, resource.ID).Error; err != nil {
		return err
	}
	if current.ConnectionRevision != revision || current.ConnectionDigest != digest || current.Local != local || current.State != "ready" {
		return errors.New("security: current asset revision differs from original impact scope")
	}
	changed := tx.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND resource_id = ? AND connection_revision = ? AND connection_digest = ?", descriptor.ProjectID, resource.ID, revision, digest).Updates(map[string]any{"store_id": journal.After.StoreID, "recovery_epoch": journal.After.RecoveryEpoch})
	if changed.Error != nil {
		return changed.Error
	}
	if changed.RowsAffected != 1 {
		return security.ErrConflict
	}
	return nil
}

// MapSecurityRecoveryImpact confirms the original finite impact scope, not the
// effect outcome. Every affected resource stays write-blocked until separate
// trusted reconciliation. Missing/opaque legacy proof remains Home-wide closed.
func (h *SecurityHome) MapSecurityRecoveryImpact(ctx context.Context, in SecurityRecoveryMapping) (out SecurityRecoveryReview, err error) {
	request := js(in)
	err = h.withSecurityRecoveryReview(ctx, func(tx *gorm.DB, journal securityRestoreJournal) error {
		if repeated, actionErr := recoveryActionBegin(tx, journal, in.Action, request, &out); repeated || actionErr != nil {
			return actionErr
		}
		var impact securityRecoveryImpactRow
		if actionErr := tx.First(&impact, "id = ? AND recovery_id = ?", in.ImpactID, journal.After.RecoveryID).Error; actionErr != nil {
			return actionErr
		}
		if impact.RecordDigest != in.RecordDigest || impact.ScopeState != "unverified" {
			return security.ErrConflict
		}
		descriptor, actionErr := verifiedRecoveryDescriptor(impact)
		if actionErr != nil {
			return actionErr
		}
		ids := sortedRecoveryResources(descriptor.Resources)
		given := append([]string(nil), in.ResourceIDs...)
		slices.Sort(given)
		if !slices.Equal(ids, given) {
			return errors.New("security: explicitly confirm every original resource identity; subsets and inferred targets are rejected")
		}
		if len(ids) == 0 {
			for _, capability := range descriptor.Capabilities {
				if !securityReadOnlyCapability(capability) {
					return errors.New("security: missing impact resources for mutating operation")
				}
			}
		}
		for _, resource := range descriptor.Resources {
			if actionErr = confirmRecoveryResource(tx, h.Home, journal, impact, descriptor, resource); actionErr != nil {
				return actionErr
			}
			block := securityRecoveryResourceBlockRow{ID: hash(impact.ID + "\x00" + resource.ID), RecoveryID: impact.RecoveryID, ImpactID: impact.ID, ProjectID: descriptor.ProjectID, ResourceID: resource.ID, ConnectionRevision: resource.ConnectionRevision, ConnectionDigest: resource.ConnectionDigest, State: "blocked", Revision: 1}
			if actionErr = tx.Create(&block).Error; actionErr != nil {
				return actionErr
			}
		}
		changed := tx.Model(&securityRecoveryImpactRow{}).Where("id = ? AND revision = ? AND scope_state = ?", impact.ID, impact.Revision, "unverified").Updates(map[string]any{"scope_state": "mapped", "resource_ids": js(ids), "revision": impact.Revision + 1})
		if changed.Error != nil {
			return changed.Error
		}
		if changed.RowsAffected != 1 {
			return security.ErrConflict
		}
		out, actionErr = recoveryActionCommit(tx, journal, in.Action, "recovery.impact.map", impact.ID, request, time.Now().UTC())
		return actionErr
	})
	return out, err
}

type SecurityRecoveryPolicyConfirmation struct {
	Action       SecurityRecoveryAction      `json:"action"`
	ProjectID    string                      `json:"projectId"`
	SourceDigest string                      `json:"sourceDigest"`
	Policy       security.ProjectPolicy      `json:"policy"`
	Resources    []security.ResourceRevision `json:"resources,omitempty"`
}

func (h *SecurityHome) ConfirmSecurityRecoveryPolicy(ctx context.Context, in SecurityRecoveryPolicyConfirmation) (out SecurityRecoveryReview, err error) {
	request := js(in)
	err = h.withSecurityRecoveryReview(ctx, func(tx *gorm.DB, journal securityRestoreJournal) error {
		if repeated, actionErr := recoveryActionBegin(tx, journal, in.Action, request, &out); repeated || actionErr != nil {
			return actionErr
		}
		var review securityRecoveryPolicyReviewRow
		if actionErr := tx.First(&review, "recovery_id = ? AND project_id = ?", journal.After.RecoveryID, in.ProjectID).Error; actionErr != nil {
			return actionErr
		}
		if review.SourceDigest != in.SourceDigest || review.Confirmed || in.Policy.ProjectID != in.ProjectID {
			return security.ErrConflict
		}
		projects, actionErr := recoveryWebProjects(filepath.Join(filepath.Dir(h.RuntimeRoot), "lake-web.sqlite"))
		if actionErr != nil {
			return actionErr
		}
		if !slices.Contains(projects, in.ProjectID) {
			return errors.New("security: policy project is not present in the restored catalog")
		}
		policy := in.Policy
		if policy.SchemaVersion != 1 || policy.Mode != "restricted" && policy.Mode != "compatible" && policy.Mode != "legacy" {
			return errSecurityAction
		}
		if policy.Mode == "legacy" {
			var previous securityProjectPolicyRow
			if actionErr = tx.First(&previous, "project_id = ? AND mode = ?", in.ProjectID, "legacy").Error; actionErr != nil {
				return errors.New("security: recovery cannot create a new legacy policy")
			}
		}
		for _, id := range policy.ResourceIDs {
			asset, catalogErr := recoveryCatalogResource(filepath.Join(filepath.Dir(h.RuntimeRoot), "lake-web.sqlite"), id)
			if catalogErr != nil || asset.project != in.ProjectID {
				return errors.New("security: policy resource belongs to another/missing project")
			}
		}
		if actionErr = confirmRecoveryPolicyCatalog(ctx, tx, h.Home, journal, in.ProjectID, policy.ResourceIDs, in.Resources); actionErr != nil {
			return actionErr
		}
		for _, rule := range policy.Rules {
			if !security.KnownCapability(rule.Capability) || rule.Effect != security.EffectAllow && rule.Effect != security.EffectAsk && rule.Effect != security.EffectDeny {
				return errSecurityAction
			}
			if rule.Effect == security.EffectAsk && rule.Confirmation != security.ConfirmSingle && rule.Confirmation != security.ConfirmTask && rule.Confirmation != security.ConfirmEither {
				return errSecurityAction
			}
			for _, id := range rule.ResourceIDs {
				if !slices.Contains(policy.ResourceIDs, id) {
					return errors.New("security: policy rule exceeds the confirmed project resource ceiling")
				}
			}
		}
		policy.StoreID, policy.RecoveryEpoch, policy.Revision, policy.Confirmed = journal.After.StoreID, journal.After.RecoveryEpoch, review.MaximumPriorRevision+1, true
		row := securityProjectPolicyRow{ProjectID: in.ProjectID, StoreID: policy.StoreID, RecoveryEpoch: policy.RecoveryEpoch, Revision: policy.Revision, Mode: policy.Mode, Confirmed: true, Data: js(policy)}
		if actionErr = tx.Save(&row).Error; actionErr != nil {
			return actionErr
		}
		changed := tx.Model(&securityRecoveryPolicyReviewRow{}).Where("id = ? AND confirmed = ? AND source_digest = ?", review.ID, false, in.SourceDigest).Updates(map[string]any{"confirmed": true, "confirmed_revision": policy.Revision})
		if changed.Error != nil {
			return changed.Error
		}
		if changed.RowsAffected != 1 {
			return security.ErrConflict
		}
		out, actionErr = recoveryActionCommit(tx, journal, in.Action, "recovery.policy.confirm", in.ProjectID, request, time.Now().UTC())
		return actionErr
	})
	return out, err
}

func SecurityRecoveryReviewOffline(ctx context.Context, home string) (SecurityRecoveryReview, error) {
	h, err := OpenSecurityReadOnlyHome(home, "")
	if err != nil {
		return SecurityRecoveryReview{}, err
	}
	defer h.Close()
	return h.SecurityRecoveryReview(ctx)
}

func MapSecurityRecoveryImpactOffline(ctx context.Context, home string, in SecurityRecoveryMapping) (SecurityRecoveryReview, error) {
	h, err := OpenSecurityReadOnlyHome(home, "")
	if err != nil {
		return SecurityRecoveryReview{}, err
	}
	defer h.Close()
	in.Action.ActorID = "local-user"
	return h.MapSecurityRecoveryImpact(ctx, in)
}

func ConfirmSecurityRecoveryPolicyOffline(ctx context.Context, home string, in SecurityRecoveryPolicyConfirmation) (SecurityRecoveryReview, error) {
	h, err := OpenSecurityReadOnlyHome(home, "")
	if err != nil {
		return SecurityRecoveryReview{}, err
	}
	defer h.Close()
	in.Action.ActorID = "local-user"
	return h.ConfirmSecurityRecoveryPolicy(ctx, in)
}
