package web

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	requests := make(chan string, 10)
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
	a := apiTest(t, h, "POST", "/api/settings/providers", providerFixture("A", remote.URL+"/prefix/v1", "synthetic-A"), 201)
	aid := stringOf(a["savedProviderId"])
	next := providerFixture("B", remote.URL+"/prefix/v1", "synthetic-B")
	apiTest(t, h, "POST", "/api/settings/providers", next, 201)
	apiTest(t, h, "POST", "/api/settings/providers/"+aid+"/discover", Object{}, 200)
	if req := <-requests; req != "Bearer synthetic-A /prefix/v1/models" {
		t.Fatal("discovery used incorrect provider or endpoint")
	}
	result := apiTest(t, h, "POST", "/api/settings/providers/"+aid+"/test", Object{}, 200)
	if result["ok"] != true {
		t.Fatal(result)
	}
	if req := <-requests; req != "Bearer synthetic-A /prefix/v1/chat/completions" {
		t.Fatal("test used incorrect provider")
	}
	apiTest(t, h, "POST", "/api/settings/providers/new/discover", Object{"baseURL": remote.URL + "/v1", "protocol": "openai"}, 200)
	if req := <-requests; req != " /v1/models" {
		t.Fatal("new provider inherited saved credentials")
	}
	active := b.Models.WithCapacity(context.Background(), b.Models.Active())
	<-requests
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
