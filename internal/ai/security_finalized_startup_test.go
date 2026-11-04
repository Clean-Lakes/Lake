package ai

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/security"
)

func closedFinalizedStartupFixture(t *testing.T) (string, string) {
	t.Helper()
	home, root, _ := finalizableMigrationFixture(t)
	if _, err := FinalizeSecurityMigration(context.Background(), home, true); err != nil {
		t.Fatal(err)
	}
	c, err := ReadSecurityControl(home)
	if err != nil {
		t.Fatal(err)
	}
	c.Gate = "closed" // Fixture simulates an old failed startup, never production.
	if err = writeSecurityJSON(filepath.Join(home, "security", "control.json"), c); err != nil {
		t.Fatal(err)
	}
	return home, root
}

func finalizedStartupHashes(t *testing.T, home string) map[string][32]byte {
	t.Helper()
	out := map[string][32]byte{}
	err := filepath.WalkDir(home, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err == nil {
			out[path] = sha256.Sum256(data)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestSecurityFinalizedStartupPreviewAndResumePreserveUnknown(t *testing.T) {
	ctx := context.Background()
	home, root := closedFinalizedStartupFixture(t)
	if h, err := OpenSecurityHome(ctx, home, ""); err == nil {
		h.Close()
		t.Fatal("normal startup silently opened the closed gate")
	}
	if err := ResumeInitialSecurityMigration(ctx, home); err == nil {
		t.Fatal("unfinished migration command accepted a finalized Home")
	}
	before := finalizedStartupHashes(t, home)
	preview, err := RecoverFinalizedInitialStartup(ctx, home, false, "")
	if err != nil || !preview.Eligible || preview.Applied || preview.Operations != 1 || preview.Unresolved != 1 || len(preview.Digest) != 64 {
		t.Fatal(preview, err)
	}
	again, err := RecoverFinalizedInitialStartup(ctx, home, false, "")
	if err != nil || preview != again {
		t.Fatal("unstable preview", again, err)
	}
	after := finalizedStartupHashes(t, home)
	if len(before) != len(after) {
		t.Fatal("preview created files")
	}
	for path, sum := range before {
		if after[path] != sum {
			t.Fatal("preview mutated", path)
		}
	}
	applied, err := RecoverFinalizedInitialStartup(ctx, home, true, preview.Digest)
	if err != nil || !applied.Applied {
		t.Fatal(applied, err)
	}
	for _, path := range []string{filepath.Join(root, "sessions.sqlite"), filepath.Join(home, "security", "legacy-inventory.json")} {
		data, err := os.ReadFile(path)
		if err != nil || sha256.Sum256(data) != before[path] {
			t.Fatal("apply changed ledger/inventory", path, err)
		}
	}
	idempotent, err := RecoverFinalizedInitialStartup(ctx, home, true, preview.Digest)
	if err != nil || idempotent != applied {
		t.Fatal("committed recovery was not idempotent", idempotent, err)
	}
	// The installed runtime can now do its normal migration and a second restart.
	for range 2 {
		h, err := OpenSecurityHome(ctx, home, "")
		if err != nil {
			t.Fatal("normal restart", err)
		}
		h.Close()
	}
	h, err := OpenSecurityHome(ctx, home, "")
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
	toolCtx := context.WithValue(ctx, adkToolContextKey{}, true)
	args := `{"path":"synthetic-old-target","content":"old"}`
	if _, err = e.dispatchNativeOperation(toolCtx, s, Config{}, Call{ID: "regenerated", Name: "append", Arguments: args}, "write", "old-target", "fixture"); err == nil {
		t.Fatal("old unknown call replayed")
	}
	if _, err = e.dispatchNativeOperation(toolCtx, s, Config{}, Call{ID: "fresh", Name: "append", Arguments: `{"path":"synthetic-new-target"}`}, "write", "new-target", "fixture"); err != nil {
		t.Fatal("fresh work blocked", err)
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var old nativeOperation
	if err = store.DB.First(&old, "id='same-op'").Error; err != nil || old.Status != "unknown" || old.Target != "old-target" {
		t.Fatal("original unknown changed", err)
	}
}

func TestSecurityFinalizedStartupRejectsOtherAuthority(t *testing.T) {
	for _, name := range []string{"receipt", "operation_identity", "settled_unknown", "extra_operation", "domain", "superagent", "reader", "goals", "restore", "recovery_directory", "bootstrap", "pending_inventory", "late_store", "active_web", "queued_web", "audit_symlink"} {
		t.Run(name, func(t *testing.T) {
			home, root := closedFinalizedStartupFixture(t)
			ctx := context.Background()
			preview, err := RecoverFinalizedInitialStartup(ctx, home, false, "")
			if err != nil {
				t.Fatal(err)
			}
			switch name {
			case "receipt":
				finalizeFixtureSQL(t, root, "DELETE FROM security_legacy_finalizations")
			case "operation_identity":
				finalizeFixtureSQL(t, root, "UPDATE native_operations SET target='different'")
			case "settled_unknown":
				finalizeFixtureSQL(t, root, "UPDATE native_operations SET status='succeeded'")
			case "extra_operation":
				finalizeFixtureSQL(t, root, "INSERT INTO native_operations(id,status) VALUES('new','succeeded')")
			case "domain", "superagent":
				prefix := "security_"
				if name == "superagent" {
					prefix = "superagent_"
				}
				finalizeFixtureSQL(t, root, "CREATE TABLE "+prefix+"test(id TEXT)")
			case "reader":
				finalizeFixtureSQL(t, root, "UPDATE security_schema_meta SET minimum_reader_version=?", security.ReaderVersion)
			case "goals":
				finalizeFixtureSQL(t, root, "CREATE TABLE native_work_goals(id TEXT);INSERT INTO native_work_goals VALUES('task')")
			case "restore":
				c, _ := ReadSecurityControl(home)
				c.RecoveryID = strings.Repeat("a", 64)
				if err = writeSecurityJSON(filepath.Join(home, "security", "control.json"), c); err != nil {
					t.Fatal(err)
				}
			case "recovery_directory":
				err = os.Mkdir(filepath.Join(home, "security", "recoveries"), 0700)
			case "bootstrap", "pending_inventory":
				file := "bootstrap.pending"
				if name == "pending_inventory" {
					file = "legacy-inventory.pending"
				}
				err = os.WriteFile(filepath.Join(home, "security", file), []byte("{}"), 0600)
			case "late_store":
				dir := filepath.Join(filepath.Dir(root), "ai", "adk")
				if err = os.MkdirAll(dir, 0700); err == nil {
					err = os.WriteFile(filepath.Join(dir, "sessions.sqlite"), []byte("unexpected"), 0600)
				}
			case "active_web", "queued_web":
				path := filepath.Join(filepath.Dir(root), "lake-web.sqlite")
				err = os.WriteFile(path, nil, 0600)
				if err == nil {
					var db *sql.DB
					db, err = sql.Open("sqlite", path)
					if err == nil {
						query := "CREATE TABLE sessions(status TEXT);INSERT INTO sessions VALUES('investigating')"
						if name == "queued_web" {
							query = "CREATE TABLE queuedMessages(id TEXT);INSERT INTO queuedMessages VALUES('queued')"
						}
						_, err = db.Exec(query)
						db.Close()
					}
				}
			case "audit_symlink":
				err = os.Symlink(t.TempDir(), filepath.Dir(finalizedStartupRecord(home, preview.Digest)))
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = RecoverFinalizedInitialStartup(ctx, home, true, preview.Digest); err == nil {
				t.Fatal("unsafe recovery accepted")
			}
			c, err := ReadSecurityControl(home)
			if err != nil || c.Gate != "closed" {
				t.Fatal("rejection opened gate", err)
			}
		})
	}
}

func TestSecurityFinalizedStartupAuthorizationAndExclusiveOwner(t *testing.T) {
	ctx := context.Background()
	home, root := closedFinalizedStartupFixture(t)
	p, err := RecoverFinalizedInitialStartup(ctx, home, false, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, digest := range []string{"", "bad", strings.Repeat("0", 64)} {
		if _, err := RecoverFinalizedInitialStartup(ctx, home, true, digest); err == nil {
			t.Fatal("missing/stale digest accepted")
		}
	}
	owner, err := OpenSecurityReadOnlyHome(home, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = RecoverFinalizedInitialStartup(ctx, home, false, ""); err != nil {
		t.Fatal("live read-only preview unavailable", err)
	}
	if _, err = RecoverFinalizedInitialStartup(ctx, home, true, p.Digest); err == nil {
		t.Fatal("apply ignored live owner")
	}
	owner.Close()
	lock, err := lockSecurityFile(filepath.Join(filepath.Dir(root), "server.lock"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = RecoverFinalizedInitialStartup(ctx, home, true, p.Digest); err == nil {
		t.Fatal("apply ignored Web owner")
	}
	lock.Close()
	crash := errors.New("simulated interruption")
	if _, err = recoverFinalizedInitialStartup(ctx, home, true, p.Digest, func(string) error { return crash }); !errors.Is(err, crash) {
		t.Fatal("authorization boundary not reached", err)
	}
	c, err := ReadSecurityControl(home)
	if err != nil || c.Gate != "closed" {
		t.Fatal("interruption activated runtime", err)
	}
	var audit finalizedStartupAuthorization
	if err = privateSecurityRead(finalizedStartupRecord(home, p.Digest), &audit); err != nil || !validFinalizedStartupAuthorization(audit, p.Digest) {
		t.Fatal("durable audit unavailable", err)
	}
	// Changes after the audit must still fail the final recheck.
	if _, err = recoverFinalizedInitialStartup(ctx, home, true, p.Digest, func(string) error {
		finalizeFixtureSQL(t, root, "UPDATE native_operations SET handle='unexpected'")
		return nil
	}); err == nil {
		t.Fatal("changed source passed precommit revalidation")
	}
	finalizeFixtureSQL(t, root, "UPDATE native_operations SET handle='' ")
	if _, err = RecoverFinalizedInitialStartup(ctx, home, true, p.Digest); err != nil {
		t.Fatal("interrupted recovery did not resume", err)
	}
}

func TestSecurityFinalizedStartupCancelledAndConflictingAudit(t *testing.T) {
	home, _ := closedFinalizedStartupFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := RecoverFinalizedInitialStartup(ctx, home, false, ""); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	p, err := RecoverFinalizedInitialStartup(context.Background(), home, false, "")
	if err != nil {
		t.Fatal(err)
	}
	_, err = recoverFinalizedInitialStartup(context.Background(), home, true, p.Digest, func(string) error {
		var a finalizedStartupAuthorization
		path := finalizedStartupRecord(home, p.Digest)
		if err := privateSecurityRead(path, &a); err != nil {
			return err
		}
		a.Actor = "unexpected"
		if err := writeSecurityJSON(path, a); err != nil {
			return err
		}
		return errors.New("interrupted")
	})
	if err == nil {
		t.Fatal("missing interruption")
	}
	if _, err = RecoverFinalizedInitialStartup(context.Background(), home, true, p.Digest); err == nil {
		t.Fatal("conflicting audit accepted")
	}
}
