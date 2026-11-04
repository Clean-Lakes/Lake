package ai

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func finalizableMigrationFixture(t *testing.T) (string, string, LegacyInventory) {
	t.Helper()
	home, root := interruptedInitialMigration(t)
	db, err := sql.Open("sqlite", filepath.Join(root, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	args := `{"path":"synthetic-old-target","content":"old"}`
	_, err = db.Exec(`CREATE TABLE finalize_fixture_history(id TEXT PRIMARY KEY,body BLOB);INSERT INTO finalize_fixture_history VALUES('history',x'0102');UPDATE native_operations SET tool='append',args_hash=?,target='old-target',risk='write' WHERE id='same-op'`, hash(args))
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err = ResumeInitialSecurityMigration(context.Background(), home); err != nil {
		t.Fatal(err)
	}
	var inv LegacyInventory
	if err = privateSecurityRead(filepath.Join(home, "security", "legacy-inventory.json"), &inv); err != nil {
		t.Fatal(err)
	}
	return home, root, inv
}
func finalizeFixtureSQL(t *testing.T, root, query string, args ...any) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(root, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

func TestSecurityFinalizeMigrationPreservesHistoryAndReplayGuards(t *testing.T) {
	home, root, inv := finalizableMigrationFixture(t)
	before := riskDurableHashes(t, home, inv)
	report, err := FinalizeSecurityMigration(context.Background(), home, false)
	if err != nil || report.Applied || report.Finalized || report.Operations != 1 || report.RemovedBytes != 0 {
		t.Fatal(report, err)
	}
	for path, sum := range before {
		data, err := os.ReadFile(path)
		if err != nil || sha256.Sum256(data) != sum {
			t.Fatal("dry run changed durable state", path, err)
		}
	}
	// No receipt table, inventory publication, outcome change or archive deletion
	// is permitted in a dry run.
	db, err := openSecurityReadOnly(filepath.Join(root, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='security_legacy_finalizations'").Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}
	db.Close()
	report, err = FinalizeSecurityMigration(context.Background(), home, true)
	if err != nil || !report.Finalized || report.RemovedBytes != report.ArchiveBytes || report.RemovedBytes == 0 {
		t.Fatal(report, err)
	}
	if _, err = os.Stat(inv.Stores[0].Snapshot); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("archive retained", err)
	}
	// Current risk inspection remains available with no historical file.
	risks, err := InspectSecurityRisks(context.Background(), home, 100)
	if err != nil || len(risks.Stores) != 1 || risks.Stores[0].Unresolved != 1 {
		t.Fatal(risks, err)
	}
	report, err = FinalizeSecurityMigration(context.Background(), home, true)
	if err != nil || !report.Finalized || report.RemovedBytes != 0 {
		t.Fatal("repeat finalization not idempotent", report, err)
	}
	h, err := OpenSecurityHome(context.Background(), home, "")
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	e, err := New(filepath.Join(filepath.Dir(root), "ai"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown()
	e.SecurityRuntime = h
	s, err := e.get("same-session")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), adkToolContextKey{}, true)
	args := `{"path":"synthetic-old-target","content":"old"}`
	if _, err = e.dispatchNativeOperation(ctx, s, Config{}, Call{ID: "regenerated", Name: "append", Arguments: args}, "write", "old-target", "fixture"); err == nil {
		t.Fatal("archived unknown call replayed")
	}
	if _, err = e.dispatchNativeOperation(ctx, s, Config{}, Call{ID: "fresh", Name: "append", Arguments: `{"path":"synthetic-new-target"}`}, "write", "new-target", "fixture"); err != nil {
		t.Fatal("fresh operation blocked", err)
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var old nativeOperation
	if err = store.DB.First(&old, "id='same-op'").Error; err != nil || old.Status != "unknown" {
		t.Fatal("old outcome changed", err)
	}
}

func TestSecurityFinalizeMigrationCrashStagesResume(t *testing.T) {
	for _, stage := range []string{"receipt", "inventory", "removed"} {
		t.Run(stage, func(t *testing.T) {
			home, _, _ := finalizableMigrationFixture(t)
			crash := errors.New("simulated interruption")
			_, err := finalizeSecurityMigration(context.Background(), home, true, func(at string) error {
				if at == stage {
					return crash
				}
				return nil
			})
			if !errors.Is(err, crash) {
				t.Fatal("stage not reached", err)
			}
			// Every durable stage admits a safe restart without losing the unknown.
			h, err := OpenSecurityHome(context.Background(), home, "")
			if err != nil {
				t.Fatal(err)
			}
			h.Close()
			report, err := FinalizeSecurityMigration(context.Background(), home, true)
			if err != nil || !report.Finalized {
				t.Fatal(report, err)
			}
		})
	}
}

func TestSecurityFinalizeCompletedCanonicalMigration(t *testing.T) {
	home := t.TempDir()
	legacySecurityFixture(t, filepath.Join(home, "web-agent", "adk", "sessions.sqlite"), "succeeded")
	h, err := OpenSecurityHome(context.Background(), home, "")
	if err != nil {
		t.Fatal(err)
	}
	h.Close()
	report, err := FinalizeSecurityMigration(context.Background(), home, true)
	if err != nil || !report.Finalized || report.Operations != 1 {
		t.Fatal(report, err)
	}
	h, err = OpenSecurityHome(context.Background(), home, "")
	if err != nil {
		t.Fatal(err)
	}
	h.Close()
}

func TestSecurityFinalizeMigrationRejectsUnsafeCleanup(t *testing.T) {
	for _, kind := range []string{"archive", "symlink", "late", "pending", "owner", "closed", "missing-operation", "changed-operation", "missing-history", "changed-history", "settled-unknown", "cancelled", "source", "epoch"} {
		t.Run(kind, func(t *testing.T) {
			home, root, inv := finalizableMigrationFixture(t)
			ctx := context.Background()
			switch kind {
			case "archive":
				os.WriteFile(inv.Stores[0].Snapshot, []byte("changed"), 0600)
			case "symlink":
				source := inv.Stores[0].Snapshot + ".original"
				if err := os.Rename(inv.Stores[0].Snapshot, source); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(source, inv.Stores[0].Snapshot); err != nil {
					t.Fatal(err)
				}
			case "late":
				legacySecurityFixture(t, filepath.Join(filepath.Dir(root), "ai", "adk", "sessions.sqlite"), "unknown")
			case "pending":
				writeSecurityJSON(filepath.Join(home, "security", "legacy-inventory.pending"), map[string]bool{"pending": true})
			case "owner":
				h, err := OpenSecurityHome(ctx, home, "")
				if err != nil {
					t.Fatal(err)
				}
				defer h.Close()
			case "closed":
				c, _ := ReadSecurityControl(home)
				c.Gate = "closed"
				writeSecurityJSON(filepath.Join(home, "security", "control.json"), c)
			case "missing-operation":
				finalizeFixtureSQL(t, root, "DELETE FROM native_operations WHERE id='same-op'")
			case "changed-operation":
				finalizeFixtureSQL(t, root, "UPDATE native_operations SET args_hash='changed' WHERE id='same-op'")
			case "missing-history":
				finalizeFixtureSQL(t, root, "DELETE FROM finalize_fixture_history")
			case "changed-history":
				finalizeFixtureSQL(t, root, "UPDATE finalize_fixture_history SET body=x'0304'")
			case "settled-unknown":
				finalizeFixtureSQL(t, root, "UPDATE native_operations SET status='succeeded' WHERE id='same-op'")
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "source":
				inv.Stores[0].Source = "another-store"
				writeSecurityJSON(filepath.Join(home, "security", "legacy-inventory.json"), inv)
			case "epoch":
				inv.RecoveryEpoch = "different"
				writeSecurityJSON(filepath.Join(home, "security", "legacy-inventory.json"), inv)
			}
			if _, err := FinalizeSecurityMigration(ctx, home, true); err == nil {
				t.Fatal("unsafe cleanup allowed")
			}
			if _, err := os.Lstat(inv.Stores[0].Snapshot); err != nil {
				t.Fatal("failed finalization deleted archive", err)
			}
		})
	}
}

func TestSecurityFinalizedReceiptFencesLostIdentityWithoutArchiveReads(t *testing.T) {
	for _, kind := range []string{"unreferenced-archive", "receipt", "empty-receipt", "trailing-receipt", "operation", "binding", "inventory"} {
		t.Run(kind, func(t *testing.T) {
			home, root, inv := finalizableMigrationFixture(t)
			if _, err := FinalizeSecurityMigration(context.Background(), home, true); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "unreferenced-archive":
				os.WriteFile(inv.Stores[0].Snapshot, []byte("not part of the running ledger"), 0600)
			case "receipt":
				finalizeFixtureSQL(t, root, "DELETE FROM security_legacy_finalizations")
			case "empty-receipt":
				finalizeFixtureSQL(t, root, `UPDATE security_legacy_finalizations SET receipt=json_set(receipt,'$.operations',json('[]'))`)
			case "trailing-receipt":
				finalizeFixtureSQL(t, root, `UPDATE security_legacy_finalizations SET receipt=receipt || ' {}'`)
			case "operation":
				finalizeFixtureSQL(t, root, "DELETE FROM native_operations WHERE id='same-op'")
			case "binding":
				finalizeFixtureSQL(t, root, "UPDATE native_operations SET target='different' WHERE id='same-op'")
			case "inventory":
				var finalized LegacyInventory
				privateSecurityRead(filepath.Join(home, "security", "legacy-inventory.json"), &finalized)
				finalized.Stores[0].SHA256 = "changed"
				writeSecurityJSON(filepath.Join(home, "security", "legacy-inventory.json"), finalized)
			}
			h, err := OpenSecurityHome(context.Background(), home, "")
			if kind == "unreferenced-archive" {
				if err != nil {
					t.Fatal("startup read retired archive", err)
				}
				h.Close()
			} else if err == nil {
				h.Close()
				t.Fatal("lost receipt/operation identity accepted")
			}
		})
	}
}
