package ai

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func checkpointFixture(t *testing.T) (*SecurityHome, string) {
	t.Helper()
	h := securityFixture(t)
	dataRoot := filepath.Dir(h.RuntimeRoot)
	db, err := sql.Open("sqlite", filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE native_operations(id TEXT PRIMARY KEY,status TEXT,risk TEXT,target TEXT); INSERT INTO native_operations VALUES('first','succeeded','readonly','asset-one'); CREATE TABLE native_approvals(id TEXT PRIMARY KEY,status TEXT); INSERT INTO native_approvals VALUES('approval','authorized'); CREATE TABLE native_evidences(id INTEGER PRIMARY KEY,operation_id TEXT,data TEXT); INSERT INTO native_evidences VALUES(1,'first','original evidence')`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	web, err := sql.Open("sqlite", filepath.Join(dataRoot, "lake-web.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = web.Exec(`CREATE TABLE fixture(id TEXT PRIMARY KEY,value TEXT);INSERT INTO fixture VALUES('paired','original-web')`)
	web.Close()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(h.RuntimeRoot, "sessions.sqlite"), filepath.Join(dataRoot, "lake-web.sqlite")} {
		if err = os.Chmod(path, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err = os.MkdirAll(filepath.Join(dataRoot, "ai"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dataRoot, "ai", "session-one.json"), []byte(`{"view":{"session":"session-one"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dataRoot, "tool-schedules.json"), []byte(`[{"id":"schedule","enabled":true,"status":"scheduled","revision":4}]`), 0600); err != nil {
		t.Fatal(err)
	}
	h.Close()
	return h, filepath.Join(t.TempDir(), "checkpoint")
}

func TestSecurityCheckpointPairedSnapshotDoesNotCopyControlOrSecrets(t *testing.T) {
	h, destination := checkpointFixture(t)
	secretDir := filepath.Join(h.Home, "secrets")
	if err := os.MkdirAll(secretDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secretDir, "fixture-secret"), []byte("must-not-copy-this-fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(h.Home, "security", "control.json"))
	cp, err := CreateSecurityCheckpoint(context.Background(), h.Home, destination)
	if err != nil {
		t.Fatal(err)
	}
	if cp.StoreID != h.control.StoreID || cp.RecoveryEpoch != h.control.RecoveryEpoch || len(cp.Files) != 4 {
		t.Fatal("incorrect paired snapshot identity")
	}
	verified, err := VerifySecurityCheckpoint(context.Background(), destination)
	if err != nil || verified.ID != cp.ID {
		t.Fatal("checkpoint verification failed", err)
	}
	after, _ := os.ReadFile(filepath.Join(h.Home, "security", "control.json"))
	if string(before) != string(after) {
		t.Fatal("backup changed execution authority")
	}
	err = filepath.WalkDir(destination, func(path string, entry os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if !entry.IsDir() && (entry.Name() == "control.json" || strings.Contains(path, "secrets")) {
			t.Fatal("control or credential copied")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSecurityCheckpointIncludesCommittedWALAndRejectsLiveOwner(t *testing.T) {
	h, destination := checkpointFixture(t)
	owner, err := OpenSecurityHome(context.Background(), h.Home, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = CreateSecurityCheckpoint(context.Background(), h.Home, destination); err == nil {
		t.Fatal("checkpoint ignored active owner")
	}
	owner.Close()
	db, err := sql.Open("sqlite", filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`PRAGMA journal_mode=WAL; INSERT INTO native_operations VALUES('wal-committed','unknown','write','asset-one')`); err != nil {
		t.Fatal(err)
	}
	if _, err = CreateSecurityCheckpoint(context.Background(), h.Home, destination); err != nil {
		t.Fatal(err)
	}
	snapshot, err := openSecurityReadOnlyMode(filepath.Join(destination, "adk", "sessions.sqlite"), true)
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	var count int
	if err = snapshot.QueryRow(`SELECT count(*) FROM native_operations WHERE id='wal-committed' AND status='unknown'`).Scan(&count); err != nil || count != 1 {
		t.Fatal("committed WAL history was lost", err)
	}
}

func TestSecurityCheckpointTamperAndUnpairedManifestRejected(t *testing.T) {
	for _, kind := range []string{"hash", "store", "epoch", "traversal", "duplicate", "missing", "symlink", "wal"} {
		t.Run(kind, func(t *testing.T) {
			h, destination := checkpointFixture(t)
			cp, err := CreateSecurityCheckpoint(context.Background(), h.Home, destination)
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "hash":
				if err = os.WriteFile(filepath.Join(destination, "ai", "session-one.json"), []byte(`{"changed":true}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "store":
				cp.StoreID = strings.Repeat("a", 64)
			case "epoch":
				cp.RecoveryEpoch = strings.Repeat("a", 64)
			case "traversal":
				cp.Files[0].Path = "../control.json"
			case "duplicate":
				cp.Files = append(cp.Files, cp.Files[0])
			case "missing":
				cp.Files = cp.Files[1:]
			case "symlink":
				path := filepath.Join(destination, "ai", "session-one.json")
				if err = os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err = os.Symlink(filepath.Join(filepath.Dir(h.RuntimeRoot), "ai", "session-one.json"), path); err != nil {
					t.Fatal(err)
				}
			case "wal":
				if err = os.WriteFile(filepath.Join(destination, "adk", "sessions.sqlite-wal"), []byte("mutable"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err = writeSecurityJSON(filepath.Join(destination, "manifest.json"), cp); err != nil {
				t.Fatal(err)
			}
			if _, err = VerifySecurityCheckpoint(context.Background(), destination); err == nil {
				t.Fatal("tampered checkpoint accepted")
			}
		})
	}
}

func TestSecurityCheckpointRejectsLegacyUninitializedAndUnknownSessionPaths(t *testing.T) {
	home, _ := securityRiskFixture(t, true, false)
	if _, err := CreateSecurityCheckpoint(context.Background(), home, filepath.Join(t.TempDir(), "cp")); err == nil {
		t.Fatal("uninitialized canonical checkpoint accepted")
	}
	h, destination := checkpointFixture(t)
	if err := os.WriteFile(filepath.Join(filepath.Dir(h.RuntimeRoot), "ai", "unexpected name.json"), json.RawMessage(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateSecurityCheckpoint(context.Background(), h.Home, destination); err == nil {
		t.Fatal("unknown session path accepted")
	}
}

func TestSecurityCheckpointAndRestoreRejectLegacyWebStoreLock(t *testing.T) {
	h, destination := checkpointFixture(t)
	ctx := context.Background()
	if _, err := CreateSecurityCheckpoint(ctx, h.Home, destination); err != nil {
		t.Fatal(err)
	}
	lock, err := lockSecurityFile(filepath.Join(filepath.Dir(h.RuntimeRoot), "server.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if _, err = CreateSecurityCheckpoint(ctx, h.Home, filepath.Join(t.TempDir(), "another")); err == nil {
		t.Fatal("checkpoint ignored pre-security Web store owner")
	}
	if _, err = RestoreSecurityBackup(ctx, h.Home, destination, false); err == nil {
		t.Fatal("restore ignored pre-security Web store owner")
	}
	control, _ := ReadSecurityControl(h.Home)
	if control != h.control {
		t.Fatal("rejected live legacy owner changed authority")
	}
}
