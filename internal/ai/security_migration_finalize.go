package ai

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/platform"
)

type LegacyRetentionTable struct {
	Name string `json:"name"`
	Rows int64  `json:"rows"`
}

// This is a verification receipt, never an operation status or permission.
type legacyOperationRetention struct {
	ID     string `json:"id"`
	Digest string `json:"digest"`
}
type legacyFinalizationReceipt struct {
	FormatVersion int                        `json:"formatVersion"`
	Inventory     LegacyInventory            `json:"inventory"`
	Tables        []LegacyRetentionTable     `json:"tables"`
	Operations    []legacyOperationRetention `json:"operations"`
	ArchiveBytes  int64                      `json:"archiveBytes"`
	CompletedAt   time.Time                  `json:"completedAt"`
}
type LegacyFinalizationReport struct {
	Applied      bool                   `json:"applied"`
	Finalized    bool                   `json:"finalized"`
	ArchiveBytes int64                  `json:"archiveBytes"`
	RemovedBytes int64                  `json:"removedBytes"`
	Tables       []LegacyRetentionTable `json:"tables"`
	Operations   int                    `json:"operations"`
}

// FinalizeSecurityMigration is explicit offline maintenance. A dry run is the
// default. It supports one canonical initial-migration archive, not independent
// stdio histories or activated recovery archives. It never resolves an outcome,
// migrates SDK tables, dispatches work, or changes the execution gate.
func FinalizeSecurityMigration(ctx context.Context, home string, apply bool) (LegacyFinalizationReport, error) {
	return finalizeSecurityMigration(ctx, home, apply, nil)
}
func finalizeSecurityMigration(ctx context.Context, home string, apply bool, checkpoint func(string) error) (out LegacyFinalizationReport, err error) {
	if home == "" {
		return out, errors.New("security: explicit Home required")
	}
	if _, err = ReadSecurityControl(home); err != nil {
		return out, err
	}
	h, err := openSecurityReadOnlyHome(home, "", true)
	if err != nil {
		return out, err
	}
	defer h.Close()
	if !h.control.StoreReady || h.control.Gate != "open" || h.control.RecoveryID != "" || h.readOnlyDB == nil {
		return out, errors.New("security: finalization requires an initialized open canonical Home without an active recovery")
	}
	webLock, err := lockSecurityFile(filepath.Join(filepath.Dir(h.RuntimeRoot), "server.lock"))
	if err != nil {
		return out, err
	}
	defer webLock.Close()
	if err = h.checkLegacyFinalizationEnvironment(); err != nil {
		return out, err
	}
	var inv LegacyInventory
	path := filepath.Join(h.Home, "security", "legacy-inventory.json")
	if err = privateSecurityRead(path, &inv); err != nil {
		return out, err
	}
	wasFinalized := inv.FormatVersion == 2
	var receipt legacyFinalizationReceipt
	if inv.FormatVersion == 2 {
		receipt, err = h.verifyLegacyFinalization(ctx, h.readOnlyDB, inv)
		if err != nil {
			return out, err
		}
	} else {
		if inv.FormatVersion != 1 || inv.State != "ready" || inv.FinalizationID != "" {
			return out, errors.New("security: migration inventory is not ready for finalization")
		}
		if err = h.checkFinalizableInventory(inv); err != nil {
			return out, err
		}
		if err = h.checkFinalizationArchive(inv.Stores[0]); err != nil {
			return out, err
		}
		receipt.Tables, err = verifyLegacyRetention(ctx, h.readOnlyDB, inv.Stores[0].Snapshot)
		if err != nil {
			return out, err
		}
		for _, table := range receipt.Tables {
			if table.Name == "native_operations" && table.Rows != inv.Stores[0].Operations || table.Name == "sessions" && table.Rows != inv.Stores[0].Sessions {
				return out, errors.New("security: migration inventory counts changed")
			}
		}
		var ids []string
		// Read the baseline IDs through an immutable handle; the comparison's
		// ATTACH has already been released.
		baseline, e := openSecurityReadOnlyMode(inv.Stores[0].Snapshot, true)
		if e != nil {
			return out, e
		}
		rows, e := baseline.QueryContext(ctx, "SELECT id FROM native_operations ORDER BY id")
		if e == nil {
			for rows.Next() {
				var id string
				if e = rows.Scan(&id); e != nil {
					break
				}
				ids = append(ids, id)
				if len(ids) > 20000 {
					e = errors.New("security: legacy operation receipt exceeds supported size")
					break
				}
			}
			if e == nil {
				e = rows.Err()
			}
			rows.Close()
		}
		if e == nil {
			receipt.Operations, e = legacyOperationProofs(ctx, baseline, ids)
		}
		baseline.Close()
		if e != nil {
			return out, e
		}
		info, e := os.Lstat(inv.Stores[0].Snapshot)
		if e != nil {
			return out, e
		}
		receipt.ArchiveBytes = info.Size()
		// Verify the immutable source again after the full retention comparison.
		if err = h.checkFinalizationArchive(inv.Stores[0]); err != nil {
			return out, err
		}
		inv.FinalizationID = legacyFinalizationDigest(inv)
		inv.FormatVersion, inv.State = 2, "finalized"
		receipt.FormatVersion, receipt.Inventory, receipt.CompletedAt = 1, inv, time.Now().UTC()
	}
	out = LegacyFinalizationReport{Applied: apply, Finalized: wasFinalized, ArchiveBytes: receipt.ArchiveBytes, Tables: receipt.Tables, Operations: len(receipt.Operations)}
	if !apply {
		return out, nil
	}
	step := func(stage string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if checkpoint != nil {
			return checkpoint(stage)
		}
		return nil
	}
	if err = h.CheckReadOnlyView(); err != nil {
		return out, err
	}
	// Publish the receipt in the canonical database before changing the small
	// inventory file. A crash leaves either the old verified archive protocol or
	// the committed receipt; deletion happens only after both are durable.
	if err = storeLegacyFinalization(ctx, h, receipt); err != nil {
		return out, err
	}
	if err = step("receipt"); err != nil {
		return out, err
	}
	if err = h.CheckReadOnlyView(); err != nil {
		return out, err
	}
	if err = writeSecurityJSON(path, inv); err != nil {
		return out, err
	}
	if err = step("inventory"); err != nil {
		return out, err
	}
	if _, err = h.verifyLegacyFinalization(ctx, h.readOnlyDB, inv); err != nil {
		return out, err
	}
	archive := inv.Stores[0]
	if _, err = os.Lstat(archive.Snapshot); err == nil {
		if err = h.checkFinalizationArchive(archive); err != nil {
			return out, err
		}
		if err = h.CheckReadOnlyView(); err != nil {
			return out, err
		}
		if err = ctx.Err(); err != nil {
			return out, err
		}
		if err = os.Remove(archive.Snapshot); err != nil {
			return out, err
		}
		if err = platform.SyncDirectory(filepath.Dir(archive.Snapshot)); err != nil {
			return out, err
		}
		out.RemovedBytes = receipt.ArchiveBytes
	} else if !errors.Is(err, os.ErrNotExist) {
		return out, err
	}
	if err = step("removed"); err != nil {
		return out, err
	}
	out.Finalized = true
	return out, nil
}

func legacyFinalizationDigest(value any) string {
	data, _ := json.Marshal(value)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
func (h *SecurityHome) checkLegacyFinalizationEnvironment() error {
	for _, p := range []string{filepath.Join(h.Home, "security", "legacy-inventory.pending"), filepath.Join(h.Home, "security", "restore.pending.json"), filepath.Join(filepath.Dir(h.RuntimeRoot), "ai", "adk", "sessions.sqlite")} {
		if _, err := os.Lstat(p); !errors.Is(err, os.ErrNotExist) {
			return errors.New("security: pending migration or independent legacy store requires management")
		}
	}
	return nil
}
func (h *SecurityHome) checkFinalizableInventory(inv LegacyInventory) error {
	if inv.StoreID != h.control.StoreID || inv.RecoveryEpoch != h.control.RecoveryEpoch || len(inv.Stores) != 1 || (inv.Policy != "" && inv.Policy != preserveLegacyUnresolved) {
		return errors.New("security: finalization requires one matching canonical inventory")
	}
	row := inv.Stores[0]
	if row.Operations < 0 || row.Operations > 20000 || row.Sessions < 0 || row.Unresolved < 0 || row.Unresolved > row.Operations {
		return errors.New("security: unsupported migration inventory counts")
	}
	canonical := filepath.Join(h.RuntimeRoot, "sessions.sqlite")
	if row.Source != canonical || row.StoreID != legacySecurityStoreID(canonical) || len(row.SHA256) != 64 || (row.Unresolved > 0 && inv.Policy != preserveLegacyUnresolved) {
		return errors.New("security: invalid canonical migration binding")
	}
	archive := filepath.Join(h.Home, "security", "legacy", row.StoreID, "sessions.sqlite")
	initial := filepath.Join(h.Home, "security", "initial-migration-recovery", "sessions.sqlite")
	if row.Snapshot != archive && row.Snapshot != initial {
		return errors.New("security: archive is outside the supported initial migration")
	}
	return nil
}
func (h *SecurityHome) checkFinalizationArchive(row LegacyStore) error {
	resolved, err := filepath.EvalSymlinks(row.Snapshot)
	if err != nil || resolved != row.Snapshot {
		return errors.New("security: migration archive path changed")
	}
	archive, err := os.Lstat(row.Snapshot)
	if err != nil {
		return err
	}
	active, err := os.Lstat(filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
	if err != nil {
		return err
	}
	if os.SameFile(archive, active) {
		return errors.New("security: migration archive aliases the active database")
	}
	for _, suffix := range []string{"-wal", "-journal", "-shm"} {
		if _, err = os.Lstat(row.Snapshot + suffix); !errors.Is(err, os.ErrNotExist) {
			return errors.New("security: migration archive has journal state")
		}
	}
	digest, err := hashSecurityArchive(row.Snapshot)
	if err != nil || digest != row.SHA256 {
		return errors.New("security: migration archive checksum mismatch")
	}
	return nil
}

func storeLegacyFinalization(ctx context.Context, h *SecurityHome, receipt legacyFinalizationReceipt) error {
	db, err := sql.Open("sqlite", filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err = db.ExecContext(ctx, "PRAGMA synchronous=FULL"); err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS security_legacy_finalizations(id TEXT PRIMARY KEY,store_id TEXT NOT NULL,recovery_epoch TEXT NOT NULL,inventory_hash TEXT NOT NULL,receipt TEXT NOT NULL)`); err != nil {
		return err
	}
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	if len(data) > 4<<20 {
		return errors.New("security: finalization receipt too large")
	}
	_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO security_legacy_finalizations VALUES(?,?,?,?,?)`, receipt.Inventory.FinalizationID, h.control.StoreID, h.control.RecoveryEpoch, legacyFinalizationDigest(receipt.Inventory), string(data))
	if err != nil {
		return err
	}
	ids := make([]string, 0, len(receipt.Operations))
	for _, op := range receipt.Operations {
		ids = append(ids, op.ID)
	}
	proofs, err := legacyOperationProofs(ctx, tx, ids)
	if err != nil {
		return err
	}
	if legacyFinalizationDigest(proofs) != legacyFinalizationDigest(receipt.Operations) {
		return errors.New("security: canonical operation binding changed before receipt commit")
	}
	return tx.Commit()
}

func (h *SecurityHome) verifyLegacyFinalization(ctx context.Context, db *sql.DB, inv LegacyInventory) (receipt legacyFinalizationReceipt, err error) {
	if inv.FormatVersion != 2 || inv.State != "finalized" || len(inv.FinalizationID) != 64 || !h.control.StoreReady {
		return receipt, errors.New("security: invalid migration finalization")
	}
	if err = h.checkFinalizableInventory(inv); err != nil {
		return receipt, err
	}
	if err = h.checkLegacyFinalizationEnvironment(); err != nil {
		return receipt, err
	}
	original := inv
	original.FormatVersion, original.State, original.FinalizationID = 1, "ready", ""
	if legacyFinalizationDigest(original) != inv.FinalizationID {
		return receipt, errors.New("security: finalization identity mismatch")
	}
	var raw, digest, store, epoch string
	err = db.QueryRowContext(ctx, `SELECT store_id,recovery_epoch,inventory_hash,receipt FROM security_legacy_finalizations WHERE id=?`, inv.FinalizationID).Scan(&store, &epoch, &digest, &raw)
	if err != nil || store != h.control.StoreID || epoch != h.control.RecoveryEpoch || digest != legacyFinalizationDigest(inv) || len(raw) > 4<<20 {
		return receipt, errors.New("security: canonical finalization receipt missing or mismatched")
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err = dec.Decode(&receipt); err != nil || receipt.FormatVersion != 1 || legacyFinalizationDigest(receipt.Inventory) != digest || receipt.CompletedAt.IsZero() || receipt.ArchiveBytes < 0 || len(receipt.Operations) != int(inv.Stores[0].Operations) || len(receipt.Tables) == 0 || len(receipt.Tables) > 128 {
		return receipt, errors.New("security: invalid canonical finalization receipt")
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return receipt, errors.New("security: trailing finalization receipt data")
	}
	ids := make([]string, 0, len(receipt.Operations))
	seen := map[string]bool{}
	for _, op := range receipt.Operations {
		if op.ID == "" || seen[op.ID] || len(op.Digest) != 64 {
			return receipt, errors.New("security: ambiguous retained operation")
		}
		seen[op.ID] = true
		ids = append(ids, op.ID)
	}
	proofs, e := legacyOperationProofs(ctx, db, ids)
	if e != nil {
		return receipt, e
	}
	if legacyFinalizationDigest(proofs) != legacyFinalizationDigest(receipt.Operations) {
		return receipt, errors.New("security: retained operation history changed")
	}
	return receipt, nil
}

// Compare every archived row using its complete primary key. Mutable current
// state is explicitly excluded; events, evidence, artifact versions and other
// append-only content must remain byte-for-byte present in the canonical DB.
func verifyLegacyRetention(ctx context.Context, db *sql.DB, snapshot string) (out []LegacyRetentionTable, err error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "ATTACH DATABASE ? AS legacy_retention", securityReadOnlyURI(snapshot, true)); err != nil {
		return nil, err
	}
	defer conn.ExecContext(context.Background(), "DETACH DATABASE legacy_retention")
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT name FROM legacy_retention.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		return nil, err
	}
	var tables []string
	for rows.Next() {
		var table string
		if err = rows.Scan(&table); err != nil {
			break
		}
		tables = append(tables, table)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(tables) > 128 {
		return nil, errors.New("security: unsupported legacy table count")
	}
	mutable := map[string]string{
		"sessions": "state update_time", "app_states": "state update_time", "user_states": "state update_time",
		"native_operations":    "status result handle finished_at",
		"native_approvals":     "status accepted confirmation_id",
		"native_work_goals":    "status revision data checkpoint wait_state wait_call_id lease_owner lease_until",
		"native_work_outboxes": "delivered",
	}
	for _, table := range tables {
		if len(table) > 128 {
			return nil, errors.New("security: unsupported legacy table name")
		}
		rows, err = tx.QueryContext(ctx, "PRAGMA legacy_retention.table_info("+quoteLegacyIdentifier(table)+")")
		if err != nil {
			return nil, err
		}
		var keys, fields []string
		excluded := map[string]bool{}
		for _, field := range strings.Fields(mutable[table]) {
			excluded[field] = true
		}
		for rows.Next() {
			var cid, nn, pk int
			var name, kind string
			var def any
			if err = rows.Scan(&cid, &name, &kind, &nn, &def, &pk); err != nil {
				break
			}
			if pk > 0 {
				keys = append(keys, name)
			}
			if !excluded[name] {
				fields = append(fields, name)
			}
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return nil, err
		}
		if len(keys) == 0 || len(fields) > 128 {
			return nil, errors.New("security: legacy table lacks a supported primary key")
		}
		var conditions []string
		for _, field := range append(keys, fields...) {
			q := quoteLegacyIdentifier(field)
			conditions = append(conditions, "c."+q+" IS o."+q)
		}
		name := quoteLegacyIdentifier(table)
		var count, missing int64
		if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM legacy_retention."+name).Scan(&count); err != nil {
			return nil, err
		}
		query := "SELECT count(*) FROM legacy_retention." + name + " o WHERE NOT EXISTS (SELECT 1 FROM main." + name + " c WHERE " + strings.Join(conditions, " AND ") + ")"
		if err = tx.QueryRowContext(ctx, query).Scan(&missing); err != nil || missing != 0 {
			return nil, fmt.Errorf("security: canonical history coverage failed for %s", table)
		}
		out = append(out, LegacyRetentionTable{Name: table, Rows: count})
	}
	// Uncertain effects cannot become settled as a side effect of cleanup. A
	// legitimate later resolution stays in the live ledger; this conservative
	// initial-finalization profile requires separate review if statuses settled.
	var settled int64
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM legacy_retention.native_operations o JOIN main.native_operations c ON c.id=o.id WHERE COALESCE(o.status,'') NOT IN ('succeeded','failed','not_executed') AND COALESCE(c.status,'') IN ('succeeded','failed','not_executed')`).Scan(&settled); err != nil || settled != 0 {
		return nil, errors.New("security: legacy uncertain outcomes require separate reconciliation review")
	}
	return out, nil
}
func quoteLegacyIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

type legacyProofReader interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func legacyOperationProofs(ctx context.Context, db legacyProofReader, ids []string) (out []legacyOperationRetention, err error) {
	out = []legacyOperationRetention{}
	for start := 0; start < len(ids); start += 200 {
		end := min(start+200, len(ids))
		args := make([]any, 0, end-start)
		for _, id := range ids[start:end] {
			args = append(args, id)
		}
		query := `SELECT id,COALESCE(session_id,''),COALESCE(root_turn_id,''),COALESCE(call_id,''),COALESCE(tool,''),COALESCE(args_hash,''),COALESCE(identity,''),COALESCE(target,''),COALESCE(fingerprint,''),COALESCE(risk,''),COALESCE(CAST(started_at AS TEXT),'') FROM native_operations WHERE id IN (` + strings.TrimRight(strings.Repeat("?,", len(args)), ",") + ") ORDER BY id"
		rows, e := db.QueryContext(ctx, query, args...)
		if e != nil {
			return nil, errors.New("security: retained operation identity unavailable")
		}
		found := map[string]string{}
		for rows.Next() {
			values := make([]string, 11)
			dest := make([]any, 11)
			for i := range values {
				dest[i] = &values[i]
			}
			if e = rows.Scan(dest...); e != nil {
				break
			}
			found[values[0]] = legacyFinalizationDigest(values)
		}
		if e == nil {
			e = rows.Err()
		}
		rows.Close()
		if e != nil {
			return nil, e
		}
		for _, id := range ids[start:end] {
			digest, ok := found[id]
			if !ok {
				return nil, errors.New("security: retained operation history missing")
			}
			out = append(out, legacyOperationRetention{ID: id, Digest: digest})
		}
	}
	return out, nil
}
