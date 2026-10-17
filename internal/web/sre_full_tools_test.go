package web

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSREFullSpecialistUsesShellThenFileWithInheritedApproval(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	other, _ := newSession(t, h)
	options := b.Store.Options(session)
	options["silentReadFiles"] = false
	options["silentCommands"] = true
	options["silentTerminalCreation"] = true
	b.Store.SaveOptions(session, options)
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	path := filepath.Join(dir, "service.log")
	if err := os.WriteFile(path, []byte("FULL_SPECIALIST_FILE actual source\n"), 0600); err != nil {
		t.Fatal(err)
	}
	plan := ai.SREPlanRevision{Goal: "检查本机及指定日志", TaskType: "investigation", Scope: []string{resource}, Steps: []ai.SREPlanStep{{ID: "inspect", Role: ai.SREInvestigator, Kind: "observe", Capability: "application", Description: "自主执行只读命令并读取指定日志", ResourceIDs: []string{resource}, CompletionChecks: []string{"记录命令和日志的实际证据"}}, {ID: "summary", Role: ai.SRECoordinator, Kind: "summarize", Description: "汇总真实记录", ResourceIDs: []string{resource}, DependsOn: []string{"inspect"}, CompletionChecks: []string{"不把采样成功视为业务恢复"}}}}
	closeProvider := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if strings.Contains(content, "Return only a JSON plan object") {
			emitModel(w, jsonText(plan), nil)
			return
		}
		if strings.Contains(content, "Lake's investigator") {
			n := 0
			for _, m := range objects(input["messages"]) {
				if m["role"] == "tool" {
					n++
				}
			}
			switch n {
			case 0:
				if !strings.Contains(jsonText(input["tools"]), `"name":"shell"`) || !strings.Contains(jsonText(input["tools"]), `"name":"read"`) {
					t.Error("specialist still received only fixed probes")
				}
				emitModel(w, "先运行只读命令，再查看日志。", []ai.Call{{ID: "custom-shell", Name: "shell", Arguments: jsonText(Object{"asset_ref": sreAliasForTest(resource), "runtime": "local", "command": "printf FULL_SPECIALIST_SHELL"})}})
			case 1:
				emitModel(w, "", []ai.Call{{ID: "ordinary-read", Name: "read", Arguments: jsonText(Object{"asset_ref": sreAliasForTest(resource), "path": path, "runtime": "local"})}})
			default:
				ids := regexp.MustCompile(`ev_[a-f0-9]{32}`).FindAllString(content, -1)
				emitModel(w, jsonText(Object{"schemaVersion": 1, "summary": "自定义命令与文件均已核对", "facts": []Object{{"statement": "命令及日志返回真实输出", "evidenceIds": ids}}, "hypotheses": []string{}, "unknowns": []string{"未验证业务恢复"}, "nextChecks": []string{}}), nil)
			}
			return
		}
		emitModel(w, "已核对实际输出，业务恢复仍需额外验收。", nil)
	})
	defer closeProvider()
	created := apiTest(t, h, "POST", "/api/sessions/"+session+"/sre/tasks", Object{"goal": plan.Goal, "resourceIds": []string{resource}, "mode": "assist", "clientRequestId": "full_tools"}, 202)
	task := waitSRE(t, b, session, stringOf(created["id"]), "waiting_approval", "paused")
	if task.Status != "waiting_approval" {
		t.Fatal("file policy was not inherited", task.Error)
	}
	progress := false
	for _, m := range task.Messages {
		progress = progress || m.RoleID == ai.SREInvestigator && m.Kind == "progress" && m.Source == "model" && strings.Contains(m.Body, "先运行只读命令")
	}
	if !progress {
		t.Fatal("specialist's actual model progress did not reach the conversation")
	}
	var pending ai.AgentRun
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
		view, _ := b.Engine.Snapshot(session)
		for _, run := range view.AgentRuns {
			if run.Pending != nil {
				pending = run
			}
		}
		if pending.Pending != nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if pending.Pending == nil || pending.Pending.Kind != "file_read" || pending.SRERole != ai.SREInvestigator {
		t.Fatal("real specialist file approval missing")
	}
	apiTest(t, h, "POST", "/api/sessions/"+other+"/ai/agentDecision", Object{"runId": pending.ID, "id": pending.Pending.ID, "accept": true}, 409)
	apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/agentDecision", Object{"runId": pending.ID, "id": pending.Pending.ID, "accept": true}, 200)
	task = waitSRE(t, b, session, task.ID, "completed", "paused")
	if task.Status != "completed" || len(task.Attempts) != 2 || len(task.Attempts[0].Evidence) != 2 || len(task.Attempts[0].Operations) != 1 || task.Attempts[0].Operations[0].Status != "succeeded" {
		t.Fatal("full specialist result/journal lost", task.Status, task.Error)
	}
	for _, ev := range task.Attempts[0].Evidence {
		page := apiTest(t, h, "GET", "/api/sessions/"+session+"/sre/tasks/"+task.ID+"/evidence/"+ev.ID+"?limit=4096", nil, 200)
		if !strings.Contains(stringOf(page["source"]), "FULL_SPECIALIST_") {
			t.Fatal("evidence is not the actual tool output")
		}
	}
}
