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
		query := tx.Where("state = ?", "queued")
		if cursor.LastProject != "" {
			var other int64
			if err = tx.Model(&superAssignmentRow{}).Where("state = ? AND project_id <> ?", "queued", cursor.LastProject).Count(&other).Error; err != nil {
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
		if err = tx.First(&row, "id = ? AND session_id = ?", w.TaskID, w.SessionID).Error; err != nil {
			return err
		}
		var goal WorkGoal
		if err = decodeWorkGoal(row, &goal); err != nil {
			return err
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
	r := db.WithContext(ctx).Model(&superAssignmentRow{}).Where("id = ? AND worker_id = ? AND owner_id = ? AND generation = ? AND state = ? AND lease_until > ?", token.AssignmentID, token.WorkerID, token.OwnerID, token.Generation, "active", now).Update("lease_until", now.Add(superLeaseDuration))
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
	r := db.WithContext(ctx).Model(&superAssignmentRow{}).Where("id = ? AND worker_id = ? AND owner_id = ? AND generation = ? AND state = ? AND lease_until > ?", token.AssignmentID, token.WorkerID, token.OwnerID, token.Generation, "active", time.Now().UTC()).Updates(map[string]any{"state": state, "owner_id": "", "lease_until": time.Time{}})
	if r.Error != nil {
		return r.Error
	}
	if r.RowsAffected != 1 {
		return errSuperConflict
	}
	return nil
}
