package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func progressFixtureView() ai.View {
	const at = "2026-10-21T01:00:00Z"
	return ai.View{Session: "s", Status: "running", TurnStartedAt: at, Cards: []ai.Card{
		{ID: "old", Type: "message", Status: "completed", At: "2026-10-20T01:00:00Z", Content: "previous-turn-private-data"},
		{ID: "stage", Type: "message", Status: "completed", At: at, Content: "源库表普遍带 modifytime / createtime，理论上能做时间戳增量。先统计实际变更量。"},
		{ID: "op", Type: "operation", Title: "execute_sql", Status: "running", At: at, Content: "raw-private-output", Data: map[string]any{"target": "演示源库", "arguments": map[string]any{"password": "synthetic-private-value"}}},
		{ID: "partial", Type: "message", Status: "running", At: at, Content: "partial-stream-do-not-summarize"},
		{ID: "thinking", Type: "thinking", Status: "completed", At: at, Content: "private-thinking"},
	}}
}

func TestProgressSummaryInputCurrentTurnAndSafeMetadata(t *testing.T) {
	view := progressFixtureView()
	view.Cards = append(view.Cards, ai.Card{Type: "message", Status: "completed", At: view.TurnStartedAt, Content: "password=synthetic-sensitive-value"})
	input := progressSummaryInput(view)
	for _, excluded := range []string{"previous-turn", "raw-private", "synthetic-private", "partial-stream", "private-thinking", "synthetic-sensitive"} {
		if strings.Contains(input, excluded) {
			t.Fatalf("unsafe input contains %q", excluded)
		}
	}
	if !strings.Contains(input, "modifytime") || !strings.Contains(input, "execute_sql：running") {
		t.Fatal("missing current evidence")
	}
	view.Question = &ai.QuestionRequest{}
	if !strings.Contains(progressSummaryInput(view), "等待用户回答") {
		t.Fatal("waiting state omitted")
	}
	for i := 0; i < 400; i++ {
		view.Cards = append(view.Cards, ai.Card{Type: "message", Status: "completed", At: view.TurnStartedAt, Content: strings.Repeat("长", 1000)})
	}
	if len([]rune(progressSummaryInput(view))) > 11000 {
		t.Fatal("unbounded summary input")
	}
}

func TestProgressSummaryRejectsRepeatedStageAndSensitiveOutput(t *testing.T) {
	input := progressSummaryInput(progressFixtureView())
	copied := progressFixtureView().Cards[1].Content
	for _, bad := range []string{copied, "最新阶段：" + copied, strings.ReplaceAll(copied, " / ", "/"), "password=synthetic-private-value", strings.Repeat("长", 161)} {
		if cleanProgressSummary(bad, input) != "" {
			t.Fatal("accepted copied or unsafe summary")
		}
	}
	if cleanProgressSummary("已确认源库具备增量条件，正在核算变更量以确定导出范围。", input) == "" {
		t.Fatal("rejected concise synthesis")
	}
}

func TestProgressSummaryCoalescesAndDiscardsObsoleteEvidence(t *testing.T) {
	b, _ := fixture(t)
	var calls atomic.Int32
	started := make(chan struct{}, 2)
	release := make(chan struct{}, 2)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := calls.Add(1)
		var payload Object
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload["reasoning_effort"] != "none" {
			t.Error("summary inherited main-task reasoning effort")
		}
		if payload["tools"] != nil {
			t.Error("summary exposed tools")
		}
		started <- struct{}{}
		<-release
		if call == 2 {
			emitModel(w, "变更范围已核定，接下来准备增量导出。", nil)
		} else {
			emitModel(w, "已确认源库具备增量条件，正在核算变更量以确定导出范围。", nil)
		}
	}))
	defer remote.Close()
	b.Models.Save(&ai.Model{URL: remote.URL, Name: "gpt-5.1", Protocol: "openai"})
	var mu sync.Mutex
	view := progressFixtureView()
	load := func() (ai.View, error) {
		mu.Lock()
		defer mu.Unlock()
		copy := view
		copy.Cards = append([]ai.Card(nil), view.Cards...)
		return copy, nil
	}
	turn := view.TurnStartedAt
	result := make(chan Object, 1)
	go func() { result <- b.summarizeProgress(context.Background(), "s", turn, load) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("summary did not start")
	}
	duplicate := b.summarizeProgress(context.Background(), "s", turn, load)
	if duplicate["pending"] != true || calls.Load() != 1 {
		t.Fatal("did not coalesce in-flight work")
	}
	mu.Lock()
	view.Cards[1].Content = "变更量已核实，开始准备导出。"
	mu.Unlock()
	release <- struct{}{}
	if old := <-result; old["text"] != "" || old["pending"] != true {
		t.Fatal("published obsolete summary")
	}
	b.progressSummaryMu.Lock()
	b.progressSummaries["s"].attempted = time.Time{}
	b.progressSummaryMu.Unlock()
	go func() { result <- b.summarizeProgress(context.Background(), "s", turn, load) }()
	<-started
	release <- struct{}{}
	if fresh := <-result; !strings.Contains(stringOf(fresh["text"]), "变更范围") {
		t.Fatal("no synthesized summary")
	}
	if b.Models.Active().ReasoningEffort != "" {
		t.Fatal("summary changed main-task model settings")
	}
	cached := b.summarizeProgress(context.Background(), "s", turn, load)
	if cached["text"] == "" || calls.Load() != 2 {
		t.Fatal("unchanged snapshots repeated provider call")
	}
	if stale := b.summarizeProgress(context.Background(), "s", "different-turn", load); stale["text"] != "" {
		t.Fatal("cross-turn summary leak")
	}

	b.progressSummaryMu.Lock()
	b.progressSummaries["s"].attempted = time.Time{}
	b.progressSummaryMu.Unlock()
	mu.Lock()
	view.Cards[1].Content = "导出范围已确定，准备进行下一阶段。"
	mu.Unlock()
	go func() { result <- b.summarizeProgress(context.Background(), "s", turn, load) }()
	<-started
	mu.Lock()
	view.TurnStartedAt = "2026-10-21T02:00:00Z"
	mu.Unlock()
	release <- struct{}{}
	if old := <-result; old["text"] != "" {
		t.Fatal("late old-turn response leaked")
	}
	mu.Lock()
	view.Status = "completed"
	mu.Unlock()
	if ended := b.summarizeProgress(context.Background(), "s", turn, load); ended["text"] != "" {
		t.Fatal("completed turn generated progress")
	}
}

func TestProgressSummaryRouteRejectsInactiveTurn(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	result := apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/progress-summary", Object{"turnStartedAt": "obsolete"}, 200)
	if result["text"] != "" || result["pending"] != false || len(b.progressSummaries) != 0 {
		t.Fatal("inactive turn requested a summary")
	}
}
