package web

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestPlanModeSSEPublishesDelta(t *testing.T) {
	_, h := fixture(t)
	id, _ := newSession(t, h)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", h.URL+"/api/sessions/"+id+"/events?after=0", nil)
	req.Host = "localhost:4177"
	req.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
	response, err := h.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("SSE status", response.StatusCode)
	}
	saved := apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/mode", Object{"mode": ai.ModePlan}, 200)
	scanner := bufio.NewScanner(response.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var event Object
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
			t.Fatal(err)
		}
		if event["conversationMode"] == ai.ModePlan {
			if event["type"] != "session" || integer(event["seq"]) != integer(saved["cursor"]) {
				t.Fatal("incorrect SSE delta")
			}
			return
		}
	}
	t.Fatal("mode delta did not reach SSE client", scanner.Err())
}

func TestPlanModePublishesOrderedDeltaWithoutTranscriptOrResourceChanges(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	before := b.Store.Snapshot(id)
	events, unsubscribe := b.Store.Subscribe()
	defer unsubscribe()
	for _, mode := range []string{ai.ModePlan, ai.ModeDefault} {
		saved := apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/mode", Object{"mode": mode}, 200)
		if saved["mode"] != mode || integer(saved["cursor"]) <= integer(before["cursor"]) {
			t.Fatal("mode save did not return its event cursor")
		}
		select {
		case event := <-events:
			if event["type"] != "session" || event["sessionId"] != id || event["conversationMode"] != mode || integer(event["seq"]) != integer(saved["cursor"]) {
				t.Fatal("mode event is not a matching ordered delta")
			}
		case <-time.After(time.Second):
			t.Fatal("mode update did not reach live subscribers")
		}
		after := b.Store.Snapshot(id)
		for _, key := range []string{"session", "resources", "resourceTree", "terminals", "messages"} {
			if jsonText(before[key]) != jsonText(after[key]) {
				t.Fatal("mode change modified unrelated state: " + key)
			}
		}
		before = after
	}
}

func TestPlanModeReviewReviseAndExecuteCurrentProposal(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	other, _ := newSession(t, h)
	b.Store.SetSREEnabled(project, true)
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			w.Write([]byte(`{"data":[{"id":"fixture","context_length":128000}]}`))
			return
		}
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		n := requests.Add(1)
		if n < 3 {
			if !strings.Contains(jsonText(body["messages"]), "PLAN MODE") {
				t.Error("Plan prompt missing")
			}
			for _, tool := range objects(body["tools"]) {
				name := stringOf(object(tool["function"])["name"])
				if set("sre_collaborate call_mcp_tool write run_workflow schedule_create")[name] {
					t.Error("planning exposed mutating/SRE tool", name)
				}
			}
			emitModel(w, "<proposed_plan>\n# 发布方案\n\n1. 查看配置。\n2. 修改配置。\n3. 验证服务。\n</proposed_plan>", nil)
		} else {
			if strings.Contains(stringOf(objects(body["messages"])[0]["content"]), "PLAN MODE") {
				t.Error("execute still in Plan mode")
			}
			if !strings.Contains(jsonText(body["messages"]), "请执行以下已确认的计划") {
				t.Error("server did not include approved plan")
			}
			emitModel(w, "已根据计划完成验证。", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "fixture", Protocol: "openai"})
	modePath := "/api/sessions/" + id + "/ai/mode"
	if apiTest(t, h, "GET", modePath, nil, 200)["mode"] != ai.ModeDefault {
		t.Fatal("legacy session did not default to execution")
	}
	apiTest(t, h, "POST", modePath, Object{"mode": "invalid"}, 400)
	apiTest(t, h, "POST", modePath, Object{"mode": ai.ModePlan}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"conversationMode": ai.ModeDefault}, 400)
	if apiTest(t, h, "GET", "/api/sessions/"+other+"/ai/mode", nil, 200)["mode"] != ai.ModeDefault {
		t.Fatal("mode leaked across sessions")
	}
	if b.sessionSnapshot(id)["conversationMode"] != ai.ModePlan || b.sessionOptions(id)["conversationMode"] != ai.ModePlan {
		t.Fatal("mode not stored in snapshot/options")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "请制定发布计划"}, 202)
	awaitQueueWorkers(t, b)
	view := waitAI(t, b, id, "completed")
	if view.ProposedPlan == nil {
		t.Fatal("no executable proposal")
	}
	firstID := view.ProposedPlan.ID
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "加上服务验证步骤"}, 202)
	awaitQueueWorkers(t, b)
	view = waitAI(t, b, id, "completed")
	if view.ProposedPlan == nil || view.ProposedPlan.ID == firstID {
		t.Fatal("revision did not replace proposal")
	}
	plansPath := "/api/sessions/" + id + "/ai/plans"
	plans := objects(apiTest(t, h, "GET", plansPath, nil, 200)["plans"])
	if len(plans) != 2 || plans[0]["id"] != view.ProposedPlan.ID || plans[1]["id"] != firstID {
		t.Fatal("plan revisions missing from list")
	}
	executePath := "/api/sessions/" + id + "/ai/executePlan"
	apiTest(t, h, "POST", executePath, Object{"planId": firstID}, 409)
	// Restore the independent project setting only after proving Plan bypassed it.
	b.Store.SetSREEnabled(project, false)
	apiTest(t, h, "POST", executePath, Object{"planId": view.ProposedPlan.ID}, 202)
	apiTest(t, h, "POST", executePath, Object{"planId": view.ProposedPlan.ID}, 409)
	awaitQueueWorkers(t, b)
	view = waitAI(t, b, id, "completed")
	if view.ProposedPlan != nil || b.conversationMode(id) != ai.ModeDefault || requests.Load() != 3 {
		t.Fatal("execution did not consume proposal exactly once")
	}
	if len(objects(apiTest(t, h, "GET", plansPath, nil, 200)["plans"])) != 2 {
		t.Fatal("execution removed plan history")
	}
}

func TestPlanModeRejectsChangesWhileBusyOrQueued(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	path := "/api/sessions/" + id + "/ai/mode"
	b.messageMu.Lock()
	b.runningMessages = map[string]bool{id: true}
	b.messageMu.Unlock()
	apiTest(t, h, "POST", path, Object{"mode": ai.ModePlan}, 409)
	b.messageMu.Lock()
	delete(b.runningMessages, id)
	b.messageMu.Unlock()
	b.Store.EnqueueMessage(id, Object{"text": "待发送", "resourceIds": []string{}})
	apiTest(t, h, "POST", path, Object{"mode": ai.ModePlan}, 409)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/executePlan", Object{"planId": "stale"}, 409)
	if b.conversationMode(id) != ai.ModeDefault {
		t.Fatal("rejected mode update persisted")
	}
}
