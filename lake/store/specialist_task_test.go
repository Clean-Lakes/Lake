package store

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestV13SpecialistMigrationPreservesV12Data(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, "lake.db"))
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range []string{migrationV1, migrationV2, migrationV3, migrationV4, migrationV5, migrationV6, migrationV7, migrationV8, migrationV9, migrationV10, migrationV11, migrationV12} {
		if _, err := db.ExecContext(ctx, migration); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO lake(id,name,created_at,updated_at) VALUES('old','旧湖',1,1); PRAGMA user_version=12`); err != nil {
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
		t.Fatalf("schema version=%d err=%v", version, err)
	}
	backups, err := filepath.Glob(filepath.Join(root, "lake.db.pre-v13-*.bak"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("backups=%v err=%v", backups, err)
	}
	if info, err := os.Stat(backups[0]); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("backup permissions: %v %v", info, err)
	}
}

func TestSpecialistTaskLifecycleAndNoRawArguments(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	input := SpecialistTaskInput{ID: "task-1", ParentRunID: "run-1", Name: "lake_ssh_agent", Model: "model-1", ScopeJSON: `{"lake_id":"lake-1","tool_names":["lake_ssh"]}`, RequestSHA256: strings.Repeat("a", 64)}
	task, err := s.CreateSpecialistTask(ctx, input)
	if err != nil || task.Status != "delegated" {
		t.Fatalf("created=%+v err=%v", task, err)
	}
	if _, err := s.UpdateSpecialistTask(ctx, task.ID, "running", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateSpecialistTask(ctx, task.ID, "completed", strings.Repeat("b", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateSpecialistTask(ctx, task.ID, "running", ""); err == nil {
		t.Fatal("terminal task restarted")
	}
	items, err := s.ListSpecialistTasks(ctx, "run-1")
	if err != nil || len(items) != 1 || items[0].Status != "completed" || items[0].ResponseSHA256 != strings.Repeat("b", 64) {
		t.Fatalf("items=%+v err=%v", items, err)
	}
	var stored string
	if err := s.db.QueryRowContext(ctx, `SELECT scope_json FROM specialist_task WHERE id='task-1'`).Scan(&stored); err != nil || strings.Contains(stored, "secret argument") {
		t.Fatalf("scope=%s err=%v", stored, err)
	}
	second := input
	second.ID = "task-2"
	if _, err := s.CreateSpecialistTask(ctx, second); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateSpecialistTask(ctx, second.ID, "running", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkInterruptedSpecialistTasks(ctx, "run-1"); err != nil {
		t.Fatal(err)
	}
	unknown, err := s.GetSpecialistTask(ctx, second.ID)
	if err != nil || unknown.Status != "unknown" {
		t.Fatalf("interrupted=%+v err=%v", unknown, err)
	}
	completed, err := s.GetSpecialistTask(ctx, task.ID)
	if err != nil || completed.Status != "completed" {
		t.Fatalf("completed task altered=%+v err=%v", completed, err)
	}
}
