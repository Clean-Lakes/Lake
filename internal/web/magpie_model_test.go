package web

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMagpieAndManualModelsCanSwitchWithoutDisconnecting(t *testing.T) {
	b, h := fixture(t)
	configPath := filepath.Join(b.Models.Home, "secrets", magpieConfigName)
	writeMagpie := func(model string) {
		t.Helper()
		data := Object{"model": model, "baseURL": "http://localhost:34567/v1", "key": "synthetic-magpie-key", "catalog": []Object{{"id": "same-model", "name": "Magpie Same"}, {"id": "magpie-other", "name": "Magpie Other"}}}
		if err := os.WriteFile(configPath, []byte(jsonText(data)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeMagpie("same-model")
	manual := apiTest(t, h, "POST", "/api/settings/providers", providerFixture("Manual", "http://localhost:12345/v1", "synthetic-manual-key"), 201)
	providerID := stringOf(manual["savedProviderId"])
	if manual["activeProviderId"] != "magpie" || b.Models.Active().Key != "synthetic-magpie-key" {
		t.Fatal("initial Magpie selection changed while saving provider")
	}
	available := apiTest(t, h, "GET", "/api/settings/model/available", nil, 200)
	if len(available["entries"].([]any)) != 3 || available["activeProviderId"] != "magpie" {
		t.Fatal("both model sources must appear in composer")
	}
	selected := apiTest(t, h, "POST", "/api/settings/model/select", Object{"providerId": providerID, "modelId": "model-one"}, 200)
	if selected["activeProviderId"] != providerID || b.Models.Active().Key != "synthetic-manual-key" || b.Models.Active().URL != "http://localhost:12345/v1/chat/completions" {
		t.Fatal("manual selection did not override connected Magpie")
	}
	settings := apiTest(t, h, "GET", "/api/settings/model", nil, 200)
	if settings["managedBy"] != nil || settings["magpie"] == nil || settings["providerId"] != providerID {
		t.Fatal("settings must distinguish connection from active source")
	}
	available = apiTest(t, h, "GET", "/api/settings/model/available", nil, 200)
	if available["activeProviderId"] != providerID || len(available["entries"].([]any)) != 3 {
		t.Fatal("manual selection hid Magpie models or reported wrong active source")
	}
	writeMagpie("magpie-other")
	fresh := &Models{Home: b.Models.Home, Dir: b.Models.Dir}
	if fresh.Active().Key != "synthetic-manual-key" {
		t.Fatal("manual choice must survive restart and Magpie default updates")
	}
	apiTest(t, h, "POST", "/api/settings/model/select", Object{"providerId": "magpie", "modelId": "same-model"}, 200)
	if b.Models.Active().Key != "synthetic-magpie-key" || fresh.Active().Name != "same-model" {
		t.Fatal("cannot switch back to Magpie or persist its chosen model")
	}
	settings = apiTest(t, h, "GET", "/api/settings/model", nil, 200)
	if settings["managedBy"] != "magpie" {
		t.Fatal("settings did not report active Magpie source")
	}
	apiTest(t, h, "POST", "/api/settings/model/select", Object{"providerId": "magpie", "modelId": "missing"}, 400)
	if b.Models.Active().Name != "same-model" {
		t.Fatal("failed selection changed active model")
	}
	if err := os.WriteFile(configPath, []byte("{}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if fresh.Active().Key != "synthetic-manual-key" {
		t.Fatal("disconnect must fall back to saved manual model")
	}
	writeMagpie("magpie-other")
	if fresh.Active().Key != "synthetic-magpie-key" {
		t.Fatal("reconnecting lost explicit Magpie source choice")
	}
	for _, response := range []Object{manual, selected, settings, available} {
		if strings.Contains(jsonText(response), "synthetic-") || strings.Contains(jsonText(response), "credentialRef") {
			t.Fatal("public settings exposed credentials")
		}
	}
}

func TestUnavailableManualModelFallsBackToConnectedMagpie(t *testing.T) {
	b, h := fixture(t)
	path := filepath.Join(b.Models.Home, "secrets", magpieConfigName)
	if err := os.WriteFile(path, []byte(jsonText(Object{"model": "magpie", "baseURL": "http://localhost:34567/v1", "key": "synthetic-magpie-key"})), 0600); err != nil {
		t.Fatal(err)
	}
	manual := apiTest(t, h, "POST", "/api/settings/providers", providerFixture("Manual", "http://localhost:12345/v1", "synthetic-manual-key"), 201)
	id := stringOf(manual["savedProviderId"])
	apiTest(t, h, "POST", "/api/settings/model/select", Object{"providerId": id, "modelId": "model-one"}, 200)
	apiTest(t, h, "DELETE", "/api/settings/providers/"+id, nil, 200)
	if b.Models.Active().Name != "magpie" || b.Models.Providers()["activeProviderId"] != "magpie" {
		t.Fatal("deleting the chosen manual provider did not fall back consistently")
	}
}

func TestMagpieBootstrapKeepsSelectionLabelsAndSourceDistinct(t *testing.T) {
	b, h := fixture(t)
	const name = "route/opaque-model"
	path := filepath.Join(b.Models.Home, "secrets", magpieConfigName)
	cfg := Object{"model": name, "baseURL": "http://localhost:34567/v1", "key": "synthetic-private-key", "catalog": []Object{{"id": name, "name": "Claude Sonnet · 区域路由"}}}
	if err := os.WriteFile(path, []byte(jsonText(cfg)), 0600); err != nil {
		t.Fatal(err)
	}
	check := func(providerID, modelID, label, providerName string) {
		t.Helper()
		boot := apiTest(t, h, "GET", "/api/bootstrap", nil, 200)
		selection := object(boot["modelSelection"])
		if boot["modelName"] != name || selection["providerId"] != providerID || selection["modelId"] != modelID || selection["displayName"] != label || selection["providerName"] != providerName {
			t.Fatalf("incorrect public selection: %v", selection)
		}
		if strings.Contains(jsonText(boot), "synthetic-private-key") || strings.Contains(jsonText(boot), "credentialRef") || selection["url"] != nil || selection["baseURL"] != nil {
			t.Fatal("bootstrap leaked private model configuration")
		}
	}
	check("magpie", name, "Claude Sonnet · 区域路由", "Magpie")
	manual := apiTest(t, h, "POST", "/api/settings/providers", Object{"name": "Manual", "baseURL": "http://localhost:12345/v1", "protocol": "openai", "enabled": true, "models": []Object{{"id": "local-model", "name": name, "displayName": "Manual Alias", "enabled": true}}}, 201)
	providerID := stringOf(manual["savedProviderId"])
	apiTest(t, h, "POST", "/api/settings/model/select", Object{"providerId": providerID, "modelId": "local-model"}, 200)
	check(providerID, "local-model", "Manual Alias", "Manual")
	apiTest(t, h, "POST", "/api/settings/model/select", Object{"providerId": "magpie", "modelId": name}, 200)
	check("magpie", name, "Claude Sonnet · 区域路由", "Magpie")
	// The legacy single-model bridge has no catalog display label.
	cfg["catalog"] = []Object{}
	if err := os.WriteFile(path, []byte(jsonText(cfg)), 0600); err != nil {
		t.Fatal(err)
	}
	check("magpie", name, name, "Magpie")
	if err := os.WriteFile(path, []byte("{}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	check(providerID, "local-model", "Manual Alias", "Manual")
}
