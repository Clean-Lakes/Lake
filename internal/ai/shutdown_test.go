package ai

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestShutdownWaitsForBackgroundCompletionAndClosesAdmission(t *testing.T) {
	cancelled := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	e, err := New(t.TempDir(), func(ctx context.Context, _, _ string, _ map[string]any, _ bool) (any, error) {
		<-ctx.Done()
		close(cancelled)
		<-release
		return nil, ctx.Err()
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.trackBridgeShell("case", map[string]any{"entry_id": "entry", "terminal_id": "terminal"}, nil); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { e.Shutdown(); close(done) }()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("background wait was not cancelled")
	}
	select {
	case <-done:
		t.Fatal("shutdown returned before the background worker finished")
	case <-time.After(30 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not wait for final persistence")
	}
	view, err := e.Snapshot("case")
	if err != nil || len(view.Cards) != 1 || view.Cards[0].Status != "failed" {
		t.Fatal("final background state was not persisted", err)
	}
	if _, err := e.startShell(Config{Runtime: "local"}, map[string]any{"__session": "case"}, "printf should-not-run"); !errors.Is(err, context.Canceled) {
		t.Fatal("shell admitted after shutdown", err)
	}
	if _, err := e.trackBridgeShell("case", map[string]any{"entry_id": "entry", "terminal_id": "terminal"}, nil); !errors.Is(err, context.Canceled) {
		t.Fatal("bridge wait admitted after shutdown", err)
	}
}
