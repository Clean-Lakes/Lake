package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

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
