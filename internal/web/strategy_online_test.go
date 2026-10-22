package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func TestStrategyOnlineOptInInheritanceAndFreshGuard(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	ctx := StrategyContext{ProjectID: project}
	global := strategy.Scope{Kind: strategy.UserScope}
	local := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}
	// Existing P6 consent does not silently enable online execution.
	in := StrategySettingsInput{MasterEnabled: true, ApplyEnabled: true, LearnEnabled: true, CorrectEnabled: true, Budget: strategy.DefaultBudget()}
	_, err := b.Store.SetStrategySettings(StrategyContext{}, global, "p6", 0, in)
	if err != nil {
		t.Fatal(err)
	}
	effective, _ := b.Store.EffectiveStrategySettings(ctx)
	if effective.Settings.OnlineCorrectEnabled {
		t.Fatal("P6 enabled online corrections")
	}
	if b.strategyCorrectionGuard(context.Background(), session, effective.GlobalEpoch, effective.ProjectEpoch) == nil {
		t.Fatal("missing online consent accepted")
	}
	in.OnlineCorrectEnabled = true
	_, err = b.Store.SetStrategySettings(StrategyContext{}, global, "online", 1, in)
	if err != nil {
		t.Fatal(err)
	}
	effective, _ = b.Store.EffectiveStrategySettings(ctx)
	if !effective.Settings.OnlineCorrectEnabled {
		t.Fatal("unsaved project did not inherit explicit global opt-in")
	}
	if err := b.strategyCorrectionGuard(context.Background(), session, effective.GlobalEpoch, effective.ProjectEpoch); err != nil {
		t.Fatal(err)
	}
	old := effective
	in.OnlineCorrectEnabled = false
	_, err = b.Store.SetStrategySettings(ctx, local, "restrict", 0, in)
	if err != nil {
		t.Fatal(err)
	}
	effective, _ = b.Store.EffectiveStrategySettings(ctx)
	if effective.Settings.OnlineCorrectEnabled {
		t.Fatal("project restriction ignored")
	}
	if b.strategyCorrectionGuard(context.Background(), session, old.GlobalEpoch, old.ProjectEpoch) == nil {
		t.Fatal("stale role dispatched after revocation")
	}
	in.OnlineCorrectEnabled = true
	_, err = b.Store.SetStrategySettings(ctx, local, "allow", 1, in)
	if err != nil {
		t.Fatal(err)
	}
	in.CorrectEnabled = false
	_, err = b.Store.SetStrategySettings(StrategyContext{}, global, "master-off", 2, in)
	if err != nil {
		t.Fatal(err)
	}
	effective, _ = b.Store.EffectiveStrategySettings(ctx)
	if effective.Settings.OnlineCorrectEnabled {
		t.Fatal("online bypassed correction master switch")
	}
	if b.strategyCorrectionGuard(context.Background(), "foreign-session", 0, 0) == nil {
		t.Fatal("missing host session accepted")
	}
}

func TestStrategyOnlineHTTPOptionalFlagDefaultsOff(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	body := Object{"expectedRevision": 0, "masterEnabled": true, "applyEnabled": true, "learnEnabled": true, "correctEnabled": true, "budget": strategy.DefaultBudget()}
	strategyHTTP(t, h, "PATCH", "/api/strategy/settings", "old-client", jsonText(body), 200)
	settings := strategyHTTP(t, h, "GET", "/api/strategy/settings", "", "", 200)
	if object(settings["settings"])["onlineCorrectEnabled"] != false || object(settings["capabilities"])["onlineCorrect"] != true {
		t.Fatal(settings)
	}
	body["expectedRevision"] = 1
	body["onlineCorrectEnabled"] = true
	strategyHTTP(t, h, "PATCH", "/api/strategy/settings", "new-client", jsonText(body), 200)
	effective, _ := b.Store.EffectiveStrategySettings(StrategyContext{ProjectID: project})
	if !effective.Settings.OnlineCorrectEnabled {
		t.Fatal("explicit HTTP online opt-in missing")
	}
}

func TestStrategyOnlineProgressDoesNotStartUnbudgetedSummary(t *testing.T) {
	b, _ := fixture(t)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		emitModel(w, "已确认资源状态，继续检查。", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "progress-fixture", Protocol: "openai"})
	view := progressFixtureView()
	view.RootTurnID = "current"
	view.Cards = append(view.Cards, ai.Card{Type: "strategy_correction", Status: "running", At: view.TurnStartedAt, Data: Object{"turnId": "current"}})
	load := func() (ai.View, error) { return view, nil }
	result := b.summarizeProgress(context.Background(), "session", view.TurnStartedAt, load)
	if result["reason"] != "bounded_strategy_correction" || result["pending"] != false || calls.Load() != 0 || len(b.progressSummaries) != 0 {
		t.Fatal("live summary bypassed correction request budget", result)
	}
	view.Cards[len(view.Cards)-1].Status = "completed"
	if result := b.summarizeProgress(context.Background(), "session", view.TurnStartedAt, load); result["reason"] != "bounded_strategy_correction" || calls.Load() != 0 {
		t.Fatal("same-turn stopped correction started another summary")
	}
	view.Cards[len(view.Cards)-1].Data = Object{"turnId": "historical"}
	_ = b.summarizeProgress(context.Background(), "session", view.TurnStartedAt, load)
	if calls.Load() != 1 {
		t.Fatal("historical correction disabled ordinary new-turn progress")
	}
}
