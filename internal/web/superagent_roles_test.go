package web

import (
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSuperSpecialistManagementProjectsIdleChannelAndRenameImmediately(t *testing.T) {
	b, _ := fixture(t)
	p := b.Store.CreateProject("Specialist management")
	project := stringOf(p["id"])
	domain, err := b.ensureSuperProject(t.Context(), project)
	if err != nil {
		t.Fatal(err)
	}
	source := b.superUserSource(project, domain.RouterSessionID)
	change := func(text string, in ai.SuperSpecialistChange) ai.SpecialistRole {
		t.Helper()
		message := b.Store.AddMessage(domain.RouterSessionID, "user", text, nil)
		event, err := b.ReceiveUserEvent(t.Context(), domain.RouterSessionID, stringOf(message["id"]))
		if err != nil {
			t.Fatal(err)
		}
		if err := b.recordSuperInput(event, nil, nil, false); err != nil {
			t.Fatal(err)
		}
		in.EventID, in.PartKey, in.Quote = event.ID, "profile", text
		out, err := b.Engine.ManageSuperSpecialist(t.Context(), source, in)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	role := change("先建专员，职责只读，不派任务", ai.SuperSpecialistChange{Action: "create", RoleKey: "ops", Name: "运维专员", Duties: "只读"})
	channels, err := b.Engine.ListSpecialistChannels(t.Context(), project)
	if err != nil || len(channels) != 1 {
		t.Fatal(channels, err)
	}
	ch := channels[0]
	// No GET reconciliation or Router final answer is needed for projection.
	session := b.Store.Session(ch.SessionID)
	if session["title"] != role.Name || b.Store.superSessionKind(ch.SessionID) != "role" {
		t.Fatal(session)
	}
	workers, err := b.Engine.SpecialistChannelWorkers(t.Context(), project, ch.SessionID, "", 100)
	if err != nil || len(workers) != 0 {
		t.Fatal(workers, err)
	}
	events := b.Store.Events(domain.RouterSessionID, 0)
	changed := false
	for _, event := range events {
		if event["type"] == "specialist" {
			changed = true
		}
	}
	if !changed {
		t.Fatal("sidebar had no durable immediate refresh signal")
	}
	before := b.roleChannelPage(t.Context(), ch.SessionID, "", 50)
	if len(before["entries"].([]roleChannelEntry)) != 0 {
		t.Fatal("creating a specialist invented task history")
	}
	updated := change("改名为可靠性专员，职责改为核实证据", ai.SuperSpecialistChange{Action: "update", RoleID: role.ID, ExpectedRevision: 1, Name: "可靠性专员", Duties: "核实证据"})
	session = b.Store.Session(ch.SessionID)
	if session["title"] != updated.Name {
		t.Fatal("host title stale", session)
	}
	next, err := b.Engine.SpecialistChannelForSession(t.Context(), project, ch.SessionID)
	if err != nil || next.RoleID != role.ID || next.RoleName != updated.Name || next.Duties != updated.Duties {
		t.Fatal(next, err)
	}
}
