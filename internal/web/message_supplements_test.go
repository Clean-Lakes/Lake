package web

import (
	"context"
	"encoding/json"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestMessageQueuePushSupplementsSameTurnBeforeProposedWrite(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	allowFixtureHost(b, id)
	options := b.Store.Options(id)
	options["silentWriteFiles"] = true
	b.Store.SaveOptions(id, options)
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var calls, active, max atomic.Int32
	target := filepath.Join(t.TempDir(), "must-not-write")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		if len(objects(body["tools"])) == 0 {
			emitModel(w, "fixture", nil)
			return
		}
		n := calls.Add(1)
		v := active.Add(1)
		defer active.Add(-1)
		if v > max.Load() {
			max.Store(v)
		}
		if n == 1 {
			entered <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			emitModel(w, "", []ai.Call{{ID: "obsolete-write", Name: "write", Arguments: jsonText(Object{"path": target, "content": "unexpected", "runtime": "local"})}})
			return
		}
		if !strings.Contains(jsonText(body["messages"]), "只补充这一条，先不要写文件") {
			t.Error("next official model request missed the actual supplement")
		}
		emitModel(w, "已补充，保留原任务且不写文件。", nil)
	}))
	defer provider.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "你好"}, 202)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("model did not enter")
	}
	before, _ := b.Engine.Snapshot(id)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "保留排队的另一条"}, 202)
	item := apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "只补充这一条，先不要写文件"}, 202)
	path := "/api/sessions/" + id + "/message-queue"
	queue := object(item["messageQueue"])
	queue = apiTest(t, h, "POST", path, Object{"operation": "pause", "revision": queue["revision"]}, 200)
	selected := stringOf(item["queuedMessageId"])
	apiTest(t, h, "POST", path, Object{"operation": "push", "revision": 0, "id": selected}, 409)
	queue = apiTest(t, h, "POST", path, Object{"operation": "push", "revision": queue["revision"], "id": selected}, 200)
	if len(objects(queue["items"])) != 2 || objects(queue["items"])[1]["supplementRootTurnId"] != before.RootTurnID {
		t.Fatal("push was not bound to the current turn")
	}
	apiTest(t, h, "POST", path, Object{"operation": "remove", "revision": queue["revision"], "id": selected}, 409)
	close(release)
	after := waitAI(t, b, id, "completed")
	awaitQueueWorkers(t, b)
	if after.RootTurnID != before.RootTurnID || after.Turns != before.Turns || calls.Load() != 2 || max.Load() != 1 {
		t.Fatal("supplement restarted or overlapped model invocations", calls.Load(), before.RootTurnID, after.RootTurnID)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("old write proposal executed")
	}
	queue = b.Store.MessageQueue(id)
	if queue["paused"] != true || len(objects(queue["items"])) != 1 || objects(queue["items"])[0]["text"] != "保留排队的另一条" {
		t.Fatal("unselected queue changed", queue)
	}
	apiTest(t, h, "POST", path, Object{"operation": "push", "revision": queue["revision"], "id": objects(queue["items"])[0]["id"]}, 409)
	if err := b.acknowledgeUserSupplements(id, before.RootTurnID, []string{selected}); err != nil {
		t.Fatal(err)
	}
	messages := objects(b.Store.Snapshot(id)["messages"])
	count := 0
	for _, message := range messages {
		if message["id"] == selected && message["role"] == "user" {
			count++
		}
	}
	if count != 1 {
		t.Fatal("supplement was not stored exactly once as a real human message", count)
	}
	if err := b.Engine.ReconcileUserSupplements(context.Background(), id); err != nil {
		t.Fatal(err)
	}
}

func TestMessageQueueStopPreservesUnappliedSupplement(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	entered := make(chan struct{}, 1)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		if len(objects(body["tools"])) == 0 {
			emitModel(w, "fixture", nil)
			return
		}
		calls.Add(1)
		entered <- struct{}{}
		<-r.Context().Done()
	}))
	defer provider.Close()
	defer b.Close()
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "你好"}, 202)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("no model")
	}
	item := apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "请补充只读核对"}, 202)
	path := "/api/sessions/" + id + "/message-queue"
	queue := object(item["messageQueue"])
	apiTest(t, h, "POST", path, Object{"operation": "push", "revision": queue["revision"], "id": item["queuedMessageId"]}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/abort", Object{}, 200)
	awaitQueueWorkers(t, b)
	queue = b.Store.MessageQueue(id)
	if calls.Load() != 1 || queue["paused"] != true || len(objects(queue["items"])) != 1 || objects(queue["items"])[0]["supplementRootTurnId"] != nil {
		t.Fatal("stop lost or dispatched supplemental input", queue, calls.Load())
	}
	for _, message := range objects(b.Store.Snapshot(id)["messages"]) {
		if message["id"] == item["queuedMessageId"] {
			t.Fatal("unapplied message appeared delivered")
		}
	}
}
