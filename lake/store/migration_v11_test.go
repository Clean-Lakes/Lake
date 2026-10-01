package store

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestV11DatabaseKindsPreserveExistingResources(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, "lake.db"))
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range []string{migrationV1, migrationV2, migrationV3, migrationV4, migrationV5, migrationV6, migrationV7, migrationV8, migrationV9, migrationV10} {
		if _, err := db.ExecContext(ctx, migration); err != nil {
			t.Fatal(err)
		}
	}
	for _, statement := range []string{
		`INSERT INTO lake(id,name,created_at,updated_at) VALUES('lake','测试湖',1,1)`,
		`INSERT INTO resource(id,lake_id,kind,name,spec,created_at,updated_at) VALUES('host','lake','host','web','{"ssh":{"host":"web.example","port":22,"username":"root"}}',1,1)`,
		`INSERT INTO resource(id,lake_id,kind,name,spec,created_at,updated_at) VALUES('cluster','lake','k8s','cluster','{"k8s":{"context":"demo","namespace":"default"}}',1,1)`,
		`INSERT INTO attach(id,resource_id,kind,ref,created_at) VALUES('attachment','host','credential','file:ssh/demo',1)`,
		`INSERT INTO link(from_id,to_id,type,created_at) VALUES('host','cluster','depends_on',1)`,
		`PRAGMA user_version=10`,
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
	defer s.Close()
	for id, kind := range map[string]string{"host": "host", "cluster": "k8s"} {
		resource, err := s.GetResource(ctx, id)
		if err != nil || resource.Kind != kind {
			t.Fatalf("%s changed: %+v %v", id, resource, err)
		}
	}
	for table := range map[string]bool{"attach": true, "link": true} {
		var count int
		if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM "+table).Scan(&count); err != nil || count != 1 {
			t.Fatalf("%s rows=%d err=%v", table, count, err)
		}
	}
	for kind, port := range map[string]int{"mysql": 3306, "postgres": 5432, "starrocks": 9030} {
		resource, err := s.CreateDatabase(ctx, kind, ResourceInput{LakeID: "lake", Name: kind, DB: DatabaseSpec{Host: "db.example", Username: "reader"}})
		if err != nil || resource.Kind != kind || resource.DB.Port != port {
			t.Fatalf("%s: %+v %v", kind, resource, err)
		}
	}
	var enabled int
	if err := s.db.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&enabled); err != nil || enabled != 1 {
		t.Fatalf("foreign keys disabled: %d %v", enabled, err)
	}
	rows, err := s.db.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	if rows.Next() {
		rows.Close()
		t.Fatal("foreign key check failed")
	}
	rows.Close()
	backups, err := filepath.Glob(filepath.Join(root, "lake.db.pre-v11-*.bak"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("v11 backup: %v %v", backups, err)
	}
	info, err := os.Stat(backups[0])
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("backup permissions: %v %v", info, err)
	}
}
