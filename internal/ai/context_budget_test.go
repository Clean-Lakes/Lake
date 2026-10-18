package ai

import (
	"context"
	"strings"
	"testing"

	adksession "google.golang.org/adk/v2/session"
)

func TestContextBudgetUsesKnownCapacityAndClampsManualLimit(t *testing.T) {
	for _, tc := range []struct{ limit, requested, want int }{
		{1000000, 0, 900000}, {128000, 0, 115200}, {8192, 0, 7372},
		{0, 0, 64000}, {1000000, 64000, 64000}, {8192, 64000, 8192},
		{0, 128000, 128000},
	} {
		m := Model{ContextLimit: tc.limit, ContextWindow: tc.requested}
		applyContextBudget(&m)
		if m.ContextWindow != tc.want || m.MaxOutput >= m.ContextWindow {
			t.Fatalf("capacity=%d requested=%d: %+v", tc.limit, tc.requested, m)
		}
	}
}

func TestADKModelCapacityAvoidsCompactionOnConsecutiveTurns(t *testing.T) {
	requests := 0
	m, closeModel := fakeModel(t, func(_ int, body map[string]any) any {
		requests++
		if body["tools"] == nil {
			t.Error("unnecessary summary request")
		}
		if !strings.Contains(js(body["messages"]), "PRESERVE_HISTORY") {
			t.Error("previous conversation lost")
		}
		result := response("recorded").(map[string]any)
		result["usage"] = map[string]any{"prompt_tokens": 40000, "completion_tokens": 20}
		return result
	})
	defer closeModel()
	m.ContextLimit, m.ContextWindow = 1000000, 0
	e := engineFor(t, m, nil)
	s, _ := e.get("case")
	s.state.History = []Message{{Role: "system", Content: "policy"}, {Role: "user", Content: "PRESERVE_HISTORY" + strings.Repeat("observation ", 15000)}, {Role: "assistant", Content: "recorded"}}
	s.state.View.Cards = []Card{{ID: "raw-operation", Type: "operation", Content: "ORIGINAL_EVIDENCE", Status: "completed"}}
	for range 3 {
		if err := e.Chat(context.Background(), "case", "continue briefly", nil); err != nil {
			t.Fatal(err)
		}
	}
	view, _ := e.Snapshot("case")
	if requests != 3 || view.Context.Budget != 900000 || s.state.View.Cards[0].Content != "ORIGINAL_EVIDENCE" {
		t.Fatal("budget or operation record changed", requests, view.Context)
	}
	for _, card := range view.Cards {
		if card.Type == "compaction" {
			t.Fatal("consecutive short turns triggered compaction")
		}
	}
}

func TestADKCompactionCallbackReusesBudgetAndLeavesHeadroom(t *testing.T) {
	summaries := 0
	m, closeModel := fakeModel(t, func(_ int, _ map[string]any) any {
		summaries++
		return response("Preserve the target and user constraints. Original operations already completed; never replay them.")
	})
	defer closeModel()
	e := engineFor(t, m, nil)
	s, _ := e.get("case")
	s.state.History = []Message{{Role: "system", Content: "policy"}, {Role: "user", Content: strings.Repeat("older observation ", 4000)}, {Role: "assistant", Content: "done"}, {Role: "user", Content: "continue"}}
	s.state.View.Cards = []Card{{ID: "raw", Type: "operation", Content: "ORIGINAL_EVIDENCE"}}
	s.state.LastRequest = &Usage{InputKnown: true, Input: 64000}
	s.state.ContextMeasurement = &ContextMeasurement{ModelID: ModelIdentity(m), HistoryCost: historyCost(s.state.History), ToolsCost: len(js(e.sessionCatalog(context.Background(), "case", s.state.Config)))}
	n := nativeCompaction{engine: e, session: s, config: s.state.Config}
	events := []*adksession.Event{{}}
	if _, err := n.SummarizeEvents(context.Background(), events); err != nil {
		t.Fatal(err)
	}
	if summaries != 1 || historyCost(s.state.History)+len(js(e.sessionCatalog(context.Background(), "case", s.state.Config))) > (m.ContextWindow-m.MaxOutput)*2*3/4 {
		t.Fatal("required compaction did not leave headroom", summaries)
	}
	for range 3 {
		s.state.History = append(s.state.History, Message{Role: "assistant", Content: "done"}, Message{Role: "user", Content: "continue"})
		if _, err := n.SummarizeEvents(context.Background(), events); err != nil {
			t.Fatal(err)
		}
		if err := e.compact(context.Background(), s, s.state.Config, false); err != nil {
			t.Fatal(err)
		}
	}
	if summaries != 1 || s.state.View.Cards[0].Content != "ORIGINAL_EVIDENCE" {
		t.Fatal("SDK callback forced repeated summaries or changed operation records", summaries)
	}
}
