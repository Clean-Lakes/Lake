package store

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestV16CodeWorkspaceMigrationBackup(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, "lake.db"))
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range []string{migrationV1, migrationV2, migrationV3, migrationV4, migrationV5, migrationV6, migrationV7, migrationV8, migrationV9, migrationV10, migrationV11, migrationV12, migrationV13, migrationV14, migrationV15} {
		if _, err := db.ExecContext(ctx, migration); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO lake(id,name,created_at,updated_at) VALUES('old','旧湖',1,1); PRAGMA user_version=15`); err != nil {
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
	var version int
	if err := s.db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil || version != schemaVersion {
		t.Fatalf("version=%d err=%v", version, err)
	}
	if _, err := s.GetLakeByName(ctx, "旧湖"); err != nil {
		t.Fatal(err)
	}
	backups, err := filepath.Glob(filepath.Join(root, "lake.db.pre-v16-*.bak"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("backups=%v err=%v", backups, err)
	}
	if info, err := os.Stat(backups[0]); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("backup mode=%v err=%v", info, err)
	}
}

func TestRemoteWorkspaceNeedsIndependentAuthorization(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "ops", "")
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateLake(ctx, "other", "")
	if err != nil {
		t.Fatal(err)
	}
	host, err := s.CreateHost(ctx, ResourceInput{LakeID: lake.ID, Name: "host", SSH: SSHSpec{Host: "example.test", Port: 22, Username: "ops"}})
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateCodeWorkspace(ctx, other.ID, host.ID, "wrong", "/srv/project"); err == nil {
		t.Fatal("cross-lake binding accepted")
	}
	for _, root := range []string{"/", "relative", "/srv/../etc", "/srv/key\nother"} {
		if _, err := s.CreateCodeWorkspace(ctx, lake.ID, host.ID, "bad", root); err == nil {
			t.Fatalf("invalid root %q accepted", root)
		}
	}
	if _, err := s.SetExecuteAuthz(ctx, host.ID, true); err != nil {
		t.Fatal(err)
	}
	workspace, err := s.CreateCodeWorkspace(ctx, lake.ID, host.ID, "repo", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	if workspace.Authorized {
		t.Fatal("host authz expanded code workspace")
	}
	if _, err := s.SetConversationCodeWorkspace(ctx, conversation.ID, workspace.ID); err == nil {
		t.Fatal("unauthorized workspace bound")
	}
	workspace, err = s.SetCodeWorkspaceAuthorized(ctx, workspace.ID, true)
	if err != nil || !workspace.Authorized {
		t.Fatalf("workspace=%+v err=%v", workspace, err)
	}
	conversation, err = s.SetConversationCodeWorkspace(ctx, conversation.ID, workspace.ID)
	if err != nil || conversation.RemoteWorkspaceID != workspace.ID || conversation.RemoteRoot != "/srv/project" || conversation.RemoteHost != "example.test" {
		t.Fatalf("conversation=%+v err=%v", conversation, err)
	}
	if _, err := s.SetCodeWorkspaceAuthorized(ctx, workspace.ID, false); err != nil {
		t.Fatal(err)
	}
	if listed, err := s.ListCodeWorkspaces(ctx, lake.ID); err != nil || len(listed) != 1 || listed[0].Authorized {
		t.Fatalf("list=%+v err=%v", listed, err)
	}
}
