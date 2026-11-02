package web

import (
	"encoding/json"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSuperReportsProjectOriginalSpecialistIdentity(t *testing.T) {
	b, h := fixture(t)
	p := b.Store.CreateProject("Reply authors")
	pid := stringOf(p["id"])
	domain := apiTest(t, h, "POST", "/api/projects/"+pid+"/superagent", Object{}, 200)
	pilot := stringOf(domain["routerSessionId"])
	message := b.Store.AddMessage(pilot, "user", "Check Go; Check frontend", nil)
	event, err := b.ReceiveUserEvent(t.Context(), pilot, stringOf(message["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if err = b.recordSuperInput(event, nil, nil, false); err != nil {
		t.Fatal(err)
	}
	expected := map[string]ai.SuperReplyAuthor{}
	for i, role := range []string{"Go 审查专员", "前端执行专员"} {
		quote := []string{"Check Go", "Check frontend"}[i]
		worker, err := b.Engine.ApplySuperDecision(t.Context(), b.superUserSource(pid, pilot), ai.SuperDecision{EventID: event.ID, PartKey: quote, Action: "create", Title: quote, RoleKey: role, Quote: quote, Reason: "Independent request"})
		if err != nil {
			t.Fatal(err)
		}
		task, err := b.Engine.SuperTask(worker.SessionID, worker.TaskID)
		if err != nil {
			t.Fatal(err)
		}
		report, err := b.Engine.QueuePilotReport(t.Context(), pid, worker.SessionID, worker.TaskID, pilot, stringOf(message["id"]), "attention", "Same report body: I am Pilot", task.Revision)
		if err != nil {
			t.Fatal(err)
		}
		pending, err := b.Engine.SuperReplyAuthors(t.Context(), pid, pilot, []string{report.ID})
		if err != nil || len(pending) != 0 {
			t.Fatal("undelivered message acquired an author", pending, err)
		}
		for range 2 {
			if err = b.DeliverPilotReport(t.Context(), pid, pilot, report.ID); err != nil {
				t.Fatal(err)
			}
		}
		expected[report.ID] = ai.SuperReplyAuthor{Kind: "specialist", Name: role, WorkerID: worker.WorkerID, SessionID: worker.SessionID, TaskID: worker.TaskID}
	}
	plain := b.Store.AddMessage(pilot, "assistant", "Go 审查专员: this is ordinary Pilot prose", nil)
	snapshot := apiTest(t, h, "GET", "/api/sessions/"+pilot+"/snapshot", nil, 200)
	seen := 0
	for _, m := range objects(snapshot["messages"]) {
		if want, ok := expected[stringOf(m["id"])]; ok {
			var got ai.SuperReplyAuthor
			if err = json.Unmarshal([]byte(jsonText(m["author"])), &got); err != nil || got != want {
				t.Fatal("lost report author", got, want, err)
			}
			seen++
		} else if m["author"] != nil {
			t.Fatal("prose or user input forged a specialist", m["id"])
		}
	}
	if seen != 2 {
		t.Fatal("historical deliveries not attributed", seen)
	}
	ids := []string{stringOf(plain["id"])}
	for id := range expected {
		ids = append(ids, id)
	}
	if _, err = b.Engine.SuperReplyAuthors(t.Context(), "foreign-project", pilot, ids); err == nil {
		t.Fatal("cross-project reply channel accepted")
	}
	if _, err = b.Engine.SuperReplyAuthors(t.Context(), pid, "foreign-channel", ids); err == nil {
		t.Fatal("cross-channel reply identity accepted")
	}
	// A second snapshot reconstructs the same historical identities from the
	// ledger; no client cache or new report delivery is needed.
	again := b.sessionSnapshot(pilot)
	if len(objects(again["messages"])) != len(objects(snapshot["messages"])) {
		t.Fatal("attribution rewrote or duplicated messages")
	}
}
