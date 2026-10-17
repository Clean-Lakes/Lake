package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSREParallelRolesExchangeMessagesAndRecordedSources(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	foreignSession, foreignResource := newSession(t, h)
	foreign, err := b.Store.CreateSRETask(ai.SRETask{SessionID: foreignSession, Goal: "隔离的其他任务", Scope: []string{foreignResource}, Mode: "plan_only", RequestID: "foreign_team_source", TokenBudget: 128000})
	must(err)
	foreignEvidence := "ev_11111111111111111111111111111111"
	_, err = b.Store.MutateSRETask(foreignSession, foreign.ID, 0, "foreign_evidence_fixture", func(task *ai.SRETask) error {
		task.Attempts = append(task.Attempts, ai.SREStepAttempt{ID: "foreign_attempt", Evidence: []ai.AgentEvidence{{ID: foreignEvidence, ResourceID: foreignResource}}})
		return nil
	})
	must(err)
	dir := t.TempDir()
	for _, role := range []string{"investigator", "coordinator", "verifier"} {
		must(os.WriteFile(filepath.Join(dir, role+".log"), []byte("TEAM_SOURCE_"+role), 0600))
	}
	step := func(id string, role ai.SREAgentRole, kind string, deps ...string) ai.SREPlanStep {
		return ai.SREPlanStep{ID: id, Role: role, Kind: kind, Capability: "application", Description: id, ResourceIDs: []string{resource}, DependsOn: deps, CompletionChecks: []string{"实际核对证据并交流"}}
	}
	plan := ai.SREPlanRevision{Goal: "并行交叉核对测试日志", TaskType: "investigation", Scope: []string{resource}, Steps: []ai.SREPlanStep{step("inspect", ai.SREInvestigator, "observe"), step("analyze", ai.SRECoordinator, "analyze"), step("independent", ai.SREVerifier, "verify"), step("最终汇总", ai.SRECoordinator, "summarize", "inspect", "analyze", "independent")}}
	plan.Steps[3].ID = "summary"
	var arrived, shared, sourceReads atomic.Int32
	initial, exchanged := make(chan struct{}), make(chan struct{})
	barrier := func(counter *atomic.Int32, ch chan struct{}) bool {
		if counter.Add(1) == 3 {
			close(ch)
		}
		select {
		case <-ch:
			return true
		case <-time.After(5 * time.Second):
			t.Error("roles did not make progress concurrently")
			return false
		}
	}
	closeProvider := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if strings.Contains(content, "Return only a JSON plan object") {
			emitModel(w, jsonText(plan), nil)
			return
		}
		if strings.Contains(content, "Assigned deliverable: 最终汇总") {
			if !strings.Contains(content, "this is the task's FINAL SUMMARY") || !strings.Contains(content, "日志返回实际测试内容") {
				t.Error("final summary lost its output stage or the structured node facts")
			}
			tasks, err := b.Store.ListSRETasks(session, 20, "")
			if err != nil || len(tasks) != 1 {
				t.Error("task unavailable")
			} else {
				done := 0
				for _, a := range tasks[0].Attempts {
					if a.Status == "succeeded" {
						done++
					}
				}
				if done != 3 {
					t.Error("summary ran before all dependencies", done)
				}
			}
			emitModel(w, "已结合三位专员的独立证据汇总。", nil)
			return
		}
		role := "coordinator"
		if strings.Contains(content, "Lake's investigator") {
			role = "investigator"
		}
		if strings.Contains(content, "Lake's independent verifier") {
			role = "verifier"
		}
		if !strings.Contains(content, "this is a NODE CHECKPOINT") {
			t.Error("non-terminal specialist was instructed to write another task summary", role)
		}
		tools := []Object{}
		for _, m := range objects(input["messages"]) {
			if m["role"] == "tool" {
				tools = append(tools, m)
			}
		}
		call := func(id, name string, args Object) ai.Call {
			return ai.Call{ID: role + id, Name: name, Arguments: jsonText(args)}
		}
		switch len(tools) {
		case 0:
			if !barrier(&arrived, initial) {
				reply(w, 500, Object{})
				return
			}
			if !strings.Contains(jsonText(input["tools"]), "sre_team_update") {
				t.Error("team tools missing")
			}
			emitModel(w, "开始独立核对。", []ai.Call{call("read", "read", Object{"asset_ref": sreAliasForTest(resource), "path": filepath.Join(dir, role+".log"), "runtime": "local"})})
		case 1:
			id := regexp.MustCompile(`ev_[a-f0-9]{32}`).FindString(stringOf(tools[0]["content"]))
			peer := map[string]string{"investigator": "coordinator", "coordinator": "verifier", "verifier": "investigator"}[role]
			emitModel(w, "", []ai.Call{call("message", "sre_team_update", Object{"message": "已完成独立采样，请结合共享原文交叉核对。", "to_role": peer, "evidence_ids": []string{id}}), call("board", "sre_team_read", Object{})})
		case 3:
			if !barrier(&shared, exchanged) {
				reply(w, 500, Object{})
				return
			}
			emitModel(w, "", []ai.Call{call("refresh", "sre_team_read", Object{})})
		case 4:
			var board Object
			must(json.Unmarshal([]byte(stringOf(tools[3]["content"])), &board))
			if len(objects(board["messages"])) == 0 || len(objects(board["evidence_index"])) != 3 {
				t.Error("live peer messages or evidence missing", role)
			}
			peerID := ""
			for _, ev := range objects(board["evidence_index"]) {
				if ev["role"] != role {
					peerID = stringOf(ev["evidence_id"])
					break
				}
			}
			emitModel(w, "", []ai.Call{call("foreign", "sre_team_read", Object{"evidence_id": foreignEvidence}), call("source", "sre_team_read", Object{"evidence_id": peerID, "offset": 0, "limit": 4096})})
		case 6:
			if !strings.Contains(stringOf(tools[len(tools)-2]["content"]), "不属于当前 SRE 任务") {
				t.Error("foreign task source was not rejected")
			}
			if !strings.Contains(stringOf(tools[len(tools)-1]["content"]), "TEAM_SOURCE_") {
				t.Error("peer source was not read")
			}
			sourceReads.Add(1)
			sender := map[string]string{"coordinator": "investigator", "verifier": "coordinator", "investigator": "verifier"}[role]
			id := regexp.MustCompile(`ev_[a-f0-9]{32}`).FindString(stringOf(tools[0]["content"]))
			emitModel(w, "", []ai.Call{call("reply", "sre_team_update", Object{"message": "已响应你的复核请求，读取原文并与本次独立采样交叉核对。", "to_role": sender, "evidence_ids": []string{id}})})
		default:
			if !strings.Contains(stringOf(tools[len(tools)-1]["content"]), `"published":true`) {
				t.Error("peer reply was not published")
			}
			if role == "investigator" {
				id := regexp.MustCompile(`ev_[a-f0-9]{32}`).FindString(stringOf(tools[0]["content"]))
				emitModel(w, jsonText(Object{"schemaVersion": 1, "summary": "已独立读取并交叉核对", "facts": []Object{{"statement": "日志返回实际测试内容", "evidenceIds": []string{id}}}, "hypotheses": []string{}, "unknowns": []string{}, "nextChecks": []string{}}), nil)
			} else {
				emitModel(w, fmt.Sprintf("%s 已独立核对并读取同伴原文，未执行变更。", role), nil)
			}
		}
	})
	defer closeProvider()
	apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/configure", Object{"contextWindow": 128000, "maxOutput": 8192}, 200)
	created := apiTest(t, h, "POST", "/api/sessions/"+session+"/sre/tasks", Object{"goal": plan.Goal, "resourceIds": []string{resource}, "mode": "assist", "clientRequestId": "parallel_roles"}, 202)
	task := waitSRE(t, b, session, stringOf(created["id"]), "completed", "paused")
	if task.Status != "completed" || arrived.Load() != 3 || sourceReads.Load() != 3 || len(task.Attempts) != 4 {
		t.Fatal("parallel team did not complete", task.Status, task.Error, arrived.Load(), sourceReads.Load())
	}
	exchanges, summaries := 0, 0
	for _, m := range task.Messages {
		if m.Kind == "summary" {
			summaries++
		}
		if m.Kind == "collaboration" {
			exchanges++
			if m.ToRoleID == "" || m.Source != "model" || len(m.EvidenceIDs) != 1 {
				t.Error("team message lost runtime identity")
			}
		}
	}
	if exchanges != 6 {
		t.Fatal("specialists did not exchange real messages", exchanges)
	}
	if summaries != 1 {
		t.Error("analysis and final stage published duplicate task summaries", summaries)
	}
	for _, a := range task.Attempts {
		if a.StepID == "inspect" && (a.Result != "已独立读取并交叉核对" || a.Report == nil || len(a.Report.Facts) != 1) {
			t.Error("node checkpoint expanded into its full evidence report or discarded the details")
		}
		if a.StepID != "summary" && len(a.Evidence) != 1 {
			t.Error("peer source reads were miscounted as fresh evidence")
		}
	}
}
