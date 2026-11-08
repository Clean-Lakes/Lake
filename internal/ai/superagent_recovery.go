package ai

import (
	"context"
	"time"

	"gorm.io/gorm"
)

type SuperRecoveryResult struct {
	fencedGeneration int64
	WorkerID         string `json:"workerId"`
	State            string `json:"state"`
	Reason           string `json:"reason"`
}

// RecoverSuperagent fences expired invocation owners; it never replays tools or
// repairs a lost process handle with a fresh command. Original work observers
// retain their own handle/checkpoint and Security recovery gate.
func (e *Engine) RecoverSuperagent(ctx context.Context, projectID string) ([]SuperRecoveryResult, error) {
	if err := e.reconcileDeletedSpecialists(ctx, projectID); err != nil {
		return nil, err
	}
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	var results []SuperRecoveryResult
	now := time.Now().UTC()
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var rows []superAssignmentRow
		if err := tx.Where("project_id = ? AND state IN ? AND lease_until <= ?", projectID, []string{"active", "waiting_user", "waiting_children"}, now).Order("created_at, id").Limit(100).Find(&rows).Error; err != nil {
			return err
		}
		for _, a := range rows {
			var w superWorkerRow
			if err := tx.First(&w, "id = ? AND project_id = ?", a.WorkerID, projectID).Error; err != nil {
				return err
			}
			row, goal, err := loadSuperGoalTx(tx, w)
			if err != nil {
				return err
			}
			state, reason := "parked", "execution_interrupted"
			if w.ParentWorkerID != "" {
				state, reason = "failed", "child_interrupted"
			} else if workTerminal(goal.Status) {
				state, reason = "finished", "canonical_terminal"
			} else if row.WaitCallID != "" && row.Checkpoint != "" {
				state, reason = "waiting_external", "original_checkpoint_only"
			} else if a.Checkpoint != "" {
				state, reason = "queued", "original_human_checkpoint_only"
			} else {
				// Do not repeat a user request merely because its ACK/checkpoint
				// was lost. A new actual input is required after an interruption.
				goal.Status, goal.Summary = "paused", "执行进程中断；已保留原操作与问题，请核对后提供实际后续要求"
				if err = writeWorkGoalTx(tx, &row, &goal, false); err != nil {
					return err
				}
			}
			updates := map[string]any{"state": state, "owner_id": "", "lease_until": time.Time{}, "generation": a.Generation + 1, "last_error": reason}
			if reason == "original_human_checkpoint_only" {
				updates["invocation_kind"] = "human_recovery"
			}
			r := tx.Model(&superAssignmentRow{}).Where("id = ? AND generation = ? AND lease_until <= ?", a.ID, a.Generation, now).Updates(updates)
			if r.Error != nil {
				return r.Error
			}
			if r.RowsAffected != 1 {
				return errSuperConflict
			}
			results = append(results, SuperRecoveryResult{WorkerID: w.ID, State: state, Reason: reason, fencedGeneration: a.Generation})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for _, r := range results {
		var w superWorkerRow
		if db.First(&w, "id = ?", r.WorkerID).Error == nil {
			e.mu.Lock()
			s := e.sessions[w.SessionID]
			e.mu.Unlock()
			if s != nil {
				s.mu.Lock()
				if token := s.state.Config.superAssignment; s.cancel != nil && token != nil && token.Generation <= r.fencedGeneration {
					s.cancel()
				}
				s.mu.Unlock()
			}
		}
	}
	return results, nil
}
