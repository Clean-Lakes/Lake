package ai

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
)

func TestSuperRecoveryFencesExpiredOwnerWithoutReplaying(t *testing.T) {
	e, _ := superFixture(t)
	goal, worker, assignment := superWorkerFixture(t, e, "crash")
	db, _ := e.superStore()
	old := SuperAssignmentToken{AssignmentID: assignment, WorkerID: worker, OwnerID: "original", Generation: 1}
	if err := db.Model(&superAssignmentRow{}).Where("id = ?", assignment).Updates(map[string]any{"project_id": "project", "owner_id": old.OwnerID, "lease_until": time.Now().UTC().Add(-time.Second)}).Error; err != nil {
		t.Fatal(err)
	}
	row, copyGoal, err := e.workRow(goal.SessionID, goal.ID)
	if err != nil {
		t.Fatal(err)
	}
	row.superFence = &old
	result, err := e.RecoverSuperagent(context.Background(), "project")
	if err != nil || len(result) != 1 || result[0].State != "parked" {
		t.Fatal(result, err)
	}
	if err = e.writeWorkGoal(&row, &copyGoal, false); !errors.Is(err, errSuperConflict) {
		t.Fatal("late goal commit accepted", err)
	}
	if err = e.renewSuperAssignment(context.Background(), old); !errors.Is(err, errSuperConflict) {
		t.Fatal("late heartbeat accepted", err)
	}
	if _, err = e.AcquireWorkerSlot(context.Background(), "project", worker); !errors.Is(err, ErrSuperWorkerQueued) {
		t.Fatal("interrupted request replayed", err)
	}
	if again, err := e.RecoverSuperagent(context.Background(), "project"); err != nil || len(again) != 0 {
		t.Fatal(again, err)
	}
	_, after, err := e.workRow(goal.SessionID, goal.ID)
	if err != nil || after.Status != "paused" || !after.DeadlineAt.Equal(goal.DeadlineAt) {
		t.Fatal(after, err)
	}
}

func TestSuperBudgetSharedReservationsSurviveContinuation(t *testing.T) {
	e, _ := superFixture(t)
	goal, worker, assignment := superWorkerFixture(t, e, "budget")
	db, _ := e.superStore()
	row, goal, err := e.workRow(goal.SessionID, goal.ID)
	if err != nil {
		t.Fatal(err)
	}
	goal.RoundLimit = 2
	if err = e.writeWorkGoal(&row, &goal, false); err != nil {
		t.Fatal(err)
	}
	token := SuperAssignmentToken{AssignmentID: assignment, WorkerID: worker, Generation: 1}
	ctx := context.WithValue(context.Background(), superAssignmentContextKey{}, token)
	var admitted atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			settle, err := e.reserveSuperModel(ctx, Model{MaxOutput: 20}, []Message{{Role: "user", Content: "actual task"}}, nil)
			if err == nil {
				admitted.Add(1)
				settle(Usage{Input: 2, Output: 3, InputKnown: true, OutputKnown: true})
				settle(Usage{Input: 2, Output: 3, InputKnown: true, OutputKnown: true})
			} else if !errors.Is(err, ErrSuperBudget) {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	var budget superBudgetRow
	if err = db.First(&budget, "task_id = ?", goal.ID).Error; err != nil || admitted.Load() != 2 || budget.Rounds != 2 || budget.Tokens != 10 {
		t.Fatal(admitted.Load(), budget, err)
	}
	if _, err = e.reserveSuperModel(ctx, Model{MaxOutput: 1}, nil, nil); !errors.Is(err, ErrSuperBudget) {
		t.Fatal("continuation reset budget", err)
	}
}

func TestSuperResourceConflictRetainsUnknownEffects(t *testing.T) {
	e, _ := superFixture(t)
	db, _ := e.superStore()
	first := security.PreparedOperation{GoalID: "one", Resources: []security.ResourceRevision{{ID: "resource"}}, Capabilities: []string{"command.execute"}, Proof: security.ProofOpaque}
	prior := nativeOperation{ID: "uncertain", GoalID: "one", Risk: "write", Status: "failed", OrphanState: "effects_unknown", SecurityDescriptor: js(first)}
	if err := db.Create(&prior).Error; err != nil {
		t.Fatal(err)
	}
	next := first
	next.GoalID = "two"
	if err := checkSuperResourceConflictsTx(db, next); !errors.Is(err, ErrSuperResourceBusy) {
		t.Fatal("unknown effect released", err)
	}
	if err := db.Model(&nativeOperation{}).Where("id = ?", prior.ID).Updates(map[string]any{"risk_resolved_at": time.Now(), "orphan_state": "reconciled"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := checkSuperResourceConflictsTx(db, next); err != nil {
		t.Fatal("reconciled resource remained busy", err)
	}
}

func TestSuperWatchdogBoundsDispatchFailureAndPreservesAcceptance(t *testing.T) {
	e, _ := superFixture(t)
	goal, worker, assignment := superWorkerFixture(t, e, "watchdog")
	db, _ := e.superStore()
	if err := db.Model(&superAssignmentRow{}).Where("id = ?", assignment).Updates(map[string]any{"project_id": "project", "state": "queued"}).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := e.RecordSuperDispatchFailure(context.Background(), "project", worker); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.CheckSuperagentProgress(context.Background(), "project"); err != nil {
		t.Fatal(err)
	}
	var a superAssignmentRow
	if err := db.First(&a, "id = ?", assignment).Error; err != nil || a.State != "parked" || a.FailureCount != 3 {
		t.Fatal(a, err)
	}
	view, err := e.SuperTask(goal.SessionID, goal.ID)
	if err != nil || view.State != "paused" || view.AcceptanceState == "passed" {
		t.Fatal(view, err)
	}
}
