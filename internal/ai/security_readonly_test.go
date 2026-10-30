package ai

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/agent/storage"
)

func TestSecurityReadOnlyLegacyRecoveryPreservesUnresolvedOperations(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "web-agent", "adk")
	store, err := storage.Open(filepath.Join(root, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if err = store.DB.AutoMigrate(&nativeOperation{}); err != nil {
		t.Fatal(err)
	}
	if err = store.DB.Create(&nativeOperation{ID: "unresolved", SessionID: "saved", Tool: "shell", Risk: "write", Status: "unknown", Handle: "original-handle", StartedAt: time.Now().UTC()}).Error; err != nil {
		t.Fatal(err)
	}
	store.Close()
	if _, err = OpenSecurityHome(context.Background(), home, ""); err == nil {
		t.Fatal("unknown legacy operation allowed execution")
	}
	c, err := ReadSecurityControl(home)
	if err != nil {
		t.Fatal(err)
	}
	home = filepath.Dir(filepath.Dir(c.RuntimeRoot))
	root = c.RuntimeRoot
	// Reproduce an interruption after snapshotting but before the inventory was
	// committed. Recovery must preserve this marker rather than rerun migration.
	if err = os.Remove(filepath.Join(home, "security", "legacy-inventory.json")); err != nil {
		t.Fatal(err)
	}
	pendingPath := filepath.Join(home, "security", "legacy-inventory.pending")
	if err = writeSecurityJSON(pendingPath, map[string]string{"storeID": c.StoreID}); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(filepath.Dir(root), "ai", "saved.json")
	os.MkdirAll(filepath.Dir(statePath), 0700)
	state := State{View: View{Session: "saved", Status: "running", Cards: []Card{{ID: "saved-card", Type: "assistant", Content: "synthetic-secret"}}}, Config: Config{Model: Model{Key: "synthetic-secret"}}}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(statePath, data, 0600); err != nil {
		t.Fatal(err)
	}
	paths := []string{statePath, filepath.Join(root, "sessions.sqlite"), filepath.Join(home, "security", "control.json"), pendingPath}
	before := map[string][32]byte{}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		before[path] = sha256.Sum256(data)
	}
	h, err := OpenSecurityReadOnlyHome(home, "")
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if h.Check() == nil {
		t.Fatal("recovery view permitted execution")
	}
	if err = h.RotateRecoveryEpoch(); err == nil {
		t.Fatal("recovery view changed the control epoch")
	}
	if err = h.MigrateLegacyStores(context.Background()); err == nil {
		t.Fatal("recovery view ran a migration")
	}
	if _, err = h.InventoryLegacyStores(context.Background()); err == nil {
		t.Fatal("recovery view wrote an inventory")
	}
	if _, err = OpenSecurityHome(context.Background(), home, ""); err == nil {
		t.Fatal("second executable owner allowed")
	}
	view, err := h.RecoverySnapshot("saved", 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if view.Status != "running" || len(view.OperationOutcomes) != 1 || view.OperationOutcomes[0].Status != "unknown" || view.OperationOutcomes[0].Handle != "original-handle" {
		t.Fatalf("changed saved outcome: %+v", view)
	}
	if view.Cards[0].Content == "synthetic-secret" {
		t.Fatal("saved credential not redacted")
	}
	if _, err = h.readOnlyDB.Exec("UPDATE native_operations SET status='succeeded'"); err == nil {
		t.Fatal("recovery database writable")
	}
	h.Close()
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil || before[path] != sha256.Sum256(data) {
			t.Fatal("recovery changed durable state", path, err)
		}
	}
}

func TestSecurityReadOnlyRejectsUnsupportedOrMismatchedHome(t *testing.T) {
	for _, kind := range []string{"future-reader", "identity", "epoch", "missing-guard", "bootstrap", "corrupt"} {
		t.Run(kind, func(t *testing.T) {
			h := securityFixture(t)
			h.Close()
			c := h.control
			c.Gate = "closed"
			path := filepath.Join(h.Home, "security", "control.json")
			if err := writeSecurityJSON(path, c); err != nil {
				t.Fatal(err)
			}
			db, err := sql.Open("sqlite", filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "future-reader":
				_, err = db.Exec("UPDATE security_schema_meta SET minimum_reader_version=999")
			case "identity":
				_, err = db.Exec("UPDATE security_schema_meta SET store_id='other'")
			case "epoch":
				_, err = db.Exec("UPDATE security_schema_meta SET recovery_epoch='other'")
			case "missing-guard":
				_, err = db.Exec("DROP TABLE security_schema_meta")
			case "bootstrap":
				err = os.WriteFile(filepath.Join(h.Home, "security", "bootstrap.pending"), []byte("{}"), 0600)
			case "corrupt":
				err = os.WriteFile(path, []byte("{"), 0600)
			}
			db.Close()
			if err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(path)
			if _, err = OpenSecurityReadOnlyHome(h.Home, ""); err == nil {
				t.Fatal("invalid Home opened")
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(before, after) {
				t.Fatal("failed recovery rewrote control")
			}
		})
	}
}
