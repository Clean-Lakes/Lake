package ai

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	adksession "google.golang.org/adk/v2/session"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func decodeSuperReceipt(delta map[string]any, receipt any) error {
	return json.Unmarshal([]byte(js(delta[supplementStateKey])), receipt)
}

// Called only after the Runner yields a committed event, or while reconciling
// its durable projection after restart. Legacy sessions do not create metadata.
func (e *Engine) acknowledgeSuperSupplements(ctx context.Context, sessionID, root string, ids, eventIDs []string) error {
	owner, err := securityRootEngine(e)
	if err != nil {
		return err
	}
	if !owner.superInitialized.Load() {
		return nil
	}
	db, err := e.superStore()
	if err != nil {
		return err
	}
	var w superWorkerRow
	err = db.WithContext(ctx).First(&w, "session_id = ?", sessionID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	var rows []superInboxRow
	if err = db.WithContext(ctx).Where("worker_id = ? AND root_turn_id = ? AND source_message_id IN ? AND delivered_at IS NOT NULL AND consumed_at IS NULL", w.ID, root, ids).Find(&rows).Error; err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	if len(eventIDs) == 0 {
		s, err := e.get(sessionID)
		if err != nil {
			return err
		}
		s.mu.Lock()
		runtimeID := ""
		if s.state.Runtime != nil {
			runtimeID = s.state.Runtime.SessionID
		}
		s.mu.Unlock()
		if runtimeID == "" {
			return errSuperBinding
		}
		store, err := e.adkStore()
		if err != nil {
			return err
		}
		got, err := store.Sessions.Get(ctx, &adksession.GetRequest{AppName: "lake", UserID: "lake", SessionID: runtimeID})
		if err != nil {
			return err
		}
		for ev := range got.Session.Events().All() {
			if !ev.Partial && ev.Actions.StateDelta[supplementStateKey] != nil {
				eventIDs = append(eventIDs, ev.ID)
			}
		}
	}
	for _, row := range rows {
		accepted := false
		for _, eventID := range eventIDs {
			if err = e.MarkWorkerInputConsumed(ctx, w.ProjectID, row.ID, eventID); err == nil {
				accepted = true
				break
			}
		}
		if !accepted {
			return errors.New("superagent: supplement receipt could not be reconciled")
		}
	}
	return nil
}

func (r superInboxRow) input() SuperWorkerInput {
	return SuperWorkerInput{ID: r.ID, EventID: r.EventID, PartKey: r.PartKey, WorkerID: r.WorkerID, TaskID: r.TaskID, Mode: r.Mode, Delivered: r.DeliveredAt != nil, Consumed: r.ConsumedAt != nil}
}
func enqueueSuperInput(tx *gorm.DB, projectID string, event superEventRow, workerID, partKey, mode string) (SuperWorkerInput, error) {
	if !validSuperInputMode(mode) || partKey == "" || len(partKey) > 128 {
		return SuperWorkerInput{}, errSuperBinding
	}
	w, err := superWorkerInProject(tx, workerID, projectID)
	if err != nil {
		return SuperWorkerInput{}, err
	}
	if event.ProjectID != projectID {
		return SuperWorkerInput{}, errSuperBinding
	}
	var source superSourceRow
	if err = tx.First(&source, "id = ? AND project_id = ? AND enabled = ? AND revision = ?", event.SourceID, projectID, true, event.SourceRevision).Error; err != nil {
		return SuperWorkerInput{}, err
	}
	if mode == "followup" && source.Kind != "user" {
		return SuperWorkerInput{}, errSuperBinding
	}
	var goal nativeWorkGoal
	if err = tx.First(&goal, "id = ? AND session_id = ?", w.TaskID, w.SessionID).Error; err != nil {
		return SuperWorkerInput{}, err
	}
	if workTerminal(goal.Status) {
		return SuperWorkerInput{}, errors.New("superagent: task is terminal")
	}
	var handback int64
	if err = tx.Model(&superHandbackRow{}).Where("event_id = ? AND worker_id = ?", event.ID, w.ID).Count(&handback).Error; err != nil {
		return SuperWorkerInput{}, err
	}
	if handback > 0 {
		return SuperWorkerInput{}, errSuperConflict
	}
	row := superInboxRow{ID: uid(), EventID: event.ID, PartKey: partKey, WorkerID: w.ID, TaskID: w.TaskID, Mode: mode, SourceMessageID: event.SourceEventID, RootTurnID: goal.RootTurnID}
	if err = tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; err != nil {
		return SuperWorkerInput{}, err
	}
	var original superInboxRow
	if err = tx.First(&original, "event_id = ? AND part_key = ? AND worker_id = ?", event.ID, partKey, w.ID).Error; err != nil {
		return SuperWorkerInput{}, err
	}
	if original.Mode != mode || original.TaskID != w.TaskID {
		return SuperWorkerInput{}, errSuperConflict
	}
	return original.input(), nil
}

func (e *Engine) EnqueueWorkerInput(ctx context.Context, projectID, eventID, workerID, partKey, mode string) (SuperWorkerInput, error) {
	db, err := e.superStore()
	if err != nil {
		return SuperWorkerInput{}, err
	}
	var out SuperWorkerInput
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var event superEventRow
		if err := tx.First(&event, "id = ? AND project_id = ?", eventID, projectID).Error; err != nil {
			return err
		}
		var err error
		out, err = enqueueSuperInput(tx, projectID, event, workerID, partKey, mode)
		return err
	})
	return out, err
}

func (e *Engine) MarkWorkerInputDelivered(ctx context.Context, projectID, inputID, assignmentID string) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var input superInboxRow
		if err := tx.First(&input, "id = ?", inputID).Error; err != nil {
			return err
		}
		if _, err := superWorkerInProject(tx, input.WorkerID, projectID); err != nil {
			return err
		}
		var assignment superAssignmentRow
		if err := tx.First(&assignment, "id = ? AND worker_id = ? AND state = ? AND lease_until > ?", assignmentID, input.WorkerID, "active", time.Now().UTC()).Error; err != nil {
			return err
		}
		if input.ConsumedAt != nil {
			return nil
		}
		return tx.Model(&superInboxRow{}).Where("id = ? AND consumed_at IS NULL", inputID).Updates(map[string]any{"assignment_id": assignmentID, "delivered_at": time.Now().UTC()}).Error
	})
}

// MarkWorkerInputConsumed verifies the receipt in official SDK storage. A
// delivery timestamp, model assertion or manually supplied ID is insufficient.
func (e *Engine) MarkWorkerInputConsumed(ctx context.Context, projectID, inputID, sdkEventID string) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	var input superInboxRow
	if err = db.WithContext(ctx).First(&input, "id = ?", inputID).Error; err != nil {
		return err
	}
	w, err := superWorkerInProject(db.WithContext(ctx), input.WorkerID, projectID)
	if err != nil {
		return err
	}
	if input.DeliveredAt == nil || sdkEventID == "" {
		return errSuperBinding
	}
	s, err := e.get(w.SessionID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	runtimeID := ""
	if s.state.Runtime != nil {
		runtimeID = s.state.Runtime.SessionID
	}
	s.mu.Unlock()
	if runtimeID == "" {
		return errSuperBinding
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	got, err := store.Sessions.Get(ctx, &adksession.GetRequest{AppName: "lake", UserID: "lake", SessionID: runtimeID})
	if err != nil {
		return err
	}
	matched := false
	for ev := range got.Session.Events().All() {
		if ev.ID != sdkEventID || ev.Partial {
			continue
		}
		var receipt struct {
			RootTurnID string   `json:"rootTurnId"`
			IDs        []string `json:"ids"`
		}
		if decodeSuperReceipt(ev.Actions.StateDelta, &receipt) != nil || receipt.RootTurnID != input.RootTurnID {
			continue
		}
		for _, id := range receipt.IDs {
			if id == input.SourceMessageID {
				matched = true
			}
		}
	}
	if !matched {
		return errors.New("superagent: SDK has not accepted this input")
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var current superInboxRow
		if err := tx.First(&current, "id = ?", inputID).Error; err != nil {
			return err
		}
		if current.ConsumedAt != nil {
			if current.ConsumedEventID == sdkEventID {
				return nil
			}
			return errSuperConflict
		}
		if current.AssignmentID != input.AssignmentID || current.RootTurnID != input.RootTurnID {
			return errSuperConflict
		}
		return tx.Model(&superInboxRow{}).Where("id = ? AND consumed_at IS NULL", inputID).Updates(map[string]any{"consumed_at": time.Now().UTC(), "consumed_event_id": sdkEventID}).Error
	})
}
