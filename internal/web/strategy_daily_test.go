package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/testsupport/legacystrategy"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func TestStrategyDailyLongContextRetriesActualFailedReadWithoutCorrectionBudget(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	var samples, requests atomic.Int32
	health := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Error("unexpected health path")
		}
		if samples.Add(1) == 1 {
			// An HTTP failure is deterministic across Unix and Windows curl;
			// abruptly closing a socket can report either EOF or a reset.
			http.Error(w, "temporary health failure", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"healthy":true,"evidence":"daily-real-read"}`)
	}))
	defer health.Close()
	command := "curl -fsS --max-time 2 " + health.URL + "/health"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		_ = json.NewDecoder(r.Body).Decode(&request)
		if strings.Contains(jsonText(request["tools"]), "revise_readonly_strategy") {
			t.Error("ordinary retry registered online controller")
		}
		n := requests.Add(1)
		if n <= 2 {
			if n == 2 {
				messages := objects(request["messages"])
				if !strings.Contains(stringOf(messages[len(messages)-1]["content"]), `"exitCode":22`) {
					t.Error("actual initial curl failure missing")
				}
			}
			emitModel(w, "", []ai.Call{{ID: fmt.Sprintf("daily-read-%d", n), Name: "shell", Arguments: jsonText(Object{"command": command})}})
			return
		}
		if !strings.Contains(jsonText(request["messages"]), "daily-real-read") {
			t.Error("actual recovery evidence missing")
		}
		emitModel(w, "首次请求失败，第二次检查取得 healthy=true；不能据此确认整个业务恢复。", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "daily-long-context", Protocol: "openai", ContextWindow: 200000, MaxOutput: 1024})
	// The old saved true flag has no versioned experimental consent.
	_, err := b.Store.SetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "legacy-true", 0, StrategySettingsInput{MasterEnabled: true, CorrectEnabled: false, OnlineCorrectEnabled: false, Budget: strategy.DefaultBudget()})
	if err != nil {
		t.Fatal(err)
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref, "contextWindow": 200000, "silentCommands": true, "silentTerminalCreation": true}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "检查健康端点，失败可按当前证据调整调查。以下是历史资料：" + strings.Repeat("历史", 10500)}, 202)
	b.workers.Wait()
	view, _ := b.Engine.Snapshot(id)
	t.Logf("retry fixture: status=%s modelRequests=%d healthSamples=%d", view.Status, requests.Load(), samples.Load())
	for _, terminal := range objects(b.Store.Snapshot(id)["terminals"]) {
		for _, entry := range objects(b.Store.History(id, stringOf(terminal["id"]))["entries"]) {
			output := stringOf(entry["output"])
			// Report only status, numeric codes and booleans, never command output.
			t.Logf("retry fixture command: status=%s exitCode=%v outputBytes=%d missingExecutable=%t recovered=%t", stringOf(entry["status"]), entry["exitCode"], len(output), strings.Contains(output, "command not found") || strings.Contains(output, "No such file"), strings.Contains(output, "daily-real-read"))
		}
	}
	if view.Status != "completed" || requests.Load() != 3 || samples.Load() != 2 {
		t.Fatal("ordinary retry interrupted or replayed", view.Status, requests.Load(), samples.Load())
	}
	for _, card := range view.Cards {
		if card.Type == "strategy_correction" {
			t.Fatal("ordinary retry created correction state")
		}
	}
	if len(view.OperationOutcomes) != 0 {
		t.Fatal("known failed read became an unknown operation")
	}
}

func TestRetiredAssetsNeverInjectAndRejectedSettingsDoNotCancelForeground(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	ctx := StrategyContext{ProjectID: project}
	scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}
	enableStrategyFixture(t, b.Store)
	in := strategyInput("Preserve facts separately from hypotheses.")
	in.Kind = strategy.ReportGuidance
	in.Reuse = &legacystrategy.ReusePolicy{General: true}
	in.Applicability = strategy.Applicability{}
	created, err := b.Store.CreateStrategyAsset(ctx, scope, "asset", in)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := b.Store.GetStrategyRevision(ctx, created.AssetID, 1)
	_, err = b.Store.BindStrategyAsset(ctx, scope, "adopt", StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref})
	if err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		_ = json.NewDecoder(r.Body).Decode(&request)
		if strings.Contains(jsonText(request["messages"]), in.Body) {
			t.Error("retired asset injected into ordinary turn")
		}
		if requests.Add(1) == 1 {
			old, _ := b.Store.GetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope})
			body := Object{"expectedRevision": old.Revision, "masterEnabled": true, "applyEnabled": true, "learnEnabled": false, "correctEnabled": false, "budget": old.Budget}
			strategyHTTP(t, h, "PATCH", "/api/strategy/settings", "learn-off", jsonText(body), 410)
			emitModel(w, "", []ai.Call{{ID: "normal-tool", Name: "todo_write", Arguments: `{"todos":[{"content":"continue investigation","status":"completed"}]}`}})
			return
		}
		emitModel(w, "调查按原证据完成。", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "learning-toggle", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "检查当前证据"}, 202)
	b.workers.Wait()
	view, _ := b.Engine.Snapshot(id)
	if view.Status != "completed" || requests.Load() != 2 || len(view.Todos) != 1 {
		t.Fatal("learning-only change cancelled foreground", view.Status, requests.Load())
	}
}
