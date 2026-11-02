package ai

import (
	"context"
	"time"

	"gorm.io/gorm"
)

// Deterministic supervision changes dispatch eligibility, never authority or
// acceptance. A normal external/human wait is not a stalled model invocation.
func (e *Engine) CheckSuperagentProgress(ctx context.Context, projectID string) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	if err = e.reconcileSuperBudgetPauses(ctx, projectID); err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&superEventRow{}).Where("project_id = ? AND disposition = ? AND routing_attempts >= ? AND retry_at <= ?", projectID, "pending", 3, time.Now().UTC()).Update("disposition", "blocked").Error; err != nil {
			return err
		}
		var blocked []superEventRow
		if err := tx.Where("project_id = ? AND disposition = ?", projectID, "blocked").Limit(100).Find(&blocked).Error; err != nil {
			return err
		}
		for _, event := range blocked {
			var domain superProjectRow
			if err := tx.First(&domain, "project_id = ?", projectID).Error; err != nil {
				return err
			}
			id := hash(js([]any{"router-failure", event.ID}))
			var count int64
			if err := tx.Model(&superOutputRow{}).Where("id = ?", id).Count(&count).Error; err != nil {
				return err
			}
			if count == 0 {
				payload := js(map[string]any{"text": "Pilot 处理一条消息连续失败，原始要求已保留。请检查模型配置，或提供新的要求；尚未派发的工作没有自动执行。"})
				if err := tx.Create(&superOutputRow{ID: id, ProjectID: projectID, ChannelRef: domain.RouterSessionID, SourceMessageID: event.SourceEventID, Kind: "router_reply", Payload: payload, RequestHash: hash(payload), ReportRevision: 1, State: "pending", CreatedAt: time.Now().UTC()}).Error; err != nil {
					return err
				}
			}
		}
		var children []superWorkerRow
		if err := tx.Where("project_id = ? AND parent_worker_id <> ''", projectID).Find(&children).Error; err != nil {
			return err
		}
		for _, child := range children {
			var parent int64
			if err := tx.Model(&superAssignmentRow{}).Where("worker_id = ? AND generation = ? AND state = ? AND lease_until > ?", child.ParentWorkerID, child.ParentGeneration, "waiting_children", time.Now().UTC()).Count(&parent).Error; err != nil {
				return err
			}
			if parent == 0 {
				if err := tx.Model(&superAssignmentRow{}).Where("worker_id = ? AND state IN ?", child.ID, []string{"graph", "queued"}).Updates(map[string]any{"state": "failed", "last_error": "parent_invocation_ended"}).Error; err != nil {
					return err
				}
			}
		}
		var rows []superAssignmentRow
		if err := tx.Where("project_id = ? AND state = ?", projectID, "queued").Limit(100).Find(&rows).Error; err != nil {
			return err
		}
		for _, a := range rows {
			var w superWorkerRow
			if err := tx.First(&w, "id = ?", a.WorkerID).Error; err != nil {
				return err
			}
			row, goal, err := loadSuperGoalTx(tx, w)
			if err != nil {
				return err
			}
			reason := ""
			state := "parked"
			if err := checkSuperWorkflowTx(tx, w, time.Now().UTC()); err != nil {
				reason = "workflow_authority_unavailable"
			}
			if w.SourceEventID != "" {
				var event superEventRow
				if err := tx.First(&event, "id = ?", w.SourceEventID).Error; err != nil {
					return err
				}
				if _, err := superSourceForEvent(tx, event.ID, projectID); err != nil {
					reason = "source_unavailable"
				} else if event.Disposition == "blocked" {
					reason = "routing_failed"
				}
			}
			if workTerminal(goal.Status) {
				state, reason = "finished", "canonical_terminal"
			} else if !goal.DeadlineAt.After(time.Now().UTC()) {
				reason = "deadline_exhausted"
			} else if goal.ModelRounds >= goal.RoundLimit {
				reason = "budget_exhausted"
			} else if a.FailureCount >= 3 {
				reason = "dispatch_failed"
			}
			paused, err := superBudgetPausedTx(tx, goal.ID, goal.RoundLimit)
			if err != nil {
				return err
			}
			if paused && !workTerminal(goal.Status) {
				if err := pauseSuperBudgetTx(tx, w, &row, &goal); err != nil {
					return err
				}
				reason = superBudgetPauseReason
			}
			if reason == "" {
				continue
			}
			if !workTerminal(goal.Status) && reason != superBudgetPauseReason {
				goal.Status, goal.Summary = "paused", "任务派发已暂停："+reason+"；原操作未重放"
				if err := writeWorkGoalTx(tx, &row, &goal, false); err != nil {
					return err
				}
			}
			if err := tx.Model(&superAssignmentRow{}).Where("id = ? AND state = ? AND generation = ?", a.ID, "queued", a.Generation).Updates(map[string]any{"state": state, "last_error": reason}).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func (e *Engine) RecordSuperDispatchFailure(ctx context.Context, projectID, workerID string) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Model(&superAssignmentRow{}).Where("project_id = ? AND worker_id = ? AND state = ?", projectID, workerID, "queued").Updates(map[string]any{"failure_count": gorm.Expr("failure_count + 1"), "last_error": "dispatch_failed"}).Error
}
