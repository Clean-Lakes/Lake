package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestModelSyncFollowsMagpieCatalogAndDefaultWithoutChangingSource(t *testing.T) {
	b, h := fixture(t)
	path := filepath.Join(b.Models.Home, "secrets", magpieConfigName)
	write := func(model, label string, ids ...string) {
		t.Helper()
		items := []Object{}
		for _, id := range ids {
			items = append(items, Object{"id": id, "name": label + " " + id, "contextWindow": 200000, "supportsImageInput": true})
		}
		must(os.WriteFile(path, []byte(jsonText(Object{"model": model, "baseURL": "http://127.0.0.1:1/v1", "key": "synthetic-sync-private-key", "catalog": items})), 0600))
	}
	state := func() Object {
		t.Helper()
		result := apiTest(t, h, "GET", "/api/settings/model/state", nil, 200)
		if strings.Contains(jsonText(result), "synthetic-sync-private-key") || strings.Contains(jsonText(result), "credentialRef") {
			t.Fatal("model sync exposed credentials")
		}
		return result
	}
	write("old", "Before", "old", "removed")
	if state()["modelName"] != "old" {
		t.Fatal("initial Magpie model missing")
	}
	apiTest(t, h, "POST", "/api/settings/model/select", Object{"providerId": "magpie", "modelId": "removed"}, 200)
	write("new", "After", "new", "added")
	synced := state()
	available := object(synced["available"])
	selection := object(synced["modelSelection"])
	if synced["modelName"] != "new" || synced["supportsImageInput"] != true || selection["displayName"] != "After new" || available["activeModelId"] != "new" || len(available["entries"].([]any)) != 2 {
		t.Fatalf("Magpie update did not reach sync state: %v", synced)
	}
	// A metadata-only update must also reach the UI, without changing the ID.
	write("new", "Renamed", "new", "added")
	if object(state()["modelSelection"])["displayName"] != "Renamed new" {
		t.Fatal("same-ID metadata update was lost")
	}
	manual := apiTest(t, h, "POST", "/api/settings/providers", providerFixture("Manual", "http://127.0.0.1:1/v1", "synthetic-manual-key"), 201)
	id := stringOf(manual["savedProviderId"])
	apiTest(t, h, "POST", "/api/settings/model/select", Object{"providerId": id, "modelId": "model-one"}, 200)
	write("added", "Latest", "added")
	synced = state()
	if object(synced["modelSelection"])["providerId"] != id || object(synced["available"])["activeProviderId"] != id || len(object(synced["available"])["entries"].([]any)) != 2 {
		t.Fatal("Magpie catalog update replaced the manual source or kept removed models")
	}
	must(os.WriteFile(path, []byte("{}"), 0600))
	if object(state()["settings"])["magpie"] != nil {
		t.Fatal("disconnect did not remove Magpie from settings")
	}
	write("added", "Reconnected", "added")
	if object(state()["settings"])["magpie"] == nil || b.Models.Active().Name != "same-model" {
		t.Fatal("reconnect did not restore catalog while retaining manual selection")
	}
}

func TestModelSyncWithoutConfiguredCatalogDoesNotDiscoverOrWrite(t *testing.T) {
	b, h := fixture(t)
	result := apiTest(t, h, "GET", "/api/settings/model/state", nil, 200)
	if result["modelConfigured"] != false || result["available"] != nil {
		t.Fatal("unconfigured model state is incorrect")
	}
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer upstream.Close()
	b.Models.Save(&ai.Model{URL: upstream.URL + "/v1/chat/completions", Name: "legacy", Protocol: "openai"})
	result = apiTest(t, h, "GET", "/api/settings/model/state", nil, 200)
	if result["modelName"] != "legacy" || result["available"] != nil || requests.Load() != 0 {
		t.Fatal("local state polling triggered upstream model discovery")
	}
	if _, err := os.Stat(filepath.Join(b.Models.Dir, "providers.json")); !os.IsNotExist(err) {
		t.Fatal("polling created a provider catalog")
	}
}
