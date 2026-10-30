package ai

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/agent/storage"
)

func legacySecurityFixture(t *testing.T, path, status string) {
	t.Helper()
	store, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = store.DB.AutoMigrate(&nativeOperation{}); err != nil {
		t.Fatal(err)
	}
	if err = store.DB.Create(&nativeOperation{ID: "same-op", SessionID: "same-session", Status: status, Target: "test-target"}).Error; err != nil {
		t.Fatal(err)
	}
}
func TestSecurityDualStoreMigrationPreservesBothHistories(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "web-agent", "adk")
	old := filepath.Join(home, "web-agent", "ai", "adk")
	legacySecurityFixture(t, filepath.Join(root, "sessions.sqlite"), "succeeded")
	legacySecurityFixture(t, filepath.Join(old, "sessions.sqlite"), "dispatched")
	// Keep a WAL writer open: VACUUM INTO must include its committed rows.
	db, err := sql.Open("sqlite", filepath.Join(old, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("INSERT INTO native_operations(id,session_id,status) VALUES('wal-op','s','unknown')"); err != nil {
		t.Fatal(err)
	}
	if _, err = OpenSecurityHome(context.Background(), home, ""); err == nil {
		t.Fatal("dual stores were silently merged")
	}
	control, err := ReadSecurityControl(home)
	if err != nil {
		t.Fatal(err)
	}
	if control.Gate != "closed" {
		t.Fatal("migration did not close gate")
	}
	var inv LegacyInventory
	if err = privateSecurityRead(filepath.Join(home, "security", "legacy-inventory.json"), &inv); err != nil {
		t.Fatal(err)
	}
	if len(inv.Stores) != 2 || inv.State != "pending_review" {
		t.Fatalf("invalid inventory: %+v", inv)
	}
	if inv.Stores[1].Unresolved != 2 || inv.Stores[1].Operations != 2 {
		t.Fatal("WAL evidence lost")
	}
	for _, row := range inv.Stores {
		if row.StoreID == "" || row.SHA256 == "" {
			t.Fatal("archive lacks namespace or checksum")
		}
		if _, err = os.Stat(row.Snapshot); err != nil {
			t.Fatal(err)
		}
	}
	if inv.Stores[0].StoreID == inv.Stores[1].StoreID {
		t.Fatal("colliding operation namespaces")
	}
	var status string
	if err = db.QueryRow("SELECT status FROM native_operations WHERE id='same-op'").Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "dispatched" {
		t.Fatal("source operation rewritten")
	}
	if _, err = OpenSecurityHome(context.Background(), home, ""); err == nil {
		t.Fatal("restart bypassed pending review")
	}
}
func TestSecurityArchiveTamperingAndLateStoreAreRejected(t *testing.T) {
	for _, kind := range []string{"archive", "late", "inventory"} {
		t.Run(kind, func(t *testing.T) {
			home := t.TempDir()
			legacySecurityFixture(t, filepath.Join(home, "web-agent", "adk", "sessions.sqlite"), "succeeded")
			h, err := OpenSecurityHome(context.Background(), home, "")
			if err != nil {
				t.Fatal(err)
			}
			h.Close()
			var inv LegacyInventory
			path := filepath.Join(home, "security", "legacy-inventory.json")
			if err = privateSecurityRead(path, &inv); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "archive":
				os.WriteFile(inv.Stores[0].Snapshot, []byte("damaged"), 0600)
			case "late":
				legacySecurityFixture(t, filepath.Join(home, "web-agent", "ai", "adk", "sessions.sqlite"), "succeeded")
			case "inventory":
				os.WriteFile(path, []byte("{"), 0600)
			}
			if _, err = OpenSecurityHome(context.Background(), home, ""); err == nil {
				t.Fatal("changed migration inventory accepted")
			}
		})
	}
}
