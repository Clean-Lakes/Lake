package web

import (
	"context"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestProjectToolsHistoryAndWorkflowScope(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	b.Store.AddMessage(id, "assistant", "查到了 timeout 原因", nil)
	result, err := b.bridge(context.Background(), id, "read_session_context", Object{"session_id": id, "query": "timeout"}, false)
	if err != nil || len(objects(object(result)["messages"])) != 1 {
		t.Fatal(result, err)
	}
	foreign, _ := newSession(t, h)
	if _, err = b.bridge(context.Background(), id, "read_session_context", Object{"session_id": foreign, "query": "timeout"}, false); err == nil {
		t.Fatal("foreign project history readable")
	}
	args := Object{"name": "Tool workflow", "goal": "Inspect logs", "steps": []any{Object{"id": "logs", "role": "application", "task": "Inspect logs", "asset_refs": []any{ai.AssetAlias(ref)}}}}
	if _, err = b.bridge(context.Background(), id, "save_workflow", args, false); err == nil {
		t.Fatal("unapproved save accepted")
	}
	saved, err := b.bridge(context.Background(), id, "save_workflow", args, true)
	if err != nil {
		t.Fatal(err)
	}
	template := saved.(workflowTemplate)
	args["workflow_id"] = template.ID
	args["version"] = 0
	if _, err = b.bridge(context.Background(), id, "save_workflow", args, true); err == nil {
		t.Fatal("stale version accepted")
	}
	rows, err := b.bridge(context.Background(), id, "list_workflows", Object{}, false)
	if err != nil || len(rows.([]workflowTemplate)) != 1 {
		t.Fatal(rows, err)
	}
	if _, err = b.bridge(context.Background(), foreign, "get_workflow_run", Object{"run_id": "wrong"}, false); err == nil {
		t.Fatal("missing run accepted")
	}
	if b.Store.Workflow(project, template.ID).Version != 1 {
		t.Fatal("unexpected version")
	}
}
func TestWorkflowToolTaskOwnershipAndPermissions(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { emitModel(w, "Fixture result", nil) }))
	defer provider.Close()
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL, "name": "tool fixture", "protocol": "openai"}, 200)
	b.configure(id, Object{"silentReadFiles": false, "silentCommands": false, "denyLocalExecution": false})
	project := stringOf(b.Store.Session(id)["projectId"])
	b.Store.SetSREEnabled(project, true)
	saved := b.Store.SaveWorkflow(project, "", 0, b.validateWorkflowTemplate(project, object(parsed(jsonText(workflowFixtureInput(ref))))))
	value, err := b.bridge(context.Background(), id, "run_workflow", Object{"workflow_id": saved.ID, "version": 1}, true)
	if err != nil {
		t.Fatal(err)
	}
	task := object(value)
	run := object(task["run"])
	options := b.Store.Options(stringOf(run["sessionId"]))
	if options["silentReadFiles"] != false || options["toolOwnerSession"] != id {
		t.Fatal("permissions/owner lost", options)
	}
	other := stringOf(b.Store.CreateSession(project, "Other", nil)["id"])
	if _, err = b.bridge(context.Background(), other, "task_output", Object{"task_id": task["task_id"]}, false); err == nil {
		t.Fatal("foreign session task readable")
	}
	if _, err = b.bridge(context.Background(), id, "task_output", Object{"task_id": task["task_id"]}, false); err != nil {
		t.Fatal(err)
	}
	b.configure(id, Object{"denyLocalExecution": true})
	if _, err = b.bridge(context.Background(), id, "run_workflow", Object{"workflow_id": saved.ID, "version": 1}, true); err == nil {
		t.Fatal("local restriction bypassed")
	}
}
func TestScheduleCRUDClaimAndRestart(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	ctx := context.Background()
	args := Object{"name": "Follow-up", "at": time.Now().Add(time.Hour).Format(time.RFC3339), "kind": "reminder", "message": "检查测试结果", "interval_seconds": 60}
	value, err := b.scheduleTool(ctx, id, project, "schedule_create", args, true)
	if err != nil {
		t.Fatal(err)
	}
	row := object(value)
	if _, err = b.scheduleTool(ctx, id, project, "schedule_update", Object{"schedule_id": row["id"], "expected_revision": 0, "name": "bad"}, true); err == nil {
		t.Fatal("revision conflict ignored")
	}
	rows, err := b.scheduleTool(ctx, id, project, "schedule_list", Object{}, false)
	if err != nil || len(rows.([]Object)) != 1 {
		t.Fatal(err)
	}
	when := time.Now().Add(2 * time.Hour)
	b.tickSchedules(when)
	b.tickSchedules(when)
	messages := objects(b.Store.Snapshot(id)["messages"])
	if len(messages) != 1 || stringOf(messages[0]["text"]) != "提醒「Follow-up」：检查测试结果" {
		t.Fatal("duplicate or missing reminder", messages)
	}
	b.scheduleMu.Lock()
	persisted, err := b.readSchedules()
	b.scheduleMu.Unlock()
	if err != nil || persisted[0].Enabled != true || persisted[0].Revision != 3 {
		t.Fatal(persisted, err)
	}
	foreign, _ := newSession(t, h)
	otherProject := stringOf(b.Store.Session(foreign)["projectId"])
	if _, err = b.scheduleTool(ctx, foreign, otherProject, "schedule_delete", Object{"schedule_id": row["id"], "expected_revision": 3}, true); err == nil {
		t.Fatal("foreign schedule deleted")
	}
	if _, err = b.scheduleTool(ctx, id, project, "schedule_delete", Object{"schedule_id": row["id"], "expected_revision": 3}, true); err != nil {
		t.Fatal(err)
	}
	// Restart normalization skips missed occurrences rather than replaying external effects.
	b.scheduleMu.Lock()
	err = b.writeSchedules([]toolSchedule{{ID: ident(), Project: project, Session: id, Name: "Missed", Kind: "reminder", Message: "must not replay", At: time.Now().Add(-time.Hour).Format(time.RFC3339), Enabled: true, Revision: 1}})
	b.scheduleMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err = b.startScheduler(); err != nil {
		t.Fatal(err)
	}
	b.scheduleMu.Lock()
	persisted, err = b.readSchedules()
	b.scheduleMu.Unlock()
	if err != nil || persisted[0].Enabled || persisted[0].Status != "missed" {
		t.Fatal(persisted, err)
	}
	b.tickSchedules(time.Now())
	if len(objects(b.Store.Snapshot(id)["messages"])) != 1 {
		t.Fatal("missed reminder replayed")
	}
}
func TestQuestionHTTPRouteCollectsRealAnswers(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	var count atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if count.Add(1) == 1 {
			emitModel(w, "", []ai.Call{{ID: "question", Name: "ask_user_question", Arguments: `{"questions":[{"id":"target","title":"选择目标","options":["测试","生产"]}]}`}})
		} else {
			emitModel(w, "选择已收到", nil)
		}
	}))
	defer provider.Close()
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL, "name": "question fixture", "protocol": "openai"}, 200)
	b.configure(id, nil)
	done := make(chan error, 1)
	go func() { done <- b.Engine.Chat(context.Background(), id, "选择调查目标", nil) }()
	var request *ai.QuestionRequest
	for until := time.Now().Add(2 * time.Second); time.Now().Before(until); {
		v, _ := b.Engine.Snapshot(id)
		if v.Question != nil {
			request = v.Question
			break
		}
		time.Sleep(time.Millisecond)
	}
	if request == nil {
		t.Fatal("question not exposed")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/questionReply", Object{"id": request.ID, "answers": Object{"target": []string{"测试"}}}, 200)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("answer did not resume turn")
	}
	history, err := b.Engine.History(id)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range history {
		if m.Name == "ask_user_question" && m.Role == "tool" {
			found = true
		}
	}
	if !found {
		t.Fatal("answer not recorded")
	}
}
