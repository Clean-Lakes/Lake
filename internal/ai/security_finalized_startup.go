package ai

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/security"
)

// FinalizedStartupReport describes one exact, already-adopted foundation store.
// Preview is advisory; apply repeats every check under exclusive offline locks.
type FinalizedStartupReport struct {
	Eligible       bool   `json:"eligible"`
	Applied        bool   `json:"applied"`
	Profile        string `json:"profile"`
	FinalizationID string `json:"finalizationID"`
	Operations     int64  `json:"operations"`
	Unresolved     int64  `json:"unresolved"`
	Digest         string `json:"digest"`
}

type finalizedStartupAuthorization struct {
	FormatVersion int                    `json:"formatVersion"`
	Actor         string                 `json:"actor"`
	Before        security.ControlState  `json:"before"`
	After         security.ControlState  `json:"after"`
	Report        FinalizedStartupReport `json:"report"`
	RecordedAt    time.Time              `json:"recordedAt"`
}

// RecoverFinalizedInitialStartup is host maintenance, never an agent tool. It
// cannot reopen a restored, task-enabled, enforced, or unreviewed legacy Home.
// It changes only a bound control gate and an audit record, never DB rows,
// approvals, outcomes, permissions, epochs, or archived history.
func RecoverFinalizedInitialStartup(ctx context.Context, home string, apply bool, expected string) (FinalizedStartupReport, error) {
	return recoverFinalizedInitialStartup(ctx, home, apply, expected, nil)
}

func recoverFinalizedInitialStartup(ctx context.Context, home string, apply bool, expected string, checkpoint func(string) error) (FinalizedStartupReport, error) {
	var out FinalizedStartupReport
	if home == "" {
		return out, errors.New("security: explicit Home required")
	}
	if apply {
		if value, err := hex.DecodeString(expected); err != nil || len(value) != 32 {
			return out, errors.New("security: apply requires the exact preview --expected-digest")
		}
	} else if expected != "" {
		return out, errors.New("security: expected digest is only valid with apply")
	}
	var h *SecurityHome
	var err error
	if apply {
		h, err = openSecurityReadOnlyHome(home, "", true)
		if err != nil {
			return out, err
		}
		defer h.Close()
		lock, err := lockSecurityFile(filepath.Join(filepath.Dir(h.RuntimeRoot), "server.lock"))
		if err != nil {
			return out, err
		}
		defer lock.Close()
		if h.control.Gate == "open" {
			var prior finalizedStartupAuthorization
			if err := privateSecurityRead(finalizedStartupRecord(h.Home, expected), &prior); err != nil || !validFinalizedStartupAuthorization(prior, expected) || prior.After != h.control {
				return out, errors.New("security: no matching committed finalized startup recovery")
			}
			prior.Report.Applied = true
			return prior.Report, nil
		}
	} else {
		// Inspection never creates an owner, runtime, database, or schema. A live
		// read-only UI may remain open; its preview conveys no execution authority.
		resolved, root, err := ResolveSecurityHome(home, "")
		if err != nil {
			return out, err
		}
		control, err := ReadSecurityControl(resolved)
		if err != nil || control.RuntimeRoot != root {
			return out, errors.New("security: invalid finalized startup identity")
		}
		path := filepath.Join(root, "sessions.sqlite")
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || !platform.Private(path, info) {
			return out, errors.New("security: invalid finalized startup database")
		}
		db, err := openSecurityReadOnly(path)
		if err != nil {
			return out, err
		}
		defer db.Close()
		h = &SecurityHome{Home: resolved, RuntimeRoot: root, control: control, readOnly: true, readOnlyDB: db}
	}
	out, err = inspectFinalizedInitialStartup(ctx, h)
	if err != nil || !apply {
		return out, err
	}
	if out.Digest != expected {
		return out, errors.New("security: finalized startup preview changed; obtain a new preview")
	}
	path := finalizedStartupRecord(h.Home, expected)
	dir := filepath.Dir(path)
	if info, err := os.Lstat(dir); err == nil && (!info.IsDir() || !platform.Private(dir, info)) {
		return out, errors.New("security: invalid finalized startup audit directory")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return out, err
	}
	if err := platform.MkdirAll(dir, 0700); err != nil {
		return out, err
	}
	if resolved, err := filepath.EvalSymlinks(dir); err != nil || resolved != dir {
		return out, errors.New("security: finalized startup audit path changed")
	}
	after := h.control
	after.Gate = "open"
	authorization := finalizedStartupAuthorization{FormatVersion: 1, Actor: "explicit_offline_cli", Before: h.control, After: after, Report: out, RecordedAt: time.Now().UTC()}
	var prior finalizedStartupAuthorization
	if err := privateSecurityRead(path, &prior); errors.Is(err, os.ErrNotExist) {
		if err := writeSecurityJSON(path, authorization); err != nil {
			return out, err
		}
	} else if err != nil || !validFinalizedStartupAuthorization(prior, expected) || prior.Before != h.control || prior.Report != out {
		return out, errors.New("security: conflicting finalized startup authorization")
	}
	if checkpoint != nil {
		if err := checkpoint("authorized"); err != nil {
			return out, err
		}
	}
	current, err := inspectFinalizedInitialStartup(ctx, h)
	if err != nil || current.Digest != expected {
		return out, errors.New("security: finalized startup changed before activation")
	}
	if err := ctx.Err(); err != nil {
		return out, err
	}
	// Final durable commit. Its bound explicit authorization is already durable.
	if err := writeSecurityJSON(filepath.Join(h.Home, "security", "control.json"), after); err != nil {
		return out, err
	}
	out.Applied = true
	return out, nil
}

func finalizedStartupRecord(home, digest string) string {
	return filepath.Join(home, "security", "finalized-startup-recovery", digest+".json")
}

func validFinalizedStartupAuthorization(a finalizedStartupAuthorization, digest string) bool {
	before := a.After
	before.Gate = "closed"
	return a.FormatVersion == 1 && a.Actor == "explicit_offline_cli" && !a.RecordedAt.IsZero() && a.Before == before && a.After.Gate == "open" && a.Before.RecoveryID == "" && a.Before.StoreReady && a.Report.Eligible && !a.Report.Applied && a.Report.Profile == "finalized_initial_foundation" && a.Report.Digest == digest
}

func inspectFinalizedInitialStartup(ctx context.Context, h *SecurityHome) (FinalizedStartupReport, error) {
	var out FinalizedStartupReport
	if err := ctx.Err(); err != nil {
		return out, err
	}
	if h.control.Gate != "closed" || !h.control.StoreReady || h.control.RecoveryID != "" {
		return out, errors.New("security: only a closed finalized initial foundation Home is supported")
	}
	if err := h.CheckReadOnlyView(); err != nil {
		return out, err
	}
	for _, path := range []string{filepath.Join(h.Home, "security", "bootstrap.pending"), filepath.Join(h.Home, "security", "recoveries")} {
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			return out, errors.New("security: another bootstrap or recovery requires its original management protocol")
		}
	}
	db := h.readOnlyDB
	var schema, reader int
	var store, epoch, state string
	if err := db.QueryRowContext(ctx, "SELECT schema_version,minimum_reader_version,store_id,recovery_epoch,migration_state FROM security_schema_meta WHERE id=1").Scan(&schema, &reader, &store, &epoch, &state); err != nil {
		return out, err
	}
	if schema != security.SchemaVersion || reader != security.FoundationReaderVersion || store != h.control.StoreID || epoch != h.control.RecoveryEpoch || state != "ready" {
		return out, errors.New("security: initialized domain runtime cannot use finalized initial recovery")
	}
	var count int64
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND ((name GLOB 'security_*' AND name NOT IN ('security_schema_meta','security_legacy_finalizations')) OR name GLOB 'superagent_*')").Scan(&count); err != nil || count != 0 {
		return out, errors.New("security: domain authority requires its original recovery protocol")
	}
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='native_work_goals'").Scan(&count); err != nil {
		return out, err
	}
	if count != 0 {
		if err := db.QueryRowContext(ctx, "SELECT count(*) FROM native_work_goals").Scan(&count); err != nil || count != 0 {
			return out, errors.New("security: existing task goals require separate recovery")
		}
	}
	var inv LegacyInventory
	if err := privateSecurityRead(filepath.Join(h.Home, "security", "legacy-inventory.json"), &inv); err != nil {
		return out, err
	}
	if inv.Policy != preserveLegacyUnresolved {
		return out, errors.New("security: finalized initial adoption policy required")
	}
	if _, err := h.verifyLegacyFinalization(ctx, db, inv); err != nil {
		return out, err
	}
	if err := db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&state); err != nil || state != "ok" {
		return out, errors.New("security: finalized startup database integrity failed")
	}
	columns, err := securityNativeOperationColumns(ctx, db)
	if err != nil {
		return out, err
	}
	rows, err := db.QueryContext(ctx, "SELECT id,COALESCE(status,''),COALESCE(handle,''),COALESCE(risk,''),CASE WHEN "+securityUnresolvedOperationPredicate(columns)+" THEN 1 ELSE 0 END FROM native_operations ORDER BY id")
	if err != nil {
		return out, err
	}
	type outcome struct {
		ID, Status, Handle, Risk string
		Unresolved               int64
	}
	var outcomes []outcome
	for rows.Next() {
		var row outcome
		if err = rows.Scan(&row.ID, &row.Status, &row.Handle, &row.Risk, &row.Unresolved); err != nil {
			break
		}
		outcomes = append(outcomes, row)
		out.Operations++
		out.Unresolved += row.Unresolved
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return out, err
	}
	if out.Operations != inv.Stores[0].Operations || out.Unresolved != inv.Stores[0].Unresolved {
		return out, errors.New("security: post-finalization operations or outcomes require separate review")
	}
	if err := checkFinalizedStartupWebIdle(ctx, filepath.Join(filepath.Dir(h.RuntimeRoot), "lake-web.sqlite")); err != nil {
		return out, err
	}
	if err := h.CheckReadOnlyView(); err != nil {
		return out, err
	}
	out.Eligible, out.Profile, out.FinalizationID = true, "finalized_initial_foundation", inv.FinalizationID
	out.Digest = legacyFinalizationDigest(struct {
		Control   security.ControlState
		Inventory LegacyInventory
		Outcomes  string
	}{h.control, inv, legacyFinalizationDigest(outcomes)})
	return out, nil
}

func checkFinalizedStartupWebIdle(ctx context.Context, path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.Mode().IsRegular() || !platform.Private(path, info) {
		return errors.New("security: invalid finalized startup Web database")
	}
	db, err := openSecurityReadOnly(path)
	if err != nil {
		return err
	}
	defer db.Close()
	for _, check := range []struct{ table, predicate string }{
		{"sessions", "status IN ('investigating','waiting_approval')"},
		{"actions", "status='running'"}, {"specialists", "status='working'"},
		{"terminals", "status='busy'"}, {"terminalEntries", "status='running'"},
		{"queuedMessages", "1=1"}, {"workflowRuns", "status='running'"},
	} {
		var n int64
		if err := db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", check.table).Scan(&n); err != nil {
			return err
		}
		if n != 0 {
			if err := db.QueryRowContext(ctx, "SELECT count(*) FROM "+check.table+" WHERE "+check.predicate).Scan(&n); err != nil || n != 0 {
				return errors.New("security: legacy work or queued input must be reviewed before startup recovery")
			}
		}
	}
	return nil
}
