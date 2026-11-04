package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSuperWorkerDirectReplyProgress(t *testing.T) {
	b, h := fixture(t)
	entered, release := make(chan struct{}, 1), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			io.WriteString(w, `{"data":[]}`)
			return
		}
		io.Copy(io.Discard, r.Body)
		select {
		case entered <- struct{}{}:
		default:
		}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		emitModel(w, "已收到，未调用工具。", nil)
	}))
	t.Cleanup(func() { unblock(); provider.Close() })
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "worker-progress-fixture", Protocol: "openai"})
	p := b.Store.CreateProject("Worker reply progress")
	pid := stringOf(p["id"])
	d := apiTest(t, h, "POST", "/api/projects/"+pid+"/superagent", Object{}, 200)
	pilot := stringOf(d["routerSessionId"])
	m := b.Store.AddMessage(pilot, "user", "Explain without resource operations", nil)
	event, err := b.ReceiveUserEvent(t.Context(), pilot, stringOf(m["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if err = b.recordSuperInput(event, nil, nil, false); err != nil {
		t.Fatal(err)
	}
	worker, err := b.Engine.ApplySuperDecision(t.Context(), b.superUserSource(pid, pilot), ai.SuperDecision{EventID: event.ID, PartKey: "explain", Action: "create", Title: "Explain", RoleKey: "分析专员", Quote: event.Payload, Reason: "Independent explanation"})
	if err != nil {
		t.Fatal(err)
	}
	if err = b.Engine.FinishSuperUserRouting(t.Context(), b.superUserSource(pid, pilot), event.ID); err != nil {
		t.Fatal(err)
	}
	domain, _, err := b.Engine.SuperProject(t.Context(), pid)
	if err != nil {
		t.Fatal(err)
	}
	b.startSuperWorkers(domain)
	select {
	case <-entered:
	case <-time.After(8 * time.Second):
		t.Fatal("worker never reached the controlled model")
	}
	before := apiTest(t, h, "GET", "/api/sessions/"+worker.SessionID+"/snapshot", nil, 200)
	goalState := object(object(before["superagent"])["task"])["state"]
	message := apiTest(t, h, "POST", "/api/sessions/"+worker.SessionID+"/messages", Object{"text": "direct-worker-gated-followup: explain only, no tools"}, 202)
	snapshot := apiTest(t, h, "GET", "/api/sessions/"+worker.SessionID+"/snapshot", nil, 200)
	view := object(snapshot["ai"])
	if view["status"] != "running" || view["replyStatus"] != "running" {
		t.Fatal("live model response was not projected", view["status"])
	}
	if goal := object(object(snapshot["superagent"])["task"]); goal["state"] != goalState {
		t.Fatal("reply presentation promoted the canonical task", goal["state"])
	}
	if last := objects(snapshot["messages"]); len(last) == 0 || last[len(last)-1]["id"] != message["id"] {
		t.Fatal("direct user message missing")
	}
	unblock()
	waitAI(t, b, worker.SessionID, "paused")
}
