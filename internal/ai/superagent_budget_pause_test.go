package ai

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestSuperRoundLimitPersistsPauseAndFollowupDoesNotRestart(t *testing.T) {
	e, source := superFixture(t)
	goal, worker, assignment := superWorkerFixture(t, e, "budget-pause")
	db, _ := e.superStore()
	if err := db.Create(&superProjectRow{ProjectID: "project", RouterSessionID: "pilot", Version: 1}).Error; err != nil {
		t.Fatal(err)
	}
	row, goal, err := e.workRow(goal.SessionID, goal.ID)
	if err != nil {
		t.Fatal(err)
	}
	goal.RoundLimit = 1
	if err := e.writeWorkGoal(&row, &goal, false); err != nil {
		t.Fatal(err)
	}
	before := superBudgetRow{TaskID: goal.ID, Rounds: 1, Tokens: 90}
	if err := db.Create(&before).Error; err != nil {
		t.Fatal(err)
	}
	token := SuperAssignmentToken{AssignmentID: assignment, WorkerID: worker, Generation: 1}
	ctx := context.WithValue(t.Context(), superAssignmentContextKey{}, token)
	if _, err := e.reserveSuperModel(ctx, Model{MaxOutput: 20}, nil, nil); !errors.Is(err, ErrSuperBudget) {
		t.Fatal("round limit did not stop provider dispatch", err)
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

func TestSuperLegacyTokenPauseRemovedWithoutReplayOrDuplicateNotice(t *testing.T) {
	e, _ := superFixture(t)
	goal, worker, assignment := superWorkerFixture(t, e, "legacy-budget-pause")
	db, _ := e.superStore()
	if err := db.Create(&superProjectRow{ProjectID: "project", RouterSessionID: "pilot", Version: 1}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&superAssignmentRow{}).Where("id = ?", assignment).Updates(map[string]any{"state": "parked", "project_id": "project", "last_error": legacySuperTokenPauseReason}).Error; err != nil {
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
	blocked.Status, blocked.Summary, blocked.RoundLimit = "paused", legacySuperTokenPauseSummary, 500
	if err := e.writeWorkGoal(&row, &blocked, false); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get(goal.SessionID)
	s.mu.Lock()
	s.state.View.Status = "blocked"
	s.state.WorkGoalID = goal.ID
	const original = "superagent: original task's cumulative model budget exhausted"
	s.state.View.Cards = append(s.state.View.Cards, Card{ID: "original-refusal", Type: "error", Content: original, Status: "failed"})
	s.mu.Unlock()
	for i := 0; i < 3; i++ {
		if err := e.CheckSuperagentProgress(t.Context(), "project"); err != nil {
			t.Fatal(err)
		}
	}
	var a superAssignmentRow
	if err := db.First(&a, "worker_id = ?", worker).Error; err != nil || a.State != "parked" || a.Generation != 1 || a.LastError != superTokenLimitRemovedReason {
		t.Fatal(a, err)
	}
	var after superBudgetRow
	if err := db.First(&after, "task_id = ?", goal.ID).Error; err != nil || after.TokenLimit != 0 || after.Tokens != before.Tokens || after.Rounds != before.Rounds {
		t.Fatal("token removal reset counters", after, err)
	}
	view, err := e.SuperTask(goal.SessionID, goal.ID)
	if err != nil || view.State != "blocked" || view.Reason != superTokenLimitRemovedReason || view.Summary != SuperTokenLimitRemovedSummary {
		t.Fatal("old token pause remains active", view, err)
	}
	var count int64
	db.Model(&superOutputRow{}).Where("task_id = ?", goal.ID).Count(&count)
	if count != 1 {
		t.Fatal("supervision duplicated pause notification", count)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.state.View.Cards) != 1 || s.state.View.Cards[0].Content != original {
		t.Fatal("legacy diagnostic was rewritten")
	}
}

func TestSuperTokenAccountingContinuesBeyondOldCeiling(t *testing.T) {
	e, _ := superFixture(t)
	goal, worker, assignment := superWorkerFixture(t, e, "uncapped-tokens")
	db, _ := e.superStore()
	row, goal, err := e.workRow(goal.SessionID, goal.ID)
	if err != nil {
		t.Fatal(err)
	}
	goal.RoundLimit = 500
	if err := e.writeWorkGoal(&row, &goal, false); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&superBudgetRow{TaskID: goal.ID, Rounds: 1, Tokens: 300000, TokenLimit: 256000}).Error; err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(t.Context(), superAssignmentContextKey{}, SuperAssignmentToken{AssignmentID: assignment, WorkerID: worker, Generation: 1})
	settle, err := e.reserveSuperModel(ctx, Model{MaxOutput: 1000000}, nil, nil)
	if err != nil {
		t.Fatal("legacy token ceiling still gates a request", err)
	}
	settle(Usage{Input: 20, Output: 10, InputKnown: true, OutputKnown: true})
	settle(Usage{Input: 20, Output: 10, InputKnown: true, OutputKnown: true})
	var budget superBudgetRow
	if err := db.First(&budget, "task_id = ?", goal.ID).Error; err != nil || budget.Tokens != 300030 || budget.Rounds != 2 || budget.TokenLimit != 0 {
		t.Fatal("unlimited token accounting lost usage or settled twice", budget, err)
	}
	if paused, err := superBudgetPausedTx(db, goal.ID, goal.RoundLimit); err != nil || paused {
		t.Fatal("tokens are still a dispatch limit", err)
	}
}

func TestSuperTokenRemovalPreservesOtherPauseAndRoundConstraints(t *testing.T) {
	for _, rounds := range []int{13, 500, -1} {
		t.Run(js(rounds), func(t *testing.T) {
			e, _ := superFixture(t)
			goal, worker, assignment := superWorkerFixture(t, e, "other-pause")
			db, _ := e.superStore()
			row, goal, err := e.workRow(goal.SessionID, goal.ID)
			if err != nil {
				t.Fatal(err)
			}
			goal.Status, goal.Summary, goal.RoundLimit = "paused", "用户主动暂停", 500
			if rounds == 500 {
				goal.Summary = legacySuperTokenPauseSummary
			}
			if rounds == -1 {
				goal.Summary, goal.DeadlineAt = legacySuperTokenPauseSummary, time.Now().UTC().Add(-time.Minute)
			}
			if err := e.writeWorkGoal(&row, &goal, false); err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&superBudgetRow{TaskID: goal.ID, Rounds: max(13, rounds), Tokens: 300000, TokenLimit: 256000}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Model(&superAssignmentRow{}).Where("id = ?", assignment).Updates(map[string]any{"state": "parked", "last_error": legacySuperTokenPauseReason}).Error; err != nil {
				t.Fatal(err)
			}
			if err := e.removeSuperTokenLimits(t.Context(), "project"); err != nil {
				t.Fatal(err)
			}
			_, current, err := e.workRow(goal.SessionID, goal.ID)
			if err != nil || current.Status != "paused" || !current.DeadlineAt.Equal(goal.DeadlineAt) {
				t.Fatal("unrelated stop or deadline changed", current, err)
			}
			if rounds == 13 && current.Summary != "用户主动暂停" || rounds == 500 && current.Summary != SuperBudgetPauseSummary {
				t.Fatal("pause cause lost", current.Summary)
			}
			if rounds == -1 {
				view, err := e.SuperTask(goal.SessionID, goal.ID)
				if err != nil || view.Reason != "deadline_expired" || !strings.Contains(view.Summary, "期限已到") {
					t.Fatal("token removal overrode expiry", view, err)
				}
			}
			if rounds == 500 {
				if _, err := e.AcquireWorkerSlot(t.Context(), "project", worker); !errors.Is(err, ErrSuperWorkerQueued) {
					t.Fatal("removing tokens bypassed round limit", err)
				}
			}
		})
	}
}
