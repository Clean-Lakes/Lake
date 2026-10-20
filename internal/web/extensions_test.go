package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestMCPJSONBatchImportIsAtomicPrivateAndDoesNotConnect(t *testing.T) {
	var connections atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { connections.Add(1); w.WriteHeader(500) }))
	defer remote.Close()
	b, h := fixture(t)
	batch := Object{"mcpServers": Object{"memory": Object{"type": "stdio", "command": "/never-start-during-import", "args": []string{"-y", "space value"}, "env": Object{"TOKEN": "synthetic-batch-secret"}}, "remote": Object{"type": "http", "url": remote.URL, "headers": Object{"Authorization": "Bearer synthetic-batch-secret"}, "timeoutMs": 25000, "protocolVersion": "2025-03-26"}}}
	response := apiTest(t, h, "POST", "/api/settings/mcp/import", batch, 200)
	raw, _ := json.Marshal(response)
	if strings.Contains(string(raw), "synthetic-batch-secret") {
		t.Fatal("import response leaked secret")
	}
	if connections.Load() != 0 {
		t.Fatal("import connected to an MCP service")
	}
	config, err := b.Extensions.Store.Read()
	if err != nil || len(config.Servers) != 2 {
		t.Fatal("batch was not saved", err)
	}
	var remoteID string
	for _, server := range config.Servers {
		if server.Name == "remote" {
			remoteID = server.ID
			if server.TimeoutMS != 25000 || server.ProtocolVersion != "2025-03-26" || server.Headers["Authorization"] != "Bearer synthetic-batch-secret" {
				t.Fatal("imported settings lost")
			}
		}
	}
	apiTest(t, h, "PUT", "/api/settings/mcp/"+remoteID, Object{"name": "Renamed", "transport": "http", "url": remote.URL, "enabled": true}, 200)
	saved, _ := b.Extensions.Store.FindServer(remoteID)
	if saved.TimeoutMS != 25000 || saved.ProtocolVersion != "2025-03-26" || len(saved.Headers) != 1 {
		t.Fatal("older edit discarded new options or credentials")
	}
	apiTest(t, h, "POST", "/api/settings/mcp/import", Object{"first-new": Object{"command": "npx"}, "MEMORY": Object{"command": "npx"}}, 400)
	apiTest(t, h, "POST", "/api/settings/mcp/import", Object{"first-new": Object{"command": "npx"}, "invalid": Object{"url": "https://example.test/?token=synthetic-batch-secret"}}, 400)
	config, _ = b.Extensions.Store.Read()
	if len(config.Servers) != 2 {
		t.Fatal("failed batch partially changed configuration")
	}
}

func TestExtensionSettingsKeepSecretsPrivateAndPersistSkills(t *testing.T) {
	b, h := fixture(t)
	apiTest(t, h, "GET", "/api/settings/mcp", nil, 200)
	row := apiTest(t, h, "POST", "/api/settings/mcp", Object{"name": "Fixture MCP", "enabled": true, "transport": "http", "url": "http://127.0.0.1:1/mcp", "headers": Object{"Authorization": "Bearer synthetic-extension-secret"}}, 200)
	id := stringOf(row["id"])
	if id == "" || row["headersConfigured"] != true {
		t.Fatal("server configuration was not persisted")
	}
	for _, response := range []Object{row, apiTest(t, h, "GET", "/api/settings/mcp", nil, 200)} {
		raw, _ := json.Marshal(response)
		if strings.Contains(string(raw), "synthetic-extension-secret") {
			t.Fatal("credentials were exposed in settings")
		}
	}
	updated := apiTest(t, h, "PUT", "/api/settings/mcp/"+id, Object{"name": "Renamed", "enabled": false, "transport": "http", "url": "http://127.0.0.1:1/mcp"}, 200)
	if updated["headersConfigured"] != true {
		t.Fatal("credential retention metadata lost")
	}
	saved, _ := b.Extensions.Store.FindServer(id)
	if saved.Headers["Authorization"] != "Bearer synthetic-extension-secret" {
		t.Fatal("saved credential changed")
	}
	apiTest(t, h, "POST", "/api/settings/mcp", Object{"name": "Invalid", "transport": "http", "url": "https://user:password@example.com"}, 400)
	apiTest(t, h, "PUT", "/api/settings/skills/service-check", Object{"create": true, "enabled": true, "content": "---\nname: service-check\ndescription: A fixture procedure\n---\nInspect bounded logs"}, 200)
	skill := apiTest(t, h, "GET", "/api/settings/skills/service-check", nil, 200)
	if object(skill["skill"])["managed"] != true || !strings.Contains(stringOf(skill["content"]), "bounded logs") {
		t.Fatal("skill content not available")
	}
	apiTest(t, h, "PUT", "/api/settings/skills/service-check", Object{"enabled": false}, 200)
	skill = apiTest(t, h, "GET", "/api/settings/skills/service-check", nil, 200)
	if object(skill["skill"])["enabled"] != false {
		t.Fatal("skill disabled state lost")
	}
	apiTest(t, h, "DELETE", "/api/settings/mcp/"+id, nil, 200)
}
