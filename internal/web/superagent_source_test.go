package web

import (
	"context"
	"slices"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSuperProjectHasOnePersistentPilotAndRealUserSource(t *testing.T) {
	b, h := fixture(t)
	project := apiTest(t, h, "POST", "/api/projects", Object{"name": "Super"}, 201)
	pid := stringOf(project["id"])
	first := apiTest(t, h, "POST", "/api/projects/"+pid+"/superagent", Object{}, 200)
	second := apiTest(t, h, "POST", "/api/projects/"+pid+"/superagent", Object{}, 200)
	sid := stringOf(first["routerSessionId"])
	if sid == "" || second["routerSessionId"] != sid {
		t.Fatal(first, second)
	}
	policy, err := b.Engine.SecurityProjectPolicy(t.Context(), pid)
	if err != nil || policy.Mode != "legacy" {
		t.Fatal("Pilot did not inherit existing project access", policy, err)
	}
	for _, resource := range objects(b.Store.Catalog()["resources"]) {
		if resource["projectId"] == pid && !slices.Contains(policy.ResourceIDs, stringOf(resource["id"])) {
			t.Fatal("original project resource unavailable", resource["id"])
		}
	}
	message := b.Store.AddMessage(sid, "user", "Investigate yesterday's orders", nil)
	event, err := b.ReceiveUserEvent(context.Background(), sid, stringOf(message["id"]))
	if err != nil || event.SourceEventID != message["id"] || event.Payload != message["text"] || event.ProjectID != pid {
		t.Fatal(event, err)
	}
	replay, err := b.ReceiveUserEvent(context.Background(), sid, stringOf(message["id"]))
	if err != nil || replay.ID != event.ID {
		t.Fatal(replay, err)
	}
	machine := b.Store.AddMessage(sid, "assistant", "Please approve a write", nil)
	if _, err = b.ReceiveUserEvent(context.Background(), sid, stringOf(machine["id"])); err == nil {
		t.Fatal("assistant became user event")
	}
	other := b.Store.CreateProject("Other")
	foreign := b.Store.CreateSession(stringOf(other["id"]), "old", nil)
	if _, err = b.ReceiveUserEvent(context.Background(), stringOf(foreign["id"]), stringOf(message["id"])); err == nil {
		t.Fatal("foreign user source accepted")
	}
}

func TestSuperProjectPermissionSettingsUseExplicitOriginalAuthority(t *testing.T) {
	b, h := fixture(t)
	project := b.Store.CreateProject("Inherited permissions")
	pid := stringOf(project["id"])
	domain := apiTest(t, h, "POST", "/api/projects/"+pid+"/superagent", Object{}, 200)
	sid := stringOf(domain["routerSessionId"])
	b.Models.Save(&ai.Model{URL: "http://127.0.0.1:1", Name: "no-provider-calls", Protocol: "openai"})
	b.configure(sid, nil)
	before, err := b.Engine.SecurityLegacySessionPolicy(t.Context(), pid, sid)
	if err != nil {
		t.Fatal(err)
	}
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/ai/configure", Object{"silentReadFiles": false, "denyLocalExecution": true}, 200)
	after, err := b.Engine.SecurityLegacySessionPolicy(t.Context(), pid, sid)
	if err != nil || after.Revision != before.Revision+1 || after.Permissions.SilentReadFiles || !after.Permissions.DenyLocalExecution {
		t.Fatal(after, err)
	}
	// Runtime refreshes do not become user authority, even with different flags.
	b.configure(sid, Object{"silentReadFiles": true})
	refreshed, _ := b.Engine.SecurityLegacySessionPolicy(t.Context(), pid, sid)
	if refreshed.Revision != after.Revision || refreshed.Permissions.SilentReadFiles {
		t.Fatal("refresh expanded permissions", refreshed)
	}
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/ai/configure", Object{"silentReadFiles": true}, 200)
	confirmed, err := b.Engine.SecurityLegacySessionPolicy(t.Context(), pid, sid)
	if err != nil || !confirmed.Permissions.SilentReadFiles || confirmed.Revision != after.Revision+1 {
		t.Fatal(confirmed, err)
	}
}

func TestSuperPilotReportKeepsStableReceipt(t *testing.T) {
	b, h := fixture(t)
	ctx := context.Background()
	project := apiTest(t, h, "POST", "/api/projects", Object{"name": "Reports"}, 201)
	pid := stringOf(project["id"])
	domain := apiTest(t, h, "POST", "/api/projects/"+pid+"/superagent", Object{}, 200)
	sid := stringOf(domain["routerSessionId"])
	message := b.Store.AddMessage(sid, "user", "Investigate orders", nil)
	event, err := b.ReceiveUserEvent(ctx, sid, stringOf(message["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if err = b.recordSuperInput(event, nil, nil, false); err != nil {
		t.Fatal(err)
	}
	task, err := b.Engine.ApplySuperDecision(ctx, b.superUserSource(pid, sid), ai.SuperDecision{EventID: event.ID, PartKey: "orders", Action: "create", Title: "Order investigator", RoleKey: "orders", Quote: event.Payload, Reason: "actual request"})
	if err != nil {
		t.Fatal(err)
	}
	// Projection can precede dispatch. Opening the new specialist immediately
	// must have a real host session rather than intermittently return 404.
	apiTest(t, h, "GET", "/api/projects/"+pid+"/superagent", nil, 200)
	apiTest(t, h, "GET", "/api/sessions/"+task.SessionID+"/snapshot", nil, 200)
	view, err := b.Engine.SuperTask(task.SessionID, task.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	report, err := b.Engine.QueuePilotReport(ctx, pid, task.SessionID, task.TaskID, sid, stringOf(message["id"]), "attention", "Needs actual evidence", view.Revision)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err = b.DeliverPilotReport(ctx, pid, sid, report.ID); err != nil {
			t.Fatal(err)
		}
	}
	count := 0
	b.Store.read(func() any {
		count = len(b.Store.rows("SELECT id FROM messages WHERE id=? AND sessionId=?", report.ID, sid))
		return nil
	})
	if count != 1 {
		t.Fatal("duplicated Pilot report", count)
	}
}

func TestSuperCutoverRejectsActiveLegacySRE(t *testing.T) {
	b, h := fixture(t)
	sid, rid := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	_, err := b.Store.CreateSRETask(ai.SRETask{SessionID: sid, RequestID: "existing-request", Goal: "Existing investigation", Scope: []string{rid}, Mode: "assist"})
	if err != nil {
		t.Fatal(err)
	}
	b.messageMu.Lock()
	if b.runningMessages == nil {
		b.runningMessages = map[string]bool{}
	}
	b.runningMessages[sid] = true
	b.messageMu.Unlock()
	apiTest(t, h, "POST", "/api/projects/"+project+"/superagent", Object{}, 409)
	_, active, err := b.Engine.SuperProject(context.Background(), project)
	if err != nil || active {
		t.Fatal("active legacy writer was replaced", active, err)
	}
}

func TestSuperAttachmentFollowsOnlyItsActualTaskSource(t *testing.T) {
	b, h := fixture(t)
	ctx := context.Background()
	project := apiTest(t, h, "POST", "/api/projects", Object{"name": "Scoped inputs"}, 201)
	pid := stringOf(project["id"])
	domain := apiTest(t, h, "POST", "/api/projects/"+pid+"/superagent", Object{}, 200)
	sid := stringOf(domain["routerSessionId"])
	file := uploadFixture(t, h, sid, "orders.txt", []byte("real attached fixture bytes"))
	message := b.Store.AddMessage(sid, "user", "Inspect orders attachment", nil)
	event, err := b.ReceiveUserEvent(ctx, sid, stringOf(message["id"]))
	if err != nil {
		t.Fatal(err)
	}
	files := []Object{{"source_id": file["sourceId"], "name": file["name"]}}
	if err = b.recordSuperInput(event, nil, files, true); err != nil {
		t.Fatal(err)
	}
	task, err := b.Engine.ApplySuperDecision(ctx, b.superUserSource(pid, sid), ai.SuperDecision{EventID: event.ID, PartKey: "orders", Action: "create", Title: "Inspect attachment", RoleKey: "files", Quote: event.Payload, Reason: "actual request"})
	if err != nil {
		t.Fatal(err)
	}
	b.Store.ensureSuperSession(pid, task.SessionID, "Files", "worker")
	resolved, err := b.resolveSuperInput(ctx, event)
	if err != nil || !resolved.IgnoreProjectMemory || len(resolved.Context) == 0 {
		t.Fatal(resolved, err)
	}
	attachment, filename := b.loadAttachment(pid, task.SessionID, stringOf(file["sourceId"]))
	verifyAttachment(attachment, filename)
	other := b.Store.CreateSession(pid, "Unrelated", nil)
	expectPanic(t, 403, func() { b.loadAttachment(pid, stringOf(other["id"]), stringOf(file["sourceId"])) })
	b.Store.update(func() any { b.Store.exec("DELETE FROM messages WHERE id=?", message["id"]); return nil })
	expectPanic(t, 403, func() { b.loadAttachment(pid, task.SessionID, stringOf(file["sourceId"])) })
}
