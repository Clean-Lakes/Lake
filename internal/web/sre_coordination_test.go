package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func emitSREReply(w http.ResponseWriter, kind, text string) {
	emitModel(w, "", []ai.Call{{ID: "final-reply", Name: "sre_reply", Arguments: jsonText(Object{"kind": kind, "text": text})}})
}

func sreCoordinationFixture(t *testing.T, b *Server, h *httptest.Server, session string, handler func(http.ResponseWriter, Object)) func() {
	t.Helper()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			reply(w, 200, Object{"data": []Object{{"id": "coordination-fixture"}}})
			return
		}
		var input Object
		_ = json.NewDecoder(r.Body).Decode(&input)
		handler(w, input)
	}))
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL, "name": "coordination-fixture", "protocol": "openai"}, 200)
	apiTest(t, h, "PUT", "/api/projects/"+stringOf(b.Store.Session(session)["projectId"])+"/sre", Object{"enabled": true}, 200)
	return provider.Close
}

func TestSREModelChoosesConversationOrClarificationWithFullContext(t *testing.T) {
	for _, tc := range []struct{ input, reply string }{{"再试试", "我继续核对刚才的图片；目前没有新的图片数据，不能补造画面内容。"}, {"?", "你是在问刚才截图里的提示吗？我先解释这条提示。"}, {"只出计划这几个字是什么意思", "它表示先讨论步骤，不立即执行。"}} {
		t.Run(tc.input, func(t *testing.T) {
			b, h := fixture(t)
			session, _ := newSession(t, h)
			b.Store.AddMessage(session, "user", "之前讨论的是截图中的对话，不是主机操作。", nil)
			var calls atomic.Int32
			closeProvider := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
				if !strings.Contains(jsonText(input["messages"]), "conversation owner") {
					emitModel(w, "metadata", nil)
					return
				}
				calls.Add(1)
				if !strings.Contains(jsonText(input["messages"]), "之前讨论的是截图中的对话") {
					t.Error("conversation context was lost")
				}
				names := map[string]bool{}
				for _, tool := range objects(input["tools"]) {
					names[stringOf(object(tool["function"])["name"])] = true
				}
				if !names["sre_collaborate"] || names["shell"] || names["write"] {
					t.Error("parent cannot choose collaboration or can bypass specialists")
				}
				emitSREReply(w, "answer", tc.reply)
			})
			defer closeProvider()
			apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": tc.input}, 202)
			awaitQueueWorkers(t, b)
			tasks, _ := b.Store.ListSRETasks(session, 20, "")
			messages := objects(b.Store.Snapshot(session)["messages"])
			if len(tasks) != 0 || calls.Load() != 1 || messages[len(messages)-1]["text"] != tc.reply {
				t.Fatal("runtime replaced the model's contextual answer")
			}
		})
	}
}

func TestSREModelSelectsPlanFromContextWithoutExplicitMention(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	alias := sreAliasForTest(resource)
	b.Store.CreateResource(stringOf(b.Store.Session(session)["projectId"]), "未选中的测试库", "database", Object{"driver": "postgres", "host": "192.0.2.8", "port": 5432, "database": "fixture"})
	b.Store.AddMessage(session, "user", "刚才已明确目标是这个项目的本机，只讨论检查步骤。", nil)
	var rootCalls atomic.Int32
	plan := ai.SREPlanRevision{Goal: "根据此前目标制定本机调查步骤", TaskType: "investigation", Scope: []string{resource}, Steps: []ai.SREPlanStep{{ID: "inspect", Role: ai.SREInvestigator, Kind: "observe", Capability: "host", Description: "检查目标主机", ResourceIDs: []string{resource}, CompletionChecks: []string{"取得新证据"}}}}
	closeProvider := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if strings.Contains(content, "Return only a JSON plan object") {
			emitModel(w, jsonText(plan), nil)
			return
		}
		if !strings.Contains(content, "conversation owner") {
			emitModel(w, "metadata", nil)
			return
		}
		rootCalls.Add(1)
		if !strings.Contains(content, "刚才已明确目标") {
			t.Error("handoff decision had no context")
		}
		emitModel(w, "我会先整理此前目标的调查计划。", []ai.Call{{ID: "choose-plan", Name: "sre_collaborate", Arguments: jsonText(Object{"action": "new_task", "goal": plan.Goal, "asset_refs": []string{alias}, "mode": "plan_only"})}})
	})
	defer closeProvider()
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "再试试"}, 202)
	awaitQueueWorkers(t, b)
	tasks, err := b.Store.ListSRETasks(session, 20, "")
	if err != nil || len(tasks) != 1 || len(tasks[0].Plans) != 1 || tasks[0].Status != "draft" || len(tasks[0].Attempts) != 0 || rootCalls.Load() != 1 {
		t.Fatal("model-selected draft handoff failed", err, tasks)
	}
	remembered, _ := b.Engine.ReferencedAssets(session)
	if len(remembered) != 0 {
		t.Fatal("model-inferred target became an explicit user reference")
	}
	if extra, err := b.Engine.TakeSREHandoff(session); err != nil || extra != nil {
		t.Fatal("a consumed model handoff could be replayed", err)
	}
	if tasks[0].Scope[0] != resource {
		t.Fatal("resource alias was not resolved by the runtime")
	}
}

func TestSREModelHandoffCannotGrantResourceReferencePermission(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	options := b.Store.Options(session)
	options["blockUnreferencedAssets"] = true
	b.Store.SaveOptions(session, options)
	var roots atomic.Int32
	closeProvider := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if !strings.Contains(content, "conversation owner") {
			emitModel(w, "metadata", nil)
			return
		}
		roots.Add(1)
		for _, m := range objects(input["messages"]) {
			if m["role"] == "tool" && m["name"] == "sre_collaborate" {
				if !strings.Contains(stringOf(m["content"]), "permissions require") {
					t.Error("missing permission rejection")
				}
				emitSREReply(w, "clarification", "当前权限只允许已授权引用的资源。请先选择你希望检查的目标。")
				return
			}
		}
		emitModel(w, "", []ai.Call{{ID: "unreferenced-target", Name: "sre_collaborate", Arguments: jsonText(Object{"action": "new_task", "goal": "检查本机", "asset_refs": []string{sreAliasForTest(resource)}, "mode": "plan_only"})}})
	})
	defer closeProvider()
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "检查此前的主机"}, 202)
	awaitQueueWorkers(t, b)
	tasks, _ := b.Store.ListSRETasks(session, 20, "")
	refs, _ := b.Engine.ReferencedAssets(session)
	if len(tasks) != 0 || len(refs) != 0 || roots.Load() != 2 {
		t.Fatal("model bypassed scope permissions")
	}
}

func TestSREActiveDraftDoesNotForceUnrelatedConversationIntoExecution(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	task, err := b.Store.CreateSRETask(ai.SRETask{SessionID: session, Goal: "讨论本机检查", Scope: []string{resource}, Mode: "plan_only", RequestID: "active_draft", TokenBudget: 128000})
	if err != nil {
		t.Fatal(err)
	}
	closeProvider := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
		if strings.Contains(jsonText(input["messages"]), "conversation owner") && !strings.Contains(jsonText(input["messages"]), task.ID) {
			t.Error("active task not presented to the model")
		}
		emitSREReply(w, "answer", "Plan 是可修订的任务计划，我先解释它，不启动调查。")
	})
	defer closeProvider()
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "解释一下 Plan 是什么"}, 202)
	awaitQueueWorkers(t, b)
	latest, err := b.Store.LoadSRETask(session, task.ID)
	if err != nil || len(latest.Runs) != 0 || len(latest.Plans) != 0 || latest.Status != "draft" {
		t.Fatal("conversation automatically ran an active draft", err)
	}
}

func TestSREModelCanChooseOneSpecialistWithoutRunningThePlan(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	task, err := b.Store.CreateSRETask(ai.SRETask{SessionID: session, Goal: "讨论检查范围", Scope: []string{resource}, Mode: "plan_only", RequestID: "specialist_choice", TokenBudget: 128000})
	if err != nil {
		t.Fatal(err)
	}
	closeProvider := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if strings.Contains(content, "conversation owner") {
			emitModel(w, "请验证员解释已有验收范围。", []ai.Call{{ID: "ask-specialist", Name: "sre_collaborate", Arguments: jsonText(Object{"action": "ask_role", "task_id": task.ID, "role": "verifier", "goal": "说明目前还缺少哪些验收依据"})}})
			return
		}
		emitModel(w, "目前只有任务目标，还没有独立采样，不能声称恢复已验证。", nil)
	})
	defer closeProvider()
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "这算验证通过了吗"}, 202)
	awaitQueueWorkers(t, b)
	latest, err := b.Store.LoadSRETask(session, task.ID)
	if err != nil || len(latest.Attempts) != 0 || len(latest.Runs) != 0 || len(latest.Messages) != 1 || latest.Messages[0].RoleID != ai.SREVerifier || latest.Messages[0].RoleRunID == "" {
		t.Fatal("model-selected specialist answer became a plan execution", err)
	}
}

func TestSREConversationKeepsCurrentAndHistoricalImagesInTheModelContext(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	var roots atomic.Int32
	imageData := "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
	closeProvider := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if !strings.Contains(content, "conversation owner") {
			emitModel(w, "metadata", nil)
			return
		}
		roots.Add(1)
		if !strings.Contains(content, "data:image/png;base64,"+imageData) {
			t.Error("actual image payload was replaced with a text-only routing context")
		}
		emitSREReply(w, "answer", "图中提供了对话和资源列表；我会结合前文解释。")
	})
	defer closeProvider()
	model := b.Models.Active()
	model.SupportsImageInput = true
	b.Models.Save(model)
	image := Object{"id": "coordination-image", "name": "fixture.png", "mimeType": "image/png", "base64": imageData}
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "解释一下这张图", "images": []any{image}}, 202)
	awaitQueueWorkers(t, b)
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "?"}, 202)
	awaitQueueWorkers(t, b)
	tasks, _ := b.Store.ListSRETasks(session, 20, "")
	if roots.Load() != 2 || len(tasks) != 0 {
		t.Fatal("image discussion was forced into a resource task")
	}
}

func TestSREPromisedInspectionContinuesIntoRealSpecialistWork(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	allowFixtureHost(b, session)
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	logPath := filepath.Join(dir, "service.log")
	if err := os.WriteFile(logPath, []byte("PROMISE_REGRESSION real log evidence\n"), 0600); err != nil {
		t.Fatal(err)
	}
	plan := ai.SREPlanRevision{Goal: "检查测试日志并分析异常", TaskType: "investigation", Scope: []string{resource}, Steps: []ai.SREPlanStep{{ID: "logs", Role: ai.SREInvestigator, Kind: "observe", Capability: "application", Description: "读取目标日志", ResourceIDs: []string{resource}, CompletionChecks: []string{"获得实际证据"}}, {ID: "summary", Role: ai.SRECoordinator, Kind: "summarize", Description: "分析真实证据及缺失信息", ResourceIDs: []string{resource}, DependsOn: []string{"logs"}, CompletionChecks: []string{"区分证据和推测"}}}}
	var roots atomic.Int32
	closeProvider := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if strings.Contains(content, "conversation owner") {
			if roots.Add(1) == 1 {
				emitModel(w, "我先在目标服务器上做只读检查，再给出分析与处理建议。", nil)
				return
			}
			if !strings.Contains(content, "No terminal decision was submitted") {
				t.Error("missing model continuation after unexecuted promise")
			}
			emitModel(w, "", []ai.Call{{ID: "actually-inspect", Name: "sre_collaborate", Arguments: jsonText(Object{"action": "new_task", "goal": plan.Goal, "asset_refs": []string{sreAliasForTest(resource)}, "mode": "assist"})}})
			return
		}
		if strings.Contains(content, "Return only a JSON plan object") {
			emitModel(w, jsonText(plan), nil)
			return
		}
		if strings.Contains(content, "Lake's investigator") {
			toolDone := false
			for _, m := range objects(input["messages"]) {
				toolDone = toolDone || m["role"] == "tool"
			}
			if !toolDone {
				emitModel(w, "", []ai.Call{{ID: "read-log", Name: "observe_logs", Arguments: jsonText(Object{"asset_ref": sreAliasForTest(resource), "path": logPath})}})
				return
			}
			ids := regexp.MustCompile(`ev_[a-f0-9]{32}`).FindAllString(content, -1)
			emitModel(w, jsonText(Object{"schemaVersion": 1, "summary": "已采集日志", "facts": []Object{{"statement": "读取到测试日志", "evidenceIds": ids}}, "hypotheses": []string{}, "unknowns": []string{"缺少业务指标"}, "nextChecks": []string{}}), nil)
			return
		}
		emitModel(w, "只读日志已采集，尚缺业务指标；不能认定根因或恢复。", nil)
	})
	defer closeProvider()
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "帮我检查服务运行状态，分析异常原因并给出处理建议。", "resourceIds": []string{resource}}, 202)
	awaitQueueWorkers(t, b)
	tasks, err := b.Store.ListSRETasks(session, 20, "")
	if err != nil || roots.Load() != 2 || len(tasks) != 1 {
		t.Fatal("promise stopped without real handoff", err, roots.Load(), tasks)
	}
	task := tasks[0]
	if task.Status != "completed" || len(task.Attempts) != 2 || len(task.Attempts[0].Evidence) == 0 || task.RecoveryStatus == "verified" {
		t.Fatal("missing real readonly specialist results", task.Status, task.Error)
	}
	ev := task.Attempts[0].Evidence[0]
	page := apiTest(t, h, "GET", "/api/sessions/"+session+"/sre/tasks/"+task.ID+"/evidence/"+ev.ID, nil, 200)
	if !strings.Contains(stringOf(page["source"]), "PROMISE_REGRESSION") {
		t.Fatal("no actual log evidence")
	}
}

func TestSRETextOnlyReplyRequiresExplicitModelCompletion(t *testing.T) {
	for _, repair := range []bool{true, false} {
		t.Run(map[bool]string{true: "model_finishes_answer", false: "model_never_decides"}[repair], func(t *testing.T) {
			b, h := fixture(t)
			session, _ := newSession(t, h)
			var roots atomic.Int32
			closeProvider := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
				if !strings.Contains(jsonText(input["messages"]), "conversation owner") {
					emitModel(w, "metadata", nil)
					return
				}
				if roots.Add(1) > 1 && repair {
					emitSREReply(w, "answer", "1+1 等于 2。")
					return
				}
				emitModel(w, "我先看一下。", nil)
			})
			defer closeProvider()
			apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "1+1 等于几"}, 202)
			awaitQueueWorkers(t, b)
			view, _ := b.Engine.Snapshot(session)
			tasks, _ := b.Store.ListSRETasks(session, 20, "")
			if roots.Load() != 2 || len(tasks) != 0 {
				t.Fatal("completion correction started a task or retried indefinitely")
			}
			if repair {
				messages := objects(b.Store.Snapshot(session)["messages"])
				if view.Status != "completed" || messages[len(messages)-1]["text"] != "1+1 等于 2。" {
					t.Fatal("model's final answer was lost")
				}
			} else if view.Status != "failed" {
				t.Fatal("undecided promise was reported completed", view.Status)
			}
		})
	}
}

func TestSREExplicitRestartCreatesFreshReadOnlyPlanWithoutLateConflict(t *testing.T) {
	b, h := fixture(t)
	sid, rid := newSession(t, h)
	old, err := b.Store.CreateSRETask(ai.SRETask{SessionID: sid, RequestID: "old_investigation", Goal: "检查测试内存", Scope: []string{rid}, Mode: "assist", TokenBudget: 128000})
	must(err)
	_, err = b.Store.MutateSRETask(sid, old.ID, 0, "paused", func(t *ai.SRETask) error { t.Status = "paused"; return nil })
	must(err)
	plan := ai.SREPlanRevision{Goal: old.Goal, TaskType: "investigation", Scope: []string{rid}, Steps: []ai.SREPlanStep{{ID: "inspect", Role: ai.SREInvestigator, Kind: "observe", Capability: "host", Description: "只读检查测试内存", ResourceIDs: []string{rid}, CompletionChecks: []string{"真实证据"}}}}
	closer := sreCoordinationFixture(t, b, h, sid, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if strings.Contains(content, "conversation owner") {
			if !strings.Contains(jsonText(input["tools"]), "restart_task") {
				t.Error("model cannot choose an explicit restart")
			}
			emitModel(w, "", []ai.Call{{ID: "restart-original", Name: "sre_collaborate", Arguments: jsonText(Object{"action": "restart_task", "task_id": old.ID, "mode": "plan_only"})}})
			return
		}
		if strings.Contains(content, "Return only a JSON plan object") {
			emitModel(w, jsonText(plan), nil)
			return
		}
		t.Error("plan-only restart dispatched a resource role")
		emitModel(w, "unexpected", nil)
	})
	defer closer()
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/messages", Object{"text": "重新来，先给计划"}, 202)
	awaitQueueWorkers(t, b)
	tasks, err := b.Store.ListSRETasks(sid, 20, "")
	must(err)
	if len(tasks) != 2 || tasks[0].ID == old.ID || tasks[0].Status != "draft" || len(tasks[0].Plans) != 1 || tasks[1].Status != "cancelled" {
		for _, task := range tasks {
			t.Log("restart task state", task.ID, task.Status, len(task.Plans), task.Error)
		}
		view, _ := b.Engine.Snapshot(sid)
		for _, card := range view.Cards {
			if card.Type == "error" {
				t.Log("handoff error", card.Content)
			}
		}
		t.Fatal("explicit restart hit a late active-task conflict or lost audit")
	}
}
