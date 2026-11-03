package ai

import (
	"testing"
)

func TestSuperChannelStopFencesRouterAndOnlyCancelsItsOwnTasks(t *testing.T) {
	e, b := superFixture(t)
	a := superCreateFixture(t, e, b, "a", "Inspect A", "a", "Inspect A")
	channels, _ := e.ListSpecialistChannels(t.Context(), b.ProjectID)
	ch := channels[0]
	event := channelEventFixture(t, e, b, ch, "pending", "Inspect another host")
	otherEvent, _, err := e.ReceiveSuperEvent(t.Context(), b, SuperEventInput{SourceEventID: "other", Kind: "message", Payload: "Review separate work"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := e.ApplySuperDecision(t.Context(), b, SuperDecision{EventID: otherEvent.ID, PartKey: "other", Action: "create", Title: otherEvent.Payload, RoleKey: "verifier", Quote: otherEvent.Payload, Reason: "Other exact role"})
	if err != nil {
		t.Fatal(err)
	}
	before, _ := e.SuperTask(a.SessionID, a.TaskID)
	if err := e.StopSpecialistChannel(t.Context(), "foreign", ch.SessionID); err == nil {
		t.Fatal("foreign project stopped a channel")
	}
	if err := e.StopSpecialistChannel(t.Context(), b.ProjectID, ch.SessionID); err != nil {
		t.Fatal(err)
	}
	after, err := e.SuperTask(a.SessionID, a.TaskID)
	if err != nil || after.State != "cancelled" || !after.DeadlineAt.Equal(before.DeadlineAt) {
		t.Fatal(after, err)
	}
	foreign, err := e.SuperTask(other.SessionID, other.TaskID)
	if err != nil || foreign.State == "cancelled" {
		t.Fatal("another role was cancelled", foreign, err)
	}
	if _, err := e.ApplySuperDecision(t.Context(), b, SuperDecision{EventID: event.ID, PartKey: "late", Action: "create", Title: event.Payload, RoleKey: "investigator", Quote: event.Payload, Reason: "Late provider response"}); err == nil {
		t.Fatal("late Router recreated stopped work")
	}
	if err := e.FinishSuperUserRouting(t.Context(), b, event.ID); err == nil {
		t.Fatal("late finalization revived stopped input")
	}
	run := &superRouterRun{projectID: b.ProjectID, bindings: map[string]SuperSourceBinding{event.ID: b}}
	if err := e.finalizeSuperRouter(t.Context(), "router", run, []SuperEvent{event}); err != nil {
		t.Fatal(err)
	}
	db, _ := e.superStore()
	var row superEventRow
	db.First(&row, "id = ?", event.ID)
	if row.Disposition != "cancelled" {
		t.Fatal(row.Disposition)
	}
	var count int64
	db.Model(&superOutputRow{}).Count(&count)
	if count != 0 {
		t.Fatal("cancelled Router published an answer")
	}
}

func TestSuperChannelPendingInteractionsAreNotLimitedToRecentWorkers(t *testing.T) {
	e, b := superFixture(t)
	a := superCreateFixture(t, e, b, "older", "Inspect older host", "older", "Inspect older host")
	db, _ := e.superStore()
	if err := db.Model(&superAssignmentRow{}).Where("worker_id = ?", a.WorkerID).Updates(map[string]any{"state": "parked", "checkpoint": "original-question"}).Error; err != nil {
		t.Fatal(err)
	}
	ids, err := e.SuperInteractionSessions(t.Context(), b.ProjectID)
	if err != nil || len(ids) != 1 || ids[0] != a.SessionID {
		t.Fatal(ids, err)
	}
	ids, err = e.SuperInteractionSessions(t.Context(), "foreign")
	if err != nil || len(ids) != 0 {
		t.Fatal(ids, err)
	}
}
