package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestV14WorkflowMigrationPreservesV13Data(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, "lake.db"))
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range []string{migrationV1, migrationV2, migrationV3, migrationV4, migrationV5, migrationV6, migrationV7, migrationV8, migrationV9, migrationV10, migrationV11, migrationV12, migrationV13} {
		if _, err := db.ExecContext(ctx, migration); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO lake(id,name,created_at,updated_at) VALUES('old','旧湖',1,1); PRAGMA user_version=13`); err != nil {
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
	backups, err := filepath.Glob(filepath.Join(root, "lake.db.pre-v14-*.bak"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("backups=%v err=%v", backups, err)
	}
	if info, err := os.Stat(backups[0]); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("permissions=%v err=%v", info, err)
	}
}

func TestWorkflowV2SnapshotsNodesAndEventsAtomically(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "workflow-v2", "")
	if err != nil {
		t.Fatal(err)
	}
	def, err := s.CreateWorkflowV2(ctx, lake.ID, "v2", "", json.RawMessage(`{"version":2,"name":"v2","nodes":[{"id":"one"}]}`))
	if err != nil || def.Revision != 1 {
		t.Fatalf("def=%+v err=%v", def, err)
	}
	run, err := s.CreateWorkflowV2Run(ctx, def, "cli", []string{"one"})
	if err != nil || run.Status != "pending" || len(run.Nodes) != 1 {
		t.Fatalf("run=%+v err=%v", run, err)
	}
	input := json.RawMessage(`{"target":"host"}`)
	if _, err := s.TransitionWorkflowV2Node(ctx, WorkflowV2NodeChange{RunID: run.ID, NodeID: "one", From: "pending", To: "waiting_approval", Input: input}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionWorkflowV2Node(ctx, WorkflowV2NodeChange{RunID: run.ID, NodeID: "one", From: "waiting_approval", To: "running", Approval: json.RawMessage(`{"outcome":"allow"}`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionWorkflowV2Node(ctx, WorkflowV2NodeChange{RunID: run.ID, NodeID: "one", From: "running", To: "completed", Result: json.RawMessage(`"ok"`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionWorkflowV2Node(ctx, WorkflowV2NodeChange{RunID: run.ID, NodeID: "one", From: "running", To: "failed"}); err == nil {
		t.Fatal("stale transition accepted")
	}
	run, err = s.GetWorkflowV2Run(ctx, run.ID)
	if err != nil || run.Nodes[0].Status != "completed" || string(run.Nodes[0].Input) != string(input) || string(run.Nodes[0].Result) != `"ok"` {
		t.Fatalf("run=%+v err=%v", run, err)
	}
	events, err := s.ListWorkflowV2Events(ctx, run.ID)
	if err != nil || len(events) < 4 {
		t.Fatalf("events=%+v err=%v", events, err)
	}
	for _, event := range events {
		if len(event.Payload) > 4096 || string(event.Payload) == string(input) {
			t.Fatalf("event leaked node snapshot: %+v", event)
		}
	}
	second, err := s.CreateWorkflowV2Run(ctx, def, "cli", []string{"two"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.TransitionWorkflowV2Node(ctx, WorkflowV2NodeChange{RunID: second.ID, NodeID: "two", From: "pending", To: "failed", ErrorCode: "Bearer secret"}); err == nil {
		t.Fatal("accepted raw error text")
	}
}
