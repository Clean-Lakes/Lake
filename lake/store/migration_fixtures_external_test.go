package store_test

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
	"github.com/cloudwego/eino/lake/workflow"
	_ "modernc.org/sqlite"
)

type fixtureSSH struct{ calls int }

func (f *fixtureSSH) RunRead(_ context.Context, resource, check string) (sshtransport.Result, error) {
	if resource != "样本主机" || check != "uptime" {
		return sshtransport.Result{}, fmt.Errorf("unexpected fixture request %q %q", resource, check)
	}
	f.calls++
	return sshtransport.Result{Stdout: "fixture uptime", ExitCode: 0}, nil
}
func (f *fixtureSSH) RunCommand(context.Context, string, string) (sshtransport.Result, error) {
	return sshtransport.Result{}, fmt.Errorf("legacy read-only workflow attempted a command")
}

func copyFixture(t *testing.T, version int) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "testdata", "migrations", fmt.Sprintf("v%02d.db", version)))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "lake.db"), data, 0600); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestMigrationFixturesV1ThroughV16(t *testing.T) {
	ctx := context.Background()
	for version := 1; version <= 16; version++ {
		t.Run(fmt.Sprintf("v%02d", version), func(t *testing.T) {
			root := copyFixture(t, version)
			s, err := store.Open(ctx, root)
			if err != nil {
				t.Fatal(err)
			}
			lake, err := s.GetLakeByName(ctx, "样本湖")
			if err != nil || lake.ID != "fixture-lake" {
				t.Fatalf("lake=%+v err=%v", lake, err)
			}
			host, err := s.GetResource(ctx, "fixture-host")
			if err != nil || host.ExecuteAuthz || host.SSH.Host != "example.invalid" {
				t.Fatalf("host=%+v err=%v", host, err)
			}
			policy, err := s.GetPermissionPolicy(ctx)
			if err != nil || policy.SilentSSHCommand || (version >= 2 && policy.SilentSSHRead) {
				t.Fatalf("policy=%+v err=%v", policy, err)
			}
			if version >= 3 {
				turns, err := s.ListConversationTurns(ctx, "fixture-conversation")
				if err != nil || len(turns) != 1 || turns[0].Prompt != "检查样本" || turns[0].Answer != "已检查" {
					t.Fatalf("turns=%+v err=%v", turns, err)
				}
				if version >= 7 && (len(turns[0].Specialists) != 1 || turns[0].Specialists[0].ID != "legacy-specialist") {
					t.Fatalf("legacy specialist lost: %+v", turns[0].Specialists)
				}
				events, err := s.ListAgentEvents(ctx, "fixture-conversation", 0, 100)
				if err != nil || len(events) != 2 || events[0].LegacyTurnID != "fixture-turn" || events[1].LegacyTurnID != "fixture-turn" {
					t.Fatalf("legacy events=%+v err=%v", events, err)
				}
			}
			if version >= 5 {
				definition, err := s.GetWorkflow(ctx, "fixture-workflow")
				if err != nil || definition.Name != "旧巡检" {
					t.Fatalf("workflow=%+v err=%v", definition, err)
				}
				ssh := &fixtureSSH{}
				run, err := workflow.Start(ctx, s, definition, "cli", ssh, nil)
				if err != nil || run.Status != "completed" || ssh.calls != 1 {
					t.Fatalf("legacy run=%+v calls=%d err=%v", run, ssh.calls, err)
				}
			}
			if err := s.Close(); err != nil {
				t.Fatal(err)
			}
			checkFixtureDatabase(t, filepath.Join(root, "lake.db"), 19, version >= 5)
			backups, err := filepath.Glob(filepath.Join(root, "lake.db.pre-*.bak"))
			if err != nil || (version <= 16 && len(backups) == 0) {
				t.Fatalf("backups=%v err=%v", backups, err)
			}
			for _, backup := range backups {
				info, err := os.Stat(backup)
				if err != nil || info.Mode().Perm() != 0600 {
					t.Fatalf("backup %s mode=%v err=%v", backup, info.Mode(), err)
				}
			}
			before := len(backups)
			s, err = store.Open(ctx, root)
			if err != nil {
				t.Fatal(err)
			}
			s.Close()
			backups, err = filepath.Glob(filepath.Join(root, "lake.db.pre-*.bak"))
			if err != nil || len(backups) != before {
				t.Fatalf("reopen backups=%v err=%v", backups, err)
			}
			checkFixtureDatabase(t, filepath.Join(root, "lake.db"), 19, version >= 5)
		})
	}
}

func checkFixtureDatabase(t *testing.T, path string, version int, hasWorkflow bool) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var got int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&got); err != nil || got != version {
		t.Fatalf("user_version=%d err=%v", got, err)
	}
	for _, query := range []string{
		`SELECT count(*) FROM resource WHERE id='fixture-host' AND execute_authz=0`,
		`SELECT count(*) FROM attach WHERE id='fixture-attach' AND ref='file:ssh/fixture-only'`,
		`SELECT count(*) FROM code_workspace WHERE authorized=1`,
	} {
		if err := db.QueryRow(query).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if (query == `SELECT count(*) FROM code_workspace WHERE authorized=1` && got != 0) || (query != `SELECT count(*) FROM code_workspace WHERE authorized=1` && got != 1) {
			t.Fatalf("query %q returned %d", query, got)
		}
	}
	if hasWorkflow {
		if err := db.QueryRow(`SELECT count(*) FROM ops_workflow WHERE id='fixture-workflow'`).Scan(&got); err != nil || got != 1 {
			t.Fatalf("legacy workflow count=%d err=%v", got, err)
		}
	}
	rows, err := db.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("foreign key check failed")
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
}

func TestFailedUpgradeKeepsRestorableV15Snapshot(t *testing.T) {
	ctx := context.Background()
	root := copyFixture(t, 15)
	path := filepath.Join(root, "lake.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE code_workspace(blocker INTEGER)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if _, err := store.Open(ctx, root); err == nil {
		t.Fatal("expected v16 migration failure")
	}
	backups, err := filepath.Glob(filepath.Join(root, "lake.db.pre-v16-*.bak"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("backups=%v err=%v", backups, err)
	}
	for _, candidate := range []string{path, backups[0]} {
		db, err := sql.Open("sqlite", candidate)
		if err != nil {
			t.Fatal(err)
		}
		var version, lakeCount int
		if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(`SELECT count(*) FROM lake WHERE id='fixture-lake'`).Scan(&lakeCount); err != nil {
			t.Fatal(err)
		}
		db.Close()
		if version != 15 || lakeCount != 1 {
			t.Fatalf("failed upgrade changed %s: version=%d lake=%d", candidate, version, lakeCount)
		}
	}
	// A user can restore the private pre-upgrade snapshot without losing old data.
	restored := t.TempDir()
	data, err := os.ReadFile(backups[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(restored, "lake.db"), data, 0600); err != nil {
		t.Fatal(err)
	}
	db, err = sql.Open("sqlite", filepath.Join(restored, "lake.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DROP TABLE code_workspace`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := store.Open(ctx, restored)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	checkFixtureDatabase(t, filepath.Join(restored, "lake.db"), 19, true)
}
