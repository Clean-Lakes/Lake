package ai

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/security"
)

// SecurityRestoreResult is management-only. ConfirmationRequired is never an
// authorization to execute: a separate verified reconciliation/policy protocol
// must establish current authority before opening the gate.
type SecurityRestoreResult struct {
	RecoveryID           string `json:"recoveryID"`
	StoreID              string `json:"storeID"`
	RecoveryEpoch        string `json:"recoveryEpoch"`
	PreservedCheckpoint  string `json:"preservedCheckpoint"`
	Stage                string `json:"stage"`
	ConfirmationRequired bool   `json:"confirmationRequired"`
	LedgerIndexAvailable bool   `json:"ledgerIndexAvailable"`
}

type securityRestoreJournal struct {
	FormatVersion         int                   `json:"formatVersion"`
	Source                string                `json:"source"`
	SourceManifestHash    string                `json:"sourceManifestHash"`
	SourceStoreID         string                `json:"sourceStoreID,omitempty"`
	SourceRecoveryEpoch   string                `json:"sourceRecoveryEpoch,omitempty"`
	Before                security.ControlState `json:"before"`
	After                 security.ControlState `json:"after"`
	Stage                 string                `json:"stage"`
	Import                bool                  `json:"import"`
	PreservedManifestHash string                `json:"preservedManifestHash,omitempty"`
	IncomingManifestHash  string                `json:"incomingManifestHash,omitempty"`
	LedgerIndexHash       string                `json:"ledgerIndexHash,omitempty"`
}

// RestoreSecurityBackup performs an offline paired restore, always leaving the
// gate closed. It preserves the complete newer stores before replacing any live
// member. Those immutable stores are required reconciliation inputs: old grants,
// approvals or an old checkpoint cannot authorize reopening the gate.
//
// Cross-device import rotates both store identity and epoch. Same-device restore
// retains store identity and rotates epoch. Retrying an interrupted restore uses
// the same durable journal/epoch and never snapshots partially restored data as
// the newer pre-restore history.
func RestoreSecurityBackup(ctx context.Context, home, checkpoint string, crossDevice bool) (SecurityRestoreResult, error) {
	return restoreSecurityBackup(ctx, home, checkpoint, crossDevice, nil)
}

func restoreSecurityBackup(ctx context.Context, home, checkpoint string, crossDevice bool, stop func(string) error) (SecurityRestoreResult, error) {
	var result SecurityRestoreResult
	source, err := privateCheckpointDir(checkpoint, false)
	if err != nil {
		return result, err
	}
	cp, err := VerifySecurityCheckpoint(ctx, source)
	if err != nil {
		return result, err
	}
	manifestHash, err := checkpointManifestHash(source)
	if err != nil {
		return result, err
	}
	home, runtimeRoot, err := ResolveSecurityHome(home, "")
	if err != nil {
		return result, err
	}
	lock, err := AcquireSecurityOwner(home)
	if err != nil {
		return result, err
	}
	defer lock.Close()
	rootLock, err := lockSecurityFile(filepath.Join(filepath.Dir(runtimeRoot), ".security-owner.lock"))
	if err != nil {
		return result, err
	}
	defer rootLock.Close()
	webLock, err := lockSecurityFile(filepath.Join(filepath.Dir(runtimeRoot), "server.lock"))
	if err != nil {
		return result, err
	}
	defer webLock.Close()
	if err = checkLegacyRuntimeOwner(filepath.Join(filepath.Dir(runtimeRoot), "runtime.json")); err != nil {
		return result, err
	}
	if withinSecurityPath(filepath.Dir(runtimeRoot), source) {
		return result, errors.New("security: restore source overlaps live data")
	}
	control, err := ReadSecurityControl(home)
	if crossDevice {
		control, err = bootstrapSecurityImportTarget(ctx, home, runtimeRoot, source, manifestHash, control, err, stop)
	}
	if err != nil {
		return result, err
	}
	if control.RuntimeRoot != runtimeRoot || !control.StoreReady {
		return result, errors.New("security: restore requires an initialized matching Home")
	}
	if withinSecurityPath(filepath.Dir(runtimeRoot), source) {
		return result, errors.New("security: restore source overlaps live data")
	}
	journalPath := filepath.Join(home, "security", "restore.pending.json")
	var journal securityRestoreJournal
	err = privateSecurityRead(journalPath, &journal)
	if errors.Is(err, os.ErrNotExist) {
		if control.RecoveryID != "" {
			return result, errors.New("security: recovery already requires management")
		}
		if !crossDevice && cp.StoreID != control.StoreID {
			return result, errors.New("security: checkpoint belongs to another store; explicit import required")
		}
		journal = securityRestoreJournal{FormatVersion: 1, Source: source, SourceManifestHash: manifestHash, SourceStoreID: cp.StoreID, SourceRecoveryEpoch: cp.RecoveryEpoch, Before: control, After: control, Stage: "prepared", Import: crossDevice}
		if journal.After.RecoveryEpoch, err = securityID(); err != nil {
			return result, err
		}
		if journal.After.RecoveryID, err = securityID(); err != nil {
			return result, err
		}
		if crossDevice {
			if journal.After.StoreID, err = securityID(); err != nil {
				return result, err
			}
		}
		journal.After.Gate = "closed"
		if err = writeSecurityJSON(journalPath, journal); err != nil {
			return result, err
		}
	} else if err != nil {
		return result, err
	}
	if !validSecurityRestoreJournal(journal) || journal.Source != source || journal.SourceManifestHash != manifestHash || journal.Import != crossDevice || journal.Before.RuntimeRoot != runtimeRoot || journal.After.RuntimeRoot != runtimeRoot {
		return result, errors.New("security: restore journal identity mismatch")
	}
	if journal.SourceStoreID != "" && (journal.SourceStoreID != cp.StoreID || journal.SourceRecoveryEpoch != cp.RecoveryEpoch) {
		return result, errors.New("security: restore source control identity mismatch")
	}
	if control != journal.Before && control != journal.After {
		return result, errors.New("security: restore owner changed")
	}
	if !crossDevice && cp.StoreID != journal.Before.StoreID {
		return result, errors.New("security: source store identity changed")
	}
	if err = ctx.Err(); err != nil {
		return result, err
	}
	// This is the first mutation of execution authority, and precedes snapshots,
	// any database changes and every file replacement.
	if control == journal.Before {
		if err = writeSecurityJSON(filepath.Join(home, "security", "control.json"), journal.After); err != nil {
			return result, err
		}
	}
	root := filepath.Join(home, "security", "recoveries", journal.After.RecoveryID)
	if err = platform.MkdirAll(root, 0700); err != nil {
		return result, err
	}
	if _, err = privateCheckpointDir(root, false); err != nil {
		return result, err
	}
	result = SecurityRestoreResult{RecoveryID: journal.After.RecoveryID, StoreID: journal.After.StoreID, RecoveryEpoch: journal.After.RecoveryEpoch, PreservedCheckpoint: filepath.Join(root, "preserved"), Stage: journal.Stage, ConfirmationRequired: true}
	step := func(stage string) error {
		result.Stage = stage
		if err := ctx.Err(); err != nil {
			return err
		}
		if stop != nil {
			return stop(stage)
		}
		return nil
	}
	if err = step("gate_closed"); err != nil {
		return result, err
	}
	if journal.Stage == "prepared" {
		preserved := result.PreservedCheckpoint
		if _, e := os.Stat(filepath.Join(preserved, "manifest.json")); errors.Is(e, os.ErrNotExist) {
			// An interrupted snapshot may have a partial directory. Never overwrite
			// it or mistake it for a complete pre-restore checkpoint.
			if _, e = os.Lstat(preserved); e == nil {
				return result, errors.New("security: interrupted preservation needs management; no database was replaced")
			}
			if _, err = writeSecurityCheckpoint(ctx, filepath.Dir(runtimeRoot), preserved, journal.Before); err != nil {
				return result, err
			}
		} else if e != nil {
			return result, e
		}
		preservedCP, e := VerifySecurityCheckpoint(ctx, preserved)
		if e != nil || preservedCP.StoreID != journal.Before.StoreID || preservedCP.RecoveryEpoch != journal.Before.RecoveryEpoch {
			return result, errors.New("security: preserved checkpoint is invalid")
		}
		if journal.PreservedManifestHash, err = checkpointManifestHash(preserved); err != nil {
			return result, err
		}
		journal.Stage = "preserved"
		if err = writeSecurityJSON(journalPath, journal); err != nil {
			return result, err
		}
	}
	if err = step("preserved"); err != nil {
		return result, err
	}
	if journal.Stage != "preserved" && journal.Stage != "staged" && journal.Stage != "confirmation_required" {
		return result, errors.New("security: invalid recovery stage")
	}
	stage := filepath.Join(root, "incoming")
	if journal.Stage == "preserved" {
		if _, e := os.Lstat(stage); errors.Is(e, os.ErrNotExist) {
			if _, e = privateCheckpointDir(stage, true); e != nil {
				return result, e
			}
		} else if e != nil {
			return result, e
		}
		if _, err = privateCheckpointDir(stage, false); err != nil {
			return result, err
		}
		for _, file := range cp.Files {
			if !file.Present {
				continue
			}
			out := filepath.Join(stage, filepath.FromSlash(file.Path))
			if err = platform.MkdirAll(filepath.Dir(out), 0700); err != nil {
				return result, err
			}
			if err = copySecurityCheckpointFile(ctx, filepath.Join(source, filepath.FromSlash(file.Path)), out); err != nil {
				return result, err
			}
		}
		if err = verifySecurityCheckpointFiles(ctx, stage, cp); err != nil {
			return result, err
		}
		if err = invalidateRestoredAuthority(ctx, filepath.Join(stage, "adk", "sessions.sqlite"), journal.After); err != nil {
			return result, err
		}
		if err = disableRestoredSchedules(filepath.Join(stage, "tool-schedules.json")); err != nil {
			return result, err
		}
		derived := cp
		derived.Files = append([]SecurityCheckpointFile(nil), cp.Files...)
		derived.StoreID, derived.RecoveryEpoch = journal.After.StoreID, journal.After.RecoveryEpoch
		for i := range derived.Files {
			member := &derived.Files[i]
			if !member.Present {
				continue
			}
			path := filepath.Join(stage, filepath.FromSlash(member.Path))
			if member.SHA256, err = hashSecurityArchive(path); err != nil {
				return result, err
			}
			info, e := os.Stat(path)
			if e != nil {
				return result, e
			}
			member.Size = info.Size()
		}
		if err = verifySecurityCheckpointFiles(ctx, stage, derived); err != nil {
			return result, err
		}
		if err = syncSecurityCheckpointDirectories(stage); err != nil {
			return result, err
		}
		if err = writeSecurityJSON(filepath.Join(stage, "manifest.json"), derived); err != nil {
			return result, err
		}
		if journal.IncomingManifestHash, err = checkpointManifestHash(stage); err != nil {
			return result, err
		}
		journal.Stage = "staged"
		if err = writeSecurityJSON(journalPath, journal); err != nil {
			return result, err
		}
	}
	if err = step("staged"); err != nil {
		return result, err
	}
	if journal.Stage == "staged" {
		if err = verifyRecoveryCheckpointBindings(ctx, root, journal); err != nil {
			return result, err
		}
		if err = applySecurityRestoreFiles(ctx, filepath.Dir(runtimeRoot), stage, root, cp, journal.After, step); err != nil {
			return result, err
		}
		if err = writeRecoveryLedgerIndex(ctx, root, journal); err != nil {
			return result, err
		}
		if journal.LedgerIndexHash, err = hashSecurityArchive(filepath.Join(root, "ledger-index.json")); err != nil {
			return result, err
		}
		journal.Stage = "confirmation_required"
		if err = initializeSecurityRecoveryReview(ctx, home, journal); err != nil {
			return result, err
		}
		if err = writeSecurityJSON(journalPath, journal); err != nil {
			return result, err
		}
	}
	if _, err = readRecoveryLedgerIndex(ctx, home, journal); err != nil {
		return result, err
	}
	result.LedgerIndexAvailable = true
	if err = step("confirmation_required"); err != nil {
		return result, err
	}
	return result, nil
}

func validSecurityRestoreJournal(journal securityRestoreJournal) bool {
	if journal.FormatVersion != 1 || !filepath.IsAbs(journal.Source) || validateSecurityControl(journal.Before) != nil || validateSecurityControl(journal.After) != nil || !journal.Before.StoreReady || !journal.After.StoreReady || journal.Before.RecoveryID != "" || journal.Before.RuntimeRoot != journal.After.RuntimeRoot || journal.After.Gate != "closed" || journal.After.RecoveryEpoch == journal.Before.RecoveryEpoch {
		return false
	}
	if journal.Import == (journal.After.StoreID == journal.Before.StoreID) {
		return false
	}
	for _, value := range []string{journal.After.RecoveryID, journal.SourceManifestHash} {
		if len(value) != 64 {
			return false
		}
		if _, err := hex.DecodeString(value); err != nil {
			return false
		}
	}
	for _, value := range []string{journal.PreservedManifestHash, journal.IncomingManifestHash, journal.LedgerIndexHash} {
		if value == "" {
			continue
		}
		if len(value) != 64 {
			return false
		}
		if _, err := hex.DecodeString(value); err != nil {
			return false
		}
	}
	if (journal.SourceStoreID == "") != (journal.SourceRecoveryEpoch == "") {
		return false
	}
	for _, value := range []string{journal.SourceStoreID, journal.SourceRecoveryEpoch} {
		if value != "" {
			if len(value) != 64 {
				return false
			}
			if _, err := hex.DecodeString(value); err != nil {
				return false
			}
		}
	}
	switch journal.Stage {
	case "prepared", "preserved", "staged", "confirmation_required":
		return true
	}
	return false
}

func invalidateRestoredAuthority(ctx context.Context, path string, control security.ControlState) error {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	updates := []struct{ table, query string }{
		{"native_approvals", `UPDATE native_approvals SET status='invalid' WHERE status IN ('pending','decided','authorized')`},
		{"native_work_goals", `UPDATE native_work_goals SET status='paused',checkpoint='',wait_state='',wait_call_id='',lease_owner='',lease_until=NULL WHERE status NOT IN ('completed','failed','cancelled')`},
		{"security_tasks", `UPDATE security_tasks SET state='paused',state_revision=state_revision+1,execution_revision=execution_revision+1 WHERE state NOT IN ('completed','cancelled','expired')`},
		{"security_task_bindings", `UPDATE security_task_bindings SET state='closed',owner_generation=owner_generation+1 WHERE state IN ('active','waiting')`},
		{"security_task_grants", `UPDATE security_task_grants SET revoked=1,revision=revision+1 WHERE revoked=0`},
		{"security_schedule_grants", `UPDATE security_schedule_grants SET revoked=1,revision=revision+1 WHERE revoked=0`},
		{"security_confirmation_questions", `UPDATE security_confirmation_questions SET status='invalid',revision=revision+1 WHERE status IN ('pending','answered','contract_confirmed')`},
		{"security_project_policies", `UPDATE security_project_policies SET confirmed=0`},
	}
	for _, update := range updates {
		var exists int
		if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", update.table).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			continue
		}
		// Present but incompatible authority schemas are errors, never skipped.
		if _, err = tx.ExecContext(ctx, update.query); err != nil {
			return err
		}
		if update.table == "native_work_goals" {
			if err = pauseRestoredGoalData(ctx, tx); err != nil {
				return err
			}
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE security_schema_meta SET store_id=?,recovery_epoch=?,migration_state='ready' WHERE id=1`, control.StoreID, control.RecoveryEpoch); err != nil {
		return err
	}
	return tx.Commit()
}

func pauseRestoredGoalData(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT id,data FROM native_work_goals WHERE status='paused'`)
	if err != nil {
		return err
	}
	type goalData struct{ id, data string }
	var goals []goalData
	for rows.Next() {
		var item goalData
		if err = rows.Scan(&item.id, &item.data); err != nil {
			rows.Close()
			return err
		}
		goals = append(goals, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, goal := range goals {
		var value map[string]any
		if json.Unmarshal([]byte(goal.data), &value) != nil || value == nil {
			return errors.New("security: invalid restored goal data")
		}
		value["status"] = "paused"
		data, e := json.Marshal(value)
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `UPDATE native_work_goals SET data=? WHERE id=?`, string(data), goal.id); e != nil {
			return e
		}
	}
	return nil
}

func disableRestoredSchedules(path string) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(data) > 16<<20 {
		return errors.New("security: schedule snapshot exceeds limit")
	}
	var schedules []map[string]any
	if err = json.Unmarshal(data, &schedules); err != nil {
		return errors.New("security: invalid schedule snapshot")
	}
	for _, schedule := range schedules {
		schedule["enabled"] = false
		schedule["status"] = "disabled"
	}
	return writeSecurityJSON(path, schedules)
}

func applySecurityRestoreFiles(ctx context.Context, dataRoot, stage, recoveryRoot string, cp SecurityCheckpoint, control security.ControlState, step func(string) error) error {
	// Verify every transformed staged member before any application or retry.
	derived, err := VerifySecurityCheckpoint(ctx, stage)
	if err != nil {
		return err
	}
	if derived.StoreID != control.StoreID || derived.RecoveryEpoch != control.RecoveryEpoch || derived.ID != cp.ID {
		return errors.New("security: staged recovery identity mismatch")
	}
	cp = derived
	quarantine := filepath.Join(recoveryRoot, "replaced")
	if err = platform.MkdirAll(quarantine, 0700); err != nil {
		return err
	}
	// Files absent from the paired snapshot cannot remain as resumable session
	// state. Move them aside, retaining history, instead of deleting them.
	current, err := checkpointSources(dataRoot)
	if err != nil {
		return err
	}
	wanted := map[string]bool{}
	for _, member := range cp.Files {
		wanted[member.Path] = member.Present
	}
	for _, member := range current {
		if wanted[member.Path] {
			continue
		}
		path := filepath.Join(dataRoot, filepath.FromSlash(member.Path))
		if _, e := os.Lstat(path); errors.Is(e, os.ErrNotExist) {
			continue
		} else if e != nil {
			return e
		}
		if err = quarantineSecurityFile(path, filepath.Join(quarantine, filepath.FromSlash(member.Path))); err != nil {
			return err
		}
	}
	for _, member := range cp.Files {
		if err = ctx.Err(); err != nil {
			return err
		}
		if !member.Present {
			continue
		}
		destination := filepath.Join(dataRoot, filepath.FromSlash(member.Path))
		if err = platform.MkdirAll(filepath.Dir(destination), 0700); err != nil {
			return err
		}
		if member.Kind == "sqlite" {
			for _, suffix := range []string{"-wal", "-shm", "-journal"} {
				if _, e := os.Lstat(destination + suffix); errors.Is(e, os.ErrNotExist) {
					continue
				} else if e != nil {
					return e
				}
				if err = quarantineSecurityFile(destination+suffix, filepath.Join(quarantine, filepath.FromSlash(member.Path))+suffix); err != nil {
					return err
				}
			}
		}
		if err = copySecurityCheckpointFile(ctx, filepath.Join(stage, filepath.FromSlash(member.Path)), destination); err != nil {
			return err
		}
		if err = step("applied:" + member.Path); err != nil {
			return err
		}
	}
	return nil
}

func quarantineSecurityFile(source, destination string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !platform.Private(source, info) {
		return errors.New("security: invalid displaced recovery file")
	}
	if err = platform.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	if _, e := os.Lstat(destination); e == nil {
		return errors.New("security: displaced recovery member already exists")
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	if err = os.Rename(source, destination); err != nil {
		return err
	}
	if err = platform.SyncDirectory(filepath.Dir(destination)); err != nil {
		return err
	}
	return platform.SyncDirectory(filepath.Dir(source))
}

// RecoveryPending reports the durable recovery identity without opening any
// execution runtime. It does not imply that resource effects are reconciled.
func RecoveryPending(home string) (SecurityRestoreResult, error) {
	var journal securityRestoreJournal
	if err := privateSecurityRead(filepath.Join(home, "security", "restore.pending.json"), &journal); err != nil {
		return SecurityRestoreResult{}, err
	}
	control, err := ReadSecurityControl(home)
	if err != nil {
		return SecurityRestoreResult{}, err
	}
	if validSecurityRestoreJournal(journal) && activatedRecoveryControl(home, control, journal) {
		_, indexErr := readRecoveryLedgerIndex(context.Background(), home, journal)
		return SecurityRestoreResult{RecoveryID: control.RecoveryID, StoreID: control.StoreID, RecoveryEpoch: control.RecoveryEpoch, PreservedCheckpoint: filepath.Join(home, "security", "recoveries", control.RecoveryID, "preserved"), Stage: "activated_restart_required", ConfirmationRequired: false, LedgerIndexAvailable: indexErr == nil}, nil
	}
	if !validSecurityRestoreJournal(journal) || journal.After != control || control.Gate != "closed" || strings.TrimSpace(control.RecoveryID) == "" {
		return SecurityRestoreResult{}, errors.New("security: recovery control mismatch")
	}
	_, indexErr := readRecoveryLedgerIndex(context.Background(), home, journal)
	return SecurityRestoreResult{RecoveryID: control.RecoveryID, StoreID: control.StoreID, RecoveryEpoch: control.RecoveryEpoch, PreservedCheckpoint: filepath.Join(home, "security", "recoveries", control.RecoveryID, "preserved"), Stage: journal.Stage, ConfirmationRequired: true, LedgerIndexAvailable: indexErr == nil}, nil
}
