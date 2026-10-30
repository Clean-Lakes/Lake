package ai

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/Clean-Lakes/Lake/internal/agent/storage"
	"github.com/Clean-Lakes/Lake/internal/platform"
)

const preserveLegacyUnresolved = "preserve_unresolved_no_replay"

type initialMigrationRecovery struct {
	FormatVersion int             `json:"formatVersion"`
	Inventory     LegacyInventory `json:"inventory"`
	Stage         string          `json:"stage"`
}

// ResumeInitialSecurityMigration is an offline host operation, never a model or
// Web tool. It adopts one existing canonical ledger without resolving its old
// unknown effects. Existing operation IDs and exact unfinished-call guards keep
// preventing replay; fresh work continues through the normal permission checks.
func ResumeInitialSecurityMigration(ctx context.Context, home string) error {
	return resumeInitialSecurityMigration(ctx, home, nil)
}

func resumeInitialSecurityMigration(ctx context.Context, home string, checkpoint func(string) error) error {
	h, err := OpenSecurityReadOnlyHome(home, "")
	if err != nil {
		return err
	}
	defer h.Close()
	if h.control.StoreReady || h.control.RecoveryID != "" {
		return errors.New("security: this command only resumes an initial legacy migration")
	}
	old := filepath.Join(filepath.Dir(h.RuntimeRoot), "ai", "adk", "sessions.sqlite")
	if _, err = os.Lstat(old); !errors.Is(err, os.ErrNotExist) {
		return errors.New("security: multiple legacy stores require separate reconciliation")
	}
	// A legacy writer must have the durable identity fields used by the existing
	// replay guard. Never adopt a stripped/unknown operation schema.
	rows, err := h.readOnlyDB.QueryContext(ctx, "SELECT id,session_id,root_turn_id,call_id,tool,args_hash,target,risk,status,handle FROM native_operations LIMIT 0")
	if err != nil {
		return err
	}
	rows.Close()
	var exists, active int
	if err = h.readOnlyDB.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='native_work_goals'").Scan(&exists); err != nil {
		return err
	}
	if exists != 0 {
		if err = h.readOnlyDB.QueryRowContext(ctx, "SELECT count(*) FROM native_work_goals WHERE status IS NULL OR status NOT IN ('completed','failed','cancelled','blocked','waiting_user')").Scan(&active); err != nil {
			return err
		}
		if active != 0 {
			return errors.New("security: active legacy work must be paused before initial migration recovery")
		}
	}
	dir := filepath.Join(h.Home, "security", "initial-migration-recovery")
	if err = platform.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if info, e := os.Lstat(dir); e != nil || !info.IsDir() || !platform.Private(dir, info) {
		return errors.New("security: invalid initial recovery directory")
	}
	var previous LegacyInventory
	inventoryPath := filepath.Join(h.Home, "security", "legacy-inventory.json")
	if e := privateSecurityRead(inventoryPath, &previous); e == nil {
		if previous.FormatVersion != 1 || previous.StoreID != h.control.StoreID || previous.RecoveryEpoch != h.control.RecoveryEpoch || len(previous.Stores) != 1 || previous.Stores[0].Source != filepath.Join(h.RuntimeRoot, "sessions.sqlite") || (previous.State != "pending_review" && !(previous.State == "ready" && previous.Policy == preserveLegacyUnresolved)) {
			return errors.New("security: existing legacy inventory does not match initial recovery")
		}
		digest, e := hashSecurityArchive(previous.Stores[0].Snapshot)
		if e != nil || digest != previous.Stores[0].SHA256 {
			return errors.New("security: existing legacy snapshot changed")
		}
		beforePath := filepath.Join(dir, "legacy-inventory.before.json")
		if _, e = os.Lstat(beforePath); errors.Is(e, os.ErrNotExist) {
			if e = writeSecurityJSON(beforePath, previous); e != nil {
				return e
			}
		} else if e != nil {
			return e
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	pending := filepath.Join(h.Home, "security", "legacy-inventory.pending")
	archivedPending := filepath.Join(dir, "legacy-inventory.pending")
	var marker struct {
		StoreID string `json:"storeID"`
	}
	markerPath := pending
	if _, e := os.Lstat(pending); errors.Is(e, os.ErrNotExist) {
		markerPath = archivedPending
	}
	if err = privateSecurityRead(markerPath, &marker); err != nil || marker.StoreID != h.control.StoreID {
		return errors.New("security: no matching interrupted initial inventory")
	}
	journalPath := filepath.Join(dir, "record.json")
	var recovery initialMigrationRecovery
	err = privateSecurityRead(journalPath, &recovery)
	if errors.Is(err, os.ErrNotExist) {
		if markerPath != pending {
			return errors.New("security: missing initial recovery journal")
		}
		if err = writeSecurityJSON(filepath.Join(dir, "control.before.json"), h.control); err != nil {
			return err
		}
		source := filepath.Join(h.RuntimeRoot, "sessions.sqlite")
		snapshot := filepath.Join(dir, "sessions.sqlite")
		if err = snapshotSecurityDatabase(ctx, source, snapshot); err != nil {
			return err
		}
		row, e := inspectInitialRecoverySnapshot(ctx, source, snapshot)
		if e != nil {
			return e
		}
		recovery = initialMigrationRecovery{FormatVersion: 1, Stage: "prepared", Inventory: LegacyInventory{FormatVersion: 1, StoreID: h.control.StoreID, RecoveryEpoch: h.control.RecoveryEpoch, State: "ready", Policy: preserveLegacyUnresolved, Stores: []LegacyStore{row}, CreatedAt: time.Now().UTC()}}
		if err = writeSecurityJSON(journalPath, recovery); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	inv := recovery.Inventory
	if recovery.FormatVersion != 1 || (recovery.Stage != "prepared" && recovery.Stage != "store_ready") || inv.FormatVersion != 1 || inv.StoreID != h.control.StoreID || inv.RecoveryEpoch != h.control.RecoveryEpoch || inv.State != "ready" || inv.Policy != preserveLegacyUnresolved || len(inv.Stores) != 1 || inv.Stores[0].Source != filepath.Join(h.RuntimeRoot, "sessions.sqlite") || inv.Stores[0].Snapshot != filepath.Join(dir, "sessions.sqlite") {
		return errors.New("security: initial recovery journal identity mismatch")
	}
	sum, err := hashSecurityArchive(inv.Stores[0].Snapshot)
	if err != nil || sum != inv.Stores[0].SHA256 {
		return errors.New("security: initial recovery snapshot changed")
	}
	step := func(stage string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if checkpoint != nil {
			return checkpoint(stage)
		}
		return ctx.Err()
	}
	if err = step("prepared"); err != nil {
		return err
	}
	if err = h.CheckReadOnlyView(); err != nil {
		return err
	}
	// Close the read-only handle before the public SDK migrator. The control
	// remains closed through all schema work and durable evidence writes.
	h.readOnlyDB.Close()
	h.readOnlyDB = nil
	store, err := storage.OpenChecked(filepath.Join(h.RuntimeRoot, "sessions.sqlite"), h.bindSecurityDatabase)
	if err != nil {
		return err
	}
	if err = store.Close(); err != nil {
		return err
	}
	recovery.Stage = "store_ready"
	if err = writeSecurityJSON(journalPath, recovery); err != nil {
		return err
	}
	if err = step("store_ready"); err != nil {
		return err
	}
	if err = writeSecurityJSON(filepath.Join(h.Home, "security", "legacy-inventory.json"), inv); err != nil {
		return err
	}
	if err = step("inventory"); err != nil {
		return err
	}
	if markerPath == pending {
		if previous, e := os.ReadFile(archivedPending); e == nil {
			current, e := os.ReadFile(pending)
			if e != nil || !bytes.Equal(previous, current) {
				return errors.New("security: archived migration marker mismatch")
			}
		} else if !errors.Is(e, os.ErrNotExist) {
			return e
		}
		if err = platform.ReplaceFile(pending, archivedPending); err != nil {
			return err
		}
		if err = platform.SyncDirectory(dir); err != nil {
			return err
		}
		if err = platform.SyncDirectory(filepath.Dir(pending)); err != nil {
			return err
		}
	}
	if err = step("marker_archived"); err != nil {
		return err
	}
	// This final durable write activates the bound store, never an old approval
	// or an unresolved call. No worker/model/tool runs in the recovery process.
	c := h.control
	c.StoreReady, c.Gate = true, "open"
	if err = h.CheckReadOnlyView(); err != nil {
		return err
	}
	return writeSecurityJSON(filepath.Join(h.Home, "security", "control.json"), c)
}

func inspectInitialRecoverySnapshot(ctx context.Context, source, snapshot string) (LegacyStore, error) {
	digest := sha256.Sum256([]byte(source))
	row := LegacyStore{StoreID: hex.EncodeToString(digest[:]), Source: source, Snapshot: snapshot}
	var err error
	row.SHA256, err = hashSecurityArchive(snapshot)
	if err != nil {
		return row, err
	}
	db, err := openSecurityReadOnly(snapshot)
	if err != nil {
		return row, err
	}
	defer db.Close()
	var integrity string
	if err = db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&integrity); err != nil {
		return row, err
	}
	if integrity != "ok" {
		return row, errors.New("security: invalid initial recovery snapshot")
	}
	err = db.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(CASE WHEN status IS NULL OR status NOT IN ('succeeded','failed','not_executed') THEN 1 ELSE 0 END),0) FROM native_operations`).Scan(&row.Operations, &row.Unresolved)
	if err != nil {
		return row, err
	}
	err = db.QueryRowContext(ctx, "SELECT count(*) FROM sessions").Scan(&row.Sessions)
	return row, err
}
