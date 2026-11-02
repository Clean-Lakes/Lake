package ai

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

// ClaimAssignment admits only a real existing machine checkpoint. It neither
// manufactures a human input nor starts another copy of the original command.
func (e *Engine) ClaimAssignment(ctx context.Context, projectID, workerID, callID string) (SuperAssignmentToken, error) {
	db, err := e.superStore()
	if err != nil {
		return SuperAssignmentToken{}, err
	}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		w, err := superWorkerInProject(tx, workerID, projectID)
		if err != nil {
			return err
		}
		row, goal, err := loadSuperGoalTx(tx, w)
		if err != nil {
			return err
		}
		if callID == "" || row.WaitCallID != callID || row.Checkpoint == "" || workTerminal(goal.Status) || !goal.DeadlineAt.After(time.Now().UTC()) {
			return errSuperBinding
		}
		if row.WaitState != "ready" && row.WaitState != "resuming" {
			return ErrSuperWorkerQueued
		}
		var a superAssignmentRow
		if err = tx.First(&a, "worker_id = ?", w.ID).Error; err != nil {
			return err
		}
		if a.State == "queued" && a.InvocationKind == "machine" {
			return nil
		}
		if a.State != "parked" && a.State != "waiting_external" {
			return ErrSuperWorkerQueued
		}
		return tx.Model(&superAssignmentRow{}).Where("id = ? AND generation = ? AND state = ?", a.ID, a.Generation, a.State).Updates(map[string]any{"state": "queued", "invocation_kind": "machine", "input_event_id": ""}).Error
	})
	if err != nil {
		return SuperAssignmentToken{}, err
	}
	return e.AcquireWorkerSlot(ctx, projectID, workerID)
}

func (e *Engine) beginSuperInvocation(ctx context.Context, token SuperAssignmentToken) (context.Context, func()) {
	run, cancel := context.WithCancel(context.WithValue(ctx, superAssignmentContextKey{}, token))
	run = context.WithValue(run, superWorkerModelKey{}, true)
	done := make(chan struct{})
	go e.heartbeatSuperAssignment(run, token, cancel, done)
	return run, func() {
		cancel()
		<-done
		state := "parked"
		if db, err := e.superStore(); err == nil {
			var w superWorkerRow
			if db.First(&w, "id = ?", token.WorkerID).Error == nil {
				row, g, err := loadSuperGoalTx(db, w)
				if err == nil {
					if w.ParentWorkerID != "" || workTerminal(g.Status) {
						state = "finished"
					} else if row.WaitCallID != "" && row.Checkpoint != "" {
						state = "waiting_external"
					}
				}
			}
		}
		_ = e.ReleaseWorkerSlot(context.Background(), token, state)
	}
}

func (e *Engine) superWorkerForGoal(ctx context.Context, sessionID, goalID string) (superWorkerRow, bool, error) {
	store, err := e.adkStore()
	if err != nil {
		return superWorkerRow{}, false, err
	}
	if !store.DB.Migrator().HasTable(&superWorkerRow{}) {
		return superWorkerRow{}, false, nil
	}
	var w superWorkerRow
	err = store.DB.WithContext(ctx).First(&w, "session_id = ? AND task_id = ? AND parent_worker_id = ''", sessionID, goalID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return w, false, nil
	}
	return w, err == nil, err
}
