package ai

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func configureRetiredOnline(t *testing.T, e *Engine) (*session, Config) {
	t.Helper()
	s, _ := e.get("case")
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	c.StrategyCorrectEnabled = true
	c.StrategyBudget = strategy.DefaultBudget()
	c.StrategyGlobalEpoch = 1
	c.StrategyProjectEpoch = 2
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	c = s.state.Config
	s.state.View.RootTurnID = "root"
	s.mu.Unlock()
	return s, c
}

func TestOnlineMemoryToolErrorsDoNotInterruptOfficialADK(t *testing.T) {
	for _, name := range []string{"list_project_memories", "read_project_memory", "save_project_memory", "forget_project_memory"} {
		t.Run(name, func(t *testing.T) {
			var requests, calls atomic.Int32
			m, close := fakeModel(t, func(_ int, body map[string]any) any {
				if requests.Add(1) == 1 {
					return response("", Call{ID: "memory", Name: name, Arguments: `{"key":"preference","type":"feedback","description":"format","body":"facts before conclusions","expectedRevision":0}`})
				}
				if !strings.Contains(js(body), "explicit_memory_intent_required") {
					t.Error("normal tool rejection was hidden")
				}
				return response("Memory was not changed; continuing the answer.")
			})
			defer close()
			e := engineFor(t, m, func(_ context.Context, _, tool string, _ map[string]any, _ bool) (any, error) {
				if tool == "project_memory_index" {
					return nil, nil
				}
				if tool == name {
					calls.Add(1)
					return nil, errors.New("explicit_memory_intent_required")
				}
				t.Error("unexpected bridge dispatch", tool)
				return nil, errors.New("not authorized")
			})
			s, c := configureRetiredOnline(t, e)
			c.MemoryEnabled = true
			c.MemoryProjectID = "project"
			if err := e.Configure("case", c); err != nil {
				t.Fatal(err)
			}
			if err := e.Chat(context.Background(), "case", "纠正一下，以后请先列事实。", nil); err != nil {
				t.Fatal("memory error escaped normal tool handling", err)
			}
			if requests.Load() != 2 || calls.Load() != 1 {
				t.Fatal("tool/model replay", requests.Load(), calls.Load())
			}
			report, err := e.onlineCurrent(s, c)
			if err != nil || report != nil {
				t.Fatal("memory created durable resource correction", err)
			}
			view, _ := e.Snapshot("case")
			if view.Status != "completed" {
				t.Fatal("ordinary reply did not complete", view.Status)
			}
			for _, card := range view.Cards {
				if card.Type == "strategy_correction" {
					t.Fatal("misleading correction card")
				}
			}
		})
	}
}
