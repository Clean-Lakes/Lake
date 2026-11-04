package ai

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func securityRiskFixture(t *testing.T, stdioOnly, dual bool) (string, LegacyInventory) {
	t.Helper()
	home := t.TempDir()
	paths := []string{filepath.Join(home, "web-agent", "adk", "sessions.sqlite")}
	if stdioOnly {
		paths[0] = filepath.Join(home, "web-agent", "ai", "adk", "sessions.sqlite")
	} else if dual {
		paths = append(paths, filepath.Join(home, "web-agent", "ai", "adk", "sessions.sqlite"))
	}
	for _, path := range paths {
		legacySecurityFixture(t, path, "unknown")
		db, err := sql.Open("sqlite", path)
		if err != nil {
			t.Fatal(err)
		}
		_, err = db.Exec(`UPDATE native_operations SET session_id='sensitive-session',tool='secret-tool',target='ssh://user:secret-password@host',result='private-result',handle='private-handle',risk='write'; INSERT INTO native_operations(id,session_id,status,risk) VALUES('read-only','','unknown','readonly'),('future','','future-status','readonly'),('done','','succeeded','dangerous')`)
		db.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	if h, err := OpenSecurityHome(context.Background(), home, ""); err == nil {
		h.Close()
		t.Fatal("unresolved migration unexpectedly allowed")
	}
	var inv LegacyInventory
	if err := privateSecurityRead(filepath.Join(home, "security", "legacy-inventory.json"), &inv); err != nil {
		t.Fatal(err)
	}
	return home, inv
}

func riskDurableHashes(t *testing.T, home string, inv LegacyInventory) map[string][32]byte {
	t.Helper()
	paths := []string{filepath.Join(home, "security", "control.json"), filepath.Join(home, "security", "legacy-inventory.json"), filepath.Join(home, "security", "legacy-inventory.pending")}
	for _, entry := range inv.Stores {
		paths = append(paths, entry.Source, entry.Snapshot)
	}
	out := map[string][32]byte{}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		out[path] = sha256.Sum256(data)
	}
	return out
}

func TestSecurityRiskInspectionPreservesNamespacesAndDurableState(t *testing.T) {
	home, inv := securityRiskFixture(t, false, true)
	before := riskDurableHashes(t, home, inv)
	report, err := InspectSecurityRisks(context.Background(), home, 2)
	if err != nil {
		t.Fatal(err)
	}
	if report.Gate != "closed" || report.ResourceMap != "unverified" || len(report.Stores) != 2 || report.Stores[0].View != "current" || report.Stores[1].View != "archived" {
		t.Fatalf("incorrect report boundaries: %+v", report)
	}
	for _, store := range report.Stores {
		if store.Operations != 4 || store.Unresolved != 3 || store.EffectReview != 2 || !store.Truncated || len(store.Risks) != 2 {
			t.Fatalf("incorrect counts: %+v", store)
		}
	}
	if report.Stores[0].Risks[0].OperationRef == report.Stores[1].Risks[0].OperationRef || report.Stores[0].LegacyStoreID == report.Stores[1].LegacyStoreID {
		t.Fatal("same legacy IDs collided across source namespaces")
	}
	all, err := InspectSecurityRisks(context.Background(), home, 10)
	if err != nil || all.Stores[0].Truncated || len(all.Stores[0].Risks) != 3 {
		t.Fatal("complete bounded query failed", err)
	}
	data, _ := json.Marshal(all)
	for _, secret := range []string{"same-op", "same-session", "sensitive-session", "secret-tool", "secret-password", "private-result", "private-handle", "future-status", "ssh://", home} {
		if strings.Contains(string(data), secret) {
			t.Fatal("raw operation data escaped the safe projection")
		}
	}
	for path, digest := range before {
		data, err := os.ReadFile(path)
		if err != nil || sha256.Sum256(data) != digest {
			t.Fatal("inspection changed durable data", err)
		}
	}
}

func TestSecurityRiskInspectionSupportsStdioOnlyAndSparseSchema(t *testing.T) {
	home, _ := securityRiskFixture(t, true, false)
	report, err := InspectSecurityRisks(context.Background(), home, 10)
	if err != nil || len(report.Stores) != 1 || report.Stores[0].View != "archived" {
		t.Fatal("stdio-only migration not inspectable", err)
	}
	if _, err = os.Stat(filepath.Join(home, "web-agent", "adk", "sessions.sqlite")); !os.IsNotExist(err) {
		t.Fatal("inspection created a canonical database")
	}
	home = t.TempDir()
	path := filepath.Join(home, "web-agent", "adk", "sessions.sqlite")
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE native_operations(id TEXT PRIMARY KEY,status TEXT);INSERT INTO native_operations VALUES('legacy-operation',NULL)`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if h, err := OpenSecurityHome(context.Background(), home, ""); err == nil {
		h.Close()
		t.Fatal("sparse unresolved store migrated silently")
	}
	report, err = InspectSecurityRisks(context.Background(), home, 10)
	if err != nil {
		t.Fatal(err)
	}
	risk := report.Stores[0].Risks[0]
	if report.Stores[0].EffectReview != 1 || risk.RecordedRisk != "unclassified" || risk.Status != "unrecognized" || risk.TargetRef != "" || risk.HasHandle {
		t.Fatal("missing metadata was treated as verified", report)
	}
}

func TestSecurityRiskInspectionWorksAfterInitialAdoptionWithoutDoubleCounting(t *testing.T) {
	home, _ := securityRiskFixture(t, false, false)
	if err := ResumeInitialSecurityMigration(context.Background(), home); err != nil {
		t.Fatal(err)
	}
	report, err := InspectSecurityRisks(context.Background(), home, 10)
	if err != nil || report.Gate != "open" || len(report.Stores) != 1 || report.Stores[0].Unresolved != 3 {
		t.Fatal("adopted current store not visible", err)
	}
	if h, err := OpenSecurityReadOnlyHome(home, ""); err == nil {
		h.Close()
		t.Fatal("inspection relaxed Web recovery gate requirements")
	}
	db, err := sql.Open("sqlite", filepath.Join(home, "web-agent", "adk", "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec("UPDATE native_operations SET status='failed' WHERE id='same-op'")
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	report, err = InspectSecurityRisks(context.Background(), home, 10)
	if err != nil || len(report.Stores) != 1 || report.Stores[0].Unresolved != 2 {
		t.Fatal("archived canonical unknown was reported as a current risk", err)
	}
}

func TestSecurityRiskInspectionRejectsInvalidInventoryAndArchive(t *testing.T) {
	for _, kind := range []string{"namespace", "outside", "checksum", "count", "identity", "future", "duplicate", "policy", "journal", "missing", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			home, inv := securityRiskFixture(t, false, false)
			entry := &inv.Stores[0]
			switch kind {
			case "namespace":
				entry.StoreID = strings.Repeat("a", 64)
			case "outside":
				entry.Snapshot = filepath.Join(t.TempDir(), "unrelated.sqlite")
			case "checksum":
				entry.SHA256 = strings.Repeat("b", 64)
			case "count":
				entry.Unresolved++
			case "identity":
				inv.RecoveryEpoch = strings.Repeat("c", 64)
			case "future":
				inv.FormatVersion++
			case "duplicate":
				inv.Stores = append(inv.Stores, *entry)
			case "policy":
				inv.Policy = "unrecognized"
			case "journal":
				if err := os.WriteFile(entry.Snapshot+"-wal", []byte("unverified"), 0600); err != nil {
					t.Fatal(err)
				}
			case "missing":
				if err := os.Remove(entry.Snapshot); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				copy := filepath.Join(t.TempDir(), "snapshot.sqlite")
				if err := os.Rename(entry.Snapshot, copy); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(copy, entry.Snapshot); err != nil {
					t.Skip("symlink unavailable", err)
				}
			}
			if err := writeSecurityJSON(filepath.Join(home, "security", "legacy-inventory.json"), inv); err != nil {
				t.Fatal(err)
			}
			if _, err := InspectSecurityRisks(context.Background(), home, 10); err == nil {
				t.Fatal("invalid inspection source accepted")
			}
		})
	}
}

func TestSecurityRiskInspectionDoesNotMistakeLostHistoryForResolution(t *testing.T) {
	for _, kind := range []string{"missing_table", "replaced_identity"} {
		t.Run(kind, func(t *testing.T) {
			home, _ := securityRiskFixture(t, false, false)
			if err := ResumeInitialSecurityMigration(context.Background(), home); err != nil {
				t.Fatal(err)
			}
			db, err := sql.Open("sqlite", filepath.Join(home, "web-agent", "adk", "sessions.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			if kind == "missing_table" {
				_, err = db.Exec("DROP TABLE native_operations")
			} else {
				// Keep row counts unchanged: counts alone cannot prove that the
				// archived invocation identities were retained.
				_, err = db.Exec("UPDATE native_operations SET id='replacement-id' WHERE id='same-op'")
			}
			db.Close()
			if err != nil {
				t.Fatal(err)
			}
			if _, err = InspectSecurityRisks(context.Background(), home, 10); err == nil {
				t.Fatal("lost history was reported as a successfully cleared risk")
			}
		})
	}
}

func TestSecurityRiskInspectionRejectsOwnerLateStoresAndInvalidInputs(t *testing.T) {
	h := securityFixture(t)
	if _, err := InspectSecurityRisks(context.Background(), h.Home, 10); err == nil {
		t.Fatal("inspection bypassed the running owner")
	}
	h.Close()
	if report, err := InspectSecurityRisks(context.Background(), h.Home, 10); err != nil || len(report.Stores) != 1 || report.Stores[0].Unresolved != 0 {
		t.Fatal("empty initialized Home could not be inspected", err)
	}
	for _, limit := range []int{-1, 0, 1001} {
		if _, err := InspectSecurityRisks(context.Background(), h.Home, limit); err == nil {
			t.Fatal("invalid limit accepted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := InspectSecurityRisks(ctx, h.Home, 10); err != context.Canceled {
		t.Fatal("cancellation ignored", err)
	}
	missing := filepath.Join(t.TempDir(), "missing")
	if _, err := InspectSecurityRisks(context.Background(), missing, 10); err == nil {
		t.Fatal("missing Home accepted")
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("inspection bootstrapped a missing Home")
	}
	legacySecurityFixture(t, filepath.Join(h.Home, "web-agent", "ai", "adk", "sessions.sqlite"), "succeeded")
	if _, err := InspectSecurityRisks(context.Background(), h.Home, 10); err == nil {
		t.Fatal("unindexed late store hidden from report")
	}
}
