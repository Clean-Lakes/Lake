package web

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func providerFixture(name, base, key string) Object {
	return Object{"name": name, "baseURL": base, "protocol": "openai", "enabled": true, "apiKey": key, "models": []any{Object{"id": "model-one", "name": "same-model", "enabled": true, "contextWindow": 1000000}}}
}
func TestProvidersMigrationAndCompatibility(t *testing.T) {
	b, h := fixture(t)
	const key = "synthetic-legacy-key"
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": "http://localhost:12345/v1", "name": "legacy", "apiKey": key, "supportsImageInput": true}, 200)
	catalog := apiTest(t, h, "GET", "/api/settings/providers", nil, 200)
	if strings.Contains(jsonText(catalog), key) || strings.Contains(jsonText(catalog), "credentialRef") {
		t.Fatal("public catalog exposed credential")
	}
	pid, mid := stringOf(catalog["activeProviderId"]), stringOf(catalog["activeModelId"])
	if pid == "" || mid == "" || b.Models.Active().Key != key || !b.Models.Active().SupportsImageInput {
		t.Fatal("legacy configuration not migrated")
	}
	fresh := &Models{Home: b.Models.Home, Dir: b.Models.Dir}
	if fresh.Active().Key != key {
		t.Fatal("provider configuration lost across reopen")
	}
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": "http://localhost:12345/v1", "name": "updated"}, 200)
	if fresh.Active().Name != "updated" || fresh.Active().Key != key {
		t.Fatal("legacy updates did not synchronize catalog")
	}
	apiTest(t, h, "DELETE", "/api/settings/model", nil, 200)
	if fresh.Active() != nil {
		t.Fatal("clear left model active")
	}
	if len(object(apiTest(t, h, "GET", "/api/settings/providers", nil, 200))["providers"].([]any)) != 1 {
		t.Fatal("clear deleted provider profiles")
	}
}
func TestProviderCredentialIsolationActivationAndLifecycle(t *testing.T) {
	b, h := fixture(t)
	a := apiTest(t, h, "POST", "/api/settings/providers", providerFixture("A", "http://localhost:12345/custom/v1", "synthetic-provider-A"), 201)
	aid := stringOf(a["savedProviderId"])
	c := apiTest(t, h, "POST", "/api/settings/providers", providerFixture("B", "http://localhost:23456/v1", "synthetic-provider-B"), 201)
	bid := stringOf(c["savedProviderId"])
	raw, err := os.ReadFile(filepath.Join(b.Models.Dir, "providers.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "synthetic-provider") || strings.Contains(jsonText(c), "synthetic-provider") {
		t.Fatal("keys leaked in profile metadata")
	}
	var catalog providerCatalog
	json.Unmarshal(raw, &catalog)
	ap, bp := findProvider(&catalog, aid), findProvider(&catalog, bid)
	if ap.CredentialRef == bp.CredentialRef {
		t.Fatal("credentials shared")
	}
	for _, provider := range catalog.Providers {
		p, err := privateFile(filepath.Join(b.Models.Home, "secrets"), provider.CredentialRef)
		if err != nil {
			t.Fatal(err)
		}
		info, _ := os.Stat(p)
		if info.Mode().Perm() != 0600 {
			t.Fatal("key not private")
		}
	}
	apiTest(t, h, "POST", "/api/settings/model/select", Object{"providerId": bid, "modelId": "model-one"}, 200)
	active := b.Models.Active()
	if active.Key != "synthetic-provider-B" || active.URL != "http://localhost:23456/v1/chat/completions" || active.ContextLimit != 1000000 {
		t.Fatal("activation did not use selected provider")
	}
	apiTest(t, h, "PUT", "/api/settings/providers/"+bid, Object{"apiKey": ""}, 200)
	if b.Models.Active().Key != "synthetic-provider-B" {
		t.Fatal("empty key did not preserve selected provider key")
	}
	apiTest(t, h, "PUT", "/api/settings/providers/"+bid, Object{"apiKey": nil}, 200)
	if b.Models.Active().Key != "" {
		t.Fatal("explicit key clearing failed")
	}
	if _, err := os.Stat(filepath.Join(b.Models.Home, "secrets", bp.CredentialRef)); !os.IsNotExist(err) {
		t.Fatal("old provider key not removed")
	}
	apiTest(t, h, "PUT", "/api/settings/providers/"+bid, Object{"enabled": false}, 200)
	if b.Models.Active().Key != "synthetic-provider-A" {
		t.Fatal("disabled provider did not fall back")
	}
	apiTest(t, h, "POST", "/api/settings/model/select", Object{"providerId": bid, "modelId": "model-one"}, 400)
	apiTest(t, h, "DELETE", "/api/settings/providers/"+aid, nil, 200)
	if b.Models.Active() != nil {
		t.Fatal("disabled provider unexpectedly active")
	}
	if _, err := os.Stat(filepath.Join(b.Models.Home, "secrets", ap.CredentialRef)); !os.IsNotExist(err) {
		t.Fatal("deleted provider key remains")
	}
}
func TestProviderDiscoveryTestAndExplicitCapacity(t *testing.T) {
	b, h := fixture(t)
	requests := make(chan string, 20)
	expectRequest := func(want string) {
		t.Helper()
		deadline := time.After(3 * time.Second)
		for {
			select {
			case req := <-requests:
				if req == want {
					return
				}
			case <-deadline:
				t.Fatalf("request %q was not observed", want)
			}
		}
	}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- r.Header.Get("Authorization") + " " + r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "GET" {
			fmt.Fprint(w, `{"data":[{"id":"same-model","context_length":8192}]}`)
		} else {
			fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"pong"}}]}`)
		}
	}))
	defer remote.Close()
	first := providerFixture("A", remote.URL+"/prefix/v1", "synthetic-A")
	first["models"] = []any{Object{"id": "model-one", "name": "same-model", "enabled": true, "contextWindow": 1000000, "imageInputMode": "off"}}
	a := apiTest(t, h, "POST", "/api/settings/providers", first, 201)
	aid := stringOf(a["savedProviderId"])
	next := providerFixture("B", remote.URL+"/prefix/v1", "synthetic-B")
	next["models"] = first["models"]
	apiTest(t, h, "POST", "/api/settings/providers", next, 201)
	apiTest(t, h, "POST", "/api/settings/providers/"+aid+"/discover", Object{}, 200)
	expectRequest("Bearer synthetic-A /prefix/v1/models")
	result := apiTest(t, h, "POST", "/api/settings/providers/"+aid+"/test", Object{}, 200)
	if result["ok"] != true {
		t.Fatal(result)
	}
	expectRequest("Bearer synthetic-A /prefix/v1/chat/completions")
	apiTest(t, h, "POST", "/api/settings/providers/new/discover", Object{"baseURL": remote.URL + "/v1", "protocol": "openai"}, 200)
	expectRequest(" /v1/models")
	active := b.Models.WithCapacity(context.Background(), b.Models.Active())
	if active.ContextLimit != 1000000 || active.ContextLimitSource != "settings" || b.Models.CachedCapacity(active).ContextLimit != 1000000 {
		t.Fatal("provider metadata overwrote explicit capacity")
	}
	available := apiTest(t, h, "GET", "/api/settings/model/available", nil, 200)
	if len(available["entries"].([]any)) != 2 {
		t.Fatal("same model names from separate providers were collapsed")
	}
}
func TestProviderValidationAndEndpointFormats(t *testing.T) {
	for _, entry := range []struct{ base, protocol, want string }{
		{"https://example.test/anthropic", "claude", "https://example.test/anthropic/v1/messages"},
		{"https://example.test/compatible-mode/v1", "openai", "https://example.test/compatible-mode/v1/chat/completions"},
		{"https://example.test/api/paas/v4", "openai", "https://example.test/api/paas/v4/chat/completions"},
		{"https://example.test/v1", "openai-response", "https://example.test/v1/responses"},
		{"http://localhost:11434", "ollama", "http://localhost:11434/api/chat"},
		{"https://example.test", "gemini", "https://example.test/v1beta/models/{model}:streamGenerateContent"},
		{"https://example.test/v1beta", "gemini", "https://example.test/v1beta/models/{model}:streamGenerateContent"},
	} {
		if got := providerEndpoint(entry.base, entry.protocol); got != entry.want {
			t.Fatalf("endpoint: %s != %s", got, entry.want)
		}
	}
	b, h := fixture(t)
	apiTest(t, h, "POST", "/api/settings/providers", providerFixture("bad", "https://user:secret@example.test/v1", ""), 400)
	input := providerFixture("bad", "https://example.test/v1", "")
	input["models"] = []any{Object{"name": "model", "contextWindow": "wrong"}}
	apiTest(t, h, "POST", "/api/settings/providers", input, 400)
	good := apiTest(t, h, "POST", "/api/settings/providers", providerFixture("okay", "https://example.test/v1", "synthetic-private"), 201)
	id := stringOf(good["savedProviderId"])
	b.Models.mu.Lock()
	catalog, _ := b.Models.readProviderCatalogLocked()
	ref := findProvider(catalog, id).CredentialRef
	b.Models.mu.Unlock()
	os.Chmod(filepath.Join(b.Models.Home, "secrets", ref), 0644)
	if b.Models.Active() != nil {
		t.Fatal("insecure key file used")
	}
	expectPanic(t, 400, func() { b.Models.ProviderInput(id, Object{}) })
	replacement := b.Models.ProviderInput(id, Object{"apiKey": "synthetic-replacement"})
	if replacement.Key != "synthetic-replacement" {
		t.Fatal("could not repair invalid stored key")
	}
}

func TestProviderMigrationPreservesCustomCompleteEndpoint(t *testing.T) {
	b, h := fixture(t)
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": "https://example.test/special/invoke", "name": "legacy"}, 200)
	catalog := apiTest(t, h, "GET", "/api/settings/providers", nil, 200)
	id := stringOf(catalog["activeProviderId"])
	if b.Models.Active().URL != "https://example.test/special/invoke" {
		t.Fatal("migration changed legacy endpoint")
	}
	apiTest(t, h, "PUT", "/api/settings/providers/"+id, Object{"name": "renamed"}, 200)
	if b.Models.Active().URL != "https://example.test/special/invoke" || b.Models.ProviderInput(id, Object{}).URL != "https://example.test/special/invoke" {
		t.Fatal("editing metadata lost legacy endpoint")
	}
	apiTest(t, h, "PUT", "/api/settings/providers/"+id, Object{"baseURL": "https://example.test/v1"}, 200)
	if b.Models.Active().URL != "https://example.test/v1/chat/completions" {
		t.Fatal("explicit endpoint update ignored")
	}
}

func TestProviderDisabledModelsAreExcludedAndCannotBeActivated(t *testing.T) {
	b, h := fixture(t)
	input := providerFixture("models", "http://localhost:12345/v1", "")
	input["models"] = []any{Object{"id": "off", "name": "disabled", "enabled": false}, Object{"id": "on", "name": "enabled", "enabled": true}}
	catalog := apiTest(t, h, "POST", "/api/settings/providers", input, 201)
	id := stringOf(catalog["savedProviderId"])
	if b.Models.Active().Name != "enabled" {
		t.Fatal("disabled model was automatically selected")
	}
	available := apiTest(t, h, "GET", "/api/settings/model/available", nil, 200)
	if names := stringsOf(available["models"]); len(names) != 1 || names[0] != "enabled" {
		t.Fatal("disabled model remains in composer choices")
	}
	apiTest(t, h, "POST", "/api/settings/model/select", Object{"providerId": id, "modelId": "off"}, 400)
	apiTest(t, h, "PUT", "/api/settings/providers/"+id, Object{"models": []any{Object{"id": "off", "name": "disabled", "enabled": false}, Object{"id": "on", "name": "enabled", "enabled": false}}}, 200)
	if b.Models.Active() != nil {
		t.Fatal("all-disabled model list remains configured")
	}
}

func TestProviderImageInputBackgroundDetectionAndManualOverride(t *testing.T) {
	b, h := fixture(t)
	var probes atomic.Int32
	var modelListings atomic.Int32
	probeStarted := make(chan struct{}, 1)
	releaseProbe := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseProbe) }) }
	defer release()
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/models") {
			modelListings.Add(1)
			fmt.Fprint(w, `{"data":[{"id":"same-model","supports_image_input":false,"effort":{"supported_levels":["low","high"],"default_level":"low"}},{"id":"other-model"}]}`)
			return
		}
		probes.Add(1)
		select {
		case probeStarted <- struct{}{}:
		default:
		}
		<-releaseProbe
		fmt.Fprint(w, `{"choices":[{"message":{"content":"blue"}}]}`)
	}))
	defer remote.Close()
	config := providerFixture("vision", remote.URL+"/v1", "synthetic-test-key")
	config["models"] = []any{Object{"id": "model-one", "name": "same-model", "enabled": true}, Object{"id": "model-two", "name": "other-model", "enabled": true}, Object{"id": "model-manual", "name": "deepseek-flash", "enabled": true, "imageInputMode": "off"}}
	catalog := apiTest(t, h, "POST", "/api/settings/providers", config, 201)
	providerID := stringOf(catalog["savedProviderId"])
	select {
	case <-probeStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("save did not start image detection")
	}
	if status := apiTest(t, h, "GET", "/api/settings/providers/"+providerID+"/detect-images", nil, 200); status["status"] != "running" {
		t.Fatal("save waited for image probe", status)
	}
	release()
	deadline := time.Now().Add(3 * time.Second)
	for {
		status := apiTest(t, h, "GET", "/api/settings/providers/"+providerID+"/detect-images", nil, 200)
		if status["status"] == "complete" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background image detection did not complete", status)
		}
		time.Sleep(10 * time.Millisecond)
	}
	provider := findProviderForTest(t, b.Models.Providers(), providerID)
	if provider.Models[0].ImageInputDetected == nil || *provider.Models[0].ImageInputDetected || provider.Models[1].ImageInputDetected == nil || !*provider.Models[1].ImageInputDetected || probes.Load() != 1 {
		t.Fatal("background detection did not combine metadata and image probe", provider.Models, probes.Load())
	}
	if capability := provider.Models[0].Reasoning; capability == nil || len(capability.Levels) != 2 || capability.Default != "low" || capability.Source != "provider" {
		t.Fatal("background detection did not save reasoning levels", capability)
	}
	if capability := provider.Models[2].Reasoning; capability == nil || len(capability.Levels) == 0 || capability.Source != "model" {
		t.Fatal("known model fallback was not saved", capability)
	}
	sessionID, _ := newSession(t, h)
	beforeListings := modelListings.Load()
	reasoning := apiTest(t, h, "GET", "/api/sessions/"+sessionID+"/ai/reasoning", nil, 200)
	if len(stringsOf(reasoning["levels"])) != 2 || reasoning["default"] != "low" || modelListings.Load() != beforeListings {
		t.Fatal("reasoning menu did not use saved capabilities", reasoning)
	}
	if b.Models.Active().SupportsImageInput {
		t.Fatal("known unsupported image model still accepts attachments")
	}
	apiTest(t, h, "PUT", "/api/settings/providers/"+providerID, Object{"models": []any{Object{"id": "model-one", "name": "same-model", "enabled": true, "imageInputMode": "off"}}}, 200)
	if b.Models.Active().SupportsImageInput {
		t.Fatal("manual image-input override was ignored")
	}
	apiTest(t, h, "POST", "/api/settings/providers/"+providerID+"/detect-images", Object{}, 202)
	if probes.Load() != 1 {
		t.Fatal("manual override triggered an image probe")
	}
}

func findProviderForTest(t *testing.T, raw Object, id string) ModelProvider {
	t.Helper()
	for _, value := range raw["providers"].([]Object) {
		if stringOf(value["id"]) == id {
			data, _ := json.Marshal(value["models"])
			var models []ProviderModel
			if err := json.Unmarshal(data, &models); err != nil {
				t.Fatal(err)
			}
			return ModelProvider{Models: models}
		}
	}
	t.Fatal("provider missing")
	return ModelProvider{}
}

func TestExistingProviderReasoningRefreshUsesMetadataWithoutModelProbes(t *testing.T) {
	b, _ := fixture(t)
	var listings, generations atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/models") {
			listings.Add(1)
			fmt.Fprint(w, `{"data":[{"id":"codex/gpt-6.1-sol","supported_reasoning_levels":[{"effort":"low"},{"effort":"ultra"}]}]}`)
			return
		}
		generations.Add(1)
		http.Error(w, "unexpected generation", http.StatusBadRequest)
	}))
	defer remote.Close()
	b.Models.mu.Lock()
	b.Models.saveProviderCatalogLocked(&providerCatalog{Version: 1, ActiveProviderID: "provider", ActiveModelID: "model", Providers: []ModelProvider{{ID: "provider", Name: "gateway", BaseURL: remote.URL + "/v1", Protocol: "openai", Enabled: true, Models: []ProviderModel{{ID: "model", Name: "codex/gpt-6.1-sol", Enabled: true, ImageInputMode: "auto"}}}}})
	b.Models.mu.Unlock()
	b.Models.RefreshStoredReasoning(context.Background())
	model := b.Models.Active()
	if listings.Load() != 1 || generations.Load() != 0 || model.Reasoning == nil || !reflect.DeepEqual(model.Reasoning.Levels, []string{"low", "ultra"}) {
		t.Fatal("stored model metadata was not refreshed without probes", listings.Load(), generations.Load(), model.Reasoning)
	}
}
