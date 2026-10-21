package web

import (
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestStrategyMigrationBackupAndFutureGuard(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "lake-web.sqlite")
	db, err := openSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, ddl := range []string{schema, presentationSchema, memorySchema} {
		if _, err = db.Exec(ddl); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = db.Exec("INSERT INTO projects VALUES('old','preserved','old-time'); INSERT INTO sessions VALUES('s','old','old','idle','old-time','old-time'); INSERT INTO messages(id,sessionId,role,text,createdAt) VALUES('old-message','s','user','preserved user text','old-time')"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	backups, _ := filepath.Glob(filepath.Join(dir, "lake-web.before-strategy-v1-*.sqlite"))
	if len(backups) != 1 {
		t.Fatal("missing migration snapshot", backups)
	}
	info, _ := os.Stat(backups[0])
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("snapshot permissions", info.Mode())
	}
	snapshot, err := openSQLite(backups[0])
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	var value string
	if err = snapshot.QueryRow("SELECT text FROM messages WHERE id='old-message'").Scan(&value); err != nil || value != "preserved user text" {
		t.Fatal("snapshot lost WAL data", value, err)
	}
	if err = snapshot.QueryRow("SELECT name FROM sqlite_master WHERE name='strategyAssets'").Scan(&value); err != sql.ErrNoRows {
		t.Fatal("snapshot taken after migration", err)
	}
	if err = s.db.QueryRow("PRAGMA integrity_check").Scan(&value); err != nil || value != "ok" {
		t.Fatal("integrity", value, err)
	}
	rows, err := s.db.Query("PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	if rows.Next() {
		t.Fatal("invalid foreign key")
	}
	rows.Close()
	s.Close()
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	backups, _ = filepath.Glob(filepath.Join(dir, "lake-web.before-strategy-v1-*.sqlite"))
	if len(backups) != 1 {
		t.Fatal("migration not idempotent")
	}
	db, err = openSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	db.Exec("UPDATE strategySchemaMeta SET schemaHash='future-format'; UPDATE sessions SET status='investigating' WHERE id='s'")
	db.Close()
	if incompatible, err := OpenStore(dir); err == nil {
		incompatible.Close()
		t.Fatal("future schema accepted")
	}
	db, _ = openSQLite(path)
	defer db.Close()
	db.QueryRow("SELECT status FROM sessions WHERE id='s'").Scan(&value)
	if value != "investigating" {
		t.Fatal("restart writes occurred before version guard")
	}
}
func TestStrategyMigrationFailureRollsBackNewSchema(t *testing.T) {
	dir := t.TempDir()
	db, err := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	for _, ddl := range []string{schema, presentationSchema, memorySchema} {
		if _, err = db.Exec(ddl); err != nil {
			t.Fatal(err)
		}
	}
	db.Exec("CREATE TABLE strategyAssets(fixture INTEGER)")
	db.Close()
	if broken, err := OpenStore(dir); err == nil {
		broken.Close()
		t.Fatal("incomplete migration accepted")
	}
	db, _ = openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	defer db.Close()
	var name string
	for _, table := range []string{"strategySchemaMeta", "strategyScopes", "strategySettings"} {
		if err = db.QueryRow("SELECT name FROM sqlite_master WHERE name=?", table).Scan(&name); err != sql.ErrNoRows {
			t.Fatal("partial schema committed", table, err)
		}
	}
}
