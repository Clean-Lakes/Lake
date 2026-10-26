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
func TestHistoricalPausedSRETaskDoesNotFailLaterReplyTiming(t *testing.T) {
	b, h := fixture(t)
	id, resource := newSession(t, h)
	task, err := b.Store.CreateSRETask(ai.SRETask{SessionID: id, RequestID: "historical_pause", Goal: "历史暂停任务", Scope: []string{resource}, Mode: "plan_only", TokenBudget: 128000})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = b.Store.MutateSRETask(id, task.ID, 0, "paused_fixture", func(v *ai.SRETask) error { v.Status = "paused"; return nil }); err != nil {
		t.Fatal(err)
	}
	b.Store.update(func() any {
		saved := b.Store.sreTask(id, task.ID)
		saved.UpdatedAt = "2020-01-01T00:00:00Z"
		b.Store.exec("UPDATE sreTasks SET body=?,updatedAt=? WHERE id=?", jsonText(saved), saved.UpdatedAt, task.ID)
		return nil
	})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			fmt.Fprint(w, `{"data":[]}`)
			return
		}
		emitModel(w, "本轮检查已完成。", nil)
	}))
	defer provider.Close()
	defer b.Close()
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "historical-pause-fixture", Protocol: "openai"})
	message := apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "再查一下"}, 202)
	awaitQueueWorkers(t, b)
	rows := objects(b.Store.Snapshot(id)["replyTimings"])
	if len(rows) != 1 || rows[0]["messageId"] != message["id"] || rows[0]["status"] != "completed" {
		t.Fatal("historical pause failed a completed reply", rows)
	}
	if b.Store.Session(id)["status"] != "completed" {
		t.Fatal("historical pause kept the session failed")
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

func TestHistoricalOutstandingOperationDoesNotFailIndependentReply(t *testing.T) {
	for _, status := range []string{"dispatched", "unknown"} {
		t.Run(status, func(t *testing.T) {
			b, h := fixture(t)
			defer b.Close()
			id, resource := newSession(t, h)
			task := stalePausedTask(t, b, id, resource)
			_, err := b.Store.MutateSRETask(id, task.ID, 0, "old_operation", func(v *ai.SRETask) error {
				v.Attempts = []ai.SREStepAttempt{{Operations: []ai.SREOperation{{ID: "old-op", Risk: "write", Status: status}}}}
				return nil
			})
			must(err)
			backdateTask(t, b, id, task.ID)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					fmt.Fprint(w, `{"data":[]}`)
					return
				}
				emitModel(w, "独立检查已完成，旧操作仍需单独核实。", nil)
			}))
			defer provider.Close()
			b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "independent-reply", Protocol: "openai"})
			message := apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "解释当前状态，不重放旧操作"}, 202)
			awaitQueueWorkers(t, b)
			messageID := stringOf(message["id"])
			if got := storedTimingStatus(b, id, messageID); got != "completed" {
				t.Fatalf("old %s failed completed reply: %s", status, got)
			}
			if b.Store.Session(id)["status"] != "failed" {
				t.Fatal("old unresolved session warning was hidden")
			}
			b.Store.SetReplyTimingStatus(id, messageID, "failed")
			b.reconcileStaleSREStatuses()
			if storedTimingStatus(b, id, messageID) != "completed" {
				t.Fatal("latest proven completion was not reconciled")
			}
			saved, err := b.Store.LoadSRETask(id, task.ID)
			if err != nil || saved.Status != "paused" || saved.Attempts[0].Operations[0].Status != status {
				t.Fatal("reconciliation changed task or operation", err)
			}
			if b.Store.Session(id)["status"] != "failed" {
				t.Fatal("reconciliation cleared outstanding operation warning")
			}
			view, err := b.Engine.Snapshot(id)
			must(err)
			rows := b.Store.ReplyTimingRows(id)
			start, _ := time.Parse(time.RFC3339Nano, stringOf(rows[0]["startedAt"]))
			end, _ := time.Parse(time.RFC3339Nano, stringOf(rows[0]["finishedAt"]))
			view.OperationOutcomes = []ai.OperationOutcome{{Status: "unknown", StartedAt: start}}
			if b.independentReplyCompleted(id, []ai.SRETask{saved}, view, start, end) {
				t.Fatal("current turn unknown operation became completed")
			}
		})
	}
}
