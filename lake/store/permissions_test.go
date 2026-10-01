package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"sync"
	"testing"
)

func TestPermissionPolicyMigratesV1AndPersists(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, "lake.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, migrationV1); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "PRAGMA user_version = 1"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	s, err := Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := s.GetPermissionPolicy(ctx)
	if err != nil || !policy.SilentSSHRead || policy.SilentSSHCommand {
		t.Fatalf("migrated defaults = %+v, %v", policy, err)
	}
	if _, err := s.SetPermissionPolicy(ctx, "ssh-command", true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetPermissionPolicy(ctx, "ssh-read", false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetPermissionPolicy(ctx, "unknown", true); err == nil {
		t.Fatal("accepted unknown permission")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	policy, err = s.GetPermissionPolicy(ctx)
	if err != nil || policy.SilentSSHRead || !policy.SilentSSHCommand {
		t.Fatalf("persisted policy = %+v, %v", policy, err)
	}
}

func TestConcurrentOpenMigratesPermissionPolicy(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	var group sync.WaitGroup
	errors := make(chan error, 8)
	for i := 0; i < 8; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			s, err := Open(ctx, root)
			if err != nil {
				errors <- err
				return
			}
			_, err = s.GetPermissionPolicy(ctx)
			if closeErr := s.Close(); err == nil {
				err = closeErr
			}
			if err != nil {
				errors <- err
			}
		}()
	}
	group.Wait()
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}
}
