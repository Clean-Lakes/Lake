package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
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
	id, _ := newSession(t, h)
	state := apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/model", Object{"name": "legacy-alternate"}, 200)
	if state["modelName"] != "legacy-alternate" || b.Models.Active().Name != "legacy" || requests.Load() != 0 {
		t.Fatal("a legacy selection changed the configured default or contacted the provider")
	}
}

func TestSessionModelChoiceIsUsedForGoConversationRequests(t *testing.T) {
	home := t.TempDir()
	b, h := fixtureAtHome(t, home)
	first, _ := newSession(t, h)
	second, _ := newSession(t, h)
	requests := make(chan Object, 8)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			reply(w, 200, Object{"data": []Object{}})
			return
		}
		var request Object
		if json.NewDecoder(r.Body).Decode(&request) == nil {
			requests <- request
		}
		emitModel(w, "已收到。", nil)
	}))
	defer provider.Close()
	models := []Object{
		{"id": "default", "name": "fixture-default", "enabled": true, "imageInputMode": "off"},
		{"id": "alternate", "name": "deepseek-flash", "enabled": true, "imageInputMode": "off"},
	}
	saved := apiTest(t, h, "POST", "/api/settings/providers", Object{"name": "Fixture", "baseURL": provider.URL + "/v1", "protocol": "openai", "models": models}, 201)
	providerID := saved["savedProviderId"]
	apiTest(t, h, "POST", "/api/settings/model/select", Object{"providerId": providerID, "modelId": "default"}, 200)
	base := "/api/sessions/" + first
	choice := apiTest(t, h, "POST", base+"/ai/model", Object{"providerId": providerID, "modelId": "alternate"}, 200)
	apiTest(t, h, "POST", base+"/ai/reasoning", Object{"modelId": choice["modelId"], "effort": "max"}, 200)
	if state := apiTest(t, h, "GET", "/api/settings/model/state?sessionId="+first, nil, 200); state["modelName"] != "fixture-default" || object(state["sessionModel"])["modelName"] != "deepseek-flash" {
		t.Fatalf("settings could not distinguish the conversation and default models: %v", state)
	}
	h.Close()
	b.Close()
	b, h = fixtureAtHome(t, home)
	for _, expected := range []struct{ id, name, effort string }{{first, "deepseek-flash", "max"}, {second, "fixture-default", ""}} {
		apiTest(t, h, "POST", "/api/sessions/"+expected.id+"/messages", Object{"text": "你好", "ignoreProjectMemory": true}, 202)
		select {
		case request := <-requests:
			if request["model"] != expected.name || stringOf(request["reasoning_effort"]) != expected.effort {
				t.Fatalf("conversation request used %q / %q, want %q / %q", stringOf(request["model"]), stringOf(request["reasoning_effort"]), expected.name, expected.effort)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("missing conversation request")
		}
		b.workers.Wait()
	}
}
