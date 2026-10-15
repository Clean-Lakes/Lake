package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestConversationFinishesWhenCompletedProviderConnectionStaysOpen(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	release := make(chan struct{})
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		calls.Add(1)
		emitModel(w, "你好，回复已完成。", nil)
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer provider.Close()
	defer close(release)
	b.Models.Save(b.Models.Input(Object{"url": provider.URL, "name": "stream completion fixture", "protocol": "openai"}))
	for _, text := range []string{"你好", "谢谢"} {
		result := apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": text}, 202)
		if result["queued"] == true {
			t.Fatal("next message remained queued after the previous reply")
		}
		deadline := time.Now().Add(3 * time.Second)
		finished := false
		for time.Now().Before(deadline) {
			snap := b.Store.Snapshot(id)
			view, _ := b.Engine.Snapshot(id)
			timings := objects(snap["replyTimings"])
			if object(snap["session"])["status"] == "completed" && view.Status == "completed" && len(timings) > 0 && timings[len(timings)-1]["finishedAt"] != "" && timings[len(timings)-1]["status"] == "completed" {
				finished = true
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if !finished {
			t.Fatal("completed answer retained investigating/running state or an open reply timer")
		}
		b.workers.Wait()
	}
	if calls.Load() != 2 {
		t.Fatal("reply retried or did not accept a follow-up")
	}
}
