package web

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProjectMemoryCommitIsolationAndRecovery(t *testing.T) {
	b, h := fixture(t)
	first := stringOf(apiTest(t, h, "POST", "/api/projects", Object{"name": "Alpha"}, 201)["id"])
	second := stringOf(apiTest(t, h, "POST", "/api/projects", Object{"name": "Beta"}, 201)["id"])
	item := "/api/projects/" + first + "/memory/release-rule"
	apiTest(t, h, "PUT", item, Object{"type": "project", "description": "发布前备份", "body": "本项目发布前需要先备份。", "expectedRevision": 0}, 200)
	apiTest(t, h, "GET", item, nil, 200)
	other := apiTest(t, h, "GET", "/api/projects/"+second+"/memory", nil, 200)
	if integer(other["total"]) != 0 {
		t.Fatalf("project memory leaked to Beta: %v", other)
	}
	apiTest(t, h, "PUT", item, Object{"type": "project", "description": "错误覆盖", "body": "stale", "expectedRevision": 0}, 409)
	apiTest(t, h, "PUT", "/api/projects/"+first+"/memory/reject-secret", Object{"type": "project", "description": "测试", "body": "password=synthetic-secret", "expectedRevision": 0}, 400)
	apiTest(t, h, "DELETE", item, Object{"expectedRevision": 1}, 200)
	apiTest(t, h, "GET", item, nil, 404)
	forgotten := apiTest(t, h, "GET", item+"?includeDeleted=true", nil, 200)
	if integer(forgotten["revision"]) != 2 || stringOf(forgotten["body"]) != "" {
		t.Fatalf("forgotten content remains: %v", forgotten)
	}
	apiTest(t, h, "PUT", item, Object{"type": "project", "description": "重新确认", "body": "发布前先备份。", "expectedRevision": 2}, 409)
	apiTest(t, h, "PUT", item, Object{"type": "project", "description": "重新确认", "body": "发布前先备份。", "expectedRevision": 2, "restoreDeleted": true}, 200)
	index := b.Store.ProjectMemoryIndex(first)
	if !strings.Contains(index, "release-rule.md") {
		t.Fatalf("missing index after restore: %q", index)
	}
	projected := filepath.Join(b.Store.Dir, "memories", "projects", first, "memory")
	if err := os.Remove(filepath.Join(projected, "MEMORY.md")); err != nil {
		t.Fatal(err)
	}
	b.Store.update(func() any {
		b.Store.exec("UPDATE projectMemorySettings SET publishedRevision=0 WHERE projectId=?", first)
		return nil
	})
	if err := b.Store.ReconcileProjectMemoryFiles(); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(projected, "MEMORY.md"))
	if err != nil || !strings.Contains(string(content), "release-rule.md") {
		t.Fatalf("projection did not recover: %v %q", err, content)
	}
}

func TestProjectMemoryProjectionRejectsSymlinkAncestor(t *testing.T) {
	b, h := fixture(t)
	project := stringOf(apiTest(t, h, "POST", "/api/projects", Object{"name": "Symlink"}, 201)["id"])
	outside := t.TempDir()
	root := filepath.Join(b.Store.Dir, "memories")
	if err := os.Symlink(outside, root); err != nil {
		t.Fatal(err)
	}
	result := apiTest(t, h, "PUT", "/api/projects/"+project+"/memory/safe-key", Object{"type": "project", "description": "测试", "body": "内容", "expectedRevision": 0}, 200)
	if result["publicationError"] == nil {
		t.Fatal("unsafe projection reported success")
	}
	if _, err := os.Stat(filepath.Join(outside, "projects")); !os.IsNotExist(err) {
		t.Fatalf("symlink target was modified: %v", err)
	}
	if stringOf(b.Store.ReadProjectMemory(project, "safe-key", false)["body"]) != "内容" {
		t.Fatal("database commit was lost on projection error")
	}
}
