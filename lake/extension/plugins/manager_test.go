package plugins

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/store"
)

func pluginSource(t *testing.T, manifest string) string {
	t.Helper()
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "lake-plugin.json"), []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(source, "skills", "review"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "skills", "review", "SKILL.md"), []byte("---\nname: review\ndescription: 审查\n---\n检查输入"), 0600); err != nil {
		t.Fatal(err)
	}
	return source
}

func TestPluginInstallVerifiesChecksumPermissionsAndState(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	source := pluginSource(t, `{"name":"demo","version":"1.2.3","description":"演示","skills":["skills/review/SKILL.md"]}`)
	bundle, err := Inspect(source)
	if err != nil || len(bundle.Digest) != 64 {
		t.Fatalf("inspect=%+v err=%v", bundle, err)
	}
	manager := NewManager(root, s)
	if _, err := manager.Install(ctx, source, strings.Repeat("0", 64)); err == nil {
		t.Fatal("incorrect checksum accepted")
	}
	item, err := manager.Install(ctx, source, bundle.Digest)
	if err != nil || item.Enabled || item.Version != "1.2.3" {
		t.Fatalf("installed=%+v err=%v", item, err)
	}
	info, err := os.Stat(item.InstallPath)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("install directory permissions: %v %v", info, err)
	}
	fileInfo, err := os.Stat(filepath.Join(item.InstallPath, "skills", "review", "SKILL.md"))
	if err != nil || fileInfo.Mode().Perm() != 0600 {
		t.Fatalf("installed file permissions: %v %v", fileInfo, err)
	}
	if err := os.Chmod(item.InstallPath, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SetEnabled(ctx, "demo", true); err == nil {
		t.Fatal("public plugin directory was enabled")
	}
	if err := os.Chmod(item.InstallPath, 0700); err != nil {
		t.Fatal(err)
	}
	item, err = manager.SetEnabled(ctx, "demo", true)
	if err != nil || !item.Enabled {
		t.Fatalf("enable=%+v err=%v", item, err)
	}
	loaded, err := manager.EnabledSkills(ctx)
	if err != nil || len(loaded) != 1 || loaded[0].Scope != "plugin:demo" || loaded[0].Body != "检查输入" {
		t.Fatalf("enabled plugin Skills=%+v err=%v", loaded, err)
	}
	if _, err := manager.LoadSkill(ctx, "demo/review"); err != nil {
		t.Fatalf("qualified plugin Skill unavailable: %v", err)
	}
	if err := os.WriteFile(filepath.Join(item.InstallPath, "skills", "review", "SKILL.md"), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SetEnabled(ctx, "demo", true); err == nil {
		t.Fatal("modified plugin was enabled")
	}
	if _, err := manager.EnabledSkills(ctx); err == nil {
		t.Fatal("modified enabled plugin was discovered")
	}
}

func TestPluginManifestRejectsResourcesSecretsAndSymlinks(t *testing.T) {
	for _, manifest := range []string{
		`{"name":"bad","version":"1.0.0","resources":["host"]}`,
		`{"name":"bad","version":"1.0.0","skills":["../secrets/key"]}`,
		`{"name":"bad","version":"1.0.0","mcp":["mcp/config.json"],"api_key":"secret"}`,
	} {
		if _, err := Inspect(pluginSource(t, manifest)); err == nil {
			t.Fatalf("unsafe manifest accepted: %s", manifest)
		}
	}
	source := pluginSource(t, `{"name":"demo","version":"1.0.0","skills":["skills/review/SKILL.md"]}`)
	if err := os.Symlink(filepath.Join(t.TempDir(), "secret"), filepath.Join(source, "leak")); err != nil {
		t.Fatal(err)
	}
	if _, err := Inspect(source); err == nil {
		t.Fatal("symlinked plugin content accepted")
	}
}
