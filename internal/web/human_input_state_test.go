package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"testing"
)

func TestHumanInputStateUpdatesSessionAndSubscriberBeforeDone(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	ch, stop := b.Store.Subscribe()
	defer stop()
	for _, tc := range []struct{ engine, session string }{
		{"waiting_approval", "waiting_approval"}, {"running", "investigating"},
		{"waiting_approval", "waiting_approval"}, {"running", "investigating"},
	} {
		b.event(ai.Event{Session: id, Type: "inputState", Data: Object{"status": tc.engine}})
		if b.Store.Session(id)["status"] != tc.session {
			t.Fatalf("stale session status after %s", tc.engine)
		}
		select {
		case event := <-ch:
			if event["sessionId"] != id {
				t.Fatal("input update crossed sessions")
			}
		default:
			t.Fatal("input transition did not reach live subscribers")
		}
	}
}
