package ai

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func interruptedInitialMigration(t *testing.T) (string, string) {
	t.Helper()
	home := t.TempDir()
	legacySecurityFixture(t, filepath.Join(home, "web-agent", "adk", "sessions.sqlite"), "unknown")
	if _, err := OpenSecurityHome(context.Background(), home, ""); err == nil {
		t.Fatal("legacy unknown unexpectedly adopted automatically")
	}
	c, err := ReadSecurityControl(home)
	if err != nil {
		t.Fatal(err)
	}
	home = filepath.Dir(filepath.Dir(c.RuntimeRoot))
	if err = writeSecurityJSON(filepath.Join(home, "security", "legacy-inventory.pending"), map[string]string{"storeID": c.StoreID}); err != nil {
		t.Fatal(err)
	}
	return home, c.RuntimeRoot
}

func TestSecurityInitialRecoveryCrashStagesPreserveLedger(t *testing.T) {
	for _, stage := range []string{"prepared", "store_ready", "inventory", "marker_archived"} {
		t.Run(stage, func(t *testing.T) {
			home, root := interruptedInitialMigration(t)
			crash := errors.New("simulated recovery interruption")
			err := resumeInitialSecurityMigration(context.Background(), home, func(at string) error {
				if at == stage {
					return crash
				}
				return nil
			})
			if !errors.Is(err, crash) {
				t.Fatal("checkpoint not reached", err)
			}
			c, err := ReadSecurityControl(home)
			if err != nil || c.Gate != "closed" || c.StoreReady {
				t.Fatal("interrupted recovery opened gate", err)
			}
			if err = ResumeInitialSecurityMigration(context.Background(), home); err != nil {
				t.Fatal(err)
			}
			h, err := OpenSecurityHome(context.Background(), home, "")
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			if err = h.Check(); err != nil {
				t.Fatal(err)
			}
			db, err := openSecurityReadOnly(filepath.Join(root, "sessions.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			var status string
			if err = db.QueryRow("SELECT status FROM native_operations WHERE id='same-op'").Scan(&status); err != nil || status != "unknown" {
				t.Fatal("old outcome changed", status, err)
			}
			var inv LegacyInventory
			if err = privateSecurityRead(filepath.Join(home, "security", "legacy-inventory.json"), &inv); err != nil || inv.Policy != preserveLegacyUnresolved || inv.Stores[0].Unresolved != 1 {
				t.Fatal("unknown history not indexed", err)
			}
			if _, err = os.Stat(filepath.Join(home, "security", "initial-migration-recovery", "legacy-inventory.pending")); err != nil {
				t.Fatal("original pending evidence lost", err)
			}
		})
	}
}

func TestSecurityInitialRecoveryRejectsUnsafeInputs(t *testing.T) {
	for _, kind := range []string{"owner", "dual", "active-work", "marker", "inventory", "snapshot"} {
		t.Run(kind, func(t *testing.T) {
			home, root := interruptedInitialMigration(t)
			switch kind {
			case "owner":
				h, err := OpenSecurityReadOnlyHome(home, "")
				if err != nil {
					t.Fatal(err)
				}
				defer h.Close()
			case "dual":
				legacySecurityFixture(t, filepath.Join(filepath.Dir(root), "ai", "adk", "sessions.sqlite"), "unknown")
			case "active-work":
				db, err := sql.Open("sqlite", filepath.Join(root, "sessions.sqlite"))
				if err != nil {
					t.Fatal(err)
				}
				_, err = db.Exec("CREATE TABLE native_work_goals(id TEXT,status TEXT); INSERT INTO native_work_goals VALUES('old-goal','waiting_external')")
				db.Close()
				if err != nil {
					t.Fatal(err)
				}
			case "marker":
				writeSecurityJSON(filepath.Join(home, "security", "legacy-inventory.pending"), map[string]string{"storeID": "another-store"})
			case "inventory":
				os.WriteFile(filepath.Join(home, "security", "legacy-inventory.json"), []byte("{"), 0600)
			case "snapshot":
				crash := errors.New("stop")
				_ = resumeInitialSecurityMigration(context.Background(), home, func(string) error { return crash })
				os.WriteFile(filepath.Join(home, "security", "initial-migration-recovery", "sessions.sqlite"), []byte("tampered"), 0600)
			}
			if err := ResumeInitialSecurityMigration(context.Background(), home); err == nil {
				t.Fatal("unsafe initial recovery allowed")
			}
			c, err := ReadSecurityControl(home)
			if err != nil || c.Gate != "closed" {
				t.Fatal("failed recovery changed gate", err)
			}
		})
	}
}

func TestSecurityInitialRecoveryAllowsFreshWorkAndFencesLegacyReplay(t *testing.T) {
	home, root := interruptedInitialMigration(t)
	db, err := sql.Open("sqlite", filepath.Join(root, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	args := `{"path":"synthetic-old-target","content":"old"}`
	_, err = db.Exec("UPDATE native_operations SET tool='append',args_hash=?,target='old-target',risk='write' WHERE id='same-op'", hash(args))
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err = ResumeInitialSecurityMigration(context.Background(), home); err != nil {
		t.Fatal(err)
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
	if _, err = e.dispatchNativeOperation(ctx, s, Config{}, Call{ID: "regenerated", Name: "append", Arguments: args}, "write", "old-target", "fixture"); err == nil {
		t.Fatal("old unknown call replayed with a new ID")
	}
	if _, err = e.dispatchNativeOperation(ctx, s, Config{}, Call{ID: "fresh", Name: "append", Arguments: `{"path":"synthetic-new-target"}`}, "write", "new-target", "fixture"); err != nil {
		t.Fatal("unrelated new operation blocked", err)
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var old nativeOperation
	if err = store.DB.First(&old, "id='same-op'").Error; err != nil || old.Status != "unknown" {
		t.Fatal("old operation result discarded", err)
	}
}
