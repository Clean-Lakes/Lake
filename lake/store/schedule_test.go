package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestV15ScheduleMigrationBacksUpV14(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, "lake.db"))
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range []string{migrationV1, migrationV2, migrationV3, migrationV4, migrationV5, migrationV6, migrationV7, migrationV8, migrationV9, migrationV10, migrationV11, migrationV12, migrationV13, migrationV14} {
		if _, err := db.ExecContext(ctx, migration); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO lake(id,name,created_at,updated_at) VALUES('old','旧湖',1,1); PRAGMA user_version=14`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.GetLakeByName(ctx, "旧湖"); err != nil {
		t.Fatal(err)
	}
	var version int
	if err := s.db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil || version != schemaVersion {
		t.Fatalf("version=%d err=%v", version, err)
	}
	backups, err := filepath.Glob(filepath.Join(root, "lake.db.pre-v15-*.bak"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("backups=%v err=%v", backups, err)
	}
	if info, err := os.Stat(backups[0]); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("backup mode=%v err=%v", info, err)
	}
}

func scheduleFixture(t *testing.T) (*Store, Schedule) {
	t.Helper()
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	lake, err := s.CreateLake(ctx, "test", "")
	if err != nil {
		t.Fatal(err)
	}
	def, err := s.CreateWorkflowV2(ctx, lake.ID, "inspect", "", json.RawMessage(`{"version":2,"name":"inspect","nodes":[{"id":"one"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	schedule, err := s.CreateSchedule(ctx, def.ID, "cron", "* * * * *", "UTC", time.Now().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	return s, schedule
}

func TestScheduleClaimIsAtomicAndNeverReplaysDueTime(t *testing.T) {
	s, schedule := scheduleFixture(t)
	defer s.Close()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	advance := func(item Schedule) (*time.Time, error) { next := item.NextAt.Add(time.Hour); return &next, nil }
	var wg sync.WaitGroup
	wg.Add(2)
	var mu sync.Mutex
	success := 0
	for i := 0; i < 2; i++ {
		go func() {
			defer wg.Done()
			_, run, err := s.ClaimDueSchedule(ctx, "worker", now, 2*time.Minute, advance)
			if err == nil {
				mu.Lock()
				success++
				mu.Unlock()
				if run.DueAt.UnixMilli() != schedule.NextAt.UnixMilli() {
					t.Errorf("due=%v", run.DueAt)
				}
			}
		}()
	}
	wg.Wait()
	if success != 1 {
		t.Fatalf("claims=%d", success)
	}
	runs, err := s.ListScheduleRuns(ctx, schedule.ID)
	if err != nil || len(runs) != 1 {
		t.Fatalf("runs=%v err=%v", runs, err)
	}
	if err := s.FinishScheduleRun(ctx, runs[0].ID, "other", "completed", "", "", now); err == nil {
		t.Fatal("wrong owner completed run")
	}
	if err := s.FinishScheduleRun(ctx, runs[0].ID, "worker", "completed", "", "", now); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.ClaimDueSchedule(ctx, "worker", now, 2*time.Minute, advance); err == nil {
		t.Fatal("same due time reclaimed")
	}
}

func TestExpiredSchedulePausesAndGrantIsBounded(t *testing.T) {
	s, schedule := scheduleFixture(t)
	defer s.Close()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	resource, err := s.CreateHost(ctx, ResourceInput{LakeID: schedule.LakeID, Name: "web", SSH: SSHSpec{Host: "example.invalid", Port: 22, Username: "root"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetExecuteAuthz(ctx, resource.ID, true); err != nil {
		t.Fatal(err)
	}
	grant, err := s.CreateScheduleGrant(ctx, schedule.ID, "write", resource.ID, CommandSHA256("echo ok"), now.Add(time.Hour), 1)
	if err != nil {
		t.Fatal(err)
	}
	call := []ScheduleGrantUse{{NodeID: "write", ResourceID: resource.ID, CommandSHA256: CommandSHA256("echo ok")}}
	if err := s.ConsumeScheduleGrants(ctx, schedule.ID, schedule.WorkflowRevision, call, now); err != nil {
		t.Fatal(err)
	}
	if err := s.ConsumeScheduleGrants(ctx, schedule.ID, schedule.WorkflowRevision, call, now); err == nil {
		t.Fatal("grant reused")
	}
	if after, err := s.GetScheduleGrant(ctx, grant.ID); err != nil || after.UsedRuns != 1 {
		t.Fatalf("grant=%+v err=%v", after, err)
	}
	advance := func(item Schedule) (*time.Time, error) { next := item.NextAt.Add(time.Hour); return &next, nil }
	_, run, err := s.ClaimDueSchedule(ctx, "worker", now, 2*time.Second, advance)
	if err != nil {
		t.Fatal(err)
	}
	count, err := s.MarkExpiredScheduleRuns(ctx, now.Add(3*time.Second))
	if err != nil || count != 1 {
		t.Fatalf("expired=%d err=%v", count, err)
	}
	after, err := s.GetScheduleRun(ctx, run.ID)
	if err != nil || after.Status != "unknown" {
		t.Fatalf("run=%+v err=%v", after, err)
	}
	paused, err := s.GetSchedule(ctx, schedule.ID)
	if err != nil || paused.Enabled {
		t.Fatalf("schedule=%+v err=%v", paused, err)
	}
}

func TestScheduleGrantRejectsChangedCommandAndRevokedResource(t *testing.T) {
	s, schedule := scheduleFixture(t)
	defer s.Close()
	ctx := context.Background()
	now := time.Now().UTC()
	resource, err := s.CreateHost(ctx, ResourceInput{LakeID: schedule.LakeID, Name: "node", SSH: SSHSpec{Host: "example.invalid", Port: 22, Username: "fixture"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetExecuteAuthz(ctx, resource.ID, true); err != nil {
		t.Fatal(err)
	}
	grant, err := s.CreateScheduleGrant(ctx, schedule.ID, "write", resource.ID, CommandSHA256("echo expected"), now.Add(time.Hour), 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, call := range []ScheduleGrantUse{
		{NodeID: "other", ResourceID: resource.ID, CommandSHA256: grant.CommandSHA256},
		{NodeID: "write", ResourceID: resource.ID, CommandSHA256: CommandSHA256("echo changed")},
	} {
		if err := s.ConsumeScheduleGrants(ctx, schedule.ID, schedule.WorkflowRevision, []ScheduleGrantUse{call}, now); err == nil {
			t.Fatalf("changed grant accepted: %+v", call)
		}
	}
	if _, err := s.SetExecuteAuthz(ctx, resource.ID, false); err != nil {
		t.Fatal(err)
	}
	call := ScheduleGrantUse{NodeID: "write", ResourceID: resource.ID, CommandSHA256: grant.CommandSHA256}
	if err := s.ConsumeScheduleGrants(ctx, schedule.ID, schedule.WorkflowRevision, []ScheduleGrantUse{call}, now); err == nil {
		t.Fatal("revoked resource consumed grant")
	}
	current, err := s.GetScheduleGrant(ctx, grant.ID)
	if err != nil || current.UsedRuns != 0 {
		t.Fatalf("grant consumption changed: %+v err=%v", current, err)
	}
}
