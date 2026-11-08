package ai

import (
	"context"
	"errors"
	"testing"
)

func TestSpecialistPreparationStartsAtCommittedRouteWithoutExecution(t *testing.T) {
	e, source := superFixture(t)
	ctx := t.Context()
	notified := 0
	e.SuperRolesChanged = func(context.Context, string) error {
		channels, err := e.ListSpecialistChannels(ctx, source.ProjectID)
		if err != nil || len(channels) != 1 || !channels[0].Preparing || channels[0].Running {
			t.Fatalf("route was not visible before lease/model dispatch: %+v, %v", channels, err)
		}
		notified++
		return errors.New("offline projection does not roll back accepted work")
	}
	worker := superCreateFixture(t, e, source, "prepare", "Check service", "check", "Check service")
	if notified != 1 {
		t.Fatal("routing did not immediately notify the sidebar", notified)
	}
	e.SuperRolesChanged = nil
	db, _ := e.superStore()
	check := func(want bool) {
		t.Helper()
		channels, err := e.ListSpecialistChannels(ctx, source.ProjectID)
		if err != nil || len(channels) != 1 || channels[0].Preparing != want || channels[0].Running {
			t.Fatalf("wanted preparation=%v without execution: %+v, %v", want, channels, err)
		}
	}
	check(true)
	if err := db.Model(&superAssignmentRow{}).Where("worker_id=?", worker.WorkerID).Update("state", "parked").Error; err != nil {
		t.Fatal(err)
	}
	check(false)
	event, _, err := e.ReceiveSuperEvent(ctx, source, SuperEventInput{SourceEventID: "retry", Kind: "message", Payload: "Continue the check"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.ApplySuperDecision(ctx, source, SuperDecision{EventID: event.ID, PartKey: "retry", Action: "followup", TaskID: worker.TaskID, Quote: event.Payload, Reason: "Actual followup"}); err != nil {
		t.Fatal(err)
	}
	check(true)
	if err = db.Model(&superEventRow{}).Where("id=?", event.ID).Update("disposition", "blocked").Error; err != nil {
		t.Fatal(err)
	}
	check(false) // A retained unconsumed input cannot spin forever after failure.
	var count int64
	if err = db.Model(&nativeOperation{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("presentation dispatched an operation", count, err)
	}
	if err = db.Model(&securityTaskRow{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("presentation created execution authority", count, err)
	}
}

func TestSpecialistPreparationTracksOnlyItsBoundChannel(t *testing.T) {
	e, source := superFixture(t)
	ctx := t.Context()
	first := superCreateFixture(t, e, source, "original", "Check service", "check", "Check service")
	db, _ := e.superStore()
	if err := db.Model(&superAssignmentRow{}).Where("worker_id=?", first.WorkerID).Update("state", "parked").Error; err != nil {
		t.Fatal(err)
	}
	channels, err := e.ListSpecialistChannels(ctx, source.ProjectID)
	if err != nil || len(channels) != 1 {
		t.Fatal(channels, err)
	}
	event, _, err := e.ReceiveSuperEvent(ctx, source, SuperEventInput{SourceEventID: "channel-input", ThreadRef: channels[0].SessionID, Kind: "message", Payload: "What is happening?"})
	if err != nil {
		t.Fatal(err)
	}
	if err = e.BindSpecialistSource(ctx, source.ProjectID, channels[0].SessionID, event.ID, ""); err != nil {
		t.Fatal(err)
	}
	channels, err = e.ListSpecialistChannels(ctx, source.ProjectID)
	if err != nil || !channels[0].Preparing || channels[0].Running {
		t.Fatal("admitted channel input had no immediate feedback", channels, err)
	}
	if other, err := e.ListSpecialistChannels(ctx, "different-project"); err != nil || len(other) != 0 {
		t.Fatal("activity crossed a project", other, err)
	}
	if err = e.FinishSuperUserRouting(ctx, source, event.ID); err != nil {
		t.Fatal(err)
	}
	channels, err = e.ListSpecialistChannels(ctx, source.ProjectID)
	if err != nil || channels[0].Preparing {
		t.Fatal("direct response left the role busy", channels, err)
	}
}
