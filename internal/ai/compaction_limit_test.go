package ai

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestCompactionUsesLowReasoningRetriesSummaryOnly(t *testing.T) {
	attempts := 0
	m, close := fakeModel(t, func(_ int, b map[string]any) any {
		first := str(obj(arr(b["messages"])[0])["content"])
		if strings.Contains(first, "handoff summary") {
			attempts++
			if obj(b["thinking"])["type"] != "disabled" || b["tools"] != nil {
				t.Error("summary inherited high reasoning or exposed tools")
			}
			if attempts == 1 {
				return map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "INCOMPLETE_SUMMARY"}, "finish_reason": "length"}}}
			}
			if num(b["max_tokens"], 0) != 8192 {
				t.Error("retry did not stay within configured output ceiling")
			}
			return response("Compact handoff: keep the host and continue the user's CPU question.")
		}
		return response("reply")
	})
	defer close()
	m.Name = "deepseek-flash"
	m.ReasoningEffort = "max"
	m.MaxOutput = 8192
	e := engineFor(t, m, nil)
	for _, text := range []string{"one", "two"} {
		if err := e.Chat(context.Background(), "case", text, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.Compact(context.Background(), "case"); err != nil {
		t.Fatal(err)
	}
	if attempts != 2 {
		t.Fatal("unexpected summary retry count")
	}
	h, _ := e.History("case")
	if strings.Contains(js(h), "INCOMPLETE_SUMMARY") || validHistory(h) != nil {
		t.Fatal("truncated handoff was committed")
	}
	s, _ := e.get("case")
	s.mu.Lock()
	effort := s.state.Config.Model.ReasoningEffort
	s.mu.Unlock()
	if effort != "max" {
		t.Fatal("summary changed the user's investigation reasoning setting")
	}
}

func TestFailedCompactionPreservesHistoryAndCheckpoints(t *testing.T) {
	attempts := 0
	m, close := fakeModel(t, func(_ int, b map[string]any) any {
		if strings.Contains(str(obj(arr(b["messages"])[0])["content"]), "handoff summary") {
			attempts++
			return map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "discarded"}, "finish_reason": "length"}}}
		}
		return response("reply")
	})
	defer close()
	e := engineFor(t, m, nil)
	for _, text := range []string{"one", "two"} {
		if err := e.Chat(context.Background(), "case", text, nil); err != nil {
			t.Fatal(err)
		}
	}
	before, _ := e.History("case")
	err := e.Compact(context.Background(), "case")
	if !errors.Is(err, ErrModelOutputLimit) || attempts != 2 {
		t.Fatal("output limit was not bounded to one retry")
	}
	after, _ := e.History("case")
	if !reflect.DeepEqual(before, after) {
		t.Fatal("failed summary changed original history")
	}
	if err := e.Rollback("case"); err != nil {
		t.Fatal("failed compaction destroyed the turn checkpoint")
	}
}
