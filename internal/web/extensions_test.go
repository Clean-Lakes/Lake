package web

import (
	"encoding/json"
	"strings"
	"testing"
)

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
