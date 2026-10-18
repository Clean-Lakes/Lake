package web

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestLiveTextEventsReachSubscribersWithoutPersistingPresentationPayload(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	ch, stop := b.Store.Subscribe()
	defer stop()
	for _, tc := range []struct {
		event  ai.Event
		target string
	}{
		{ai.Event{Session: id, Type: "delta", Data: Object{"card_id": "reply", "kind": "message", "content": "中文👩🏽‍💻", "at": "now", "rootTurnId": "turn"}}, "card"},
		{ai.Event{Session: id, Type: "sreUpdate", Data: Object{"target": "agent", "id": "role", "textId": "part", "content": "核对中"}}, "agent"},
	} {
		b.event(tc.event)
		select {
		case ev := <-ch:
			update := object(ev["textUpdate"])
			if update["target"] != tc.target || stringOf(update["content"]) == "" {
				t.Fatal("text did not reach live subscriber")
			}
		default:
			t.Fatal("live update missing")
		}
	}
	for _, ev := range b.Store.Events(id, 0) {
		if ev["textUpdate"] != nil {
			t.Fatal("ephemeral text was written into durable event replay")
		}
	}
	b.event(ai.Event{Session: id, Type: "sreUpdate"})
	select {
	case ev := <-ch:
		if ev["textUpdate"] != nil {
			t.Fatal("structural update incorrectly treated as text")
		}
	default:
		t.Fatal("structural update missing")
	}
}

func TestSSEDeliversLiveTextBeforeCompletionAndReplayRecoversWithSnapshot(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	after := integer(b.Store.Snapshot(id)["cursor"]) - 1
	r, _ := http.NewRequestWithContext(ctx, "GET", h.URL+"/api/sessions/"+id+"/events?after="+jsonText(after), nil)
	r.Host = "localhost:4177"
	r.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
	resp, err := h.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	replayed := false
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var ev Object
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev); err != nil {
			t.Fatal(err)
		}
		if !replayed {
			if ev["textUpdate"] != nil {
				t.Fatal("replay must recover using the canonical snapshot")
			}
			replayed = true
			b.event(ai.Event{Session: id, Type: "delta", Data: Object{"card_id": "reply", "kind": "message", "content": "正在输出👩🏽‍💻", "at": "now", "rootTurnId": "turn"}})
			continue
		}
		if object(ev["textUpdate"])["content"] != "正在输出👩🏽‍💻" {
			t.Fatal("SSE lost live text")
		}
		if ev["sessionId"] != id || integer(ev["seq"]) <= after {
			t.Fatal("SSE scope/order invalid")
		}
		return
	}
	t.Fatal("SSE text not delivered", scanner.Err())
}
