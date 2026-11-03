package ai

import (
	"context"
	"errors"

	"gorm.io/gorm"
)

// StopSpecialistChannel is a host-only stop, never a model tool. Stop admission
// first so an in-flight Router cannot recreate work after the user stops it.
func (e *Engine) StopSpecialistChannel(ctx context.Context, project, sessionID string) error {
	ch, err := e.SpecialistChannelForSession(ctx, project, sessionID)
	if err != nil {
		return err
	}
	db, err := e.superStore()
	if err != nil {
		return err
	}
	var workers []superWorkerRow
	stopped := map[string]bool{}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var events []superEventRow
		pendingInbox := tx.Model(&superInboxRow{}).Select("event_id").Where("mode = ? AND delivered_at IS NULL AND consumed_at IS NULL", "followup")
		if err := tx.Where("project_id = ? AND id IN (?)", project, tx.Model(&superChannelSourceRow{}).Select("event_id").Where("channel_id = ?", ch.ID)).Where("disposition IN ? OR (disposition = ? AND id IN (?))", []string{"pending", "staged"}, "routed", pendingInbox).Find(&events).Error; err != nil {
			return err
		}
		for _, event := range events {
			if err := tx.Model(&superEventRow{}).Where("id = ?", event.ID).Update("disposition", "cancelled").Error; err != nil {
				return err
			}
			stopped[event.ID] = true
		}
		return tx.Where("project_id = ? AND role_id = ? AND parent_worker_id = '' AND id IN (?)", project, ch.RoleID, tx.Model(&superAssignmentRow{}).Select("worker_id").Where("state IN ? OR checkpoint <> ''", []string{"active", "queued", "waiting_user"})).Find(&workers).Error
	})
	if err != nil {
		return err
	}
	// Abort a Router request only when every admitted source was stopped. Other
	// role channels in the same project must keep their own provider request.
	if domain, ok, loadErr := e.SuperProject(ctx, project); loadErr == nil && ok {
		if s, loadErr := e.get(domain.RouterSessionID); loadErr == nil {
			s.mu.Lock()
			run := s.state.Config.superRouter
			if run != nil && len(run.events) > 0 {
				all := true
				for id := range run.events {
					if !stopped[id] {
						all = false
					}
				}
				if all && s.cancel != nil {
					s.cancel()
				}
			}
			s.mu.Unlock()
		}
	}
	for _, worker := range workers {
		// A concurrent completion wins. A concurrent progress update is retried
		// with its real revision; no limits, permissions or outcomes are reset.
		for attempt := 0; attempt < 3; attempt++ {
			view, err := e.SuperTask(worker.SessionID, worker.TaskID)
			if err != nil {
				return err
			}
			if workTerminal(view.State) {
				break
			}
			err = e.WorkControl(ctx, worker.SessionID, worker.TaskID, "cancel", view.Revision)
			if err == nil {
				break
			}
			if !errors.Is(err, errWorkConflict) || attempt == 2 {
				return err
			}
		}
	}
	return nil
}

// Pending interactions can belong to an older task outside the recent list.
func (e *Engine) SuperInteractionSessions(ctx context.Context, project string) ([]string, error) {
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	var ids []string
	err = db.WithContext(ctx).Table("superagent_workers w").Select("w.session_id").Joins("JOIN superagent_assignments a ON a.worker_id=w.id").Where("w.project_id = ? AND w.parent_worker_id = '' AND (a.state IN ? OR a.checkpoint <> '')", project, []string{"waiting_user", "active"}).Scan(&ids).Error
	return ids, err
}
