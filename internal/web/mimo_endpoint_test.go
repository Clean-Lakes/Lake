package web

import (
	"path/filepath"
	"testing"
)

func TestExistingMiMoProviderRepairsProtocolPrefixWithoutChangingSelection(t *testing.T) {
	b, _ := fixture(t)
	catalog := providerCatalog{Version: 1, ActiveSource: "native", ActiveProviderID: "mimo-fixture", ActiveModelID: "mimo-pro", Providers: []ModelProvider{{ID: "mimo-fixture", Name: "MiMo", BaseURL: "https://api.xiaomimimo.com/v1", Protocol: "claude", Enabled: true, Models: []ProviderModel{{ID: "mimo-pro", Name: "mimo-v2.6-pro", Enabled: true}}}}}
	if err := atomicFile(filepath.Join(b.Models.Dir, "providers.json"), []byte(jsonText(catalog))); err != nil {
		t.Fatal(err)
	}
	active := b.Models.Active()
	if active == nil || active.Name != "mimo-v2.6-pro" || active.Protocol != "claude" || active.URL != "https://api.xiaomimimo.com/anthropic/v1/messages" {
		t.Fatal("existing provider still resolves to an OpenAI prefix")
	}
	providers := b.Models.Providers()
	provider := objects(providers["providers"])[0]
	if provider["baseURL"] != "https://api.xiaomimimo.com/anthropic/v1" || providers["activeModelId"] != "mimo-pro" {
		t.Fatal("public configuration disagrees with the active model")
	}
	probe := b.Models.ProviderInput("mimo-fixture", Object{"model": "mimo-v2.6-pro"})
	if probe.URL != active.URL || probe.Protocol != active.Protocol {
		t.Fatal("connection test uses a different endpoint from chat")
	}
	if got := providerEndpoint("https://api.xiaomimimo.com/anthropic/v1", "openai"); got != "https://api.xiaomimimo.com/v1/chat/completions" {
		t.Fatal("switching back to OpenAI retained the Anthropic prefix")
	}
}
