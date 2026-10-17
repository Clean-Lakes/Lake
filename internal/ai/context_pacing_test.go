package ai

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestAutomaticCompactionUsesMeasuredInputAcrossToolBatches(t *testing.T) {
	path := filepath.Join(t.TempDir(), "observations.log")
	if err := os.WriteFile(path, []byte(strings.Repeat("log entry\n", 1200)), 0600); err != nil {
		t.Fatal(err)
	}
	requests := 0
	m, close := fakeModel(t, func(n int, b map[string]any) any {
		requests++
		if b["tools"] == nil {
			t.Error("extra model summary despite measured input below budget")
		}
		var r any
		if n <= 14 {
			r = response("正在核查。", Call{ID: fmt.Sprint(n), Name: "read", Arguments: js(map[string]any{"path": path, "limit": 1200})})
		} else {
			r = response("检查完成。")
		}
		r.(map[string]any)["usage"] = map[string]any{"prompt_tokens": 15000 + n*1500, "completion_tokens": 100}
		return r
	})
	defer close()
	m.MaxOutput = 8192
	e := engineFor(t, m, nil)
	if err := e.Chat(context.Background(), "case", "只读核查日志。", nil); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	if requests != 15 || historyCost(s.state.History)+len(js(Catalog("core"))) <= (m.ContextWindow-m.MaxOutput)*2 {
		t.Fatal("fixture did not cross the old byte-based trigger")
	}
	for _, card := range s.state.View.Cards {
		if card.Type == "compaction" {
			t.Fatal("premature context maintenance")
		}
	}
	loaded, err := New(e.Dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer loaded.Shutdown()
	ls, _ := loaded.get("case")
	if !reflect.DeepEqual(ls.state.ContextMeasurement, s.state.ContextMeasurement) {
		t.Fatal("provider measurement anchor lost on reload")
	}
	if err := loaded.compact(context.Background(), ls, ls.state.Config, false); err != nil || requests != 15 {
		t.Fatal("reload triggered an unnecessary summary", err)
	}
}

func TestMeasuredContextCountsNewMaterialAndCatalogGrowth(t *testing.T) {
	history := []Message{{Role: "system", Content: "policy"}, {Role: "user", Content: "question"}}
	state := State{Config: Config{Model: Model{Name: "test"}}, LastRequest: &Usage{InputKnown: true, Input: 20000, CachedInput: usageInt(19000)}}
	state.ContextMeasurement = &ContextMeasurement{ModelID: ModelIdentity(state.Config.Model), HistoryCost: historyCost(history), ToolsCost: 40000}
	base := estimatedContextCost(state, history, 40000)
	if base != 44000 {
		t.Fatal("cached input deducted or margin missing", base)
	}
	grown := append(append([]Message(nil), history...), Message{Role: "assistant", Content: strings.Repeat("new observation ", 6000)})
	want := base + historyCost(grown) - historyCost(history) + 3000
	if got := estimatedContextCost(state, grown, 43000); got != want || got < 112000 {
		t.Fatal("new content or new tools escaped the budget", got, want)
	}
	for _, mutate := range []func(*State){
		func(s *State) { s.ContextMeasurement = nil }, // Pre-upgrade history.
		func(s *State) { s.LastRequest = nil },
		func(s *State) { s.LastRequest = &Usage{} },
		func(s *State) { s.LastRequest = &Usage{InputKnown: true, Input: 0} },
		func(s *State) { s.Config.Model.Name = "new model" },
	} {
		copy := state
		mutate(&copy)
		if got := estimatedContextCost(copy, grown, 43000); got != historyCost(grown)+43000 {
			t.Fatal("unknown/stale measurement did not use conservative fallback", got)
		}
	}
}

func TestAutomaticCompactionReducesOldToolsWithHeadroom(t *testing.T) {
	m, close := fakeModel(t, func(_ int, _ map[string]any) any {
		t.Error("old output previews should not require a model summary")
		return response("unused")
	})
	defer close()
	e := engineFor(t, m, nil)
	s, _ := e.get("case")
	original := longFirstTurn()
	s.state.History = original
	s.state.View.Cards = []Card{{ID: "raw", Type: "operation", Content: original[3].Content, Status: "completed"}}
	if err := e.compact(context.Background(), s, s.state.Config, false); err != nil {
		t.Fatal(err)
	}
	after := s.state.History
	if validHistory(after) != nil || len(after) != len(original) || !reflect.DeepEqual(after[6:], original[6:]) || !reflect.DeepEqual(after[:2], original[:2]) {
		t.Fatal("latest full batch, user message or tool pairing changed")
	}
	if !strings.Contains(after[3].Content, "context_truncated") || s.state.View.Cards[0].Content != original[3].Content {
		t.Fatal("preview missing or original operation changed")
	}
	budget := (m.ContextWindow - m.MaxOutput) * 2
	if historyCost(after)+len(js(e.sessionCatalog(context.Background(), "case", s.state.Config))) > budget*3/4 {
		t.Fatal("maintenance left insufficient headroom")
	}
	// A small next batch must not immediately trigger the same work again.
	s.state.History = append(after, Message{Role: "assistant", Calls: []Call{{ID: "next", Name: "shell", Arguments: `{}`}}}, Message{Role: "tool", CallID: "next", Name: "shell", Content: strings.Repeat("ok ", 1000)})
	count := len(s.state.View.Cards)
	if err := e.compact(context.Background(), s, s.state.Config, false); err != nil || len(s.state.View.Cards) != count {
		t.Fatal("next small batch triggered maintenance again", err)
	}
}

func TestActualInputCanTriggerCompactionBelowByteEstimate(t *testing.T) {
	requests := 0
	m, close := fakeModel(t, func(_ int, _ map[string]any) any {
		requests++
		return response("保留当前目标、已完成观察与后续步骤。")
	})
	defer close()
	e := engineFor(t, m, nil)
	s, _ := e.get("case")
	s.state.History = []Message{{Role: "system", Content: "policy"}, {Role: "user", Content: "earlier"}, {Role: "assistant", Content: "done"}, {Role: "user", Content: "continue"}}
	// Fixed prompt/tool overhead makes a 16 KB summary reserve miss the low
	// target. Older complete turns can still be summarized; a no-op preview
	// must not take their place and cause another maintenance cycle.
	target := (m.ContextWindow - m.MaxOutput) * 2 * 3 / 4
	s.state.History[0].Content = strings.Repeat("p", max(1, target-len(js(Catalog("core")))-8000))
	s.state.LastRequest = &Usage{InputKnown: true, Input: 64000}
	s.state.ContextMeasurement = &ContextMeasurement{ModelID: ModelIdentity(m), HistoryCost: historyCost(s.state.History), ToolsCost: len(js(Catalog("core")))}
	if err := e.compact(context.Background(), s, s.state.Config, false); err != nil || requests != 1 {
		t.Fatal("high actual input was ignored or produced a no-op maintenance loop", err, requests)
	}
	if s.state.LastRequest != nil || s.state.ContextMeasurement != nil {
		t.Fatal("compaction retained an invalid provider measurement")
	}
}

func TestContextMeasurementInvalidatesWhenRequestProjectionChanges(t *testing.T) {
	for _, kind := range []string{"memory", "profile", "images"} {
		t.Run(kind, func(t *testing.T) {
			m, close := fakeModel(t, func(_ int, _ map[string]any) any { return response("reply") })
			defer close()
			e := engineFor(t, m, nil)
			if err := e.Chat(context.Background(), "case", "question", nil); err != nil {
				t.Fatal(err)
			}
			s, _ := e.get("case")
			c := s.state.Config
			switch kind {
			case "memory":
				c.MemoryEnabled = !c.MemoryEnabled
			case "profile":
				c.Profile = "terminal2"
			case "images":
				c.Model.SupportsImageInput = true
			}
			if err := e.Configure("case", c); err != nil {
				t.Fatal(err)
			}
			if s.state.ContextMeasurement != nil || s.state.LastRequest == nil {
				t.Fatal("projection retained a stale anchor or lost the actual request usage")
			}
		})
	}
}
