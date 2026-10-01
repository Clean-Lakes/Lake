package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestV9AllowsK8sAndPreservesHostRelations(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, "lake.db"))
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range []string{migrationV1, migrationV2, migrationV3, migrationV4, migrationV5, migrationV6, migrationV7, migrationV8} {
		if _, err := db.ExecContext(ctx, migration); err != nil {
			t.Fatal(err)
		}
	}
	for _, statement := range []string{
		`INSERT INTO lake(id,name,created_at,updated_at) VALUES('lake','测试湖',1,1)`,
		`INSERT INTO resource(id,lake_id,kind,name,spec,created_at,updated_at) VALUES('host-a','lake','host','a','{"ssh":{"host":"a.example","port":22,"username":"root"}}',1,1)`,
		`INSERT INTO resource(id,lake_id,kind,name,spec,created_at,updated_at) VALUES('host-b','lake','host','b','{"ssh":{"host":"b.example","port":22,"username":"root"}}',1,1)`,
		`INSERT INTO attach(id,resource_id,kind,ref,created_at) VALUES('attachment','host-a','credential','file:ssh/test',1)`,
		`INSERT INTO link(from_id,to_id,type,created_at) VALUES('host-a','host-b','depends_on',1)`,
		`INSERT INTO script(id,name,language,path,sha256,resource_id,created_at,updated_at) VALUES('script','check','sh','check.sh','hash','host-a',1,1)`,
		`PRAGMA user_version=8`,
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
	host, err := s.GetResource(ctx, "host-a")
	if err != nil || host.Kind != "host" || host.SSH.Host != "a.example" {
		t.Fatalf("host changed: %+v %v", host, err)
	}
	for table := range map[string]bool{"attach": true, "link": true, "script": true} {
		var count int
		if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM "+table).Scan(&count); err != nil || count != 1 {
			t.Fatalf("%s rows=%d err=%v", table, count, err)
		}
	}
	var failures int
	rows, err := s.db.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		failures++
	}
	rows.Close()
	if failures != 0 {
		t.Fatalf("foreign key failures: %d", failures)
	}
	var foreignKeys int
	if err := s.db.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&foreignKeys); err != nil || foreignKeys != 1 {
		t.Fatalf("foreign keys left disabled: %d %v", foreignKeys, err)
	}
	resource, err := s.CreateK8s(ctx, ResourceInput{LakeID: "lake", Name: "cluster", K8s: K8sSpec{Context: "demo", Namespace: "default"}})
	if err != nil || resource.Kind != "k8s" {
		t.Fatalf("K8s insert: %+v %v", resource, err)
	}
}
