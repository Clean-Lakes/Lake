package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

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
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			conn.Close()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"healthy":true,"evidence":"daily-real-read"}`)
	}))
	defer health.Close()
	command := "curl -sS --max-time 2 " + health.URL + "/health"
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
				if !strings.Contains(stringOf(messages[len(messages)-1]["content"]), `"exitCode":52`) {
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
	_, err := b.Store.SetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "legacy-true", 0, StrategySettingsInput{MasterEnabled: true, CorrectEnabled: true, OnlineCorrectEnabled: true, Budget: strategy.DefaultBudget()})
	if err != nil {
		t.Fatal(err)
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref, "contextWindow": 200000, "silentCommands": true, "silentTerminalCreation": true}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "检查健康端点，失败可按当前证据调整调查。以下是历史资料：" + strings.Repeat("历史", 10500)}, 202)
	b.workers.Wait()
	view, _ := b.Engine.Snapshot(id)
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

func TestStrategyLegacyTrueWithoutVersionCannotEnableExperiment(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	input := Object{"expectedRevision": 0, "masterEnabled": true, "applyEnabled": false, "learnEnabled": true, "correctEnabled": true, "onlineCorrectEnabled": true, "budget": strategy.DefaultBudget()}
	strategyHTTP(t, h, "PATCH", "/api/strategy/settings", "old-client-true", jsonText(input), 200)
	stored, _ := b.Store.GetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope})
	if stored.OnlineCorrectEnabled || !stored.LearnEnabled || stored.ApplyEnabled {
		t.Fatal("old client enabled online or lost independent learning choice", stored)
	}
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		_ = json.NewDecoder(r.Body).Decode(&request)
		if strings.Contains(jsonText(request["tools"]), "revise_readonly_strategy") || strings.Contains(jsonText(request["messages"]), "Optional bounded read-only correction is enabled") {
			t.Error("legacy consent activated controller")
		}
		if requests.Add(1) == 1 {
			emitModel(w, "", []ai.Call{{ID: "failed-read", Name: "read_project_memory", Arguments: `{"key":"not-present"}`}})
		} else {
			emitModel(w, "未找到记录，继续按本次证据回答。", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "ordinary", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "检查已有记忆"}, 202)
	b.workers.Wait()
	view, _ := b.Engine.Snapshot(id)
	if view.Status != "completed" || requests.Load() != 2 {
		t.Fatal("legacy controller interrupted ordinary task", view.Status, requests.Load())
	}
	for _, card := range view.Cards {
		if card.Type == "strategy_correction" {
			t.Fatal("ordinary task created correction state")
		}
	}
	effective, _ := b.Store.EffectiveStrategySettings(StrategyContext{ProjectID: project})
	if effective.Settings.OnlineCorrectEnabled {
		t.Fatal("legacy consent inherited by project")
	}
}

func TestStrategyLearningToggleDoesNotCancelTurnUsingAdoptedAsset(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	ctx := StrategyContext{ProjectID: project}
	scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}
	enableStrategyFixture(t, b.Store)
	in := strategyInput("Preserve facts separately from hypotheses.")
	in.Kind = strategy.ReportGuidance
	in.Reuse = &strategy.ReusePolicy{General: true}
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
		if !strings.Contains(jsonText(request["messages"]), in.Body) {
			t.Error("adopted asset lost during learning-only change")
		}
		if requests.Add(1) == 1 {
			old, _ := b.Store.GetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope})
			body := Object{"expectedRevision": old.Revision, "masterEnabled": true, "applyEnabled": true, "learnEnabled": false, "correctEnabled": false, "budget": old.Budget}
			strategyHTTP(t, h, "PATCH", "/api/strategy/settings", "learn-off", jsonText(body), 200)
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
	// A source withdrawal must still invalidate a context which used it.
	selected, err := b.Store.resolveStrategyBindings(ctx, strategy.SelectionQuery{Profile: "core"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = b.Store.ForgetStrategySource(ctx, created.SourceID, "withdraw", true)
	if err != nil {
		t.Fatal(err)
	}
	_, err = b.Store.resolveStrategyBindings(ctx, strategy.SelectionQuery{Profile: "core"}, &selected.Selection, nil)
	strategyCheckError(t, err, 409)
}

func TestStrategyLegacyConsentMigrationKeepsAuditAndUnknownJobs(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	global := strategy.Scope{Kind: strategy.UserScope}
	_, err = s.SetStrategySettings(StrategyContext{}, global, "saved", 0, StrategySettingsInput{MasterEnabled: true, ApplyEnabled: true, LearnEnabled: true, Budget: strategy.DefaultBudget()})
	if err != nil {
		t.Fatal(err)
	}
	// Model the old deployed JSON, bypassing the new consent normalization.
	s.update(func() any {
		old := s.strategySettings(global)
		old.OnlineCorrectEnabled = true
		old.RuntimePolicyVersion = 0
		old.CorrectEnabled = true
		s.strategySaveSettings("user", old)
		for _, state := range []string{"none", "unknown"} {
			status := "queued"
			if state == "unknown" {
				status = "awaiting_reconciliation"
			}
			s.exec("INSERT INTO strategyJobs(id,scopeKey,accessProjectId,kind,expectedRevision,status,globalEpoch,projectEpoch,sourceSetHash,runtimeId,dispatchState,expiresAtMs,createdAt,updatedAt) VALUES(?,'user','','experiment',0,?,1,0,'hash',?,?,9999999999999,?,?)", state, status, "runtime-"+state, state, now(), now())
		}
		return nil
	})
	s.Close()
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	settings, err := s.GetStrategySettings(StrategyContext{}, global)
	if err != nil || settings.OnlineCorrectEnabled || settings.LegacyOnlineConsent == nil || !settings.LegacyOnlineConsent.Enabled || settings.LegacyOnlineConsent.SettingsRevision != 1 || !settings.ApplyEnabled || !settings.LearnEnabled {
		t.Fatal("migration lost choices/history or kept executable consent", settings, err)
	}
	if row := s.row("SELECT * FROM strategyJobs WHERE id='none'"); row["status"] != "cancelled" || row["errorCode"] != "online_consent_retired" {
		t.Fatal("unclaimed legacy work can run", row)
	}
	if row := s.row("SELECT * FROM strategyJobs WHERE id='unknown'"); row["status"] != "awaiting_reconciliation" || row["dispatchState"] != "unknown" || row["runtimeId"] != "runtime-unknown" {
		t.Fatal("unknown ledger was reset", row)
	}
	before := settings.Revision
	s.update(func() any { s.retireLegacyOnlineConsent(); return nil })
	settings, _ = s.GetStrategySettings(StrategyContext{}, global)
	if settings.Revision != before || integer(s.row("SELECT COUNT(*) AS n FROM strategyEvents WHERE type='online_consent_retired_v2'")["n"]) != 1 {
		t.Fatal("migration not idempotent")
	}
	// Source/permission guard cannot be used with a legacy epoch after migration.
	if effective, _ := s.EffectiveStrategySettings(StrategyContext{}); effective.Settings.OnlineCorrectEnabled || effective.GlobalEpoch <= 1 {
		t.Fatal("stale execution remains effective")
	}
}
