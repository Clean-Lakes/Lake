package ai

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func TestStrategyRetiredDirectAndRestoredConfigCannotRegisterOrExecuteCorrection(t *testing.T) {
	m, close := fakeModel(t, func(n int, body map[string]any) any {
		if strings.Contains(js(body["tools"]), onlineRevisionTool) || strings.Contains(js(body), "Optional bounded read-only correction is enabled") {
			t.Error("retired controller registered")
		}
		if n == 1 {
			return response("", Call{ID: "old-proposal", Name: onlineRevisionTool, Arguments: `{}`})
		}
		return response("继续正常回答，不执行旧提案。")
	})
	defer close()
	e := engineFor(t, m, nil)
	s, _ := e.get("case")
	c := s.state.Config
	if err := json.Unmarshal([]byte(`{"StrategyCorrectEnabled":true,"StrategyLearnEnabled":true,"StrategyBudget":{"maxRevisions":99}}`), &c); err != nil {
		t.Fatal(err)
	}
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(js(s.state.Config), "StrategyCorrectEnabled") {
		t.Fatal("retired config persisted")
	}
	if err := e.Chat(context.Background(), "case", "纠正一下，本轮继续回答。", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.invoke(context.Background(), s, c, Call{Name: onlineRevisionTool, ID: "restored", Arguments: `{}`}); err == nil || !strings.Contains(err.Error(), "strategy_execution_retired") {
		t.Fatal("restored invocation admitted", err)
	}
	if len(s.state.StrategyOutbox) != 0 {
		t.Fatal("old config captured new learning")
	}
	store, _ := e.adkStore()
	var count int64
	store.DB.Model(&nativeCorrection{}).Count(&count)
	if count != 0 {
		t.Fatal("old call created a controller")
	}
}

func TestStrategyRetiredOnlineRecoveryKeepsUnknownIdentitiesAndBudgets(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "unused"}, nil)
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"active", "waiting", "unknown", "completed"} {
		r := strategy.OnlineReport{SchemaVersion: 1, ID: state, TurnID: "original-turn", Budget: strategy.DefaultBudget(), Requests: 4, TokensCharged: 777, StartedAt: timestamp(), Observations: []strategy.OnlineObservation{{CallID: "original-call", Class: "transient"}}}
		if state == "waiting" {
			r.StopReason = strategy.AwaitingUser
		}
		if state == "unknown" {
			r.InFlightRequest = true
			r.InFlightCall = "original-call"
			r.UsageUnknown = true
		}
		if state == "completed" {
			r.StopReason = strategy.Completed
		}
		if err := store.DB.Create(&nativeCorrection{ID: state, SessionID: "case", Body: js(r)}).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := recoverOnlineCorrections(store.DB); err != nil {
		t.Fatal(err)
	}
	var rows []nativeCorrection
	store.DB.Order("id").Find(&rows)
	for _, row := range rows {
		var r strategy.OnlineReport
		_ = json.Unmarshal([]byte(row.Body), &r)
		if !r.Retired || r.Requests != 4 || r.TokensCharged != 777 || r.TurnID != "original-turn" || r.Observations[0].CallID != "original-call" {
			t.Fatal(row)
		}
		want := strategy.Cancelled
		if row.ID == "unknown" {
			want = strategy.AwaitingReconciliation
			if r.InFlightCall != "original-call" || !r.InFlightRequest || !r.UsageUnknown {
				t.Fatal(r)
			}
		}
		if row.ID == "completed" {
			want = strategy.Completed
		}
		if r.StopReason != want {
			t.Fatal(r)
		}
	}
	if err := recoverOnlineCorrections(store.DB); err != nil {
		t.Fatal(err)
	}
	var again []nativeCorrection
	store.DB.Order("id").Find(&again)
	if js(rows) != js(again) {
		t.Fatal("retirement rewrote history on restart")
	}
}
