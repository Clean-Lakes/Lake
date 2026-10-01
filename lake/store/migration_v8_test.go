package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestV8MigratesLegacyTurnsAndKeepsPrivateBackup(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, "lake.db"))
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range []string{migrationV1, migrationV2, migrationV3, migrationV4, migrationV5, migrationV6, migrationV7} {
		if _, err := db.ExecContext(ctx, migration); err != nil {
			t.Fatal(err)
		}
	}
	for _, statement := range []string{
		`INSERT INTO lake(id,name,created_at,updated_at) VALUES('lake-1','测试湖',1,1)`,
		`INSERT INTO conversation(id,lake_id,created_at,updated_at) VALUES('conversation-1','lake-1',2,2)`,
		`INSERT INTO conversation_turn(id,conversation_id,prompt,answer,display,created_at) VALUES('turn-z','conversation-1','first','answer one','answer one',3)`,
		`INSERT INTO conversation_turn(id,conversation_id,prompt,answer,display,created_at) VALUES('turn-a','conversation-1','second','answer two','answer two',3)`,
		`PRAGMA user_version = 7`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	s, err := Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT seq,kind,actor,payload,legacy_turn_id FROM conversation_event WHERE conversation_id='conversation-1' ORDER BY seq`)
	if err != nil {
		t.Fatal(err)
	}
	type event struct {
		seq    int
		kind   string
		actor  string
		text   string
		turnID string
	}
	var events []event
	for rows.Next() {
		var item event
		var payload []byte
		if err := rows.Scan(&item.seq, &item.kind, &item.actor, &payload, &item.turnID); err != nil {
			t.Fatal(err)
		}
		var body struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(payload, &body); err != nil {
			t.Fatal(err)
		}
		item.text = body.Text
		events = append(events, item)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	listed, err := s.ListAgentEvents(ctx, "conversation-1", 0, 10)
	if err != nil || len(listed) != 4 || listed[0].LegacyTurnID != "turn-z" || listed[2].LegacyTurnID != "turn-a" {
		t.Fatalf("legacy link was lost: events=%+v err=%v", listed, err)
	}
	want := []event{
		{1, "user", "user", "first", "turn-z"},
		{2, "assistant", "assistant", "answer one", "turn-z"},
		{3, "user", "user", "second", "turn-a"},
		{4, "assistant", "assistant", "answer two", "turn-a"},
	}
	if len(events) != len(want) {
		t.Fatalf("events = %+v, want %+v", events, want)
	}
	for i := range want {
		if events[i] != want[i] {
			t.Fatalf("event %d = %+v, want %+v", i, events[i], want[i])
		}
	}
	var legacyCount int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM conversation_turn WHERE conversation_id='conversation-1'`).Scan(&legacyCount); err != nil || legacyCount != 2 {
		t.Fatalf("legacy turns changed: count=%d err=%v", legacyCount, err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	backups, err := filepath.Glob(filepath.Join(root, "lake.db.pre-v8-*.bak"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("backups = %v, err = %v", backups, err)
	}
	info, err := os.Stat(backups[0])
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("backup mode = %v, err = %v", info.Mode(), err)
	}
	backupDB, err := sql.Open("sqlite", backups[0])
	if err != nil {
		t.Fatal(err)
	}
	defer backupDB.Close()
	var backupVersion, backupTurns int
	if err := backupDB.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&backupVersion); err != nil {
		t.Fatal(err)
	}
	if err := backupDB.QueryRowContext(ctx, `SELECT count(*) FROM conversation_turn`).Scan(&backupTurns); err != nil {
		t.Fatal(err)
	}
	if backupVersion != 7 || backupTurns != 2 {
		t.Fatalf("backup version=%d turns=%d", backupVersion, backupTurns)
	}

	s, err = Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM conversation_event WHERE conversation_id='conversation-1'`).Scan(&legacyCount); err != nil || legacyCount != 4 {
		t.Fatalf("reopened event count=%d err=%v", legacyCount, err)
	}
	backups, err = filepath.Glob(filepath.Join(root, "lake.db.pre-v8-*.bak"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("reopen created another backup: %v, err=%v", backups, err)
	}
}
