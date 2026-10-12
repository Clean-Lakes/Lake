package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func awaitQueueRequest(t *testing.T, requests <-chan string) string {
	t.Helper()
	select {
	case message := <-requests:
		return message
	case <-time.After(5 * time.Second):
		t.Fatal("queued turn did not reach model")
		return ""
	}
}
func awaitQueueWorkers(t *testing.T, b *Server) {
	t.Helper()
	done := make(chan struct{})
	go func() { b.workers.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("queued turn worker did not finish")
	}
}
func lastQueueRequest(body Object) string {
	result := ""
	for _, message := range objects(body["messages"]) {
		if message["role"] == "user" {
			result = stringOf(message["content"])
		}
	}
	parts := strings.Split(result, "\n")
	return parts[len(parts)-1]
}
func TestMessageQueueFIFOEditingRemovalAndOrdering(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	requests := make(chan string, 8)
	release := make(chan struct{}, 8)
	var active, maxActive atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			fmt.Fprint(w, `{"data":[{"id":"fixture","context_length":128000}]}`)
			return
		}
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		value := active.Add(1)
		defer active.Add(-1)
		for {
			current := maxActive.Load()
			if value <= current || maxActive.CompareAndSwap(current, value) {
				break
			}
		}
		requests <- lastQueueRequest(body)
		select {
		case <-release:
			emitModel(w, "收到。", nil)
		case <-r.Context().Done():
		}
	}))
	defer provider.Close()
	defer b.Close()
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "你好"}, 202)
	if awaitQueueRequest(t, requests) != "你好" {
		t.Fatal("first request changed")
	}
	a := apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "谢谢"}, 202)
	c := apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "收到"}, 202)
	d := apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "好的"}, 202)
	if a["queued"] != true || len(objects(b.Store.MessageQueue(id)["items"])) != 3 {
		t.Fatal("busy messages not queued")
	}
	path := "/api/sessions/" + id + "/message-queue"
	queue := object(d["messageQueue"])
	queue = apiTest(t, h, "POST", path, Object{"operation": "pause", "revision": queue["revision"]}, 200)
	queue = apiTest(t, h, "POST", path, Object{"operation": "edit", "revision": queue["revision"], "id": a["queuedMessageId"], "text": "明白", "resourceIds": []string{}}, 200)
	queue = apiTest(t, h, "POST", path, Object{"operation": "remove", "revision": queue["revision"], "id": c["queuedMessageId"]}, 200)
	queue = apiTest(t, h, "POST", path, Object{"operation": "reorder", "revision": queue["revision"], "ids": []string{stringOf(d["queuedMessageId"]), stringOf(a["queuedMessageId"])}}, 200)
	if len(objects(b.Store.Snapshot(id)["messages"])) != 1 {
		t.Fatal("future input entered the active turn")
	}
	queue = apiTest(t, h, "POST", path, Object{"operation": "resume", "revision": queue["revision"]}, 200)
	select {
	case <-requests:
		t.Fatal("second request started before first completed")
	default:
	}
	release <- struct{}{}
	if awaitQueueRequest(t, requests) != "好的" {
		t.Fatal("reordering was ignored")
	}
	if len(objects(b.Store.MessageQueue(id)["items"])) != 1 {
		t.Fatal("more than one message consumed")
	}
	release <- struct{}{}
	if awaitQueueRequest(t, requests) != "明白" {
		t.Fatal("edited message not used")
	}
	release <- struct{}{}
	awaitQueueWorkers(t, b)
	if maxActive.Load() != 1 || len(objects(b.Store.MessageQueue(id)["items"])) != 0 {
		t.Fatal("turns overlapped or queue not drained")
	}
	users := []string{}
	for _, message := range objects(b.Store.Snapshot(id)["messages"]) {
		if message["role"] == "user" {
			users = append(users, stringOf(message["text"]))
		}
	}
	if strings.Join(users, ",") != "你好,好的,明白" {
		t.Fatal("queue text or order incorrect", users)
	}
}
func TestMessageQueueStopsOnAbortAndFailure(t *testing.T) {
	for _, failure := range []bool{false, true} {
		t.Run(fmt.Sprint("failure=", failure), func(t *testing.T) {
			b, h := fixture(t)
			id, _ := newSession(t, h)
			started := make(chan struct{}, 1)
			release := make(chan struct{}, 1)
			var count atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					fmt.Fprint(w, `{"data":[]}`)
					return
				}
				if count.Add(1) > 1 {
					emitModel(w, "收到。", nil)
					return
				}
				started <- struct{}{}
				if failure {
					<-release
					http.Error(w, "synthetic failure", 503)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"正在回复\"}}]}\n\n")
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			}))
			defer provider.Close()
			defer b.Close()
			b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "fixture", Protocol: "openai"})
			apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "你好"}, 202)
			<-started
			apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "谢谢"}, 202)
			if failure {
				release <- struct{}{}
			} else {
				apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/abort", Object{}, 200)
			}
			awaitQueueWorkers(t, b)
			queue := b.Store.MessageQueue(id)
			if count.Load() != 1 || queue["paused"] != true || len(objects(queue["items"])) != 1 {
				t.Fatal("stop/failure dispatched queued work")
			}
			apiTest(t, h, "POST", "/api/sessions/"+id+"/message-queue", Object{"operation": "resume", "revision": queue["revision"]}, 200)
			awaitQueueWorkers(t, b)
			if count.Load() != 2 || len(objects(b.Store.MessageQueue(id)["items"])) != 0 {
				t.Fatal("explicit resume did not dispatch")
			}
		})
	}
}
func TestMessageQueuePersistenceIsolationAndRevisionConflicts(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	other, foreign := newSession(t, h)
	b.Store.Status(id, "investigating")
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "谢谢", "resourceIds": []string{foreign}}, 404)
	file := b.saveImportSource(stringOf(b.Store.Session(other)["projectId"]), other, "file.txt", "hosts")
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "谢谢", "files": []Object{file}}, 403)
	good := apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "谢谢", "resourceIds": []string{ref}}, 202)
	queue := object(good["messageQueue"])
	qid := stringOf(good["queuedMessageId"])
	path := "/api/sessions/" + id + "/message-queue"
	apiTest(t, h, "POST", path, Object{"operation": "edit", "revision": queue["revision"], "id": qid, "text": "明白", "resourceIds": []string{foreign}}, 404)
	apiTest(t, h, "POST", path, Object{"operation": "remove", "revision": 0, "id": qid}, 409)
	apiTest(t, h, "POST", path, Object{"operation": "remove", "revision": "wrong", "id": qid}, 409)
	apiTest(t, h, "POST", path, Object{"operation": "reorder", "revision": queue["revision"], "ids": []string{qid, qid}}, 409)
	apiTest(t, h, "POST", "/api/sessions/"+other+"/message-queue", Object{"operation": "remove", "revision": 0, "id": qid}, 404)
	if len(objects(b.Store.MessageQueue(id)["items"])) != 1 {
		t.Fatal("invalid mutations changed queue")
	}
	// Delete references after enqueue: access is checked again before the turn starts.
	b.Models.Save(&ai.Model{URL: "http://localhost:12345/v1/chat/completions", Name: "fixture", Protocol: "openai"})
	b.Store.update(func() any {
		b.Store.exec("DELETE FROM sessionResources WHERE resourceId=?", ref)
		b.Store.exec("DELETE FROM resourceTree WHERE resourceId=?", ref)
		b.Store.exec("DELETE FROM resources WHERE id=?", ref)
		return nil
	})
	b.Store.Status(id, "completed")
	apiTest(t, h, "POST", path, Object{"operation": "resume", "revision": queue["revision"]}, 200)
	if state := b.Store.MessageQueue(id); state["paused"] != true || len(objects(state["items"])) != 1 {
		t.Fatal("dispatch used a deleted resource")
	}
	home := t.TempDir()
	store, err := OpenStore(home)
	if err != nil {
		t.Fatal(err)
	}
	project := store.CreateProject("queue persistence")
	session := store.CreateSession(stringOf(project["id"]), "queued", nil)
	sid := stringOf(session["id"])
	store.EnqueueMessage(sid, Object{"text": "pending", "images": []Object{{"id": "image", "name": "fixture.png", "mimeType": "image/png", "base64": "private-image-payload"}}})
	if strings.Contains(jsonText(store.MessageQueue(sid)), "private-image-payload") {
		t.Fatal("snapshot exposes image payload")
	}
	store.Close()
	store, err = OpenStore(home)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	restored := store.MessageQueue(sid)
	if restored["paused"] != true || len(objects(restored["items"])) != 1 || !strings.Contains(stringOf(restored["lastError"]), "重启") {
		t.Fatal("restart lost or replayed queued messages")
	}
	if len(objects(store.Snapshot(sid)["messages"])) != 0 {
		t.Fatal("restart posted future messages")
	}
	store.DeleteSession(sid)
	if len(store.rows("SELECT id FROM queuedMessages WHERE sessionId=?", sid)) != 0 {
		t.Fatal("session delete orphaned queue")
	}
}
func TestMessageQueueConcurrentSubmissionNeverOverlapsTurns(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	started := make(chan struct{}, 20)
	release := make(chan struct{}, 20)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			fmt.Fprint(w, `{"data":[]}`)
			return
		}
		calls.Add(1)
		started <- struct{}{}
		select {
		case <-release:
			emitModel(w, "好。", nil)
		case <-r.Context().Done():
		}
	}))
	defer provider.Close()
	defer b.Close()
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "fixture", Protocol: "openai"})
	var workers sync.WaitGroup
	statuses := make(chan int, 6)
	for i := 0; i < 6; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			request, _ := http.NewRequest("POST", h.URL+"/api/sessions/"+id+"/messages", strings.NewReader(`{"text":"你好"}`))
			request.Host = "localhost:4177"
			request.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
			request.Header.Set("Content-Type", "application/json")
			response, err := h.Client().Do(request)
			if err != nil {
				statuses <- 0
				return
			}
			response.Body.Close()
			statuses <- response.StatusCode
		}()
	}
	workers.Wait()
	close(statuses)
	for status := range statuses {
		if status != 202 {
			t.Fatal("concurrent submission rejected", status)
		}
	}
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("first model request missing")
	}
	if calls.Load() != 1 || len(objects(b.Store.MessageQueue(id)["items"])) != 5 {
		t.Fatal("admission started overlapping turns")
	}
	for i := 0; i < 6; i++ {
		release <- struct{}{}
	}
	awaitQueueWorkers(t, b)
	if calls.Load() != 6 || len(objects(b.Store.MessageQueue(id)["items"])) != 0 {
		t.Fatal("concurrent messages lost or duplicated")
	}
}

func TestMessageQueueAttachmentsStayScopedAndAreRevalidated(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	b.Store.Status(id, "investigating")
	b.Models.Save(&ai.Model{URL: "http://localhost:12345/v1/chat/completions", Name: "fixture", Protocol: "openai", SupportsImageInput: true})
	file := b.saveImportSource(stringOf(b.Store.Session(id)["projectId"]), id, "actual.txt", "synthetic file")
	file["name"] = "spoofed.txt"
	file["unknown"] = "must-not-appear"
	const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
	result := apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "你好", "images": []Object{{"id": "image", "name": "fixture.png", "mimeType": "image/png", "base64": image}}, "files": []Object{file}}, 202)
	if strings.Contains(jsonText(result), image) || strings.Contains(jsonText(result), "must-not-appear") || strings.Contains(jsonText(result), "spoofed.txt") {
		t.Fatal("raw attachment metadata returned")
	}
	if !strings.Contains(jsonText(result), "actual.txt") {
		t.Fatal("attachment filename lost")
	}
	b.Models.Save(&ai.Model{URL: "http://localhost:12345/v1/chat/completions", Name: "fixture", Protocol: "openai"})
	b.Store.Status(id, "completed")
	queue := object(result["messageQueue"])
	apiTest(t, h, "POST", "/api/sessions/"+id+"/message-queue", Object{"operation": "resume", "revision": queue["revision"]}, 200)
	state := b.Store.MessageQueue(id)
	if state["paused"] != true || !strings.Contains(stringOf(state["lastError"]), "图片") || len(objects(state["items"])) != 1 {
		t.Fatal("changed model consumed incompatible image")
	}
}
