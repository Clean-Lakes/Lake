package ai

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

const securityEnforcedReaderVersion = 2

// This is compiled host evidence, never configuration or a request field.
// A name may enter this list only after its actual adapter and execution family
// pass the final dispatch/revocation/recovery matrix and boundary checker.
// The audited static declaration is in security_enforcement_coverage.go.

var securityRequiredExecutionFamilies = [...]string{
	"@invoke", "@web_bridge", "@stdio", "@pilot", "@child", "@sre", "@observation",
	"@workflow", "@schedule", "@mcp", "@terminal_agent", "@memory_background", "@provider_continuation",
}

type SecurityEnforcementReadiness struct {
	Ready                 bool   `json:"ready"`
	RequiredEntrypoints   int    `json:"requiredEntrypoints"`
	VerifiedEntrypoints   int    `json:"verifiedEntrypoints"`
	RegistryDigest        string `json:"registryDigest"`
	Reason                string `json:"reason"`
	RequiredReaderVersion int    `json:"requiredReaderVersion"`
}

type securityEnforcementProof struct{ registryDigest string }

func currentSecurityEnforcementReadiness() (SecurityEnforcementReadiness, securityEnforcementProof) {
	return verifySecurityEnforcementCoverage(securityVerifiedEnforcementEntrypoints[:])
}

func verifySecurityEnforcementCoverage(verified []string) (SecurityEnforcementReadiness, securityEnforcementProof) {
	required := append(security.RegisteredTools(), securityRequiredExecutionFamilies[:]...)
	slices.Sort(required)
	actual := append([]string(nil), verified...)
	slices.Sort(actual)
	digest := hash(security.RegistryVersion + "\x00" + js(required))
	result := SecurityEnforcementReadiness{RequiredEntrypoints: len(required), VerifiedEntrypoints: len(actual), RegistryDigest: digest, RequiredReaderVersion: securityEnforcedReaderVersion}
	if !slices.Equal(required, actual) {
		result.Reason = "ENTRYPOINT_COVERAGE_INCOMPLETE"
		return result, securityEnforcementProof{}
	}
	if security.ReaderVersion < securityEnforcedReaderVersion {
		result.Reason = "READER_GUARD_UPGRADE_REQUIRED"
		return result, securityEnforcementProof{}
	}
	result.Ready, result.Reason = true, "READY"
	return result, securityEnforcementProof{registryDigest: digest}
}

func SecurityEnforcementStatus() SecurityEnforcementReadiness {
	readiness, _ := currentSecurityEnforcementReadiness()
	return readiness
}

// ActivateSecurityRecovery cannot accept coverage or an "ignore unknown" flag
// from a caller. Its first barrier is the compiled current-entrypoint proof.
// The remaining review/configuration/ledger checks are performed in the same
// management transaction before any reader-guard/control transition.
func (h *SecurityHome) ActivateSecurityRecovery(ctx context.Context, action SecurityRecoveryAction) (SecurityRecoveryReview, error) {
	readiness, proof := currentSecurityEnforcementReadiness()
	if !readiness.Ready || proof.registryDigest == "" {
		return SecurityRecoveryReview{}, errors.New("security: " + readiness.Reason + "; recovery gate remains closed")
	}
	return h.activateSecurityRecovery(ctx, action, proof)
}

func ActivateSecurityRecoveryOffline(ctx context.Context, home string, action SecurityRecoveryAction) (SecurityRecoveryReview, error) {
	h, err := OpenSecurityReadOnlyHome(home, "")
	if err != nil {
		return SecurityRecoveryReview{}, err
	}
	defer h.Close()
	action.ActorID = "local-user"
	return h.ActivateSecurityRecovery(ctx, action)
}

func (h *SecurityHome) activateSecurityRecovery(ctx context.Context, action SecurityRecoveryAction, proof securityEnforcementProof) (SecurityRecoveryReview, error) {
	var out SecurityRecoveryReview
	var origin securityRestoreJournal
	readiness, currentProof := currentSecurityEnforcementReadiness()
	if !readiness.Ready || proof.registryDigest == "" || proof != currentProof || security.ReaderVersion < securityEnforcedReaderVersion {
		return out, errors.New("security: trusted enforcement coverage and current reader required")
	}
	request := js(struct {
		Action   SecurityRecoveryAction
		Coverage string
	}{action, proof.registryDigest})
	err := h.withSecurityRecoveryReview(ctx, func(tx *gorm.DB, journal securityRestoreJournal) error {
		origin = journal
		if repeated, err := securityActionReplay(tx, journal.After.StoreID, journal.After.RecoveryEpoch, action.ActorID, action.ActionID, request, &out); repeated || err != nil {
			return err
		}
		if _, err := recoveryActionBegin(tx, journal, action, request, &out); err != nil {
			return err
		}
		var err error
		out, err = readSecurityRecoveryReview(tx, journal)
		if err != nil {
			return err
		}
		if !out.ReviewComplete {
			return errors.New("security: policies or operation impact scopes remain unconfirmed")
		}
		for _, legacy := range out.LegacyPolicies {
			var policy securityLegacySessionPolicyRow
			if !legacy.Confirmed || tx.First(&policy, "session_id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ? AND revision = ?", legacy.SessionID, legacy.ProjectID, journal.After.StoreID, journal.After.RecoveryEpoch, legacy.ConfirmedRevision).Error != nil {
				return errors.New("security: legacy effective session permissions require explicit reconfirmation")
			}
		}
		for _, policyReview := range out.Policies {
			policy, err := loadSecurityPolicy(tx, policyReview.ProjectID, journal.After.StoreID, journal.After.RecoveryEpoch)
			if err != nil || policy.Revision != policyReview.ConfirmedRevision {
				return errors.New("security: confirmed project policy changed")
			}
			for _, resourceID := range policy.ResourceIDs {
				var resource securityResourceRevisionRow
				if err := tx.First(&resource, "project_id = ? AND resource_id = ? AND store_id = ? AND recovery_epoch = ? AND state = ?", policy.ProjectID, resourceID, journal.After.StoreID, journal.After.RecoveryEpoch, "ready").Error; err != nil {
					return errors.New("security: resource configuration requires trusted catalog confirmation")
				}
			}
		}
		var impacts []securityRecoveryImpactRow
		if err = tx.Where("recovery_id = ?", action.RecoveryID).Find(&impacts).Error; err != nil {
			return err
		}
		for _, impact := range impacts {
			descriptor, err := verifiedRecoveryDescriptor(impact)
			if err != nil {
				return err
			}
			for _, resource := range descriptor.Resources {
				if err := confirmRecoveryResource(tx, h.Home, journal, impact, descriptor, resource); err != nil {
					return err
				}
				var count int64
				if err = tx.Model(&securityRecoveryResourceBlockRow{}).Where("recovery_id = ? AND impact_id = ? AND resource_id = ? AND state = ?", action.RecoveryID, impact.ID, resource.ID, "blocked").Count(&count).Error; err != nil || count != 1 {
					return errors.New("security: recovery resource write block missing")
				}
			}
		}
		for _, name := range []string{"native_approvals", "security_task_grants", "security_tasks"} {
			if !tx.Migrator().HasTable(name) {
				continue
			}
			var count int64
			query := tx.Table(name)
			switch name {
			case "native_approvals":
				query = query.Where("status IN ?", []string{"pending", "decided", "authorized"})
			case "security_task_grants":
				query = query.Where("revoked = ?", false)
			case "security_tasks":
				query = query.Where("state NOT IN ?", []string{"paused", "completed", "cancelled", "expired"})
			}
			if err = query.Count(&count).Error; err != nil || count != 0 {
				return errors.New("security: old execution authority was not fully invalidated")
			}
		}
		if err = verifyRecoverySchedulesDisabled(filepath.Join(filepath.Dir(h.RuntimeRoot), "tool-schedules.json")); err != nil {
			return err
		}
		for _, path := range []string{filepath.Join(filepath.Dir(h.RuntimeRoot), "ai", "adk", "sessions.sqlite"), filepath.Join(h.Home, "security", "legacy-inventory.pending")} {
			if _, err = os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
				return errors.New("security: unreviewed legacy store or inventory remains")
			}
		}
		changed := tx.Model(&securityRecoveryReviewRow{}).Where("recovery_id = ? AND revision = ? AND state = ?", action.RecoveryID, action.ExpectedRevision, "review").Updates(map[string]any{"state": "activation_prepared", "revision": action.ExpectedRevision + 1})
		if changed.Error != nil {
			return changed.Error
		}
		if changed.RowsAffected != 1 {
			return security.ErrConflict
		}
		if err = activateRecoveredSecurityModeTx(tx, journal.After.StoreID, journal.After.RecoveryEpoch); err != nil {
			return err
		}
		if err = tx.Exec("UPDATE security_schema_meta SET minimum_reader_version=? WHERE id=1 AND store_id=? AND recovery_epoch=?", securityEnforcedReaderVersion, journal.After.StoreID, journal.After.RecoveryEpoch).Error; err != nil {
			return err
		}
		out.State, out.Revision = "activation_prepared", action.ExpectedRevision+1
		return securityActionRecord(tx, journal.After.StoreID, journal.After.RecoveryEpoch, action.ActorID, action.ActionID, "recovery.activate", action.RecoveryID, request, action.ExpectedRevision, out.Revision, out, time.Now().UTC())
	})
	if err != nil {
		return out, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	control, err := ReadSecurityControl(h.Home)
	if err != nil || h.closed || !h.readOnly || control != origin.After {
		return out, errors.New("security: activation owner/epoch changed; gate remains closed")
	}
	if err = h.prepareRecoveryActivationInventory(ctx, origin, out, proof); err != nil {
		return out, err
	}
	control.Gate = "open"
	if err = writeSecurityJSON(filepath.Join(h.Home, "security", "control.json"), control); err != nil {
		return out, err
	}
	// The current owner stays read-only. A fresh process must validate Reader 2,
	// the adopted inventory and the new epoch before starting any runtime.
	out.State = "activated_restart_required"
	return out, nil
}

func verifyRecoverySchedulesDisabled(path string) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var schedules []map[string]any
	if err = json.Unmarshal(data, &schedules); err != nil {
		return err
	}
	for _, schedule := range schedules {
		if schedule["enabled"] != false {
			return errors.New("security: restored schedule remains enabled")
		}
	}
	return nil
}

type securityRecoveryActivationRecord struct {
	FormatVersion                                                int `json:"formatVersion"`
	RecoveryID, StoreID, RecoveryEpoch                           string
	ReviewRevision                                               int64
	LedgerIndexHash, CoverageDigest, SnapshotHash, InventoryHash string
	MinimumReaderVersion                                         int
}

func (h *SecurityHome) prepareRecoveryActivationInventory(ctx context.Context, journal securityRestoreJournal, review SecurityRecoveryReview, proof securityEnforcementProof) error {
	dir := filepath.Join(h.Home, "security", "recoveries", journal.After.RecoveryID, "activation")
	if err := platform.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if _, err := privateCheckpointDir(dir, false); err != nil {
		return err
	}
	path := filepath.Join(dir, "record.json")
	var existing securityRecoveryActivationRecord
	if err := privateSecurityRead(path, &existing); err == nil {
		if existing.RecoveryID != journal.After.RecoveryID || existing.StoreID != journal.After.StoreID || existing.RecoveryEpoch != journal.After.RecoveryEpoch || existing.ReviewRevision != review.Revision || existing.CoverageDigest != proof.registryDigest || existing.LedgerIndexHash != journal.LedgerIndexHash {
			return security.ErrConflict
		}
		if err := verifySecurityRecoveryActivationRecord(h.Home, journal, existing); err != nil {
			return err
		}
		return copySecurityCheckpointFile(ctx, filepath.Join(dir, "legacy-inventory.json"), filepath.Join(h.Home, "security", "legacy-inventory.json"))
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	snapshot := filepath.Join(dir, "sessions.sqlite")
	if _, err := os.Lstat(snapshot); errors.Is(err, os.ErrNotExist) {
		if err = snapshotSecurityDatabase(ctx, filepath.Join(h.RuntimeRoot, "sessions.sqlite"), snapshot); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	digest, err := hashSecurityArchive(snapshot)
	if err != nil {
		return err
	}
	row := LegacyStore{StoreID: legacySecurityStoreID(filepath.Join(h.RuntimeRoot, "sessions.sqlite")), Source: filepath.Join(h.RuntimeRoot, "sessions.sqlite"), Snapshot: snapshot, SHA256: digest}
	db, err := openSecurityReadOnlyMode(snapshot, true)
	if err != nil {
		return err
	}
	var exists int
	if err = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='native_operations'").Scan(&exists); err == nil && exists > 0 {
		err = db.QueryRow(`SELECT count(*),COALESCE(sum(CASE WHEN status IS NULL OR status NOT IN ('succeeded','failed','not_executed') THEN 1 ELSE 0 END),0) FROM native_operations`).Scan(&row.Operations, &row.Unresolved)
	}
	if err == nil {
		err = db.QueryRow("SELECT count(*) FROM sessions").Scan(&row.Sessions)
	}
	db.Close()
	if err != nil {
		return err
	}
	inv := LegacyInventory{FormatVersion: 1, StoreID: journal.After.StoreID, RecoveryEpoch: journal.After.RecoveryEpoch, State: "ready", Policy: preserveLegacyUnresolved, Stores: []LegacyStore{row}, CreatedAt: time.Now().UTC()}
	if err = writeSecurityJSON(filepath.Join(dir, "legacy-inventory.json"), inv); err != nil {
		return err
	}
	invHash, err := hashSecurityArchive(filepath.Join(dir, "legacy-inventory.json"))
	if err != nil {
		return err
	}
	record := securityRecoveryActivationRecord{FormatVersion: 1, RecoveryID: journal.After.RecoveryID, StoreID: journal.After.StoreID, RecoveryEpoch: journal.After.RecoveryEpoch, ReviewRevision: review.Revision, LedgerIndexHash: journal.LedgerIndexHash, CoverageDigest: proof.registryDigest, SnapshotHash: digest, InventoryHash: invHash, MinimumReaderVersion: securityEnforcedReaderVersion}
	if err = writeSecurityJSON(path, record); err != nil {
		return err
	}
	return copySecurityCheckpointFile(ctx, filepath.Join(dir, "legacy-inventory.json"), filepath.Join(h.Home, "security", "legacy-inventory.json"))
}

func verifySecurityRecoveryActivationRecord(home string, journal securityRestoreJournal, record securityRecoveryActivationRecord) error {
	if record.FormatVersion != 1 || record.RecoveryID != journal.After.RecoveryID || record.StoreID != journal.After.StoreID || record.RecoveryEpoch != journal.After.RecoveryEpoch || record.MinimumReaderVersion != securityEnforcedReaderVersion || record.CoverageDigest == "" || record.LedgerIndexHash != journal.LedgerIndexHash {
		return security.ErrConflict
	}
	dir := filepath.Join(home, "security", "recoveries", record.RecoveryID, "activation")
	for name, expected := range map[string]string{"sessions.sqlite": record.SnapshotHash, "legacy-inventory.json": record.InventoryHash} {
		digest, err := hashSecurityArchive(filepath.Join(dir, name))
		if err != nil || digest != expected {
			return errors.New("security: activation preservation binding changed")
		}
	}
	return nil
}

func activatedRecoveryControl(home string, control security.ControlState, journal securityRestoreJournal) bool {
	if control.Gate != "open" {
		return false
	}
	closed := control
	closed.Gate = "closed"
	if closed != journal.After {
		return false
	}
	var record securityRecoveryActivationRecord
	path := filepath.Join(home, "security", "recoveries", control.RecoveryID, "activation", "record.json")
	if privateSecurityRead(path, &record) != nil {
		return false
	}
	return verifySecurityRecoveryActivationRecord(home, journal, record) == nil
}

// SecurityRecoveryArchive validates the only additional legacy-inventory
// archive admitted after a fully confirmed restore. Callers still verify its
// own inventory SHA and canonical-history retention before inspecting it.
func SecurityRecoveryArchive(home, snapshot string) bool {
	var journal securityRestoreJournal
	if privateSecurityRead(filepath.Join(home, "security", "restore.pending.json"), &journal) != nil || !validSecurityRestoreJournal(journal) {
		return false
	}
	dir := filepath.Join(home, "security", "recoveries", journal.After.RecoveryID, "activation")
	if snapshot != filepath.Join(dir, "sessions.sqlite") {
		return false
	}
	var record securityRecoveryActivationRecord
	if privateSecurityRead(filepath.Join(dir, "record.json"), &record) != nil {
		return false
	}
	return verifySecurityRecoveryActivationRecord(home, journal, record) == nil
}
