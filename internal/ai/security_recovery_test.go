package ai

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSecurityRestoreImportInitializesEmptyTargetClosedAndResumes(t *testing.T) {
	for _, interruption := range []string{"", "import_gate_closed", "import_store_initialized"} {
		t.Run(interruption, func(t *testing.T) {
			h, source := checkpointFixture(t)
			ctx := context.Background()
			if _, err := CreateSecurityCheckpoint(ctx, h.Home, source); err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(t.TempDir(), "new-device")
			if interruption != "" {
				_, err := restoreSecurityBackup(ctx, target, source, true, func(stage string) error {
					if stage == interruption {
						return errors.New("simulated interruption")
					}
					return nil
				})
				if err == nil {
					t.Fatal("interruption did not stop import")
				}
				control, err := ReadSecurityControl(target)
				if err != nil || control.Gate != "closed" || control.StoreID == h.control.StoreID {
					t.Fatal("new target authority was not closed first", err)
				}
				if owner, err := OpenSecurityHome(ctx, target, ""); err == nil {
					owner.Close()
					t.Fatal("interrupted empty import became executable")
				}
			}
			result, err := RestoreSecurityBackup(ctx, target, source, true)
			if err != nil {
				t.Fatal(err)
			}
			control, err := ReadSecurityControl(target)
			if err != nil || control.Gate != "closed" || control.StoreID == h.control.StoreID || control.RecoveryEpoch == h.control.RecoveryEpoch || !control.StoreReady || result.Stage != "confirmation_required" {
				t.Fatal("fresh import silently reused authority", err)
			}
			if _, err := VerifySecurityCheckpoint(ctx, result.PreservedCheckpoint); err != nil {
				t.Fatal("empty target preservation was not verifiable", err)
			}
		})
	}
}

func TestSecurityRestoreImportRejectsNonemptyMissingControlTarget(t *testing.T) {
	h, source := checkpointFixture(t)
	ctx := context.Background()
	if _, err := CreateSecurityCheckpoint(ctx, h.Home, source); err != nil {
		t.Fatal(err)
	}
	for _, filename := range []string{"legacy.json", "web-agent/lake-web.sqlite", "secrets/anything"} {
		t.Run(filename, func(t *testing.T) {
			target := t.TempDir()
			path := filepath.Join(target, filename)
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("original data"), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := RestoreSecurityBackup(ctx, target, source, true); err == nil {
				t.Fatal("nonempty target treated as fresh import")
			}
			if _, err := ReadSecurityControl(target); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("rejected target acquired fabricated identity", err)
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != "original data" {
				t.Fatal("unclassified original data changed", err)
			}
		})
	}
}

func TestSecurityRestorePreservesNewerUnknownAndInvalidatesOldApproval(t *testing.T) {
	h, destination := checkpointFixture(t)
	ctx := context.Background()
	if _, err := CreateSecurityCheckpoint(ctx, h.Home, destination); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO native_operations VALUES('newer-unknown','unknown','write','asset-one');INSERT INTO native_evidences VALUES(2,'newer-unknown','preserve this effect');UPDATE native_approvals SET status='consumed'`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	result, err := RestoreSecurityBackup(ctx, h.Home, destination, false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Stage != "confirmation_required" || !result.ConfirmationRequired || result.RecoveryEpoch == h.control.RecoveryEpoch || result.StoreID != h.control.StoreID {
		t.Fatal("restore authority was not fenced")
	}
	if !result.LedgerIndexAvailable {
		t.Fatal("restore did not index preserved history")
	}
	index, err := ReadRecoveryLedgerIndex(ctx, h.Home)
	if err != nil || len(index.Stores) != 2 || index.Stores[0].Unresolved != 1 || index.Stores[1].Unresolved != 0 || index.ResourceMapping != "unverified" {
		t.Fatal("recovery ledger facts are incorrect", err)
	}
	rawIndex, _ := json.Marshal(index)
	if strings.Contains(string(rawIndex), "newer-unknown") || strings.Contains(string(rawIndex), "asset-one") || strings.Contains(string(rawIndex), "preserve this effect") {
		t.Fatal("legacy metadata escaped recovery projection")
	}
	control, err := ReadSecurityControl(h.Home)
	if err != nil || control.Gate != "closed" || control.RecoveryEpoch != result.RecoveryEpoch {
		t.Fatal("restore opened the gate", err)
	}
	preserved, err := VerifySecurityCheckpoint(ctx, result.PreservedCheckpoint)
	if err != nil || preserved.RecoveryEpoch != h.control.RecoveryEpoch {
		t.Fatal("newer ledger preservation failed", err)
	}
	old, err := openSecurityReadOnlyMode(filepath.Join(result.PreservedCheckpoint, "adk", "sessions.sqlite"), true)
	if err != nil {
		t.Fatal(err)
	}
	var count int
	err = old.QueryRow(`SELECT count(*) FROM native_operations WHERE id='newer-unknown' AND status='unknown'`).Scan(&count)
	if err != nil || count != 1 {
		t.Fatal("newer unknown was lost", err)
	}
	err = old.QueryRow(`SELECT count(*) FROM native_evidences WHERE operation_id='newer-unknown'`).Scan(&count)
	old.Close()
	if err != nil || count != 1 {
		t.Fatal("newer evidence was lost", err)
	}
	current, err := openSecurityReadOnly(filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer current.Close()
	var status string
	if err = current.QueryRow(`SELECT status FROM native_approvals WHERE id='approval'`).Scan(&status); err != nil || status != "invalid" {
		t.Fatal("old approval resurrected", err)
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(h.RuntimeRoot), "tool-schedules.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schedules []map[string]any
	if err = json.Unmarshal(data, &schedules); err != nil || schedules[0]["enabled"] != false {
		t.Fatal("old schedule enabled", err)
	}
	if executable, err := OpenSecurityHome(ctx, h.Home, ""); err == nil {
		executable.Close()
		t.Fatal("restore silently resumed execution")
	}
	statusResult, err := RecoveryPending(h.Home)
	if err != nil || statusResult.Stage != result.Stage {
		t.Fatal("recovery status unavailable", err)
	}
}

func TestSecurityRestoreLedgerIndexTamperDoesNotUnlock(t *testing.T) {
	h, destination := checkpointFixture(t)
	ctx := context.Background()
	if _, err := CreateSecurityCheckpoint(ctx, h.Home, destination); err != nil {
		t.Fatal(err)
	}
	result, err := RestoreSecurityBackup(ctx, h.Home, destination, false)
	if err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(h.Home, "security", "recoveries", result.RecoveryID, "ledger-index.json")
	if err = os.WriteFile(indexPath, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = ReadRecoveryLedgerIndex(ctx, h.Home); err == nil {
		t.Fatal("damaged preservation index accepted")
	}
	if _, err = RestoreSecurityBackup(ctx, h.Home, destination, false); err == nil {
		t.Fatal("damaged preservation index silently rebuilt")
	}
	control, _ := ReadSecurityControl(h.Home)
	if control.Gate != "closed" {
		t.Fatal("damaged history opened gate")
	}
}

func TestSecurityRestoreEveryInterruptionRemainsClosedAndResumes(t *testing.T) {
	for _, stage := range []string{"gate_closed", "preserved", "staged", "applied:adk/sessions.sqlite", "applied:lake-web.sqlite", "confirmation_required"} {
		t.Run(stage, func(t *testing.T) {
			h, destination := checkpointFixture(t)
			ctx := context.Background()
			if _, err := CreateSecurityCheckpoint(ctx, h.Home, destination); err != nil {
				t.Fatal(err)
			}
			stopped := errors.New("injected interruption")
			_, err := restoreSecurityBackup(ctx, h.Home, destination, false, func(at string) error {
				if at == stage {
					return stopped
				}
				return nil
			})
			if !errors.Is(err, stopped) {
				t.Fatal("interruption not reached", err)
			}
			control, err := ReadSecurityControl(h.Home)
			if err != nil || control.Gate != "closed" || control.RecoveryEpoch == h.control.RecoveryEpoch {
				t.Fatal("interrupted restore left executable authority", err)
			}
			if executable, err := OpenSecurityHome(ctx, h.Home, ""); err == nil {
				executable.Close()
				t.Fatal("interrupted restore executable")
			}
			result, err := RestoreSecurityBackup(ctx, h.Home, destination, false)
			if err != nil || result.Stage != "confirmation_required" || result.RecoveryEpoch != control.RecoveryEpoch {
				t.Fatal("interrupted restore did not resume its original epoch", err)
			}
		})
	}
}

func TestSecurityRestoreCrossDeviceRequiresImportAndChangesIdentity(t *testing.T) {
	source, destination := checkpointFixture(t)
	ctx := context.Background()
	if _, err := CreateSecurityCheckpoint(ctx, source.Home, destination); err != nil {
		t.Fatal(err)
	}
	target, _ := checkpointFixture(t)
	if _, err := RestoreSecurityBackup(ctx, target.Home, destination, false); err == nil {
		t.Fatal("foreign checkpoint accepted as same-device restore")
	}
	control, _ := ReadSecurityControl(target.Home)
	if control != target.control {
		t.Fatal("rejected foreign checkpoint changed authority")
	}
	result, err := RestoreSecurityBackup(ctx, target.Home, destination, true)
	if err != nil {
		t.Fatal(err)
	}
	if result.StoreID == source.control.StoreID || result.StoreID == target.control.StoreID || result.RecoveryEpoch == source.control.RecoveryEpoch || result.RecoveryEpoch == target.control.RecoveryEpoch {
		t.Fatal("import reused old identity or authority")
	}
	control, _ = ReadSecurityControl(target.Home)
	if control.Gate != "closed" {
		t.Fatal("import opened execution gate")
	}
}

func TestSecurityRestoreRejectedCheckpointDoesNotChangeAuthority(t *testing.T) {
	h, destination := checkpointFixture(t)
	ctx := context.Background()
	if _, err := CreateSecurityCheckpoint(ctx, h.Home, destination); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(destination, "tool-schedules.json"), []byte(`[]`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := RestoreSecurityBackup(ctx, h.Home, destination, false); err == nil {
		t.Fatal("tampered backup restored")
	}
	control, _ := ReadSecurityControl(h.Home)
	if control != h.control {
		t.Fatal("invalid backup changed execution authority")
	}
}

func TestSecurityRestoreInvalidatesAllUnconsumedAuthorityAndPreservesGoalData(t *testing.T) {
	h, destination := checkpointFixture(t)
	db, err := sql.Open("sqlite", filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
INSERT INTO native_approvals VALUES('pending','pending'),('decided','decided'),('consumed','consumed');
CREATE TABLE native_work_goals(id TEXT PRIMARY KEY,session_id TEXT,status TEXT,data TEXT,checkpoint TEXT,wait_state TEXT,wait_call_id TEXT,lease_owner TEXT,lease_until TIMESTAMP);
INSERT INTO native_work_goals VALUES('goal','session','running','{"id":"goal","status":"running","items":[{"id":"step","status":"running"}]}','old-checkpoint','waiting','call','owner',CURRENT_TIMESTAMP);
CREATE TABLE security_tasks(id TEXT PRIMARY KEY,state TEXT,state_revision INTEGER,execution_revision INTEGER,recovery_epoch TEXT);
INSERT INTO security_tasks VALUES('task','waiting',2,1,'old-epoch');
CREATE TABLE security_task_bindings(id TEXT PRIMARY KEY,state TEXT,owner_generation INTEGER);
INSERT INTO security_task_bindings VALUES('binding','active',7);
CREATE TABLE security_task_grants(id TEXT PRIMARY KEY,revoked BOOLEAN,revision INTEGER);
INSERT INTO security_task_grants VALUES('grant',0,1);
CREATE TABLE security_schedule_grants(id TEXT PRIMARY KEY,revoked BOOLEAN,revision INTEGER);
INSERT INTO security_schedule_grants VALUES('schedule-grant',0,1);
CREATE TABLE security_project_policies(project_id TEXT PRIMARY KEY,revision INTEGER,data TEXT,confirmed BOOLEAN);
INSERT INTO security_project_policies VALUES('project',1,'{"ProjectID":"project","SchemaVersion":1,"Revision":1,"Mode":"restricted","Confirmed":true}',1);`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err = CreateSecurityCheckpoint(ctx, h.Home, destination); err != nil {
		t.Fatal(err)
	}
	if _, err = RestoreSecurityBackup(ctx, h.Home, destination, false); err != nil {
		t.Fatal(err)
	}
	db, err = openSecurityReadOnly(filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for query, expected := range map[string]int{
		`SELECT count(*) FROM native_approvals WHERE status='invalid'`:                                                                            3,
		`SELECT count(*) FROM native_approvals WHERE id='consumed' AND status='consumed'`:                                                         1,
		`SELECT count(*) FROM native_work_goals WHERE status='paused' AND checkpoint='' AND wait_state='' AND wait_call_id='' AND lease_owner=''`: 1,
		`SELECT count(*) FROM security_tasks WHERE state='paused' AND state_revision=3 AND execution_revision=2 AND recovery_epoch='old-epoch'`:   1,
		`SELECT count(*) FROM security_task_bindings WHERE state='closed' AND owner_generation=8`:                                                 1,
		`SELECT count(*) FROM security_task_grants WHERE revoked=1 AND revision=2`:                                                                1,
		`SELECT count(*) FROM security_schedule_grants WHERE revoked=1 AND revision=2`:                                                            1,
		`SELECT count(*) FROM security_project_policies WHERE confirmed=0`:                                                                        1,
	} {
		var count int
		if err = db.QueryRow(query).Scan(&count); err != nil || count != expected {
			t.Fatal("restore authority invalidation failed", query, count, err)
		}
	}
	var raw string
	if err = db.QueryRow(`SELECT data FROM native_work_goals WHERE id='goal'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var goal map[string]any
	if err = json.Unmarshal([]byte(raw), &goal); err != nil || goal["status"] != "paused" || goal["id"] != "goal" {
		t.Fatal("serialized goal diverged from paused row", err)
	}
}
