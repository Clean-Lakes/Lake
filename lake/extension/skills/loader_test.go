package skills

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeSkill(t *testing.T, dir, name, description, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
	data := "---\nname: " + name + "\ndescription: " + description + "\n---\n" + body
	if err := os.WriteFile(filepath.Join(path, "SKILL.md"), []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDiscoverAndLoadProjectOverridesUserSkill(t *testing.T) {
	userRoot, projectRoot := t.TempDir(), t.TempDir()
	writeSkill(t, filepath.Join(userRoot, "skills"), "review", "用户审查", "用户版流程")
	writeSkill(t, filepath.Join(projectRoot, ".lake", "skills"), "review", "项目审查", "项目版流程")
	writeSkill(t, filepath.Join(userRoot, "skills"), "notes", "笔记", "记录摘要")
	list, err := Discover(userRoot, projectRoot)
	if err != nil || len(list) != 3 {
		t.Fatalf("skills=%+v err=%v", list, err)
	}
	skill, err := Load(userRoot, projectRoot, "review")
	if err != nil || skill.Scope != "project" || skill.Description != "项目审查" || skill.Body != "项目版流程" || len(skill.SHA256) != 64 {
		t.Fatalf("loaded=%+v err=%v", skill, err)
	}
}

func TestLoaderRejectsEscapeMalformedAndOversizedFiles(t *testing.T) {
	root := t.TempDir()
	skillsDir := filepath.Join(root, "skills")
	if err := os.MkdirAll(skillsDir, 0700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "SKILL.md")
	if err := os.WriteFile(outside, []byte("---\nname: escape\ndescription: escape\n---\nsecret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(outside), filepath.Join(skillsDir, "escape")); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(root, "", "escape"); err == nil {
		t.Fatal("skill directory symlink escaped root")
	}
	writeSkill(t, skillsDir, "broken", "说明", "")
	if _, err := Load(root, "", "broken"); err == nil {
		t.Fatal("empty skill body accepted")
	}
	writeSkill(t, skillsDir, "huge", "说明", strings.Repeat("x", 32*1024))
	if _, err := Load(root, "", "huge"); err == nil {
		t.Fatal("oversized skill accepted")
	}
	if _, err := Load(root, "", "../secrets"); err == nil {
		t.Fatal("path traversal accepted")
	}
}
