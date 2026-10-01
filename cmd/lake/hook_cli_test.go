package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/store"
)

func TestHookCLIExplicitEnableAndChangedStatus(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, ".lake"), 0700); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(project, ".lake", "hooks.json")
	config := `{"version":1,"hooks":[{"event":"SessionStart","command":"hook.sh"}]}`
	if err := os.WriteFile(configPath, []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "hook.sh"), []byte("#!/bin/sh\necho ok\n"), 0700); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := hookCommand(ctx, s, []string{"status", "-C", project}, &out, &out); err != nil || !strings.Contains(out.String(), "disabled") {
		t.Fatalf("default status=%s err=%v", out.String(), err)
	}
	out.Reset()
	if err := hookCommand(ctx, s, []string{"enable", "-C", project}, &out, &out); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := hookCommand(ctx, s, []string{"status", "-C", project}, &out, &out); err != nil || !strings.Contains(out.String(), "enabled") {
		t.Fatalf("enabled status=%s err=%v", out.String(), err)
	}
	if err := os.WriteFile(filepath.Join(project, "hook.sh"), []byte("#!/bin/sh\necho changed\n"), 0700); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := hookCommand(ctx, s, []string{"status", "-C", project}, &out, &out); err != nil || !strings.Contains(out.String(), "changed") {
		t.Fatalf("changed status=%s err=%v", out.String(), err)
	}
}
