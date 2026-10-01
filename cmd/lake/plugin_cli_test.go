package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/extension/plugins"
	"github.com/cloudwego/eino/lake/store"
)

func TestPluginCLILifecycle(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "lake-plugin.json"), []byte(`{"name":"demo","version":"1.0.0","description":"演示","skills":["skills/review/SKILL.md"]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(source, "skills", "review"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "skills", "review", "SKILL.md"), []byte("---\nname: review\ndescription: 审查\n---\n插件正文"), 0600); err != nil {
		t.Fatal(err)
	}
	bundle, err := plugins.Inspect(source)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := pluginCommand(ctx, s, []string{"install", source, "--sha256", bundle.Digest}, &out, &out); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := pluginCommand(ctx, s, []string{"list"}, &out, &out); err != nil || !strings.Contains(out.String(), "demo") || !strings.Contains(out.String(), "disabled") {
		t.Fatalf("list=%s err=%v", out.String(), err)
	}
	out.Reset()
	if err := pluginCommand(ctx, s, []string{"enable", "demo"}, &out, &out); err != nil {
		t.Fatal(err)
	}
	item, err := s.GetPluginExtension(ctx, "demo")
	if err != nil || !item.Enabled {
		t.Fatalf("plugin enabled=%+v err=%v", item, err)
	}
	out.Reset()
	if err := skillCommand(ctx, []string{"list"}, root, &out, &out); err != nil || !strings.Contains(out.String(), "plugin:demo") {
		t.Fatalf("enabled plugin Skill list=%s err=%v", out.String(), err)
	}
	out.Reset()
	if err := skillCommand(ctx, []string{"show", "demo/review"}, root, &out, &out); err != nil || !strings.Contains(out.String(), "插件正文") {
		t.Fatalf("enabled plugin Skill show=%s err=%v", out.String(), err)
	}
	if err := pluginCommand(ctx, s, []string{"disable", "demo"}, &out, &out); err != nil {
		t.Fatal(err)
	}
	item, err = s.GetPluginExtension(ctx, "demo")
	if err != nil || item.Enabled {
		t.Fatalf("plugin disabled=%+v err=%v", item, err)
	}
}
