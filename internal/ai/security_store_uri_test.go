package ai

import (
	"bytes"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestSecurityReadOnlyURIKeepsWindowsVolumeInPath(t *testing.T) {
	for _, path := range []string{"C:/Lake 数据 # % &/sessions.sqlite", "d:/runtime/sessions.sqlite"} {
		for _, immutable := range []bool{false, true} {
			u, err := url.Parse(securityReadOnlyURI(path, immutable))
			if err != nil {
				t.Fatal(err)
			}
			if u.Scheme != "file" || u.Host != "" || u.Path != "/"+path || u.Fragment != "" || u.Opaque != "" {
				t.Fatalf("drive path became a URI authority or lost exact bytes: %+v", u)
			}
			if q := u.Query(); q.Get("mode") != "ro" || q.Get("_pragma") != "busy_timeout(5000)" || (q.Get("immutable") == "1") != immutable {
				t.Fatal("read-only options changed", q)
			}
		}
	}
}

func TestSecurityReadOnlyDatabaseReadsExactFileAndRejectsWrites(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Lake 数据 # % &")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "sessions.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec("CREATE TABLE exact_source(value TEXT); INSERT INTO exact_source VALUES('original ledger')")
	closeErr := db.Close()
	if err != nil || closeErr != nil {
		t.Fatal(err, closeErr)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, immutable := range []bool{false, true} {
		ro, err := openSecurityReadOnlyMode(path, immutable)
		if err != nil {
			t.Fatal(err)
		}
		var actual string
		readErr := ro.QueryRow("SELECT value FROM exact_source").Scan(&actual)
		_, writeErr := ro.Exec("INSERT INTO exact_source VALUES('must not write')")
		closeErr := ro.Close()
		if readErr != nil || actual != "original ledger" || writeErr == nil || closeErr != nil {
			t.Fatal("exact read or write rejection failed", actual, readErr, writeErr, closeErr)
		}
		after, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(before, after) {
			t.Fatal("read-only inspection changed the original database", err)
		}
	}
	missing := filepath.Join(dir, "missing.sqlite")
	if ro, err := openSecurityReadOnly(missing); err == nil {
		ro.Close()
		t.Fatal("read-only open accepted a missing source")
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("read-only open created a missing database", err)
	}
}
