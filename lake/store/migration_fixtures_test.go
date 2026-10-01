package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// Regenerate with LAKE_UPDATE_MIGRATION_FIXTURES=1 go test ./lake/store -run TestGenerateMigrationFixtures.
// Every value below is synthetic. No key material or real endpoint is stored.
func TestGenerateMigrationFixtures(t *testing.T) {
	if os.Getenv("LAKE_UPDATE_MIGRATION_FIXTURES") != "1" {
		t.Skip("fixture regeneration is explicit")
	}
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "source.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	fixtureDir := filepath.Join("..", "testdata", "migrations")
	if err := os.MkdirAll(fixtureDir, 0755); err != nil {
		t.Fatal(err)
	}
	migrations := []string{"", migrationV1, migrationV2, migrationV3, migrationV4, migrationV5, migrationV6, migrationV7, migrationV8, migrationV9, migrationV10, migrationV11, migrationV12, migrationV13, migrationV14, migrationV15, migrationV16}
	for version := 1; version < len(migrations); version++ {
		if _, err := db.ExecContext(ctx, migrations[version]); err != nil {
			t.Fatalf("v%d: %v", version, err)
		}
		switch version {
		case 1:
			fixtureExec(t, db, `INSERT INTO lake(id,name,created_at,updated_at) VALUES('fixture-lake','样本湖',1,1)`)
			fixtureExec(t, db, `UPDATE current_lake SET lake_id='fixture-lake' WHERE singleton=1`)
			fixtureExec(t, db, `INSERT INTO resource(id,lake_id,kind,name,spec,execute_authz,created_at,updated_at) VALUES('fixture-host','fixture-lake','host','样本主机','{"ssh":{"host":"example.invalid","port":22,"username":"fixture"}}',0,1,1)`)
			fixtureExec(t, db, `INSERT INTO attach(id,resource_id,kind,ref,created_at) VALUES('fixture-attach','fixture-host','credential','file:ssh/fixture-only',1)`)
		case 2:
			fixtureExec(t, db, `UPDATE permission_policy SET silent_ssh_read=0,silent_ssh_command=0 WHERE singleton=1`)
		case 3:
			fixtureExec(t, db, `INSERT INTO conversation(id,lake_id,title,created_at,updated_at) VALUES('fixture-conversation','fixture-lake','旧会话',2,2)`)
			fixtureExec(t, db, `INSERT INTO conversation_turn(id,conversation_id,prompt,answer,display,created_at) VALUES('fixture-turn','fixture-conversation','检查样本','已检查','已检查',3)`)
		case 5:
			fixtureExec(t, db, `INSERT INTO ops_workflow(id,lake_id,name,spec,created_at,updated_at) VALUES('fixture-workflow','fixture-lake','旧巡检','{"name":"旧巡检","target_mode":"fixed","steps":[{"id":"check","name":"只读检查","kind":"ssh_check","resource":"样本主机","check":"uptime"}]}',4,4)`)
		case 7:
			fixtureExec(t, db, `UPDATE conversation_turn SET specialists='[{"id":"legacy-specialist","kind":"ssh","task":"检查样本","stage":"completed"}]' WHERE id='fixture-turn'`)
		case 8:
			fixtureExec(t, db, migrationV8Backfill)
		case 16:
			fixtureExec(t, db, `INSERT INTO code_workspace(id,lake_id,resource_id,name,remote_root,authorized,created_at,updated_at) VALUES('fixture-workspace','fixture-lake','fixture-host','样本代码','/srv/fixture',0,5,5)`)
		}
		fixtureExec(t, db, fmt.Sprintf("PRAGMA user_version = %d", version))
		rows, err := db.QueryContext(ctx, "PRAGMA foreign_key_check")
		if err != nil {
			t.Fatal(err)
		}
		if rows.Next() {
			rows.Close()
			t.Fatalf("v%d has invalid foreign keys", version)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		output := filepath.Join(fixtureDir, fmt.Sprintf("v%02d.db", version))
		if err := os.Remove(output); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, "VACUUM INTO ?", output); err != nil {
			t.Fatal(err)
		}
	}
}

func fixtureExec(t *testing.T, db *sql.DB, query string) {
	t.Helper()
	if _, err := db.Exec(query); err != nil {
		t.Fatal(err)
	}
}
