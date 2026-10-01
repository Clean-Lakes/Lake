package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSkillCLIListsMetadataAndShowsSelectedBody(t *testing.T) {
	root := t.TempDir()
	project := t.TempDir()
	for dir, body := range map[string]string{
		filepath.Join(root, "skills", "review"):             "用户建议",
		filepath.Join(project, ".lake", "skills", "review"): "项目建议",
	} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		data := "---\nname: review\ndescription: 审查\n---\n" + body
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	var out bytes.Buffer
	if err := skillCommand(context.Background(), []string{"list", "-C", project}, root, &out, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "project") || strings.Contains(out.String(), "项目建议") {
		t.Fatalf("list should contain metadata only: %s", out.String())
	}
	out.Reset()
	if err := skillCommand(context.Background(), []string{"show", "review", "-C", project}, root, &out, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "项目建议") || strings.Contains(out.String(), "用户建议") {
		t.Fatalf("project Skill did not shadow user Skill: %s", out.String())
	}
}
