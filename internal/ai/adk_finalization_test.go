package ai

import (
	"context"
	adksession "google.golang.org/adk/v2/session"
	"strings"
	"sync"
	"testing"
	"time"
)

type heldProjection struct {
	adksession.Service
	entered, release chan struct{}
	once             sync.Once
}

func (h *heldProjection) AppendEvent(ctx context.Context, s adksession.Session, event *adksession.Event) error {
	if strings.HasPrefix(event.InvocationID, "projection_") {
		h.once.Do(func() { close(h.entered); <-h.release })
	}
	return h.Service.AppendEvent(ctx, s, event)
}

func TestADKFinalProjectionKeepsTurnReservedUntilDurable(t *testing.T) {
	m, closeModel := fakeModel(t, func(_ int, _ map[string]any) any { return response("recorded") })
	defer closeModel()
	e := engineFor(t, m, nil)
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	h := &heldProjection{Service: store.Sessions, entered: make(chan struct{}), release: make(chan struct{})}
	store.Sessions = h
	var release sync.Once
	defer release.Do(func() { close(h.release) })
	result := make(chan error, 1)
	go func() { result <- e.Chat(context.Background(), "case", "first turn", nil) }()
	select {
	case <-h.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("final projection not reached")
	}
	s, _ := e.get("case")
	s.mu.Lock()
	reserved := s.cancel != nil
	s.mu.Unlock()
	if !reserved {
		release.Do(func() { close(h.release) })
		<-result
		t.Fatal("next turn admitted before final ADK projection was durable")
	}
	view, err := e.Snapshot("case")
	if err != nil || view.Status != "running" || view.TurnFinishedAt != "" {
		t.Fatal("completion published before canonical persistence", view.Status, err)
	}
	if err = e.Chat(context.Background(), "case", "overlapping turn", nil); err == nil || !strings.Contains(err.Error(), "busy") {
		t.Fatal("overlapping turn was not refused", err)
	}
	release.Do(func() { close(h.release) })
	if err = <-result; err != nil {
		t.Fatal(err)
	}
	if err = e.Chat(context.Background(), "case", "next turn", nil); err != nil {
		t.Fatal(err)
	}
}
