package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestWorkReleaseObserverRequiresExplicitLocalCapability(t *testing.T) {
	var connections atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { connections.Add(1); w.WriteHeader(500) }))
	defer remote.Close()
	b, h := fixture(t)
	id, _ := newSession(t, h)
	allowFixtureHost(b, id)
	server := apiTest(t, h, "POST", "/api/settings/mcp", Object{"name": "Fixture release", "enabled": true, "transport": "http", "url": remote.URL}, 200)
	serverID := stringOf(server["id"])
	if _, err := b.workReleaseBridge(context.Background(), id, "work_release_capability", Object{"server_id": serverID}); err == nil {
		t.Fatal("arbitrary MCP acquired a trusted read capability")
	}
	server["workObserver"] = "release-v1"
	apiTest(t, h, "PUT", "/api/settings/mcp/"+serverID, server, 200)
	value, err := b.workReleaseBridge(context.Background(), id, "work_release_capability", Object{"server_id": serverID})
	if err != nil || stringOf(object(value)["configurationRevision"]) == "" {
		t.Fatal("configured capability missing", err)
	}
	revision := object(value)["configurationRevision"]
	server["name"] = "Reconfigured release"
	apiTest(t, h, "PUT", "/api/settings/mcp/"+serverID, server, 200)
	if _, err = b.workReleaseBridge(context.Background(), id, "work_release_observe", Object{"server_id": serverID, "order_id": "original", "configurationRevision": revision}); err == nil {
		t.Fatal("old capability survived configuration replacement")
	}
	if connections.Load() != 0 {
		t.Fatal("capability checks contacted a remote tool")
	}
	apiTest(t, h, "POST", "/api/settings/mcp/import", Object{"untrusted": Object{"command": "never-execute", "workObserver": "release-v1"}}, 400)
}
