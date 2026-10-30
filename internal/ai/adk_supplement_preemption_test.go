package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestUserSupplementPreemptsModelStreamAndContinuesOfficialTurn(t *testing.T) {
	entered, cancelled := make(chan struct{}), make(chan struct{})
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if body["tools"] == nil {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(response("fixture"))
			return
		}
		if requests.Add(1) == 1 {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"obsolete partial reply\"}}]}\n\n")
			w.(http.Flusher).Flush()
			close(entered)
			<-r.Context().Done()
			close(cancelled)
			return
		}
		if !strings.Contains(js(body["messages"]), "先确认数据量，不要迁移") {
			t.Error("new request omitted real supplement")
		}
		if strings.Contains(js(body["messages"]), "obsolete partial reply") {
			t.Error("superseded reply entered provider history")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response("按补充先确认数据量。"))
	}))
	defer provider.Close()
	e := engineFor(t, Model{URL: provider.URL, Name: "fixture", Protocol: "openai", ContextWindow: 64000, MaxOutput: 1024}, nil)
	defer e.Shutdown()
	var mu sync.Mutex
	var pending []UserSupplement
	var receipts atomic.Int32
	e.SetSupplementHooks(func(_, root string) ([]UserSupplement, error) {
		mu.Lock()
		defer mu.Unlock()
		return append([]UserSupplement{}, pending...), nil
	}, func(_, root string, ids []string) error { receipts.Add(1); return nil })
	done := make(chan error, 1)
	go func() { done <- e.Chat(context.Background(), "case", "处理原任务", nil) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("model did not enter")
	}
	before, _ := e.Snapshot("case")
	if err := e.AdmitSupplement("case", func(root string) error {
		if root != before.RootTurnID {
			t.Error("root changed")
		}
		mu.Lock()
		defer mu.Unlock()
		pending = []UserSupplement{{ID: "live-steer", Input: TurnInput{UserText: "先确认数据量，不要迁移"}}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("provider request was not cancelled promptly")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("official ADK turn did not continue")
	}
	after, _ := e.Snapshot("case")
	if after.RootTurnID != before.RootTurnID || after.Turns != before.Turns || requests.Load() != 2 || receipts.Load() == 0 {
		t.Fatal("supplement restarted or lost the current turn", requests.Load(), receipts.Load())
	}
	for _, card := range after.Cards {
		if card.Content == "obsolete partial reply" && (card.Type != "draft" || card.Status != "interrupted") {
			t.Fatal("superseded text masquerades as a completed reply")
		}
	}
	history, _ := e.History("case")
	if err := validHistory(history); err != nil {
		t.Fatal(err)
	}
}

func TestUserSupplementCannotCancelToolContext(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	s, _ := e.get("case")
	e.SetSupplementHooks(func(string, string) ([]UserSupplement, error) { return nil, nil }, nil)
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.mu.Lock()
	s.cancel = cancel
	s.state.View.RootTurnID = "root"
	s.mu.Unlock()
	d := &adkTurnDriver{engine: e, session: s}
	modelCtx, finish, err := d.supplementRequestContext(parent)
	if err != nil {
		t.Fatal(err)
	}
	if err = e.AdmitSupplement("case", func(string) error { return fmt.Errorf("admission rejected") }); err == nil {
		t.Fatal("rejected admission accepted")
	}
	if modelCtx.Err() != nil {
		t.Fatal("failed admission cancelled model")
	}
	if err = e.AdmitSupplement("case", func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if modelCtx.Err() == nil || parent.Err() != nil {
		t.Fatal("supplement cancelled invocation/tool instead of provider")
	}
	if !finish() {
		t.Fatal("missing preemption reason")
	}
	s.mu.Lock()
	if s.supplementRequest != nil {
		t.Error("provider cancellation handle leaked into tool execution")
	}
	s.cancel = nil
	s.mu.Unlock()
}
