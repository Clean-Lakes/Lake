package ai

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

const superLeaseDuration = 45 * time.Second
const superHeartbeatInterval = 15 * time.Second

var ErrSuperWorkerQueued = errors.New("superagent: Worker remains queued")

type SuperAssignmentToken struct {
	AssignmentID string `json:"assignmentId"`
	WorkerID     string `json:"workerId"`
	OwnerID      string `json:"-"`
	Generation   int64  `json:"generation"`
}
type superAssignmentContextKey struct{}

func (e *Engine) checkSuperAssignmentContext(ctx context.Context) error {
	token, ok := ctx.Value(superAssignmentContextKey{}).(SuperAssignmentToken)
	if !ok {
		return nil
	}
	db, err := e.superStore()
	if err != nil {
		return err
	}
	return checkSuperAssignmentTx(db.WithContext(ctx), token)
}

// Repeat inside the same transaction as dispatch/commit. An entrance check
// alone cannot fence an owner that lost its lease while waiting for approval.
func checkSuperAssignmentTx(tx *gorm.DB, token SuperAssignmentToken) error {
	if err := checkSuperLeaseTx(tx, token, []string{"active"}); err != nil {
		return err
	}
	var worker superWorkerRow
	if err := tx.First(&worker, "id = ?", token.WorkerID).Error; err != nil {
		return err
	}
	if worker.ParentWorkerID != "" {
		var parent superWorkerRow
		if err := tx.First(&parent, "id = ?", worker.ParentWorkerID).Error; err != nil {
			return err
		}
		worker = parent
	}
	return checkSuperWorkflowTx(tx, worker, time.Now().UTC())
}

func checkSuperLeaseTx(tx *gorm.DB, token SuperAssignmentToken, states []string) error {
	var count int64
	if err := tx.Model(&superAssignmentRow{}).Where("id = ? AND worker_id = ? AND owner_id = ? AND generation = ? AND state IN ? AND lease_until > ?", token.AssignmentID, token.WorkerID, token.OwnerID, token.Generation, states, time.Now().UTC()).Count(&count).Error; err != nil {
		return err
	}
	if count != 1 {
		return errSuperConflict
	}
	var w superWorkerRow
	if err := tx.First(&w, "id = ?", token.WorkerID).Error; err != nil {
		return err
	}
	if w.ParentWorkerID != "" {
		if err := tx.Model(&superAssignmentRow{}).Where("worker_id = ? AND generation = ? AND state = ? AND lease_until > ?", w.ParentWorkerID, w.ParentGeneration, "waiting_children", time.Now().UTC()).Count(&count).Error; err != nil {
			return err
		}
		if count != 1 {
			return errSuperConflict
		}
	}
	return nil
}

func checkSuperContextTx(ctx context.Context, tx *gorm.DB) error {
	if token, ok := ctx.Value(superAssignmentContextKey{}).(SuperAssignmentToken); ok {
		return checkSuperAssignmentTx(tx, token)
	}
	return nil
}

type superAdmissionRow struct {
	ID          int `gorm:"primaryKey"`
	LastProject string
}

func (superAdmissionRow) TableName() string { return "superagent_admission" }

// AcquireWorkerSlot admits one invocation, not a graph node. SDK workflows own
// graph scheduling. Expired active assignments require recovery, never stealing.
func (e *Engine) AcquireWorkerSlot(ctx context.Context, projectID, workerID string) (SuperAssignmentToken, error) {
	var token SuperAssignmentToken
	db, err := e.superStore()
	if err != nil {
		return token, err
	}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		w, err := superWorkerInProject(tx, workerID, projectID)
		if err != nil {
			return err
		}
		if w.ParentWorkerID != "" {
			var parent superAssignmentRow
			if err := tx.First(&parent, "worker_id = ? AND generation = ? AND state = ? AND lease_until > ?", w.ParentWorkerID, w.ParentGeneration, "waiting_children", time.Now().UTC()).Error; err != nil {
				return errSuperConflict
			}
		}
		if w.SourceEventID != "" {
			var event superEventRow
			if err := tx.First(&event, "id = ? AND project_id = ? AND disposition = ?", w.SourceEventID, projectID, "routed").Error; err != nil {
				return ErrSuperWorkerQueued
			}
		}
		var a superAssignmentRow
		if err = tx.First(&a, "worker_id = ?", w.ID).Error; err != nil {
			return err
		}
		if a.State != "queued" {
			return ErrSuperWorkerQueued
		}
		if err := checkSuperWorkflowTx(tx, w, time.Now().UTC()); err != nil {
			return err
		}
		var active int64
		// An expired owner still occupies a slot until explicitly reconciled.
		if err = tx.Model(&superAssignmentRow{}).Where("state = ?", "active").Count(&active).Error; err != nil {
			return err
		}
		if active >= 6 {
			return ErrSuperWorkerQueued
		}
		var cursor superAdmissionRow
		lookup := tx.First(&cursor, "id = ?", 1).Error
		if lookup != nil && !errors.Is(lookup, gorm.ErrRecordNotFound) {
			return lookup
		}
		var next superAssignmentRow
		readyEvents := tx.Table("superagent_events AS event").Select("event.id").Joins("JOIN superagent_sources AS source ON source.id=event.source_id AND source.project_id=event.project_id AND source.revision=event.source_revision AND source.actor_ref=event.actor_ref AND source.enabled=1").Where("event.disposition = ?", "routed")
		readyWorkers := tx.Model(&superWorkerRow{}).Select("id").Where("source_event_id = '' OR source_event_id IN (?)", readyEvents)
		query := tx.Where("state = ? AND worker_id IN (?)", "queued", readyWorkers)
		if cursor.LastProject != "" {
			var other int64
			if err = tx.Model(&superAssignmentRow{}).Where("state = ? AND project_id <> ? AND worker_id IN (?)", "queued", cursor.LastProject, readyWorkers).Count(&other).Error; err != nil {
				return err
			}
			if other > 0 {
				query = query.Where("project_id <> ?", cursor.LastProject)
			}
		}
		if err = query.Order("created_at, id").First(&next).Error; err != nil {
			return err
		}
		if next.ID != a.ID {
			return ErrSuperWorkerQueued
		}
		var row nativeWorkGoal
		if err = tx.First(&row, "id = ? AND session_id = ?", w.TaskID, w.goalSession()).Error; err != nil {
			return err
		}
		var goal WorkGoal
		if err = decodeWorkGoal(row, &goal); err != nil {
			return err
		}
		paused, err := superBudgetPausedTx(tx, goal.ID, goal.RoundLimit)
		if err != nil {
			return err
		}
		if paused {
			return ErrSuperWorkerQueued
		}
		if workTerminal(goal.Status) || !goal.DeadlineAt.After(time.Now().UTC()) || goal.ModelRounds >= goal.RoundLimit {
			return errors.New("superagent: task deadline, state or budget prevents dispatch")
		}
		token = SuperAssignmentToken{AssignmentID: a.ID, WorkerID: w.ID, OwnerID: uid(), Generation: a.Generation + 1}
		r := tx.Model(&superAssignmentRow{}).Where("id = ? AND generation = ? AND state = ?", a.ID, a.Generation, "queued").Updates(map[string]any{"owner_id": token.OwnerID, "generation": token.Generation, "state": "active", "lease_until": time.Now().UTC().Add(superLeaseDuration)})
		if r.Error != nil {
			return r.Error
		}
		if r.RowsAffected != 1 {
			return errSuperConflict
		}
		cursor.ID, cursor.LastProject = 1, projectID
		return tx.Save(&cursor).Error
	})
	return token, err
}

func (e *Engine) renewSuperAssignment(ctx context.Context, token SuperAssignmentToken) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	r := db.WithContext(ctx).Model(&superAssignmentRow{}).Where("id = ? AND worker_id = ? AND owner_id = ? AND generation = ? AND state IN ? AND lease_until > ?", token.AssignmentID, token.WorkerID, token.OwnerID, token.Generation, []string{"active", "waiting_user", "waiting_children"}, now).Update("lease_until", now.Add(superLeaseDuration))
	if r.Error != nil {
		return r.Error
	}
	if r.RowsAffected != 1 {
		return errSuperConflict
	}
	return nil
}
func (e *Engine) heartbeatSuperAssignment(ctx context.Context, token SuperAssignmentToken, cancel context.CancelFunc, done chan<- struct{}) {
	defer close(done)
	ticker := time.NewTicker(superHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if e.renewSuperAssignment(ctx, token) != nil {
				cancel()
				return
			}
		}
	}
}
func (e *Engine) ReleaseWorkerSlot(ctx context.Context, token SuperAssignmentToken, state string) error {
	switch state {
	case "parked", "waiting_external", "waiting_user", "finished", "failed":
	default:
		return errSuperBinding
	}
	db, err := e.superStore()
	if err != nil {
		return err
	}
	r := db.WithContext(ctx).Model(&superAssignmentRow{}).Where("id = ? AND worker_id = ? AND owner_id = ? AND generation = ? AND state IN ? AND lease_until > ?", token.AssignmentID, token.WorkerID, token.OwnerID, token.Generation, []string{"active", "waiting_user", "waiting_children"}, time.Now().UTC()).Updates(map[string]any{"state": state, "owner_id": "", "lease_until": time.Time{}})
	if r.Error != nil {
		return r.Error
	}
	if r.RowsAffected != 1 {
		return errSuperConflict
	}
	return nil
}

func (e *Engine) parkSuperHumanInput(ctx context.Context) (func() error, error) {
	return e.parkSuperInvocation(ctx, "waiting_user")
}

func (e *Engine) parkSuperInvocation(ctx context.Context, waiting string) (func() error, error) {
	if waiting != "waiting_user" && waiting != "waiting_children" {
		return nil, errSuperBinding
	}
	token, ok := ctx.Value(superAssignmentContextKey{}).(SuperAssignmentToken)
	if !ok {
		return func() error { return nil }, nil
	}
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	r := db.WithContext(ctx).Model(&superAssignmentRow{}).Where("id = ? AND owner_id = ? AND generation = ? AND state = ? AND lease_until > ?", token.AssignmentID, token.OwnerID, token.Generation, "active", time.Now().UTC()).Update("state", waiting)
	if r.Error != nil {
		return nil, r.Error
	}
	if r.RowsAffected != 1 {
		return nil, errSuperConflict
	}
	return func() error {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			admitted := false
			err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
				var active int64
				if err := tx.Model(&superAssignmentRow{}).Where("state = ?", "active").Count(&active).Error; err != nil {
					return err
				}
				if active >= 6 {
					return nil
				}
				r := tx.Model(&superAssignmentRow{}).Where("id = ? AND owner_id = ? AND generation = ? AND state = ? AND lease_until > ?", token.AssignmentID, token.OwnerID, token.Generation, waiting, time.Now().UTC()).Update("state", "active")
				if r.Error != nil {
					return r.Error
				}
				if r.RowsAffected != 1 {
					return errSuperConflict
				}
				admitted = true
				return nil
			})
			if err != nil {
				return err
			}
			if admitted {
				return nil
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-ticker.C:
			}
		}
	}, nil
}
