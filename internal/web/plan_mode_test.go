package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

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
