package web

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestComposerCompletionDoesNotCreateMessagesOrRunAgentTools(t *testing.T) {
	b, h := fixture(t)
	calls := 0
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if payload["tools"] != nil {
			t.Error("completion must not expose agent tools")
		}
		body, _ := json.Marshal(Object{"choices": []Object{{"delta": Object{"content": `{"suffix":"服务状态。"}`}, "finish_reason": "stop"}}})
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\n", body)
	}))
	defer remote.Close()
	id, _ := newSession(t, h)
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": remote.URL, "name": "completion-model", "protocol": "openai"}, 200)
	model := b.Models.Active()
	before := len(objects(b.Store.Snapshot(id)["messages"]))
	result := apiTest(t, h, "POST", "/api/sessions/"+id+"/completion", Object{"text": "帮我检查", "modelId": ai.ModelIdentity(*model)}, 200)
	if result["suffix"] != "服务状态。" || calls != 1 {
		t.Fatal("missing generated completion")
	}
	if len(objects(b.Store.Snapshot(id)["messages"])) != before || len(objects(b.Store.Snapshot(id)["actions"])) != 0 {
		t.Fatal("completion mutated the conversation")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/completion", Object{"text": "帮我检查", "modelId": "stale-model"}, 409)
	apiTest(t, h, "POST", "/api/sessions/missing/completion", Object{"text": "帮我检查"}, 404)
	if calls != 1 {
		t.Fatal("invalid completion requests called the provider")
	}
}

func TestComposerCompletionCancelsPreviousDraft(t *testing.T) {
	b, h := fixture(t)
	started, cancelled := make(chan struct{}), make(chan struct{})
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if strings.Contains(string(raw), "慢速") {
			close(started)
			select {
			case <-r.Context().Done():
				close(cancelled)
			case <-time.After(5 * time.Second):
				t.Error("obsolete provider request was not cancelled")
			}
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"{\"suffix\":\"新建议。\"}"},"finish_reason":"stop"}]}`+"\n\n")
	}))
	defer remote.Close()
	id, _ := newSession(t, h)
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": remote.URL, "name": "completion-model", "protocol": "openai"}, 200)
	first := make(chan Object, 1)
	go func() {
		first <- apiTest(t, h, "POST", "/api/sessions/"+id+"/completion", Object{"text": "慢速草稿"}, 200)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("first request did not start")
	}
	result := apiTest(t, h, "POST", "/api/sessions/"+id+"/completion", Object{"text": "新的草稿"}, 200)
	if result["suffix"] != "新建议。" {
		t.Fatal("new draft did not receive its own completion")
	}
	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("previous model request stayed active")
	}
	select {
	case old := <-first:
		if old["suffix"] != "" {
			t.Fatal("obsolete draft returned a suggestion")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("previous request did not finish")
	}
	if _, ok := b.draftCompletions.Load(id); ok {
		t.Fatal("completed request leaked")
	}
}
