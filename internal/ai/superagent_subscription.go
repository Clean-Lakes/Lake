package ai

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type SuperSubscription struct {
	SourceID, ThreadRef, WorkerID, Mode string
}
type SuperWorkerInput struct {
	ID        string `json:"id"`
	EventID   string `json:"eventId"`
	PartKey   string `json:"partKey"`
	WorkerID  string `json:"workerId"`
	TaskID    string `json:"taskId"`
	Mode      string `json:"mode"`
	Delivered bool   `json:"delivered"`
	Consumed  bool   `json:"consumed"`
}

func validSuperInputMode(mode string) bool { return mode == "followup" || mode == "context_only" }

func superWorkerInProject(tx *gorm.DB, workerID, projectID string) (superWorkerRow, error) {
	var w superWorkerRow
	err := tx.First(&w, "id = ? AND project_id = ?", workerID, projectID).Error
	return w, err
}

// SubscribeSuperWorker is a host operation. Only a user source can convey a
// followup; automated observations remain data and cannot become instructions.
func (e *Engine) SubscribeSuperWorker(ctx context.Context, projectID string, in SuperSubscription) error {
	if in.ThreadRef == "" || !validSuperInputMode(in.Mode) {
		return errSuperBinding
	}
	db, err := e.superStore()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var source superSourceRow
		if err := tx.First(&source, "id = ? AND project_id = ? AND enabled = ?", in.SourceID, projectID, true).Error; err != nil {
			return err
		}
		if in.Mode == "followup" && source.Kind != "user" {
			return errSuperBinding
		}
		w, err := superWorkerInProject(tx, in.WorkerID, projectID)
		if err != nil {
			return err
		}
		row := superSubscriptionRow{ID: uid(), SourceID: in.SourceID, ThreadRef: in.ThreadRef, WorkerID: w.ID, ProjectID: projectID, TaskID: w.TaskID, Mode: in.Mode, Revision: 1}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; err != nil {
			return err
		}
		var existing superSubscriptionRow
		if err := tx.First(&existing, "source_id = ? AND thread_ref = ? AND worker_id = ?", in.SourceID, in.ThreadRef, w.ID).Error; err != nil {
			return err
		}
		if existing.Mode != in.Mode || existing.TaskID != w.TaskID || existing.ClosedAt != nil {
			return errSuperConflict
		}
		return nil
	})
}

// RouteSubscribedEvent uses exact thread ownership. It never guesses a task
// from matching resource names or broadcasts an entire Pilot conversation.
func (e *Engine) RouteSubscribedEvent(ctx context.Context, projectID, eventID string) ([]SuperWorkerInput, error) {
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	out := []SuperWorkerInput{}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var event superEventRow
		if err := tx.First(&event, "id = ? AND project_id = ?", eventID, projectID).Error; err != nil {
			return err
		}
		var source superSourceRow
		if err := tx.First(&source, "id = ? AND project_id = ? AND revision = ? AND enabled = ?", event.SourceID, projectID, event.SourceRevision, true).Error; err != nil {
			return err
		}
		if event.ThreadRef == "" {
			return nil
		}
		var subscriptions []superSubscriptionRow
		if err := tx.Where("source_id = ? AND thread_ref = ? AND project_id = ? AND closed_at IS NULL", event.SourceID, event.ThreadRef, projectID).Order("id").Find(&subscriptions).Error; err != nil {
			return err
		}
		followups := 0
		for _, s := range subscriptions {
			if s.Mode == "followup" {
				followups++
			}
		}
		// Ambiguous ownership must be resolved by Router, never duplicate control.
		if followups > 1 {
			return nil
		}
		for _, s := range subscriptions {
			var handedBack int64
			if err := tx.Model(&superHandbackRow{}).Where("event_id = ? AND worker_id = ?", eventID, s.WorkerID).Count(&handedBack).Error; err != nil {
				return err
			}
			if handedBack != 0 {
				continue
			}
			input, err := enqueueSuperInput(tx, projectID, event, s.WorkerID, "whole", s.Mode)
			if err != nil {
				return err
			}
			out = append(out, input)
		}
		if len(out) > 0 {
			return tx.Model(&superEventRow{}).Where("id = ?", eventID).Update("disposition", "routed").Error
		}
		return nil
	})
	return out, err
}

func (e *Engine) HandBackSuperEvent(ctx context.Context, projectID, eventID, workerID, reason string) error {
	if reason == "" || len(reason) > 1024 {
		return errSuperBinding
	}
	db, err := e.superStore()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		w, err := superWorkerInProject(tx, workerID, projectID)
		if err != nil {
			return err
		}
		var event superEventRow
		if err = tx.First(&event, "id = ? AND project_id = ?", eventID, projectID).Error; err != nil {
			return err
		}
		var consumed int64
		if err = tx.Model(&superInboxRow{}).Where("event_id = ? AND worker_id = ? AND consumed_at IS NOT NULL", eventID, workerID).Count(&consumed).Error; err != nil {
			return err
		}
		if consumed > 0 {
			return errors.New("superagent: consumed input cannot be handed back")
		}
		result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&superHandbackRow{EventID: eventID, WorkerID: workerID, Reason: reason, At: time.Now().UTC()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return errSuperConflict
		}
		if err = tx.Where("event_id = ? AND worker_id = ? AND consumed_at IS NULL", eventID, workerID).Delete(&superInboxRow{}).Error; err != nil {
			return err
		}
		now := time.Now().UTC()
		if err = tx.Model(&superSubscriptionRow{}).Where("worker_id = ? AND task_id = ? AND source_id = ? AND thread_ref = ? AND closed_at IS NULL", workerID, w.TaskID, event.SourceID, event.ThreadRef).Update("closed_at", now).Error; err != nil {
			return err
		}
		return tx.Model(&superEventRow{}).Where("id = ?", eventID).Update("disposition", "pending").Error
	})
}
