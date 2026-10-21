package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func TestStrategyWebApplyOffOnNewRevisionAndProjectCap(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	base := "/api/projects/" + project + "/strategy"
	var mu sync.Mutex
	requests := []string{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		_ = json.NewDecoder(r.Body).Decode(&request)
		mu.Lock()
		messages := objects(request["messages"])
		system := ""
		for _, msg := range messages {
			if msg["role"] == "system" {
				system += stringOf(msg["content"])
			}
		}
		requests = append(requests, system)
		mu.Unlock()
		emitModel(w, "已收到。", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "strategy fixture", Protocol: "openai", ContextWindow: 200000, MaxOutput: 1024})
	ctx := StrategyContext{ProjectID: project}
	scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}
	input := StrategyAssetInput{Title: "Reports", Kind: strategy.ReportGuidance, Body: "P3_FROZEN_VERSION_ONE: organize a report by evidence."}
	asset, err := b.Store.CreateStrategyAsset(ctx, scope, "asset", input)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := b.Store.GetStrategyRevision(ctx, asset.AssetID, 1)
	_, err = b.Store.BindStrategyAsset(ctx, scope, "adopt", StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref})
	if err != nil {
		t.Fatal(err)
	}
	send := func() {
		apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "回复收到，无需工具。"}, 202)
		waitAI(t, b, id, "completed")
		b.workers.Wait()
	}
	send() // Adopted but master/apply remain off.
	settings := Object{"expectedRevision": 0, "masterEnabled": true, "applyEnabled": true, "learnEnabled": false, "correctEnabled": false, "budget": strategy.DefaultBudget()}
	strategyHTTP(t, h, "PATCH", "/api/strategy/settings", "enable", jsonText(settings), 200)
	send()
	input.Body = "P3_UNADOPTED_VERSION_TWO: new preference."
	_, err = b.Store.ReviseStrategyAsset(ctx, asset.AssetID, "new-version", 1, 1, input)
	if err != nil {
		t.Fatal(err)
	}
	send()
	// An explicit project restriction wins over global enablement.
	settings["applyEnabled"] = false
	strategyHTTP(t, h, "PATCH", base+"/settings", "cap", jsonText(settings), 200)
	send()
	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 4 {
		t.Fatalf("unexpected model dispatches: %d", len(requests))
	}
	if strings.Contains(requests[0], "P3_FROZEN_VERSION_ONE") || !strings.Contains(requests[1], "P3_FROZEN_VERSION_ONE") || !strings.Contains(requests[2], "P3_FROZEN_VERSION_ONE") || strings.Contains(requests[2], "P3_UNADOPTED_VERSION_TWO") || strings.Contains(requests[3], "P3_FROZEN_VERSION_ONE") {
		t.Fatal("apply/adoption/project cap did not control actual requests")
	}
}

func TestStrategySwitchOffCancelsInFlightRequest(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	entered := make(chan struct{})
	release := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		select {
		case <-r.Context().Done():
		case <-release:
		}
		emitModel(w, "已收到。", nil)
	}))
	defer func() { close(release); provider.Close() }()

	b.Models.Save(&ai.Model{URL: provider.URL, Name: "strategy cancel fixture", Protocol: "openai", ContextWindow: 200000, MaxOutput: 1024})
	settings := Object{"expectedRevision": 0, "masterEnabled": true, "applyEnabled": true, "learnEnabled": false, "correctEnabled": false, "budget": strategy.DefaultBudget()}
	strategyHTTP(t, h, "PATCH", "/api/strategy/settings", "enable", jsonText(settings), 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "回复收到。"}, 202)
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("provider was not reached")
	}
	settings["expectedRevision"] = 1
	settings["masterEnabled"] = false
	strategyHTTP(t, h, "PATCH", "/api/strategy/settings", "disable", jsonText(settings), 200)
	waitAI(t, b, id, "cancelled")
	b.workers.Wait()
}
