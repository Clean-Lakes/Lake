package extensions

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPJSONImportShapesAndAtomicCommit(t *testing.T) {
	rows, err := ParseServerImport([]byte(`{"mcpServers":{"memory":{"command":"npx","args":["-y","@example/memory"],"env":{"TOKEN":"synthetic-import-secret"}},"remote":{"type":"streamable-http","url":"https://example.test/mcp","enabled":false,"timeoutMs":15000,"protocolVersion":"2025-03-26"}}}`))
	if err != nil || len(rows) != 2 {
		t.Fatal("valid import rejected", err)
	}
	for i := range rows {
		rows[i].ID = []string{"first", "second"}[i]
	}
	store := NewStore(t.TempDir())
	if err := store.ImportServers(rows); err != nil {
		t.Fatal(err)
	}
	before, _ := store.Read()
	if len(before.Servers) != 2 || before.Servers[0].TimeoutMS != 30000 {
		t.Fatal("import defaults lost")
	}
	public, _ := json.Marshal(PublicServer(before.Servers[0]))
	if strings.Contains(string(public), "synthetic-import-secret") {
		t.Fatal("secret exposed")
	}
	changed := []Server{{ID: "new", Name: "New", Transport: "stdio", Command: "npx", Enabled: true}, {ID: "duplicate", Name: "MEMORY", Transport: "stdio", Command: "npx", Enabled: true}}
	if store.ImportServers(changed) == nil {
		t.Fatal("duplicate import accepted")
	}
	after, _ := store.Read()
	if len(after.Servers) != 2 {
		t.Fatal("failed import partially committed")
	}
	changed[1].Name = "Invalid"
	changed[1].Command = ""
	if store.ImportServers(changed) == nil {
		t.Fatal("invalid import accepted")
	}
	after, _ = store.Read()
	if len(after.Servers) != 2 {
		t.Fatal("invalid import partially committed")
	}
}
func TestMCPJSONImportValidationDoesNotEchoSecrets(t *testing.T) {
	for _, raw := range []string{`[]`, `{}`, `{"mcpServers":{}}`, `{"x":{"command":"npx","unknown":"synthetic-private"}}`, `{"x":{"command":"npx","args":[1]}}`, `{"x":{"command":"npx","env":{"TOKEN":1}}}`, `{"x":{"command":"npx","headers":null}}`, `{"x":{"command":"npx","timeoutMs":0}}`, `{"x":{"type":"http","url":"https://example.test/mcp?token=synthetic-private"}}`, `{"x":{"type":"http","transport":"sse","url":"https://example.test"}}`, `{"x":{"command":"npx","protocolVersion":"unknown"}}`} {
		_, err := ParseServerImport([]byte(raw))
		if err == nil {
			t.Fatal("invalid configuration accepted")
		}
		if strings.Contains(err.Error(), "synthetic-private") {
			t.Fatal("secret included in validation error")
		}
	}
}
func TestMCPConfiguredProtocolAndTimeout(t *testing.T) {
	var observed atomic.Bool
	server := testServer()
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			raw, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewReader(raw))
			var request struct {
				Method string `json:"method"`
				Params struct {
					Version string `json:"protocolVersion"`
				} `json:"params"`
			}
			_ = json.Unmarshal(raw, &request)
			if request.Method == "initialize" && request.Params.Version == "2025-03-26" {
				observed.Store(true)
			}
		}
		handler.ServeHTTP(w, r)
	}))
	defer remote.Close()
	store := NewStore(t.TempDir())
	manager := NewManager(store)
	defer manager.Close()
	config := Server{ID: "protocol", Name: "Protocol fixture", Transport: "http", URL: remote.URL, Enabled: true, TimeoutMS: 2000, ProtocolVersion: "2025-03-26"}
	if err := store.SaveServer(config, false, false); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Tools(context.Background(), config.ID, true); err != nil {
		t.Fatal(err)
	}
	if !observed.Load() {
		t.Fatal("configured protocol was not sent")
	}
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(3 * time.Second):
		}
	}))
	defer slow.Close()
	config.ID = "timeout"
	config.URL = slow.URL
	config.TimeoutMS = 1000
	if err := store.SaveServer(config, false, false); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if _, err := manager.Tools(context.Background(), config.ID, true); err == nil {
		t.Fatal("slow connection did not time out")
	}
	if time.Since(started) > 2500*time.Millisecond {
		t.Fatal("configured timeout was not honored")
	}
}
