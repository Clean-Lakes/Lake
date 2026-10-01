package store

import (
	"context"
	"strings"
	"testing"
)

func TestWorkspaceHookDigestChangeRevokesEnabledState(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	path := t.TempDir()
	firstDigest, secondDigest := strings.Repeat("a", 64), strings.Repeat("b", 64)
	first, err := s.SaveWorkspaceHook(ctx, path, firstDigest)
	if err != nil || first.Enabled {
		t.Fatalf("new hook=%+v err=%v", first, err)
	}
	first, err = s.SetWorkspaceHookEnabled(ctx, path, firstDigest, true)
	if err != nil || !first.Enabled {
		t.Fatalf("enabled hook=%+v err=%v", first, err)
	}
	again, err := s.SaveWorkspaceHook(ctx, path, firstDigest)
	if err != nil || !again.Enabled {
		t.Fatalf("unchanged hook lost permission: %+v err=%v", again, err)
	}
	changed, err := s.SaveWorkspaceHook(ctx, path, secondDigest)
	if err != nil || changed.Enabled {
		t.Fatalf("changed hook retained permission: %+v err=%v", changed, err)
	}
	if _, err := s.SetWorkspaceHookEnabled(ctx, path, firstDigest, true); err == nil {
		t.Fatal("stale hook digest enabled")
	}
}
