package ai

import (
	"context"
	"testing"
	"time"
)

func TestSuperProjectIntakePrioritizesActualHumansAcrossSources(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	observer := SuperSourceBinding{SourceID: "observer", ProjectID: b.ProjectID, Kind: "observer", ActorRef: "host-build-adapter", Revision: "one"}
	if err := e.RegisterSuperSource(ctx, observer); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.ReceiveSuperEvent(ctx, observer, SuperEventInput{SourceEventID: "first-observation", Kind: "result", Payload: "untrusted machine data"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.ReceiveSuperEvent(ctx, b, SuperEventInput{SourceEventID: "human", Kind: "message", Payload: "Actual user followup"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.ReceiveSuperEvent(ctx, b, SuperEventInput{SourceEventID: "stop", Kind: "stop", Payload: "Stop that task"}); err != nil {
		t.Fatal(err)
	}
	rows, err := e.PendingSuperProjectEvents(ctx, b.ProjectID, 16)
	if err != nil || len(rows) != 3 || rows[0].SourceEventID != "stop" || rows[1].SourceEventID != "human" || rows[2].SourceID != observer.SourceID || rows[2].SourceKind != "observer" {
		t.Fatal(rows, err)
	}
}

func TestSuperRouterFailuresHavePersistentBoundedRetries(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	event, _, err := e.ReceiveSuperEvent(ctx, b, SuperEventInput{SourceEventID: "failing", Kind: "message", Payload: "Actual request"})
	if err != nil {
		t.Fatal(err)
	}
	db, _ := e.superStore()
	for i := 0; i < 3; i++ {
		if err = e.beginSuperRoutingAttempt(ctx, b.ProjectID, []SuperEvent{event}); err != nil {
			t.Fatal(err)
		}
		if err = e.failSuperRouting(ctx, b.ProjectID, []SuperEvent{event}); err != nil {
			t.Fatal(err)
		}
		if err = db.Model(&superEventRow{}).Where("id = ?", event.ID).Update("retry_at", time.Time{}).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err = e.beginSuperRoutingAttempt(ctx, b.ProjectID, []SuperEvent{event}); err == nil {
		t.Fatal("unbounded Router retry")
	}
	if pending, err := e.PendingSuperProjectEvents(ctx, b.ProjectID, 16); err != nil || len(pending) != 0 {
		t.Fatal(pending, err)
	}
	if _, _, err = e.ReceiveSuperEvent(ctx, b, SuperEventInput{SourceEventID: "new-human", Kind: "message", Payload: "A new actual request"}); err != nil {
		t.Fatal(err)
	}
	if pending, err := e.PendingSuperProjectEvents(ctx, b.ProjectID, 16); err != nil || len(pending) != 1 || pending[0].SourceEventID != "new-human" {
		t.Fatal("old failure blocked fresh human", pending, err)
	}
}
