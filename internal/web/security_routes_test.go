package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"net/http"
	"strings"
	"testing"
)

func TestSecurityManagementCatalogReconciliationAndOwnership(t *testing.T) {
	b, h := fixture(t)
	p := b.Store.CreateProject("Security catalog")
	pid := stringOf(p["id"])
	resource := b.Store.CreateResource(pid, "host", "ssh", Object{"host": "192.0.2.1", "port": 22, "username": "fixture", "authMethod": "password"})
	rid := stringOf(resource["id"])
	path := "/api/projects/" + pid + "/security"
	apiTest(t, h, "PUT", path+"/policy", Object{"actionId": "policy", "expectedRevision": 0, "policy": Object{"schemaVersion": 1, "mode": "restricted", "resourceIDs": []string{rid}, "rules": []Object{Object{"capability": "file.read", "effect": "deny"}}}}, 200)
	preview := apiTest(t, h, "POST", path+"/catalog/preview-reconciliation", Object{}, 200)
	if len(stringOf(preview["Digest"])) != 64 {
		t.Fatalf("missing preview digest: %v", preview)
	}
	apiTest(t, h, "POST", path+"/catalog/confirm-reconciliation", Object{"actionId": "confirm", "expectedRevision": 1, "digest": strings.Repeat("0", 64)}, 409)
	result := apiTest(t, h, "POST", path+"/catalog/confirm-reconciliation", Object{"actionId": "confirm", "expectedRevision": 1, "digest": preview["Digest"]}, 200)
	if result["Digest"] != preview["Digest"] {
		t.Fatal("reconciliation changed reviewed snapshot")
	}
	apiTest(t, h, "POST", path+"/catalog/confirm-reconciliation", Object{"actionId": "confirm", "expectedRevision": 1, "digest": preview["Digest"]}, 200)
	req, _ := http.NewRequest("GET", h.URL+path+"/catalog", nil)
	req.Host = "localhost:4177"
	resp, err := h.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("unauthenticated management status %d", resp.StatusCode)
	}
	other := b.Store.CreateProject("Other")
	outside := b.Store.CreateResource(stringOf(other["id"]), "outside", "ssh", Object{"host": "192.0.2.2", "port": 22, "username": "fixture", "authMethod": "password"})
	apiTest(t, h, "PUT", path+"/policy", Object{"actionId": "escape", "expectedRevision": 1, "policy": Object{"schemaVersion": 1, "mode": "restricted", "resourceIDs": []string{stringOf(outside["id"])}, "rules": []Object{}}}, 403)
}

func TestSecurityMCPSettingsHooksAndProjectBindingCAS(t *testing.T) {
	b, h := fixture(t)
	p := b.Store.CreateProject("MCP binding")
	pid := stringOf(p["id"])
	path := "/api/projects/" + pid + "/security"
	apiTest(t, h, "PUT", path+"/policy", Object{"actionId": "policy", "expectedRevision": 0, "policy": Object{"schemaVersion": 1, "mode": "compatible", "resourceIDs": []string{}, "rules": []Object{}}}, 200)
	server := apiTest(t, h, "POST", "/api/settings/mcp", Object{"name": "fixture", "transport": "http", "url": "http://127.0.0.1:18765/mcp", "enabled": true}, 200)
	id := stringOf(server["id"])
	bound := apiTest(t, h, "PUT", path+"/mcp-bindings/"+id, Object{"actionId": "bind", "expectedRevision": 0, "enabled": true, "toolNames": []string{}}, 200)
	if integer(bound["Revision"]) != 1 {
		t.Fatalf("binding revision: %v", bound)
	}
	apiTest(t, h, "PUT", path+"/mcp-bindings/"+id, Object{"actionId": "stale", "expectedRevision": 0, "enabled": false, "toolNames": []string{}}, 409)
	apiTest(t, h, "PUT", path+"/mcp-bindings/"+id, Object{"actionId": "unknown-tool", "expectedRevision": 1, "enabled": true, "toolNames": []string{"unreviewed"}}, 409)
	apiTest(t, h, "PUT", "/api/settings/mcp/"+id, Object{"name": "renamed", "transport": "http", "url": "http://127.0.0.1:18765/mcp", "enabled": true}, 200)
	rows, err := b.Engine.SecurityMCPBindings(b.Context, pid)
	if err != nil || len(rows) != 1 || rows[0].ConfigRevision != 1 {
		t.Fatalf("rename changed config: %+v %v", rows, err)
	}
	apiTest(t, h, "PUT", "/api/settings/mcp/"+id, Object{"name": "renamed", "transport": "http", "url": "http://127.0.0.1:18766/mcp", "enabled": true}, 200)
	rows, err = b.Engine.SecurityMCPBindings(b.Context, pid)
	if err != nil || rows[0].ConfigRevision != 2 {
		t.Fatalf("connection failed to advance: %+v %v", rows, err)
	}
}

func TestSecurityLegacyPolicyManagementRequiresCompleteSettingsAndCAS(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	pid := stringOf(b.Store.Session(session)["projectId"])
	p := ai.Permissions{SilentReadFiles: true}
	if err := b.Engine.CaptureSecurityLegacyPolicy(b.Context, pid, session, "web", ai.Config{Permissions: &p}); err != nil {
		t.Fatal(err)
	}
	apiTest(t, h, "PUT", "/api/projects/"+pid+"/security/policy", Object{"actionId": "activate-legacy", "expectedRevision": 0, "policy": Object{"schemaVersion": 1, "mode": "legacy", "resourceIDs": []string{}, "rules": []Object{}}}, 200)
	path := "/api/sessions/" + session + "/security/legacy-policy"
	before := apiTest(t, h, "GET", path, nil, 200)
	permissions := Object{"silentReadFiles": false, "silentWriteFiles": false, "silentReadSQL": false, "silentCommands": false, "silentTerminalCreation": false, "blockUnreferencedAssets": false, "denyLocalExecution": true}
	apiTest(t, h, "PUT", path, Object{"actionId": "incomplete", "expectedRevision": before["Revision"], "permissions": Object{"denyLocalExecution": true}}, 400)
	changed := apiTest(t, h, "PUT", path, Object{"actionId": "deny-local", "expectedRevision": before["Revision"], "permissions": permissions}, 200)
	if integer(changed["Revision"]) != integer(before["Revision"])+1 {
		t.Fatal(changed)
	}
	apiTest(t, h, "PUT", path, Object{"actionId": "stale", "expectedRevision": before["Revision"], "permissions": permissions}, 409)
	permissions["silentMCPCalls"] = true
	updated := apiTest(t, h, "PUT", path, Object{"actionId": "auto-mcp", "expectedRevision": changed["Revision"], "permissions": permissions}, 200)
	if object(updated["Permissions"])["silentMCPCalls"] != true {
		t.Fatal("MCP setting was not persisted", updated)
	}
	delete(permissions, "silentMCPCalls")
	permissions["unknown"] = true
	apiTest(t, h, "PUT", path, Object{"actionId": "unknown", "expectedRevision": updated["Revision"], "permissions": permissions}, 400)
}

func TestSecurityCommandTargetManagementStaleDefinitionCanBeReconfirmed(t *testing.T) {
	b, h := fixture(t)
	p := b.Store.CreateProject("Command targets")
	pid := stringOf(p["id"])
	config := Object{"host": "192.0.2.1", "username": "fixture", "port": 22, "authMethod": "password"}
	resource := b.Store.CreateResource(pid, "service host", "ssh", config)
	rid := stringOf(resource["id"])
	path := "/api/projects/" + pid + "/security/command-targets/" + rid
	services := []Object{{"ID": "web", "Unit": "nginx.service"}}
	payload := Object{"actionId": "register", "expectedRevision": 0, "os": "linux", "enabled": true, "services": services}
	registered := apiTest(t, h, "PUT", path, payload, 200)
	if integer(registered["Revision"]) != 1 || registered["State"] != "ready" {
		t.Fatal(registered)
	}
	apiTest(t, h, "PUT", path, Object{"actionId": "stale", "expectedRevision": 0, "os": "linux", "enabled": true, "services": services}, 409)
	changed := cloneObject(config)
	changed["host"] = "192.0.2.2"
	b.Store.EditTerminalResource(rid, "repointed", changed, true)
	stale := apiTest(t, h, "GET", path, nil, 200)
	if stale["State"] != "stale" || integer(stale["Revision"]) != 1 || integer(stale["CurrentConnectionRevision"]) != 2 {
		t.Fatal(stale)
	}
	apiTest(t, h, "PUT", path, Object{"actionId": "reconfirm", "expectedRevision": 1, "os": "linux", "enabled": true, "services": services}, 200)
	fresh := apiTest(t, h, "GET", path, nil, 200)
	if fresh["State"] != "ready" || integer(fresh["Revision"]) != 2 || integer(fresh["ConnectionRevision"]) != 2 {
		t.Fatal(fresh)
	}
	other := b.Store.CreateProject("Other target owner")
	apiTest(t, h, "GET", "/api/projects/"+stringOf(other["id"])+"/security/command-targets/"+rid, nil, 403)
}
