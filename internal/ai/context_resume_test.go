package ai

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func seedIdleConversation(t *testing.T, e *Engine, outputSize int) []Message {
	t.Helper()
	s, _ := e.get("case")
	s.mu.Lock()
	defer s.mu.Unlock()
	old := time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339Nano)
	s.state.History = []Message{
		{Role: "system", Content: "Use evidence; never replay previous commands."},
		{Role: "user", Content: "只检查 node-a，不重启任何服务。"},
		{Role: "assistant", Calls: []Call{{ID: "old-read", Name: "shell", Arguments: `{"command":"uptime"}`}}},
		{Role: "tool", CallID: "old-read", Name: "shell", Content: strings.Repeat("x", outputSize)},
		{Role: "assistant", Content: "之前的检查已结束，仍需核查服务状态。"},
	}
	s.state.View.Status = "completed"
	s.state.View.TurnStartedAt, s.state.View.TurnFinishedAt = old, old
	s.state.View.Cards = []Card{{ID: "raw", Type: "operation", Content: s.state.History[3].Content, Status: "completed", At: old}}
	s.state.Checkpoints = []int{0}
	if err := e.save(s); err != nil {
		t.Fatal(err)
	}
	return append([]Message(nil), s.state.History...)
}

func TestIdleConversationReloadCompactsThenAnswersWithoutReplaying(t *testing.T) {
	var summaries, answers atomic.Int32
	const question = "继续检查服务状态，仍然不要重启。"
	m, closeModel := fakeModel(t, func(_ int, body map[string]any) any {
		messages := arr(body["messages"])
		if strings.Contains(str(obj(messages[0])["content"]), "handoff summary") {
			summaries.Add(1)
			if body["tools"] != nil || !strings.Contains(js(messages), "不重启任何服务") {
				t.Error("summary lost constraints or gained tools")
			}
			return response("之前只检查 node-a；不得重启任何服务。旧命令已完成，不要重放；下一步检查服务。")
		}
		answers.Add(1)
		if str(obj(messages[len(messages)-1])["content"]) != question || !strings.Contains(js(messages), "旧命令已完成") {
			t.Error("resumed answer lost new question or handoff")
		}
		return response("继续核查服务状态，遵守不重启的限制。")
	})
	defer closeModel()
	e := engineFor(t, m, nil)
	original := seedIdleConversation(t, e, 12000)
	reloaded, err := New(e.Dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reloaded.Shutdown)
	if err := reloaded.Chat(context.Background(), "case", question, nil); err != nil {
		t.Fatal(err)
	}
	h, _ := reloaded.History("case")
	v, _ := reloaded.Snapshot("case")
	if summaries.Load() != 1 || answers.Load() != 1 || validHistory(h) != nil || len(h) != 4 || v.Status != "completed" {
		t.Fatalf("resume failed: summaries=%d answers=%d history=%d status=%s", summaries.Load(), answers.Load(), len(h), v.Status)
	}
	if v.Cards[0].Content != original[3].Content {
		t.Fatal("raw operation record changed")
	}
	for _, card := range v.Cards {
		if card.Type == "compaction" && card.Status != "completed" {
			t.Fatal("compaction never finished")
		}
	}
}

func TestIdleResumePolicySkipsShortFreshAndUnknownHistory(t *testing.T) {
	now := time.Now()
	old := now.Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	st := State{History: []Message{{Role: "system"}, {Role: "user", Content: strings.Repeat("x", 9000)}, {Role: "assistant", Content: "done"}}, View: View{TurnFinishedAt: old}}
	if !shouldCompactResumedConversation(st, now) {
		t.Fatal("old long conversation was skipped")
	}
	st.View.Cards = []Card{{At: now.UTC().Format(time.RFC3339Nano)}}
	if shouldCompactResumedConversation(st, now) {
		t.Fatal("fresh activity was ignored")
	}
	st.View = View{}
	if shouldCompactResumedConversation(st, now) {
		t.Fatal("unknown age was treated as idle")
	}
	st.View.StartedAt = old
	if !shouldCompactResumedConversation(st, now) {
		t.Fatal("legacy timestamp was ignored")
	}
	st.History[1].Content = "hello"
	if shouldCompactResumedConversation(st, now) {
		t.Fatal("short conversation needs no handoff")
	}
}

func TestManualCompactionTimeoutPreservesHistoryAndAllowsRetry(t *testing.T) {
	requested, release := make(chan struct{}), make(chan struct{})
	m, closeModel := fakeModel(t, func(n int, _ map[string]any) any {
		if n == 1 {
			close(requested)
			<-release
		}
		return response("保留 node-a 和不重启的限制；继续检查服务。")
	})
	defer closeModel()
	defer close(release)
	e := engineFor(t, m, nil)
	e.compactionTimeout = 100 * time.Millisecond
	before := seedIdleConversation(t, e, 12000)
	done := make(chan error, 1)
	go func() { done <- e.Compact(context.Background(), "case") }()
	select {
	case <-requested:
	case <-time.After(3 * time.Second):
		t.Fatal("summary did not start")
	}
	// This deliberately short deadline may already have expired by the time
	// the test goroutine is scheduled. Check live visibility independently
	// below, while the provider is held behind an explicit barrier.
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "context compaction:") {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("summary did not respect its own deadline")
	}
	after, _ := e.History("case")
	if !reflect.DeepEqual(before, after) {
		t.Fatal("timed-out summary changed original history")
	}
	s, _ := e.get("case")
	s.mu.Lock()
	if s.cancel != nil || len(s.state.Checkpoints) != 1 || s.state.View.Cards[len(s.state.View.Cards)-1].Status != "failed" {
		t.Error("timeout left the session busy or destroyed its checkpoint")
	}
	s.mu.Unlock()
	if err := e.Compact(context.Background(), "case"); err != nil {
		t.Fatal("cannot retry", err)
	}
}

func TestManualCompactionShowsRunningBeforeCompletion(t *testing.T) {
	requested, release := make(chan struct{}), make(chan struct{})
	m, closeModel := fakeModel(t, func(_ int, _ map[string]any) any {
		close(requested)
		<-release
		return response("保留 node-a 和不重启的限制；继续检查服务。")
	})
	defer closeModel()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	e := engineFor(t, m, nil)
	e.compactionTimeout = 10 * time.Second
	seedIdleConversation(t, e, 12000)
	done := make(chan error, 1)
	go func() { done <- e.Compact(context.Background(), "case") }()
	select {
	case <-requested:
	case <-time.After(3 * time.Second):
		t.Fatal("summary did not start")
	}
	v, err := e.Snapshot("case")
	if err != nil || len(v.Cards) == 0 || v.Cards[len(v.Cards)-1].Status != "running" {
		t.Fatal("no live compaction status", err)
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("released summary did not finish")
	}
	v, _ = e.Snapshot("case")
	if v.Cards[len(v.Cards)-1].Status != "completed" {
		t.Fatal("completed compaction retained live status")
	}
}

func TestIdleCompactionFailureOnlyFallsBackWhenOriginalHistoryFits(t *testing.T) {
	for _, oversized := range []bool{false, true} {
		t.Run(map[bool]string{false: "fits", true: "over-budget"}[oversized], func(t *testing.T) {
			var answers atomic.Int32
			m, closeModel := fakeModel(t, func(_ int, body map[string]any) any {
				if strings.Contains(str(obj(arr(body["messages"])[0])["content"]), "handoff summary") {
					return response("")
				}
				answers.Add(1)
				return response("继续处理")
			})
			defer closeModel()
			e := engineFor(t, m, nil)
			size := 12000
			if oversized {
				size = 150000
			}
			before := seedIdleConversation(t, e, size)
			err := e.Chat(context.Background(), "case", "继续检查，不重启", nil)
			if oversized {
				if err == nil || answers.Load() != 0 {
					t.Fatal("over-budget history bypassed failed compaction")
				}
			} else if err != nil || answers.Load() != 1 {
				t.Fatal("optional handoff blocked conversation", err)
			}
			h, _ := e.History("case")
			if !reflect.DeepEqual(h[1:len(before)], before[1:]) {
				t.Fatal("failed compaction changed original messages")
			}
			v, _ := e.Snapshot("case")
			notices := 0
			for _, card := range v.Cards {
				if card.Type == "notice" {
					notices++
				}
				if card.Status == "running" {
					t.Fatal("stale running card")
				}
			}
			if !oversized && notices != 1 {
				t.Fatal("fallback was not disclosed")
			}
		})
	}
}

func TestCancelIdleCompactionDoesNotStartAnswerAndSessionCanResume(t *testing.T) {
	requested, release := make(chan struct{}), make(chan struct{})
	var answers atomic.Int32
	m, closeModel := fakeModel(t, func(n int, body map[string]any) any {
		if n == 1 {
			close(requested)
			<-release
			return response("discarded")
		}
		answers.Add(1)
		return response("可以继续")
	})
	defer closeModel()
	defer close(release)
	e := engineFor(t, m, nil)
	seedIdleConversation(t, e, 12000)
	done := make(chan error, 1)
	go func() { done <- e.Chat(context.Background(), "case", "继续检查", nil) }()
	select {
	case <-requested:
	case <-time.After(3 * time.Second):
		t.Fatal("summary not started")
	}
	if err := e.Abort("case"); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancel did not stop summary")
	}
	v, _ := e.Snapshot("case")
	if v.Status != "cancelled" || answers.Load() != 0 {
		t.Fatal("cancellation started another request")
	}
	if err := e.Chat(context.Background(), "case", "继续检查", nil); err != nil {
		t.Fatal("cancel left session locked", err)
	}
}

func TestReloadClearsInterruptedManualCompaction(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture", Protocol: "openai"}, nil)
	seedIdleConversation(t, e, 12000)
	s, _ := e.get("case")
	s.state.View.Cards = append(s.state.View.Cards, Card{ID: "lost", Type: "compaction", Status: "running", At: timestamp()})
	if err := e.save(s); err != nil {
		t.Fatal(err)
	}
	reloaded, err := New(e.Dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reloaded.Shutdown)
	v, err := reloaded.Snapshot("case")
	if err != nil || v.Cards[len(v.Cards)-1].Status != "interrupted" {
		t.Fatal("orphaned compaction still active", err)
	}
}
