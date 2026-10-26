package web

import (
	"net/http"
	"net/http/httptest"
	"os/exec"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestPilotParallelNetworkHeadActuallyExecutesAndFinishes(t *testing.T) {
	if _, err := exec.LookPath("curl"); err != nil {
		t.Skip("curl unavailable")
	}
	b, h := fixture(t)
	session, resource := newSession(t, h)
	var requests atomic.Int32
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != http.MethodHead || r.URL.Path != "/" {
			t.Error("probe changed method or path")
		}
		w.Header().Set("X-Lake-Network-Fixture", "actual-head-response")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer endpoint.Close()
	plan := ai.SREPlanRevision{Goal: "独立核对连接", TaskType: "investigation", Scope: []string{resource}, Steps: []ai.SREPlanStep{
		{ID: "probe", Role: ai.SREInvestigator, Kind: "observe", Capability: "host", Description: "读取响应头", ResourceIDs: []string{resource}, CompletionChecks: []string{"实际返回响应头"}},
		{ID: "review", Role: ai.SREVerifier, Kind: "verify", Description: "独立复测响应头", ResourceIDs: []string{resource}, CompletionChecks: []string{"独立收到响应头"}},
		{ID: "summary", Role: ai.SRECoordinator, Kind: "summarize", Description: "汇总两方证据", ResourceIDs: []string{resource}, DependsOn: []string{"probe", "review"}, CompletionChecks: []string{"不补造结果"}},
	}}
	closeProvider := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
		messages := objects(input["messages"])
		content := jsonText(messages)
		if strings.Contains(content, "Return only a JSON plan object") {
			emitModel(w, jsonText(plan), nil)
			return
		}
		if strings.Contains(content, "Lake's investigator") || strings.Contains(content, "Lake's independent verifier") {
			called := false
			for _, m := range messages {
				called = called || m["role"] == "tool" && m["tool_call_id"] == "network-head"
			}
			if !called {
				emitModel(w, "", []ai.Call{{ID: "network-head", Name: "shell", Arguments: jsonText(Object{"asset_ref": sreAliasForTest(resource), "runtime": "local", "command": "curl -sS -I --max-time 3 " + endpoint.URL, "timeout_ms": 10000})}})
				return
			}
			emitModel(w, jsonText(Object{"schemaVersion": 1, "summary": "已取得真实响应头", "facts": []Object{{"statement": "实际返回204响应", "evidenceIds": regexp.MustCompile(`ev_[a-f0-9]{32}`).FindAllString(content, -1)}}, "unknowns": []string{}, "hypotheses": []string{}, "nextChecks": []string{}}), nil)
			return
		}
		emitModel(w, "两方均已独立读取响应头。", nil)
	})
	defer closeProvider()
	allowFixtureHost(b, session)
	project := stringOf(b.Store.Session(session)["projectId"])
	apiTest(t, h, "PUT", "/api/projects/"+project+"/pilot", Object{"enabled": true, "autoAdvance": true, "expectedRevision": b.Store.PilotSettings(project)["revision"]}, 200)
	created := apiTest(t, h, "POST", "/api/sessions/"+session+"/sre/tasks", Object{"goal": plan.Goal, "resourceIds": []string{resource}, "mode": "assist", "clientRequestId": "network-diagnostic"}, 202)
	task := waitSRE(t, b, session, stringOf(created["id"]), "completed", "paused", "waiting_approval")
	if task.Status != "completed" || requests.Load() != 2 {
		t.Fatalf("network checks did not finish: %s %s requests=%d", task.Status, task.Error, requests.Load())
	}
	operations := 0
	for _, a := range task.Attempts {
		for _, op := range a.Operations {
			operations++
			if op.Risk != "readonly" || op.Status != "succeeded" || len(op.EvidenceIDs) == 0 || !strings.Contains(strings.ToLower(op.Result), "x-lake-network-fixture") {
				t.Fatal("actual diagnostic evidence missing", op.Status)
			}
		}
	}
	if operations != 2 {
		t.Fatalf("expected one probe per specialist, got %d", operations)
	}
}
