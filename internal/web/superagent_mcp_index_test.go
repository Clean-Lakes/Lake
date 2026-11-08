package web

import (
	"slices"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestProjectMCPInheritanceBeforeFirstWorker(t *testing.T) {
	b, h := fixture(t)
	project := stringOf(b.Store.CreateProject("Release")["id"])
	other := stringOf(b.Store.CreateProject("Other")["id"])
	path := "/api/projects/" + project + "/security/mcp-inheritance"
	apiTest(t, h, "PUT", path, Object{"actionId": "invalid", "enabled": true}, 400)
	apiTest(t, h, "PUT", path, Object{"actionId": "invalid", "expectedRevision": 0}, 400)
	enable := Object{"actionId": "enable", "enabled": true, "expectedRevision": 0}
	apiTest(t, h, "PUT", path, enable, 200)
	apiTest(t, h, "PUT", path, enable, 200)
	httpServer := apiTest(t, h, "POST", "/api/settings/mcp", Object{"name": "Release API", "transport": "http", "url": "http://127.0.0.1:18765/mcp", "enabled": true}, 200)
	stdio := apiTest(t, h, "POST", "/api/settings/mcp", Object{"name": "Local tool", "transport": "stdio", "command": "echo", "enabled": true}, 200)
	expected := []ai.ProjectMCPServer{{ID: stringOf(httpServer["id"]), Name: "Release API"}, {ID: stringOf(stdio["id"]), Name: "Local tool"}}
	got := b.projectMCPIndex(b.Context, project, &ai.Permissions{})
	if len(got) != 2 || !slices.Contains(got, expected[0]) || !slices.Contains(got, expected[1]) {
		t.Fatalf("public index %v, expected %v", got, expected)
	}
	if got := b.projectMCPIndex(b.Context, project, &ai.Permissions{DenyLocalExecution: true}); !slices.Equal(got, expected[:1]) {
		t.Fatalf("local execution denied, got %v", got)
	}
	if got := b.projectMCPIndex(b.Context, project, &ai.Permissions{BlockUnreferencedAssets: true}); len(got) != 0 {
		t.Fatalf("blocked session exposed index %v", got)
	}
	unchanged := apiTest(t, h, "GET", "/api/projects/"+other+"/security/mcp-inheritance", nil, 200)
	if unchanged["Enabled"] != false || integer(unchanged["Revision"]) != 0 || len(unchanged["servers"].([]any)) != 0 {
		t.Fatal("unselected project changed", unchanged)
	}
	apiTest(t, h, "PUT", path, Object{"actionId": "stale", "enabled": false, "expectedRevision": 0}, 409)
	apiTest(t, h, "PUT", path, Object{"actionId": "disable", "enabled": false, "expectedRevision": 1}, 200)
	disabled := apiTest(t, h, "GET", path, nil, 200)
	if disabled["Enabled"] != false || integer(disabled["Revision"]) != 2 || len(disabled["servers"].([]any)) != 0 {
		t.Fatal("disabled project retained inheritance", disabled)
	}
}
