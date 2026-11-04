package ai

import (
	"fmt"
	"testing"
	"time"
)

func TestSpecialistChannelActivityUsesAllRootTasksAndLiveAssignments(t *testing.T) {
	e, source := superFixture(t)
	ctx := t.Context()
	first := superCreateFixture(t, e, source, "first", "Check service", "check", "Check service")
	db, err := e.superStore()
	if err != nil {
		t.Fatal(err)
	}
	channels, err := e.ListSpecialistChannels(ctx, source.ProjectID)
	if err != nil || len(channels) != 1 {
		t.Fatal(channels, err)
	}
	role := channels[0].RoleID
	// Push the first root out of the recent-100 workspace preview.
	var newer []superWorkerRow
	for i := range 101 {
		id := fmt.Sprintf("later-%03d", i)
		newer = append(newer, superWorkerRow{ID: id, SessionID: "session-" + id, TaskID: "goal-" + id,
			ProjectID: source.ProjectID, RoleID: role, CreatedAt: time.Now().UTC().Add(time.Minute)})
	}
	if err := db.CreateInBatches(newer, 50).Error; err != nil {
		t.Fatal(err)
	}
	check := func(running bool) {
		t.Helper()
		channels, err := e.ListSpecialistChannels(ctx, source.ProjectID)
		if err != nil || len(channels) != 1 || channels[0].Running != running || channels[0].CompletionCursor != "" {
			t.Fatalf("wanted running=%v and no completions, got %+v, %v", running, channels, err)
		}
	}
	check(false)
	token, err := e.AcquireWorkerSlot(ctx, source.ProjectID, first.WorkerID)
	if err != nil {
		t.Fatal(err)
	}
	check(true)
	if err := db.Model(&superAssignmentRow{}).Where("id = ?", token.AssignmentID).Update("lease_until", time.Now().UTC().Add(-time.Minute)).Error; err != nil {
		t.Fatal(err)
	}
	check(false)
	child := superWorkerRow{ID: "child", SessionID: "child-session", TaskID: first.TaskID, GoalSessionID: first.SessionID,
		RoleID: "delegatedrole", ProjectID: source.ProjectID, ParentWorkerID: first.WorkerID}
	if err := db.Create(&child).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&superAssignmentRow{ID: "child-lease", WorkerID: child.ID, ProjectID: source.ProjectID,
		OwnerID: "active-child", State: "active", LeaseUntil: time.Now().UTC().Add(time.Minute)}).Error; err != nil {
		t.Fatal(err)
	}
	check(true)
	if err := db.Model(&nativeWorkGoal{}).Where("id = ?", first.TaskID).Update("status", "paused").Error; err != nil {
		t.Fatal(err)
	}
	check(false)
}

func TestSpecialistCompletionCursorAdvancesOncePerAcceptedTask(t *testing.T) {
	e, source := superFixture(t)
	ctx := t.Context()
	a := superCreateFixture(t, e, source, "a", "Check A", "a", "Check A")
	b := superCreateFixture(t, e, source, "b", "Check B", "b", "Check B")
	db, err := e.superStore()
	if err != nil {
		t.Fatal(err)
	}
	channels, err := e.ListSpecialistChannels(ctx, source.ProjectID)
	if err != nil || len(channels) != 1 {
		t.Fatal(channels, err)
	}
	check := func(want string) {
		t.Helper()
		rows, err := e.ListSpecialistChannels(ctx, source.ProjectID)
		if err != nil || len(rows) != 1 || rows[0].CompletionCursor != want {
			t.Fatalf("wanted channel cursor %q, got %+v, %v", want, rows, err)
		}
		got, err := e.SpecialistCompletionCursor(ctx, source.ProjectID, channels[0].RoleID)
		if err != nil || got != want {
			t.Fatalf("wanted scoped cursor %q, got %q, %v", want, got, err)
		}
	}
	finish := func(task SuperRouteResult) {
		t.Helper()
		if err := db.Model(&nativeWorkGoal{}).Where("id = ?", task.TaskID).Updates(map[string]any{
			"status": "completed", "closure_contract": "{}", "goal_revision": 1, "plan_revision": 1,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	receipt := func(task SuperRouteResult, scope, state string, plan int64) {
		t.Helper()
		if err := db.Create(&workAcceptanceRecord{ID: uid(), SessionID: task.SessionID, GoalID: task.TaskID, ProjectID: source.ProjectID,
			GoalRevision: 1, PlanRevision: plan, Scope: scope, State: state, At: time.Now().UTC()}).Error; err != nil {
			t.Fatal(err)
		}
	}
	finish(a)
	receipt(a, "step", "pass", 1)
	receipt(a, "goal", "insufficient", 1)
	receipt(a, "goal", "pass", 2)
	check("")
	receipt(a, "goal", "pass", 1)
	check("00000000000000000001")
	receipt(a, "goal", "pass", 1)
	if err := db.Model(&nativeWorkGoal{}).Where("id = ?", a.TaskID).Update("progress_revision", 17).Error; err != nil {
		t.Fatal(err)
	}
	check("00000000000000000001")
	receipt(b, "goal", "pass", 1)
	check("00000000000000000001")
	finish(b)
	check("00000000000000000002")
	if got, err := e.SpecialistCompletionCursor(ctx, "other-project", channels[0].RoleID); err != nil || got != "" {
		t.Fatal("cursor crossed project boundary", got, err)
	}
}
