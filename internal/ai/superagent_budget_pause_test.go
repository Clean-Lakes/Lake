package ai

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestSuperBudgetReservationRefusalPersistsPauseAndFollowupDoesNotRestart(t *testing.T) {
	e, source := superFixture(t)
	goal, worker, assignment := superWorkerFixture(t, e, "budget-pause")
	db, _ := e.superStore()
	if err := db.Create(&superProjectRow{ProjectID: "project", RouterSessionID: "pilot", Version: 1}).Error; err != nil {
		t.Fatal(err)
	}
	before := superBudgetRow{TaskID: goal.ID, Rounds: 1, Tokens: 90, TokenLimit: 100}
	if err := db.Create(&before).Error; err != nil {
		t.Fatal(err)
	}
	token := SuperAssignmentToken{AssignmentID: assignment, WorkerID: worker, Generation: 1}
	ctx := context.WithValue(t.Context(), superAssignmentContextKey{}, token)
	if _, err := e.reserveSuperModel(ctx, Model{MaxOutput: 20}, nil, nil); !errors.Is(err, ErrSuperBudget) {
		t.Fatal("positive balance incorrectly admitted a request that cannot fit", err)
	}
	var budget superBudgetRow
	var charges int64
	if err := db.First(&budget, "task_id = ?", goal.ID).Error; err != nil || budget != before {
		t.Fatal("refusal reset or spent quota", budget, err)
	}
	db.Model(&superModelChargeRow{}).Where("task_id = ?", goal.ID).Count(&charges)
	if charges != 0 {
		t.Fatal("refused provider request was charged")
	}
	view, err := e.SuperTask(goal.SessionID, goal.ID)
	if err != nil || view.State != "paused" || view.Reason != superBudgetPauseReason || view.Summary != SuperBudgetPauseSummary || !view.DeadlineAt.Equal(goal.DeadlineAt) || view.AcceptanceState == "pass" {
		t.Fatal(view, err)
	}
	if err := e.ReleaseWorkerSlot(t.Context(), token, "parked"); err != nil {
		t.Fatal(err)
	}
	event, _, err := e.ReceiveSuperEvent(t.Context(), source, SuperEventInput{SourceEventID: "new-followup", ThreadRef: "pilot", Kind: "message", Payload: "Check the current status"})
	if err != nil {
		t.Fatal(err)
	}
	route, err := e.ApplySuperDecision(t.Context(), source, SuperDecision{EventID: event.ID, PartKey: "status", Action: "followup", TaskID: goal.ID, Quote: event.Payload, Reason: "real followup"})
	if err != nil || route.State != "paused" || route.Reason != superBudgetPauseReason || route.Summary != SuperBudgetPauseSummary {
		t.Fatal("Router cannot explain the preserved but undispatchable input", route, err)
	}
	if err := e.finishSuperRouting(t.Context(), source, event.ID); err != nil {
		t.Fatal(err)
	}
	if err := e.QueueSuperFollowup(t.Context(), "project", worker); !errors.Is(err, ErrSuperWorkerQueued) {
		t.Fatal("followup renewed quota", err)
	}
	if _, err := e.AcquireWorkerSlot(t.Context(), "project", worker); !errors.Is(err, ErrSuperWorkerQueued) {
		t.Fatal("paused provider was dispatched", err)
	}
	var input superInboxRow
	if err := db.First(&input, "event_id = ?", event.ID).Error; err != nil || input.ConsumedAt != nil || input.DeliveredAt != nil {
		t.Fatal("undelivered human input was lost or marked consumed", input, err)
	}
	var reports []superOutputRow
	if err := db.Where("task_id = ?", goal.ID).Find(&reports).Error; err != nil || len(reports) != 1 || !strings.Contains(reports[0].Payload, SuperBudgetPauseSummary) {
		t.Fatal("missing or duplicate attention delivery", reports, err)
	}
	e.Shutdown()
	reopened, err := New(e.Dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Shutdown)
	if err := reopened.QueueSuperFollowup(t.Context(), "project", worker); !errors.Is(err, ErrSuperWorkerQueued) {
		t.Fatal("restart renewed quota", err)
	}
	if view, err := reopened.SuperTask(goal.SessionID, goal.ID); err != nil || view.Reason != superBudgetPauseReason || view.State != "paused" {
		t.Fatal(view, err)
	}
}

func TestSuperBudgetLegacyStopReconcilesWithoutReplayOrDuplicateNotice(t *testing.T) {
	e, _ := superFixture(t)
	goal, worker, assignment := superWorkerFixture(t, e, "legacy-budget-pause")
	db, _ := e.superStore()
	if err := db.Create(&superProjectRow{ProjectID: "project", RouterSessionID: "pilot", Version: 1}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&superAssignmentRow{}).Where("id = ?", assignment).Updates(map[string]any{"state": "parked", "project_id": "project"}).Error; err != nil {
		t.Fatal(err)
	}
	before := superBudgetRow{TaskID: goal.ID, Rounds: 13, Tokens: 236780, TokenLimit: 256000}
	if err := db.Create(&before).Error; err != nil {
		t.Fatal(err)
	}
	row, blocked, err := e.workRow(goal.SessionID, goal.ID)
	if err != nil {
		t.Fatal(err)
	}
	blocked.Status = "blocked"
	if err := e.writeWorkGoal(&row, &blocked, false); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get(goal.SessionID)
	s.mu.Lock()
	s.state.View.Status = "blocked"
	s.state.WorkGoalID = goal.ID
	s.state.View.Cards = append(s.state.View.Cards, Card{ID: "original-refusal", Type: "error", Content: ErrSuperBudget.Error(), Status: "failed"})
	s.mu.Unlock()
	for i := 0; i < 3; i++ {
		if err := e.CheckSuperagentProgress(t.Context(), "project"); err != nil {
			t.Fatal(err)
		}
	}
	var a superAssignmentRow
	if err := db.First(&a, "worker_id = ?", worker).Error; err != nil || a.State != "parked" || a.Generation != 1 || a.LastError != superBudgetPauseReason {
		t.Fatal(a, err)
	}
	var after superBudgetRow
	if err := db.First(&after, "task_id = ?", goal.ID).Error; err != nil || after != before {
		t.Fatal("supervision changed original quota", after, err)
	}
	var count int64
	db.Model(&superOutputRow{}).Where("task_id = ?", goal.ID).Count(&count)
	if count != 1 {
		t.Fatal("supervision duplicated pause notification", count)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.state.View.Cards) != 1 || s.state.View.Cards[0].Content != ErrSuperBudget.Error() {
		t.Fatal("legacy diagnostic was rewritten")
	}
}
