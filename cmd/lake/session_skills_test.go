package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/extension/plugins"
	"github.com/cloudwego/eino/lake/store"
)

func TestSessionSkillLoadRestoreAndChangeInvalidation(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "skills lake", "")
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "skills", "review")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "SKILL.md")
	data := "---\nname: review\ndescription: 检查代码\n---\n先检查边界条件"
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	selected := newSessionSkills(root, "", conversation.ID, s)
	if _, err := selected.Load(ctx, "review"); err != nil {
		t.Fatal(err)
	}
	message := selected.ContextMessage()
	if message == nil || !strings.Contains(message.Content, "先检查边界条件") {
		t.Fatalf("Skill missing from context: %+v", message)
	}
	events, err := s.ListAgentEvents(ctx, conversation.ID, 0, 10)
	if err != nil || len(events) != 1 || events[0].Kind != "skill_loaded" || strings.Contains(string(events[0].Payload), "先检查边界条件") {
		t.Fatalf("Skill event retained untrusted content: %+v, %v", events, err)
	}
	restored := newSessionSkills(root, "", conversation.ID, s)
	if err := restored.Restore(ctx); err != nil || restored.ContextMessage() == nil {
		t.Fatalf("Skill did not restore: %v", err)
	}
	if err := os.WriteFile(path, []byte(data+"\n后来修改"), 0600); err != nil {
		t.Fatal(err)
	}
	changed := newSessionSkills(root, "", conversation.ID, s)
	if err := changed.Restore(ctx); err != nil || changed.ContextMessage() != nil {
		t.Fatalf("changed Skill silently reloaded: %v", err)
	}
}

func TestSessionLoadsEnabledPluginSkillExplicitly(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	source := t.TempDir()
	dir := filepath.Join(source, "skills", "review")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "lake-plugin.json"), []byte(`{"name":"demo","version":"1.0.0","skills":["skills/review/SKILL.md"]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: review\ndescription: 审查\n---\n插件检查建议"), 0600); err != nil {
		t.Fatal(err)
	}
	bundle, err := plugins.Inspect(source)
	if err != nil {
		t.Fatal(err)
	}
	manager := plugins.NewManager(root, s)
	if _, err := manager.Install(ctx, source, bundle.Digest); err != nil {
		t.Fatal(err)
	}
	selected := newSessionSkills(root, "", "", s)
	if _, err := selected.Load(ctx, "demo/review"); err == nil {
		t.Fatal("disabled plugin Skill loaded")
	}
	if _, err := manager.SetEnabled(ctx, "demo", true); err != nil {
		t.Fatal(err)
	}
	skill, err := selected.Load(ctx, "demo/review")
	if err != nil || skill.Scope != "plugin:demo" || !strings.Contains(selected.ContextMessage().Content, "插件检查建议") {
		t.Fatalf("plugin Skill=%+v err=%v", skill, err)
	}
}
