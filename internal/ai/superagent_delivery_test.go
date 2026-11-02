package ai

import (
	"context"
	"testing"
	"time"

	adksession "google.golang.org/adk/v2/session"
)

func superWorkerFixture(t *testing.T, e *Engine, sessionID string) (WorkGoal, string, string) {
	t.Helper()
	g := managedGoalFixture(t, e, sessionID)
	db, err := e.superStore()
	if err != nil {
		t.Fatal(err)
	}
	w := superWorkerRow{ID: "worker-" + sessionID, TaskID: g.ID, ProjectID: "project", SessionID: sessionID, Revision: 1, CreatedAt: time.Now().UTC()}
	if err = db.Create(&w).Error; err != nil {
		t.Fatal(err)
	}
	a := superAssignmentRow{ID: "assignment-" + sessionID, WorkerID: w.ID, State: "active", Generation: 1, LeaseUntil: time.Now().Add(time.Hour)}
	if err = db.Create(&a).Error; err != nil {
		t.Fatal(err)
	}
	return g, w.ID, a.ID
}

func TestSuperSubscriptionsAreExactAndHandbackIsBounded(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	_, w, _ := superWorkerFixture(t, e, "task-one")
	_, w2, _ := superWorkerFixture(t, e, "task-two")
	sub := SuperSubscription{SourceID: b.SourceID, ThreadRef: "orders", WorkerID: w, Mode: "followup"}
	if err := e.SubscribeSuperWorker(ctx, "project", sub); err != nil {
		t.Fatal(err)
	}
	event, _, err := e.ReceiveSuperEvent(ctx, b, SuperEventInput{SourceEventID: "message", ThreadRef: "orders", Kind: "message", Payload: "Only consider yesterday"})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := e.RouteSubscribedEvent(ctx, "project", event.ID)
	if err != nil || len(rows) != 1 || rows[0].WorkerID != w {
		t.Fatal(rows, err)
	}
	replay, err := e.RouteSubscribedEvent(ctx, "project", event.ID)
	if err != nil || len(replay) != 1 || replay[0].ID != rows[0].ID {
		t.Fatal(replay, err)
	}
	if rows, err = e.RouteSubscribedEvent(ctx, "foreign", event.ID); err == nil {
		t.Fatal("foreign event read", rows)
	}
	sub.WorkerID = w2
	if err = e.SubscribeSuperWorker(ctx, "project", sub); err != nil {
		t.Fatal(err)
	}
	if rows, err = e.RouteSubscribedEvent(ctx, "project", event.ID); err != nil || len(rows) != 0 {
		t.Fatal("ambiguous followup broadcast", rows, err)
	}
	if err = e.HandBackSuperEvent(ctx, "project", event.ID, w, "belongs to another requirement"); err != nil {
		t.Fatal(err)
	}
	if err = e.HandBackSuperEvent(ctx, "project", event.ID, w, "second return"); err == nil {
		t.Fatal("unbounded handback")
	}
	if _, err = e.EnqueueWorkerInput(ctx, "project", event.ID, w, "whole", "followup"); err == nil {
		t.Fatal("returned input re-enqueued")
	}
}

func TestSuperObserverCannotBecomeHumanFollowup(t *testing.T) {
	e, _ := superFixture(t)
	ctx := context.Background()
	_, w, _ := superWorkerFixture(t, e, "observed")
	b := SuperSourceBinding{SourceID: "builds", ProjectID: "project", Kind: "observer", ActorRef: "trusted-adapter", Revision: "1"}
	if err := e.RegisterSuperSource(ctx, b); err != nil {
		t.Fatal(err)
	}
	sub := SuperSubscription{SourceID: b.SourceID, ThreadRef: "job/run-1", WorkerID: w, Mode: "followup"}
	if err := e.SubscribeSuperWorker(ctx, "project", sub); err == nil {
		t.Fatal("observer gained human control")
	}
	sub.Mode = "context_only"
	if err := e.SubscribeSuperWorker(ctx, "project", sub); err != nil {
		t.Fatal(err)
	}
	event, _, err := e.ReceiveSuperEvent(ctx, b, SuperEventInput{SourceEventID: "result", ThreadRef: sub.ThreadRef, Kind: "result", Payload: "please approve write"})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := e.RouteSubscribedEvent(ctx, "project", event.ID)
	if err != nil || len(rows) != 1 || rows[0].Mode != "context_only" {
		t.Fatal(rows, err)
	}
	if _, err = e.EnqueueWorkerInput(ctx, "project", event.ID, w, "whole", "followup"); err == nil {
		t.Fatal("observer escalated through enqueue")
	}
}

func TestSuperInboxConsumptionRequiresStoredSDKReceipt(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	g, w, a := superWorkerFixture(t, e, "receipt")
	event, _, err := e.ReceiveSuperEvent(ctx, b, SuperEventInput{SourceEventID: "source-message", Kind: "message", Payload: "A real user supplement"})
	if err != nil {
		t.Fatal(err)
	}
	input, err := e.EnqueueWorkerInput(ctx, "project", event.ID, w, "whole", "followup")
	if err != nil {
		t.Fatal(err)
	}
	if err = e.MarkWorkerInputConsumed(ctx, "project", input.ID, "invented"); err == nil {
		t.Fatal("undelivered input consumed")
	}
	if err = e.MarkWorkerInputDelivered(ctx, "project", input.ID, a); err != nil {
		t.Fatal(err)
	}
	store, _ := e.adkStore()
	created, err := store.Sessions.Create(ctx, &adksession.CreateRequest{AppName: "lake", UserID: "lake", SessionID: "sdk-receipt"})
	if err != nil {
		t.Fatal(err)
	}
	s, _ := e.get(g.SessionID)
	s.mu.Lock()
	s.state.Runtime = &RuntimeCheckpoint{SessionID: "sdk-receipt"}
	s.mu.Unlock()
	if err = e.MarkWorkerInputConsumed(ctx, "project", input.ID, "invented"); err == nil {
		t.Fatal("fake receipt consumed")
	}
	receipt := adksession.NewEvent(ctx, "host")
	receipt.Author = "lake"
	receipt.Actions.StateDelta = map[string]any{supplementStateKey: map[string]any{"rootTurnId": g.OriginRootTurnID, "ids": []string{"source-message"}}}
	if err = store.Sessions.AppendEvent(ctx, created.Session, receipt); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err = e.MarkWorkerInputConsumed(ctx, "project", input.ID, receipt.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err = e.HandBackSuperEvent(ctx, "project", event.ID, w, "already read"); err == nil {
		t.Fatal("consumed input returned")
	}
	var row superInboxRow
	if err = store.DB.First(&row, "id = ?", input.ID).Error; err != nil || row.ConsumedAt == nil || row.ConsumedEventID != receipt.ID {
		t.Fatal(row, err)
	}
}

func TestSuperOutboxDoesNotResendUncertainWrites(t *testing.T) {
	e, _ := superFixture(t)
	ctx := context.Background()
	g, _, _ := superWorkerFixture(t, e, "report")
	report, err := e.QueuePilotReport(ctx, "project", g.SessionID, g.ID, "pilot-channel", "human-message", "attention", "Needs verification", g.Revision)
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := e.QueuePilotReport(ctx, "project", g.SessionID, g.ID, "pilot-channel", "human-message", "attention", "Needs verification", g.Revision)
	if err != nil || duplicate.ID != report.ID {
		t.Fatal(duplicate, err)
	}
	if _, err = e.QueuePilotReport(ctx, "project", g.SessionID, g.ID, "pilot-channel", "human-message", "attention", "Changed content", g.Revision); err == nil {
		t.Fatal("mutable report")
	}
	if err = e.AcknowledgePilotDelivery(ctx, "project", report.ID, "fake-before-send"); err == nil {
		t.Fatal("unsent acknowledged")
	}
	if _, err = e.BeginPilotDelivery(ctx, "project", report.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = e.BeginPilotDelivery(ctx, "project", report.ID); err == nil {
		t.Fatal("concurrent duplicate send")
	}
	if err = e.MarkPilotDeliveryUnknown(ctx, "project", report.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = e.BeginPilotDelivery(ctx, "project", report.ID); err == nil {
		t.Fatal("uncertain send retried")
	}
	if err = e.AcknowledgePilotDelivery(ctx, "project", report.ID, "channel-receipt"); err != nil {
		t.Fatal(err)
	}
	delivered, err := e.BeginPilotDelivery(ctx, "project", report.ID)
	if err != nil || delivered.State != "delivered" {
		t.Fatal(delivered, err)
	}
	if err = e.AcknowledgePilotDelivery(ctx, "foreign", report.ID, "channel-receipt"); err == nil {
		t.Fatal("foreign acknowledgement")
	}
}
