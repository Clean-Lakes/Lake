package web

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestReplyTimingPersistsPerMessageAndExcludesQueueWaiting(t *testing.T) {
	home := t.TempDir()
	store, err := OpenStore(home)
	if err != nil {
		t.Fatal(err)
	}
	project := store.CreateProject("timing")
	session := store.CreateSession(stringOf(project["id"]), "duration", nil)
	id := stringOf(session["id"])
	first := store.Begin(id, "你好", nil)
	pending := store.EnqueueMessage(id, Object{"text": "谢谢"})
	if len(objects(store.Snapshot(id)["replyTimings"])) != 1 {
		t.Fatal("queued waiting counted as answer time")
	}
	store.FinishReplyTiming(id, "completed")
	store.Status(id, "completed")
	frozen := jsonText(objects(store.Snapshot(id)["replyTimings"])[0])
	next := store.BeginQueuedMessage(id, stringOf(pending["queuedMessageId"]), "谢谢", nil, "谢谢")
	rows := objects(store.Snapshot(id)["replyTimings"])
	if len(rows) != 2 || rows[1]["messageId"] != next["id"] || rows[1]["startedAt"] != next["createdAt"] || jsonText(rows[0]) != frozen {
		t.Fatal("next turn changed previous duration or included queue wait")
	}
	store.FinishReplyTiming(id, "cancelled")
	store.Status(id, "completed")
	third := store.Begin(id, "明白", nil)
	store.Close()
	store, err = OpenStore(home)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	rows = objects(store.Snapshot(id)["replyTimings"])
	if len(rows) != 3 || rows[0]["messageId"] != first["id"] || jsonText(rows[0]) != frozen || rows[1]["status"] != "cancelled" {
		t.Fatal("historical timing changed on reopen")
	}
	if rows[2]["messageId"] != third["id"] || rows[2]["status"] != "interrupted" || rows[2]["finishedAt"] != "" {
		t.Fatal("restart invented a completion timestamp")
	}
	store.DeleteSession(id)
	if len(store.rows("SELECT messageId FROM replyTimings WHERE sessionId=?", id)) != 0 {
		t.Fatal("deleted session orphaned timings")
	}
}
func TestReplyTimingFinalizesCompletionFailureAndAbort(t *testing.T) {
	for _, mode := range []string{"completed", "failed", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			b, h := fixture(t)
			id, _ := newSession(t, h)
			started := make(chan struct{}, 1)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					fmt.Fprint(w, `{"data":[]}`)
					return
				}
				started <- struct{}{}
				switch mode {
				case "failed":
					http.Error(w, "synthetic failure", 503)
				case "cancelled":
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"stream\"}}]}\n\n")
					w.(http.Flusher).Flush()
					<-r.Context().Done()
				default:
					emitModel(w, "你好。", nil)
				}
			}))
			defer provider.Close()
			defer b.Close()
			b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "duration-fixture", Protocol: "openai"})
			message := apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "你好"}, 202)
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("model never started")
			}
			if mode == "cancelled" {
				apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/abort", Object{}, 200)
			}
			awaitQueueWorkers(t, b)
			rows := objects(apiTest(t, h, "GET", "/api/sessions/"+id+"/snapshot", nil, 200)["replyTimings"])
			if len(rows) != 1 || rows[0]["messageId"] != message["id"] || rows[0]["status"] != mode {
				t.Fatal("wrong final timing status")
			}
			start, err := time.Parse(time.RFC3339Nano, stringOf(rows[0]["startedAt"]))
			if err != nil {
				t.Fatal(err)
			}
			end, err := time.Parse(time.RFC3339Nano, stringOf(rows[0]["finishedAt"]))
			if err != nil || end.Before(start) {
				t.Fatal("invalid final duration", err)
			}
			if rows[0]["startedAt"] != message["createdAt"] {
				t.Fatal("dispatch start differs from message timestamp")
			}
		})
	}
}
