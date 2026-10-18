package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSRELiveProseExtractsPartialSummary(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"正在检查服务。", "正在检查服务。"},
		{`{"schemaVersion":1,"summary":"正在检查`, "正在检查"},
		{`{"summary":"第一行\n第二行\`, "第一行\n第二行"},
		{`{"summary":"中文\u4e`, "中文"},
		{`{"summary":"已完成","facts":[{"statement":"隐藏原始字段`, "已完成"},
		{"```json\n{\"summary\":\"检查中", "检查中"},
		{"```sh\nuptime", "```sh\nuptime"},
		{`{"facts":[`, ""},
	} {
		if got := sreLiveProse(tc.input); got != tc.want {
			t.Errorf("got %q, want %q", got, tc.want)
		}
	}
}

// Exercise the actual child callback while the provider is still open. A
// component-only animation fixture would miss dropped SRE delta events.
func TestSRERolePublishesTextBeforeProviderCompletes(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		packet := map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "正在逐步核对服务状态。"}}}}
		fmt.Fprintf(w, "data: %s\n\n", js(packet))
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"检查结束。\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer provider.Close()
	e := engineFor(t, Model{URL: provider.URL, Name: "fixture", Protocol: "openai"}, nil)
	repo := &srePolicyRepository{task: SRETask{ID: "task", Status: "active", TokenBudget: 1000000, Attempts: []SREStepAttempt{{ID: "attempt", Status: "running"}}}}
	e.SetSRERepository(repo)
	observed := make(chan string, 8)
	e.Emit = func(event Event) {
		if event.Type != "sreUpdate" {
			return
		}
		view, err := e.Snapshot("case")
		if err == nil && len(view.AgentRuns) > 0 {
			select {
			case observed <- view.AgentRuns[0].LiveText:
			default:
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := e.ExecuteSRERole(ctx, "case", repo.task, SREPlanStep{ID: "summary", Role: SRECoordinator, Kind: "summarize", Description: "总结状态"}, "plan-run", "attempt", "总结现状", true)
		done <- err
	}()
	select {
	case text := <-observed:
		if !strings.Contains(text, "正在逐步") {
			t.Fatal("missing streamed content", text)
		}
	case err := <-done:
		t.Fatal("role ended before streaming", err)
	case <-ctx.Done():
		t.Fatal("SRE delta dropped or callback deadlocked")
	}
	// No streamed body is written into the durable task message on each packet.
	b, _ := json.Marshal(repo.task.Messages)
	if strings.Contains(string(b), "正在逐步") {
		t.Fatal("streaming rewrote durable task messages")
	}
	release <- struct{}{}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("provider completion did not terminate stream")
	}
	view, err := e.Snapshot("case")
	if err != nil || len(view.AgentRuns) == 0 || view.AgentRuns[0].LiveText != "正在逐步核对服务状态。检查结束。" || view.AgentRuns[0].Status != "completed" {
		t.Fatal("final suffix disappeared before durable task completion", err)
	}
}
