package web

import (
	"context"
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
	task, err := b.Engine.ApplySuperDecision(ctx, b.superUserSource(pid, sid), ai.SuperDecision{EventID: event.ID, PartKey: "orders", Action: "create", Title: "Order investigator", RoleKey: "orders", Quote: event.Payload, Reason: "actual request"})
	if err != nil {
		t.Fatal(err)
	}
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
	apiTest(t, h, "POST", "/api/projects/"+project+"/superagent", Object{}, 409)
	_, active, err := b.Engine.SuperProject(context.Background(), project)
	if err != nil || active {
		t.Fatal("active legacy writer was replaced", active, err)
	}
}
