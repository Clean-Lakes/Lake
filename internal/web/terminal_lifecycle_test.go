package web

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestWaitCancellationPreservesPTYAndHistoricalSource(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	term := b.Terminals.Open(context.Background(), id, ref)
	tid := stringOf(term["id"])
	initial := b.Terminals.Execute(id, tid, "user", "export LAKE_PERSIST=kept", "")
	b.Terminals.Wait(context.Background(), id, tid, stringOf(initial["id"]))
	entry := b.Terminals.Execute(id, tid, "user", "sleep 0.2; printf 'fresh:%s' \"$LAKE_PERSIST\"", "")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := b.waitTerminal(ctx, id, tid, stringOf(entry["id"])); err != context.Canceled {
		t.Fatalf("cancel %v", err)
	}
	result := b.Terminals.Wait(context.Background(), id, tid, stringOf(entry["id"]))
	if !strings.Contains(stringOf(result["output"]), "fresh:kept") {
		t.Fatal(result)
	}
	live := b.Terminals.ScreenResult(id, tid, "tail", 80, 20000)
	if live["source"] != "live" || stringOf(live["generation"]) == "" || stringOf(live["capturedAt"]) == "" {
		t.Fatal(live)
	}
	b.Terminals.Close(id, tid)
	old := b.Terminals.ScreenResult(id, tid, "tail", 80, 20000)
	if old["source"] != "historical" || old["capturedAt"] != b.Store.Terminal(id, tid)["outputCapturedAt"] || old["generation"] != live["generation"] {
		t.Fatal(old)
	}
	time.Sleep(20 * time.Millisecond)
	if b.Terminals.ScreenResult(id, tid, "tail", 80, 20000)["capturedAt"] != old["capturedAt"] {
		t.Fatal("historical read invented a new collection time")
	}
	_, err := b.bridge(context.Background(), id, "terminal_expect", Object{"terminal_id": tid, "wait_for": []string{"fresh:kept"}}, false)
	if err == nil || !strings.Contains(err.Error(), "terminal_disconnected") {
		t.Fatalf("historical expect %v", err)
	}
	next := b.Terminals.Open(context.Background(), id, ref)
	if next["generation"] == term["generation"] {
		t.Fatal("generation reused")
	}
}

func TestAIAbortDoesNotKillBackgroundTerminal(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	term := b.Terminals.Open(context.Background(), id, ref)
	tid := stringOf(term["id"])
	entry := b.Terminals.Execute(id, tid, "user", "sleep 0.2; printf continued", "")
	if err := b.Engine.Abort(id); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	result := b.Terminals.Wait(ctx, id, tid, stringOf(entry["id"]))
	if !strings.Contains(stringOf(result["output"]), "continued") || b.Store.Terminal(id, tid)["status"] != "ready" {
		t.Fatal(result)
	}
}

func TestLiveScreenTimestampDescribesCurrentSample(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	term := b.Terminals.Open(context.Background(), id, ref)
	tid := stringOf(term["id"])
	before := time.Now().UTC()
	l := b.Terminals.get(id, tid)
	l.mu.Lock()
	b.Terminals.record(l, "fresh-screen-observation")
	l.mu.Unlock()
	observed := b.Terminals.ScreenResult(id, tid, "tail", 80, 20000)
	captured, err := time.Parse(time.RFC3339Nano, stringOf(observed["capturedAt"]))
	if err != nil || captured.Before(before) || !strings.Contains(stringOf(observed["text"]), "fresh-screen-observation") {
		t.Fatal("live screen used a stale persistence timestamp", observed)
	}
}
