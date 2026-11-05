package web

import (
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSpecialistActivitySignalIsImmediateScopedAndSkipsTextDeltas(t *testing.T) {
	b, project, pilot, worker, _ := roleWorkspaceFixture(t)
	other := b.Store.CreateProject("Other specialist activity")
	domain, err := b.ensureSuperProject(t.Context(), stringOf(other["id"]))
	if err != nil {
		t.Fatal(err)
	}
	count := func(session string) int {
		n := 0
		for _, event := range b.Store.Events(session, 0) {
			if event["type"] == "specialist" {
				n++
			}
		}
		return n
	}
	before, foreign := count(pilot), count(domain.RouterSessionID)
	b.event(ai.Event{Session: worker.SessionID, Type: "inputState", Data: Object{"status": "running"}})
	if count(pilot) != before+1 || count(domain.RouterSessionID) != foreign {
		t.Fatal("worker start did not immediately refresh only its own Pilot", project)
	}
	b.event(ai.Event{Session: worker.SessionID, Type: "delta", Data: Object{"kind": "message", "card_id": "fixture", "content": "text"}})
	if count(pilot) != before+1 {
		t.Fatal("streaming text repeatedly refreshed the workspace")
	}
	b.event(ai.Event{Session: worker.SessionID, Type: "done", Data: Object{"status": "completed"}})
	if count(pilot) != before+2 {
		t.Fatal("completion did not immediately clear activity")
	}
}
