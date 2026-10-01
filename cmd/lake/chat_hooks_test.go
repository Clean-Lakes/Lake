package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	lakehooks "github.com/cloudwego/eino/lake/extension/hooks"
	"github.com/cloudwego/eino/lake/store"
)

func TestChatHookApprovalHappensAfterReady(t *testing.T) {
	ctx := context.Background()
	root, project := t.TempDir(), t.TempDir()
	project, err := filepath.EvalSymlinks(project)
	if err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(project, ".lake"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, ".lake", "hooks.json"), []byte(`{"version":1,"hooks":[{"event":"SessionStart","command":"hook.sh","args":["start"]},{"event":"UserPromptSubmit","command":"hook.sh","args":["prompt"]},{"event":"Stop","command":"hook.sh","args":["stop"]}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "hook.sh"), []byte("#!/bin/sh\necho \"$1\" >> ran\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "skills", "review"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "skills", "review", "SKILL.md"), []byte("---\nname: review\ndescription: 审查\n---\n建议"), 0600); err != nil {
		t.Fatal(err)
	}
	runner, err := lakehooks.Load(project)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveWorkspaceHook(ctx, project, runner.Digest); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetWorkspaceHookEnabled(ctx, project, runner.Digest, true); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: "https://example.com/anthropic", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	ready, approved := false, false
	var out bytes.Buffer
	hooks := &chatHooks{ProjectPath: project, OnReady: func(string) { ready = true }, Approve: func(kind, _, _ string) (bool, error) {
		if !ready || kind != "hook" {
			t.Errorf("Hook approval before ready or wrong kind: ready=%t kind=%s", ready, kind)
		}
		approved = true
		return true, nil
	}}
	if err := runChatWithHooks(ctx, nil, root, strings.NewReader("/skill load review\n/exit\n"), &out, &bytes.Buffer{}, hooks); err != nil {
		t.Fatal(err)
	}
	if !ready || !approved {
		t.Fatalf("Hook lifecycle missing: ready=%t approved=%t", ready, approved)
	}
	events, err := os.ReadFile(filepath.Join(project, "ran"))
	if err != nil {
		t.Fatal(err)
	}
	if string(events) != "start\nprompt\nstop\n" {
		t.Fatalf("Hook lifecycle events=%q", events)
	}
}
