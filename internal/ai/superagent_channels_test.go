package ai

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSuperChannelMigrationCancellationLeavesPreviousSchemaIntact(t *testing.T) {
	e, _ := superFixture(t)
	db, err := e.superStore()
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&superSchemaRow{}).Where("id = ?", 1).Update("version", 3).Error; err != nil {
		t.Fatal(err)
	}
	dir := e.Dir
	e.Shutdown()
	next, err := New(dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Shutdown()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	next.HostContext = ctx
	if _, err := next.superStore(); !errors.Is(err, context.Canceled) {
		t.Fatal("migration ignored host shutdown", err)
	}
	store, err := next.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var schema superSchemaRow
	if err := store.DB.First(&schema, "id = ?", 1).Error; err != nil || schema.Version != 3 {
		t.Fatal("cancelled backup changed schema", schema, err)
	}
}

func channelEventFixture(t *testing.T, e *Engine, b SuperSourceBinding, ch SpecialistChannel, id, text string) SuperEvent {
	t.Helper()
	event, _, err := e.ReceiveSuperEvent(t.Context(), b, SuperEventInput{SourceEventID: id, ThreadRef: ch.SessionID, Kind: "message", Payload: text})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.BindSpecialistSource(t.Context(), b.ProjectID, ch.SessionID, event.ID, ""); err != nil {
		t.Fatal(err)
	}
	return event
}

func TestSuperChannelKeepsOneRoleAndIndependentTaskContexts(t *testing.T) {
	e, b := superFixture(t)
	a := superCreateFixture(t, e, b, "a", "Check host A", "a", "Check host A")
	channels, err := e.ListSpecialistChannels(t.Context(), b.ProjectID)
	if err != nil || len(channels) != 1 {
		t.Fatal(channels, err)
	}
	ch := channels[0]
	before, err := e.SuperTaskDetail(a.SessionID, a.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	event := channelEventFixture(t, e, b, ch, "b", "Check host B")
	create := SuperDecision{EventID: event.ID, PartKey: "b", Action: "create", Title: "Check host B", RoleKey: "investigator", Quote: event.Payload, Reason: "Independent resource"}
	second, err := e.ApplySuperDecision(t.Context(), b, create)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := e.ApplySuperDecision(t.Context(), b, create)
	if err != nil || replay.TaskID != second.TaskID {
		t.Fatal(replay, err)
	}
	if second.TaskID == a.TaskID || second.SessionID == a.SessionID || second.WorkerID == a.WorkerID {
		t.Fatal("task contexts merged", a, second)
	}
	channels, err = e.ListSpecialistChannels(t.Context(), b.ProjectID)
	if err != nil || len(channels) != 1 || channels[0].ID != ch.ID {
		t.Fatal(channels, err)
	}
	after, err := e.SuperTaskDetail(a.SessionID, a.TaskID)
	if err != nil || js(before) != js(after) {
		t.Fatal("new task changed A", err)
	}
	follow := channelEventFixture(t, e, b, ch, "return-a", "Continue host A")
	_, err = e.ApplySuperDecision(t.Context(), b, SuperDecision{EventID: follow.ID, PartKey: "a", Action: "followup", TaskID: a.TaskID, Quote: follow.Payload, Reason: "Exact original task"})
	if err != nil {
		t.Fatal(err)
	}
	db, _ := e.superStore()
	var inbox []superInboxRow
	if err := db.Find(&inbox).Error; err != nil || len(inbox) != 1 || inbox[0].TaskID != a.TaskID {
		t.Fatal(inbox, err)
	}
	var operationCount int64
	db.Model(&nativeOperation{}).Count(&operationCount)
	if operationCount != 0 {
		t.Fatal("channel or routing executed I/O")
	}
}

func TestSuperChannelRoleAndSubscriptionBoundaries(t *testing.T) {
	e, b := superFixture(t)
	a := superCreateFixture(t, e, b, "a", "Check A", "a", "Check A")
	channels, _ := e.ListSpecialistChannels(t.Context(), b.ProjectID)
	ch := channels[0]
	event := channelEventFixture(t, e, b, ch, "input", "Check another host")
	_, err := e.ApplySuperDecision(t.Context(), b, SuperDecision{EventID: event.ID, PartKey: "new", Action: "create", Title: "Check another host", RoleKey: "invented-other-role", Quote: event.Payload, Reason: "Wrong role"})
	if err == nil {
		t.Fatal("model created a second role from channel")
	}
	if err = e.SubscribeSuperWorker(t.Context(), b.ProjectID, SuperSubscription{SourceID: b.SourceID, ThreadRef: ch.SessionID, WorkerID: a.WorkerID, Mode: "followup"}); err == nil {
		t.Fatal("shared channel became a task subscription")
	}
	if inputs, err := e.RouteSubscribedEvent(t.Context(), b.ProjectID, event.ID); err != nil || len(inputs) != 0 {
		t.Fatal(inputs, err)
	}
	if err = e.BindSpecialistSource(t.Context(), "foreign", ch.SessionID, event.ID, ""); err == nil {
		t.Fatal("foreign channel binding accepted")
	}
	s, _ := e.get("router")
	s.mu.Lock()
	s.state.Config = Config{SecurityProjectID: b.ProjectID, superRole: "router"}
	s.mu.Unlock()
	page, err := e.ReadSuperObject(t.Context(), "router", "event", event.ID, 0, 0, 16384)
	if err != nil || !strings.Contains(page.Text, "preferredRoleKey") || !strings.Contains(page.Text, "investigator") {
		t.Fatal(page, err)
	}
}

func TestSuperChannelSchemaThreeMigrationIsIdempotent(t *testing.T) {
	e, b := superFixture(t)
	a := superCreateFixture(t, e, b, "a", "Check A", "a", "Check A")
	before, _ := e.SuperTaskDetail(a.SessionID, a.TaskID)
	db, _ := e.superStore()
	for _, model := range []any{&superChannelSourceRow{}, &superTaskReferenceRow{}, &superChannelRow{}} {
		if err := db.Migrator().DropTable(model); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Model(&superSchemaRow{}).Where("id = ?", 1).Update("version", 3).Error; err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := MigrateSuperagentStore(db); err != nil {
			t.Fatal(err)
		}
	}
	after, err := e.SuperTaskDetail(a.SessionID, a.TaskID)
	if err != nil || js(before) != js(after) {
		t.Fatal("migration changed task", err)
	}
	channels, err := e.ListSpecialistChannels(t.Context(), b.ProjectID)
	if err != nil || len(channels) != 1 {
		t.Fatal(channels, err)
	}
	var version superSchemaRow
	db.First(&version, "id = ?", 1)
	if version.Version != 4 {
		t.Fatal(version)
	}
	if err := db.Model(&superSchemaRow{}).Where("id = ?", 1).Update("version", 5).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateSuperagentStore(db); err == nil {
		t.Fatal("future schema accepted")
	}
}

func TestSuperHistoricalTaskIndexExceedsRecentLimits(t *testing.T) {
	e, b := superFixture(t)
	expected := map[string]bool{}
	for i := 0; i < 121; i++ {
		text := fmt.Sprintf("Check historical host %03d", i)
		task := superCreateFixture(t, e, b, fmt.Sprint(i), text, "check", text)
		expected[task.TaskID] = true
	}
	s, _ := e.get("router")
	s.mu.Lock()
	s.state.Config = Config{SecurityProjectID: b.ProjectID, superRole: "router"}
	s.mu.Unlock()
	cursor := ""
	found := map[string]bool{}
	for rounds := 0; rounds < 10; rounds++ {
		page, err := e.SearchSuperTaskIndex(t.Context(), "router", "", "", "", cursor, 20)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Items {
			if found[item.Task.TaskID] || !expected[item.Task.TaskID] {
				t.Fatal("duplicate or foreign task")
			}
			found[item.Task.TaskID] = true
		}
		cursor = page.NextCursor
		if cursor == "" {
			break
		}
	}
	if len(found) != 121 {
		t.Fatal("history clipped to recent tasks", len(found))
	}
	s.mu.Lock()
	s.state.Config = Config{SecurityProjectID: b.ProjectID, superRole: "worker"}
	s.mu.Unlock()
	if _, err := e.SearchSuperTaskIndex(t.Context(), "router", "", "", "", "", 20); err == nil {
		t.Fatal("Worker read all project history")
	}
}

func TestSuperChannelBlockedRouteDoesNotStarveLaterTaskFollowup(t *testing.T) {
	e, b := superFixture(t)
	task := superCreateFixture(t, e, b, "original", "Inspect A", "a", "Inspect A")
	db, _ := e.superStore()
	var worker superWorkerRow
	if err := db.First(&worker, "id = ?", task.WorkerID).Error; err != nil {
		t.Fatal(err)
	}
	if err := e.finishSuperRouting(t.Context(), b, worker.SourceEventID); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&superAssignmentRow{}).Where("worker_id = ?", worker.ID).Update("state", "parked").Error; err != nil {
		t.Fatal(err)
	}
	channels, _ := e.ListSpecialistChannels(t.Context(), b.ProjectID)
	var admitted SuperEvent
	for i, disposition := range []string{"blocked", "routed"} {
		event := channelEventFixture(t, e, b, channels[0], fmt.Sprint("followup-", i), "Continue original task")
		if _, err := e.ApplySuperDecision(t.Context(), b, SuperDecision{EventID: event.ID, PartKey: "continue", Action: "followup", TaskID: task.TaskID, Quote: event.Payload, Reason: "Exact original task"}); err != nil {
			t.Fatal(err)
		}
		if err := db.Model(&superEventRow{}).Where("id = ?", event.ID).Update("disposition", disposition).Error; err != nil {
			t.Fatal(err)
		}
		if disposition == "routed" {
			admitted = event
		}
	}
	before, _ := e.SuperTaskDetail(task.SessionID, task.TaskID)
	if err := e.QueueSuperFollowup(t.Context(), b.ProjectID, worker.ID); err != nil {
		t.Fatal("blocked input starved later routed request", err)
	}
	var assignment superAssignmentRow
	if err := db.First(&assignment, "worker_id = ?", worker.ID).Error; err != nil || assignment.InputEventID != admitted.ID || assignment.State != "queued" {
		t.Fatal(assignment, err)
	}
	after, _ := e.SuperTaskDetail(task.SessionID, task.TaskID)
	if js(before) != js(after) {
		t.Fatal("queueing reset task state, limits or scope")
	}
	var rows []superInboxRow
	if err := db.Where("worker_id = ?", worker.ID).Find(&rows).Error; err != nil || len(rows) != 2 {
		t.Fatal(rows, err)
	}
	for _, row := range rows {
		if row.DeliveredAt != nil || row.ConsumedAt != nil {
			t.Fatal("queueing consumed or removed another input")
		}
	}
	if err := db.Model(&superInboxRow{}).Where("event_id = ?", admitted.ID).Update("delivered_at", time.Now().UTC()).Error; err != nil {
		t.Fatal(err)
	}
	if ids, err := e.SuperInputWorkers(t.Context(), b.ProjectID); err != nil || len(ids) != 0 {
		t.Fatal("blocked route remained a deliverable supplement", ids, err)
	}

}

func TestSuperEmptyFollowupDeliveryDoesNotPreemptProvider(t *testing.T) {
	e, b := superFixture(t)
	task := superCreateFixture(t, e, b, "original", "Inspect A", "a", "Inspect A")
	db, _ := e.superStore()
	if err := db.Model(&superAssignmentRow{}).Where("worker_id = ?", task.WorkerID).Updates(map[string]any{"state": "active", "lease_until": time.Now().Add(time.Minute)}).Error; err != nil {
		t.Fatal(err)
	}
	e.SetSupplementHooks(func(string, string) ([]UserSupplement, error) { return nil, nil }, nil)
	s, _ := e.get(task.SessionID)
	ctx, cancelCause := context.WithCancelCause(t.Context())
	defer cancelCause(nil)
	_, cancel := context.WithCancel(t.Context())
	defer cancel()
	s.mu.Lock()
	s.cancel = cancel
	s.state.View.RootTurnID = "live-root"
	s.supplementRequest = &supplementRequest{cancel: cancelCause}
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.cancel = nil; s.supplementRequest = nil; s.mu.Unlock() }()
	if err := e.DeliverSuperFollowups(t.Context(), b.ProjectID, task.WorkerID); err != nil {
		t.Fatal(err)
	}
	if context.Cause(ctx) != nil {
		t.Fatal("empty poll cancelled live provider", context.Cause(ctx))
	}
}
