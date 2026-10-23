package ai

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestNativeKubernetesCapabilityScopeAndReadPermissions(t *testing.T) {
	for _, role := range []string{"host", "application", "data"} {
		if resourceAgentCapabilities("kubernetes")[role] == "" {
			t.Fatal("missing native capability")
		}
		tools := js(childObservationTools(role, []Asset{{Kind: "kubernetes"}}))
		if !strings.Contains(tools, `"name":"observe_cluster"`) || strings.Contains(tools, `"name":"observe_host"`) || strings.Contains(tools, `"name":"shell"`) {
			t.Fatal("native cluster was assigned host tools")
		}
	}
	p := DefaultPermissions()
	p.SilentReadFiles = false
	c := Config{Permissions: &p, ConversationMode: ModePlan}
	if needs, err := RequiresApproval(c, "query_kubernetes", "readonly", map[string]any{"kubernetesLogs": true}); err != nil || !needs {
		t.Fatal("logs bypassed file-read preference")
	}
	if needs, err := RequiresApproval(c, "query_kubernetes", "readonly", nil); err != nil || needs {
		t.Fatal("read-only status required a terminal")
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1) }))
	defer server.Close()
	c = Config{Model: Model{URL: "http://127.0.0.1:1", Protocol: "openai", Name: "unused"}, Profile: "core", Assets: []Asset{{ID: "cluster", Name: "Nanjing-k1", Kind: "kubernetes", Settings: map[string]any{"endpoint": server.URL}}}, targetScope: &TargetScope{ResourceIDs: []string{"other"}}}
	e := engineFor(t, c.Model, nil)
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	if _, err := e.invoke(context.Background(), s, c, Call{ID: "wrong-scope", Name: "query_kubernetes", Arguments: js(map[string]any{"asset_ref": assetAlias("cluster"), "metric": "nodes"})}); err == nil {
		t.Fatal("cross-scope query was accepted")
	}
	c.targetScope = nil
	p.BlockUnreferencedAssets = true
	c.Permissions = &p
	if _, err := e.invoke(context.Background(), s, c, Call{ID: "unreferenced", Name: "query_kubernetes", Arguments: js(map[string]any{"asset_ref": assetAlias("cluster"), "metric": "nodes"})}); err == nil {
		t.Fatal("unreferenced query was accepted")
	}
	for _, args := range []map[string]any{{"asset_ref": assetAlias("cluster"), "metric": "secrets"}, {"asset_ref": assetAlias("cluster"), "metric": "nodes", "endpoint": server.URL}, {"asset_ref": assetAlias("cluster"), "metric": "nodes", "command": "kubectl get secrets"}} {
		if err := validateTool(kubernetesQueryTool(), args); err == nil {
			t.Fatal("unsafe query schema")
		}
	}
	if requests.Load() != 0 {
		t.Fatal("blocked calls contacted a cluster")
	}
}
