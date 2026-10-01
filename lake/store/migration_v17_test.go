package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestV17RepairsLegacyEventColumnAndKeepsConversation(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, err := Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	lake, _ := s.CreateLake(ctx, "test", "")
	conversation, _ := s.CreateConversation(ctx, lake.Name)
	if _, err := s.AppendConversationTurn(ctx, conversation.ID, "original request", "original answer", "original display", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE conversation_event DROP COLUMN tool_call_id; PRAGMA user_version=16`); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 1 || turns[0].Prompt != "original request" {
		t.Fatalf("turns=%+v err=%v", turns, err)
	}
	events, err := s.ListAgentEvents(ctx, conversation.ID, 0, 100)
	if err != nil || len(events) != 2 {
		t.Fatalf("events=%+v err=%v", events, err)
	}
	var version int
	s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version)
	if version != schemaVersion {
		t.Fatal(version)
	}
	backups, err := filepath.Glob(filepath.Join(root, "lake.db.pre-v17-*.bak"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("backup=%v err=%v", backups, err)
	}
	s.Close()
	s, err = Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	backups, err = filepath.Glob(filepath.Join(root, "lake.db.pre-v17-*.bak"))
	if err != nil || len(backups) != 1 {
		t.Fatal("reopening duplicated upgrade")
	}
}
