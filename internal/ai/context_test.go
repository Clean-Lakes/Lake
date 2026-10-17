package ai

import (
	"context"
	"strings"
	"testing"
)

func TestProviderUsageCacheAndPartialFrames(t *testing.T) {
	for _, tc := range []struct {
		protocol             string
		frames               []map[string]any
		input, output, total int
		cached               *int
	}{
		{"openai", []map[string]any{{"prompt_tokens": 100, "completion_tokens": 20, "prompt_tokens_details": map[string]any{"cached_tokens": 80}}, {"prompt_tokens": 100, "completion_tokens": 20}}, 100, 20, 120, usageInt(80)},
		{"openai", []map[string]any{{"prompt_tokens": 100, "completion_tokens": 20, "prompt_cache_hit_tokens": 0}}, 100, 20, 120, usageInt(0)},
		{"openai-response", []map[string]any{{"input_tokens": 100, "output_tokens": 20, "input_tokens_details": map[string]any{"cached_tokens": 60}}}, 100, 20, 120, usageInt(60)},
		{"claude", []map[string]any{{"input_tokens": 10, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 30, "output_tokens": 0}, {"output_tokens": 20}}, 140, 20, 160, usageInt(100)},
		{"gemini", []map[string]any{{"promptTokenCount": 100, "candidatesTokenCount": 20, "thoughtsTokenCount": 30, "totalTokenCount": 150, "cachedContentTokenCount": 80}}, 100, 50, 150, usageInt(80)},
		{"ollama", []map[string]any{{"input_tokens": 100, "output_tokens": 20}}, 100, 20, 120, nil},
	} {
		a := newAccumulator(tc.protocol, nil)
		for _, frame := range tc.frames {
			a.use(frame)
		}
		u := a.usage
		if !u.Known || !u.InputKnown || !u.OutputKnown || u.Input != tc.input || u.Output != tc.output || u.Total != tc.total {
			t.Fatalf("%s usage incorrect: %+v", tc.protocol, u)
		}
		if (u.CachedInput == nil) != (tc.cached == nil) || tc.cached != nil && *u.CachedInput != *tc.cached {
			t.Fatalf("%s cache count incorrect", tc.protocol)
		}
	}
	a := newAccumulator("openai", nil)
	a.use(map[string]any{})
	if a.usage.Known || a.usage.CachedInput != nil {
		t.Fatal("absent usage must remain unknown")
	}
	a.use(map[string]any{"prompt_tokens": 0, "prompt_tokens_details": map[string]any{"cached_tokens": 0}})
	if !a.usage.InputKnown || a.usage.OutputKnown || a.usage.CachedInput == nil {
		t.Fatal("reported zero differs from missing output")
	}
}
func usageInt(n int) *int { return &n }

func TestContextUsagePersistsAndClearsIndependently(t *testing.T) {
	model, close := fakeModel(t, func(_ int, _ map[string]any) any {
		reply := response("回答")
		reply.(map[string]any)["usage"] = map[string]any{"prompt_tokens": 100, "completion_tokens": 20, "prompt_tokens_details": map[string]any{"cached_tokens": 80}}
		return reply
	})
	defer close()
	e, err := New(t.TempDir(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown()
	model.ContextLimit = 1000000
	model.ContextLimitSource = "provider"
	c := Config{Model: model, Profile: "core"}
	if err = e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	if err = e.Chat(context.Background(), "case", "查询一", nil); err != nil {
		t.Fatal(err)
	}
	if err = e.Chat(context.Background(), "case", "查询二", nil); err != nil {
		t.Fatal(err)
	}
	view, err := e.Snapshot("case")
	if err != nil {
		t.Fatal(err)
	}
	if view.Context == nil || view.Context.Estimated || !view.Context.UsedKnown || view.Context.Window != 1000000 || view.Context.Budget != 64000 || view.Context.Used != 100 || view.Context.LastRequest == nil || view.Context.LastRequest.Input != 100 || *view.Context.LastRequest.CachedInput != 80 || view.Usage.Total != 240 {
		t.Fatal("current and cumulative usage mixed")
	}
	loaded, err := New(e.Dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	persisted, _ := loaded.Snapshot("case")
	loaded.Shutdown()
	if persisted.Context.LastRequest == nil || persisted.Context.LastRequest.CachedInput == nil || *persisted.Context.LastRequest.CachedInput != 80 {
		t.Fatal("latest provider usage not persisted")
	}
	if err = e.Rollback("case"); err != nil {
		t.Fatal(err)
	}
	rollback, _ := e.Snapshot("case")
	rolledState, _ := e.get("case")
	if rolledState.state.ContextMeasurement != nil || rollback.Context.LastRequest != nil || rollback.Context.UsedKnown || rollback.Context.Used != 0 || rollback.Usage.Total != 240 {
		t.Fatal("rollback did not separate context and cumulative tokens")
	}
	if err = e.Chat(context.Background(), "case", "新的第二轮", nil); err != nil {
		t.Fatal(err)
	}
	if err = e.Compact(context.Background(), "case"); err != nil {
		t.Fatal(err)
	}
	view, _ = e.Snapshot("case")
	if rolledState.state.ContextMeasurement != nil || view.Context.LastRequest != nil || view.Usage.Total != 480 {
		t.Fatal("compaction request displayed as normal context usage")
	}
	if err = e.Restore("case", []Message{{Role: "user", Content: strings.Repeat("large context ", 10000)}}); err != nil {
		t.Fatal(err)
	}
	large, _ := e.Snapshot("case")
	if large.Context.EstimatedUsed <= view.Context.EstimatedUsed || large.Context.UsedKnown || large.Context.Used != 0 || large.Context.LastRequest != nil {
		t.Fatal("restored history did not update occupancy")
	}
	reopened, err := New(e.Dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Shutdown()
	restored, _ := reopened.Snapshot("case")
	if restored.Context.EstimatedUsed != large.Context.EstimatedUsed || restored.Context.UsedKnown || restored.Usage.Total != large.Usage.Total {
		t.Fatal("usage lost after restart")
	}
	if err = e.Clear("case"); err != nil {
		t.Fatal(err)
	}
	view, _ = e.Snapshot("case")
	if view.Context.Used != 0 || view.Context.LastRequest != nil || view.Usage.Total != 480 {
		t.Fatal("clear changed cumulative usage or retained current context")
	}
}

func TestMeasuredContextClearsOnModelSwitch(t *testing.T) {
	model, close := fakeModel(t, func(_ int, _ map[string]any) any {
		r := response("reply").(map[string]any)
		r["usage"] = map[string]any{"prompt_tokens": 30800, "completion_tokens": 442}
		return r
	})
	defer close()
	model.ContextLimit = 1000000
	model.ContextLimitSource = "provider"
	e, err := New(t.TempDir(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown()
	c := Config{Model: model, Profile: "core"}
	if err = e.Configure("usage", c); err != nil {
		t.Fatal(err)
	}
	if err = e.Chat(context.Background(), "usage", "question", nil); err != nil {
		t.Fatal(err)
	}
	view, _ := e.Snapshot("usage")
	if view.Context.Used != 30800 || !view.Context.UsedKnown || view.Context.Window != 1000000 || view.Context.Estimated {
		t.Fatal("not actual request input", view.Context)
	}
	c.Model.ContextWindow = 128000
	if err = e.Configure("usage", c); err != nil {
		t.Fatal(err)
	}
	view, _ = e.Snapshot("usage")
	if view.Context.Used != 30800 || !view.Context.UsedKnown {
		t.Fatal("budget change lost a valid measurement")
	}
	c.Model.Name = "different-model"
	if err = e.Configure("usage", c); err != nil {
		t.Fatal(err)
	}
	view, _ = e.Snapshot("usage")
	switchedState, _ := e.get("usage")
	if switchedState.state.ContextMeasurement != nil || view.Context.UsedKnown || view.Context.LastRequest != nil {
		t.Fatal("used old model tokens for new model")
	}
}
