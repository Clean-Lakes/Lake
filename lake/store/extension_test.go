package store

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestV12ExtensionMigrationPreservesV11Data(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, "lake.db"))
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range []string{migrationV1, migrationV2, migrationV3, migrationV4, migrationV5, migrationV6, migrationV7, migrationV8, migrationV9, migrationV10, migrationV11} {
		if _, err := db.ExecContext(ctx, migration); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO lake(id,name,created_at,updated_at) VALUES('old','旧湖',1,1); PRAGMA user_version=11`); err != nil {
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
		t.Fatalf("v11 lake lost: %v", err)
	}
	var version int
	if err := s.db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil || version != schemaVersion {
		t.Fatalf("schema version=%d err=%v", version, err)
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO extension_config(kind,name,version,source,sha256,install_path,manifest_json,enabled,created_at,updated_at) VALUES('plugin','demo','1.0.0','local','abc','/tmp/demo','{}',0,1,1)`); err != nil {
		t.Fatal(err)
	}
	backups, err := filepath.Glob(filepath.Join(root, "lake.db.pre-v12-*.bak"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("v12 backup=%v err=%v", backups, err)
	}
	if info, err := os.Stat(backups[0]); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("v12 backup permissions: %v %v", info, err)
	}
}

func TestPluginExtensionSaveAndToggle(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	item, err := s.SavePluginExtension(ctx, PluginExtensionInput{Name: "demo", Version: "1.0.0", Source: "local:/tmp/demo", SHA256: "checksum", InstallPath: "/tmp/demo", ManifestJSON: []byte(`{"name":"demo"}`)})
	if err != nil || item.Enabled {
		t.Fatalf("saved=%+v err=%v", item, err)
	}
	item, err = s.SetPluginExtensionEnabled(ctx, "demo", true)
	if err != nil || !item.Enabled {
		t.Fatalf("enabled=%+v err=%v", item, err)
	}
	items, err := s.ListPluginExtensions(ctx)
	if err != nil || len(items) != 1 || items[0].Name != "demo" {
		t.Fatalf("listed=%+v err=%v", items, err)
	}
}
