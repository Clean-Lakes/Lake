package web

import (
	"encoding/json"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestSessionReasoningPersistsAndReachesProvider(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	other, _ := newSession(t, h)
	requests := make(chan Object, 4)
	nextRequest := func() Object {
		select {
		case req := <-requests:
			return req
		case <-time.After(5 * time.Second):
			t.Fatal("provider request missing")
			return nil
		}
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			reply(w, 200, Object{"data": []Object{{"id": "deepseek-flash"}}})
			return
		}
		var req Object
		json.NewDecoder(r.Body).Decode(&req)
		requests <- req
		emitModel(w, "你好，已收到。", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "magpie/deepseek/deepseek-flash", Protocol: "openai"})
	path := "/api/sessions/" + id + "/ai/reasoning"
	initial := apiTest(t, h, "GET", path, nil, 200)
	modelID := stringOf(initial["modelId"])
	apiTest(t, h, "POST", path, Object{"modelId": modelID, "effort": "max"}, 200)
	got := apiTest(t, h, "GET", path, nil, 200)
	if got["effort"] != "max" {
		t.Fatal("choice not persisted", got)
	}
	if apiTest(t, h, "GET", "/api/sessions/"+other+"/ai/reasoning", nil, 200)["effort"] != "" {
		t.Fatal("choice leaked across sessions")
	}
	// Bulk settings forms omit separately managed reasoning fields.
	options := apiTest(t, h, "GET", "/api/sessions/"+id+"/ai/options", nil, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", options, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "你好"}, 202)
	b.workers.Wait()
	if req := nextRequest(); req["reasoning_effort"] != "max" || object(req["thinking"])["type"] != "enabled" {
		t.Fatal("selection did not reach model", req["reasoning_effort"])
	}
	apiTest(t, h, "POST", path, Object{"modelId": modelID, "effort": "medium"}, 400)
	apiTest(t, h, "POST", path, Object{"modelId": modelID, "effort": 10}, 400)
	apiTest(t, h, "POST", path, Object{"modelId": modelID, "effort": "none"}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "谢谢"}, 202)
	b.workers.Wait()
	if req := nextRequest(); object(req["thinking"])["type"] != "disabled" || req["reasoning_effort"] != nil {
		t.Fatal("off did not reach provider")
	}
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "gpt-4.1", Protocol: "openai"})
	changed := apiTest(t, h, "GET", path, nil, 200)
	if changed["effort"] != "" || len(stringsOf(changed["levels"])) != 0 {
		t.Fatal("model switch retained unsupported choice", changed)
	}
	apiTest(t, h, "POST", path, Object{"modelId": modelID, "effort": "max"}, 409)
	apiTest(t, h, "POST", path, Object{"modelId": changed["modelId"], "effort": "high"}, 400)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "你好"}, 202)
	b.workers.Wait()
	if req := nextRequest(); req["thinking"] != nil || req["reasoning_effort"] != nil {
		t.Fatal("stale effort leaked to unsupported model")
	}
}

func TestReasoningChangeRejectedDuringRunningTurn(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			reply(w, 200, Object{"data": []Object{}})
			return
		}
		close(started)
		<-release
		emitModel(w, "已完成", nil)
	}))
	defer provider.Close()
	defer releaseOnce.Do(func() { close(release) })
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "deepseek-flash", Protocol: "openai"})
	path := "/api/sessions/" + id + "/ai/reasoning"
	initial := apiTest(t, h, "GET", path, nil, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "你好"}, 202)
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("provider request did not start")
	}
	apiTest(t, h, "POST", path, Object{"modelId": initial["modelId"], "effort": "max"}, 409)
	releaseOnce.Do(func() { close(release) })
	b.workers.Wait()
	if apiTest(t, h, "GET", path, nil, 200)["effort"] != "" {
		t.Fatal("rejected update was saved")
	}
}
