package web

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOriginalPrototypeSchemaMigration(t *testing.T) {
	dir := t.TempDir()
	db, e := sql.Open("sqlite3", filepath.Join(dir, "lake-web.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	old := strings.ReplaceAll(schema, "CHECK(kind IN ('local','ssh','database','docker','redis'))", "CHECK(kind = 'local')")
	old = strings.ReplaceAll(old, "CHECK(status IN ('connecting','ready','busy','disconnected','unknown'))", "CHECK(status IN ('ready','busy','disconnected','unknown'))")
	old = strings.ReplaceAll(old, "images TEXT NOT NULL DEFAULT '[]', ", "")
	old = strings.ReplaceAll(old, "mentions TEXT, ", "")
	old = strings.ReplaceAll(old, "terminalId TEXT, contextVersion INTEGER, ", "")
	old = strings.ReplaceAll(old, ", contextVersion INTEGER NOT NULL DEFAULT 0, output TEXT NOT NULL DEFAULT ''", "")
	if _, e = db.Exec(old); e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(`INSERT INTO projects VALUES('p','original','2026-10-01T00:00:00.000Z'); INSERT INTO resources VALUES('r','p','Local machine','local','old','available'); INSERT INTO sessions VALUES('s','p','original','idle','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z'); INSERT INTO sessionResources VALUES('s','r'); INSERT INTO messages(id,sessionId,role,text,createdAt) VALUES('m','s','user','preserved message','2026-10-01T00:00:00.000Z'); INSERT INTO terminals(id,sessionId,resourceId,status,holder,createdAt) VALUES('t','s','r','ready','user','2026-10-01T00:00:00.000Z')`); e != nil {
		t.Fatal(e)
	}
	db.Close()
	store, e := OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	snap := store.Snapshot("s")
	if len(objects(snap["messages"])) != 1 || objects(snap["messages"])[0]["text"] != "preserved message" {
		t.Fatal(snap)
	}
	if store.Terminal("s", "t")["status"] != "disconnected" {
		t.Fatal("live process replayed")
	}
	r := store.CreateResource("p", "db", "database", Object{"driver": "sqlite", "path": "/tmp/test.sqlite"})
	if r["kind"] != "database" {
		t.Fatal(r)
	}
	backups, _ := filepath.Glob(filepath.Join(dir, "lake-web.before-go-*.sqlite"))
	if len(backups) != 1 {
		t.Fatal("consistent pre-migration backup missing", backups)
	}
	info, _ := os.Stat(backups[0])
	if info.Mode().Perm() != 0600 {
		t.Fatal(info.Mode())
	}
	backup, e := sql.Open("sqlite3", backups[0])
	if e != nil {
		t.Fatal(e)
	}
	defer backup.Close()
	var text string
	if backup.QueryRow("SELECT text FROM messages WHERE id='m'").Scan(&text) != nil || text != "preserved message" {
		t.Fatal("inconsistent migration backup")
	}
	var memoryTable string
	if err := backup.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='projectMemories'").Scan(&memoryTable); err != sql.ErrNoRows {
		t.Fatalf("backup was taken after memory migration: %v", err)
	}
	if store.MemorySettings("p")["useEnabled"] != true {
		t.Fatal("existing project did not receive default memory settings")
	}
	store.Close()
	store, e = OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	backups, _ = filepath.Glob(filepath.Join(dir, "lake-web.before-go-*.sqlite"))
	if len(backups) != 1 {
		t.Fatal("non-idempotent migration")
	}
}
func TestOnlyOneGoBackendOwnsData(t *testing.T) {
	dir := t.TempDir()
	s, e := OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	if other, e := OpenStore(dir); e == nil {
		other.Close()
		t.Fatal("second writer allowed")
	}
}
