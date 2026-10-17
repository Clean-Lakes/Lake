package ai

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestResponsesIncompleteNeverCommitsPartialTextAndKeepsUsage(t *testing.T) {
	for _, whole := range []bool{false, true} {
		for _, reason := range []string{"max_output_tokens", "other"} {
			a := newAccumulator("openai-response", nil)
			body := map[string]any{"status": "incomplete", "incomplete_details": map[string]any{"reason": reason}, "usage": map[string]any{"input_tokens": 1200, "output_tokens": 100}, "output": []any{map[string]any{"type": "message", "content": []any{map[string]any{"type": "output_text", "text": "DISCARD_PARTIAL"}}}}}
			v := body
			if !whole {
				v = map[string]any{"type": "response.incomplete", "response": body}
			}
			err := a.consume(v, whole)
			want := ErrModelIncomplete
			if reason == "max_output_tokens" {
				want = ErrModelOutputLimit
			}
			if !errors.Is(err, want) || a.completed || a.msg.Content != "" || a.usage.Total != 1300 {
				t.Fatalf("whole=%v reason=%s err=%v usage=%+v", whole, reason, err, a.usage)
			}
		}
	}
}

func TestAutomaticCompactionRecoversFromFailedSummaryWithoutReplayingTools(t *testing.T) {
	summaries, replies := 0, 0
	m, close := fakeModel(t, func(_ int, b map[string]any) any {
		if b["tools"] == nil {
			summaries++
			return map[string]any{"status": "incomplete", "incomplete_details": map[string]any{"reason": "max_output_tokens"}, "usage": map[string]any{"input_tokens": 1200, "output_tokens": 100}}
		}
		replies++
		return map[string]any{"status": "completed", "output": []any{map[string]any{"type": "message", "content": []any{map[string]any{"type": "output_text", "text": "继续分析已采集证据，不重复执行。"}}}}}
	})
	defer close()
	m.Protocol = "openai-response"
	m.MaxOutput = 8192
	e := engineFor(t, m, nil)
	s, _ := e.get("case")
	h := []Message{{Role: "system", Content: strings.Repeat("policy ", 400)}, {Role: "user", Content: strings.Repeat("scope ", 3000)}}
	for i := 0; i < 19; i++ {
		id := fmt.Sprintf("collected-%d", i)
		h = append(h, Message{Role: "assistant", Calls: []Call{{ID: id, Name: "shell", Arguments: js(map[string]any{"command": "readonly observation " + strings.Repeat("scope ", 20)})}}}, Message{Role: "tool", CallID: id, Name: "shell", Content: js(map[string]any{"evidence_id": id, "exitCode": 0, "output": strings.Repeat("observed ", 400)})})
	}
	s.state.History = h
	s.state.Checkpoints = []int{0}
	s.state.View.Cards = []Card{{ID: "raw", Type: "operation", Content: h[3].Content, Status: "completed"}}
	s.state.LastRequest = &Usage{InputKnown: true, Input: 52000}
	s.state.ContextMeasurement = &ContextMeasurement{ModelID: ModelIdentity(m), HistoryCost: historyCost(h), ToolsCost: len(js(e.sessionCatalog(context.Background(), "case", s.state.Config)))}
	if err := e.compact(context.Background(), s, s.state.Config, false); err != nil {
		t.Fatal(err)
	}
	if summaries != 2 || validHistory(s.state.History) != nil || !reflect.DeepEqual(s.state.History[:2], h[:2]) || len(s.state.History) != len(h) || s.state.View.Cards[0].Content != h[3].Content || !reflect.DeepEqual(s.state.Checkpoints, []int{0}) {
		t.Fatalf("recovery changed immutable records or skipped summary recovery: summaries=%d", summaries)
	}
	for i := range h {
		if !reflect.DeepEqual(s.state.History[i].Calls, h[i].Calls) || s.state.History[i].CallID != h[i].CallID {
			t.Fatal("recovery changed tool identities")
		}
	}
	if err := e.Chat(context.Background(), "case", "分析已有证据即可。", nil); err != nil || replies != 1 {
		t.Fatal("did not continue after safe context recovery", err, replies)
	}
}

func TestCompactionFallbackDoesNotMutateOnCancellationOrIrreducibleInput(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	s, _ := e.get("case")
	h := []Message{{Role: "system", Content: "policy"}, {Role: "user", Content: strings.Repeat("constraint ", 1000)}}
	s.state.History = h
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if ok, err := e.recoverCompaction(ctx, s, h, 0, 100); ok || !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled fallback continued", err)
	}
	if ok, err := e.recoverCompaction(context.Background(), s, h, 0, 100); ok || err != nil || !reflect.DeepEqual(s.state.History, h) {
		t.Fatal("fallback discarded user constraints to fit", err)
	}
}

func TestCompactionFallbackFitsLargeImmutableAssignmentWithMinimumHeadroom(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	s, _ := e.get("case")
	// A long recorded handoff and already-executed call arguments cannot be
	// removed. They leave room for previews only at the 1/16 reserve tier.
	h := []Message{{Role: "system", Content: "policy"}, {Role: "user", Content: strings.Repeat("scope ", 7000)}}
	for i := 0; i < 10; i++ {
		id := fmt.Sprint(i)
		h = append(h, Message{Role: "assistant", Calls: []Call{{ID: id, Name: "shell", Arguments: `{"command":"already executed"}`}}}, Message{Role: "tool", CallID: id, Name: "shell", Content: strings.Repeat("observed ", 2500)})
	}
	s.state.History = h
	const budget, catalog = 111616, 52961
	if _, fits := fitToolContext(h, budget-budget/8-catalog); fits {
		t.Fatal("fixture does not require the minimum-headroom tier")
	}
	if ok, err := e.recoverCompaction(context.Background(), s, h, catalog, budget); !ok || err != nil {
		t.Fatal("large immutable assignment could not recover", err)
	}
	if historyCost(s.state.History)+catalog > budget-budget/16 || !reflect.DeepEqual(s.state.History[:2], h[:2]) {
		t.Fatal("fallback used the headroom or discarded user constraints")
	}
}
