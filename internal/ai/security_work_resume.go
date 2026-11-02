package ai

import (
	"context"
	"errors"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// A one-way delivery binding for an actual original-operation observation.
// It is neither a second operation ledger nor a new user-message authority.
type securityWorkResumeRow struct {
	ObservationID                                                                                                            string `gorm:"primaryKey"`
	StoreID, RecoveryEpoch, ProjectID, SessionID, GoalID, TaskID, StepID, AttemptID, OperationID, RootTurnID, OwnerBindingID string
	At                                                                                                                       time.Time
}

func (securityWorkResumeRow) TableName() string { return "security_work_resumes" }

func (e *Engine) observeSecurityWork(ctx context.Context, g WorkGoal, w *ExternalWatch, c Config) (string, error) {
	if w.Adapter != "shell-v1" {
		return "", errors.New("security: this external observer needs a registered current read profile and permit; no automatic external I/O")
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return "", err
	}
	_ = e.completeManagedShellOperation(w.OperationID)
	var op nativeOperation
	if err = db.First(&op, "id = ? AND session_id = ? AND goal_id = ? AND store_id = ? AND recovery_epoch = ?", w.OperationID, g.SessionID, g.ID, storeID, epoch).Error; err != nil {
		return "", err
	}
	if op.Tool != "shell" || op.OwnerKind != "agent" || op.Handle != w.Handle || op.SecurityTaskID == "" || op.AttemptID == "" || op.StepID == "" || op.OrphanState != "" && op.RiskResolvedAt == nil {
		return "", errors.New("security: original observed operation binding or effects unresolved")
	}
	var task securityTaskRow
	if err = db.First(&task, "id = ? AND session_id = ? AND goal_id = ?", op.SecurityTaskID, g.SessionID, g.ID).Error; err != nil {
		return "", err
	}
	if task.StoreID != storeID || task.RecoveryEpoch != epoch || task.BackgroundPolicy != "monitored_background" || !task.ExpiresAt.After(time.Now().UTC()) || task.State != security.TaskIdle && task.State != security.TaskActive {
		return "", errors.New("security: original background task is not currently authorized")
	}
	if valid, err := runningOperationAuthorityValid(db, op, time.Now().UTC()); err != nil || !valid {
		return "", errors.New("security: original background authority expired or changed")
	}
	if op.Status == "dispatched" || op.Status == "unknown" {
		if valid, err := operationHasValidMonitor(db, op, time.Now().UTC()); err != nil || !valid {
			return "", errors.New("security: original execution monitor unavailable")
		}
		return e.recordWorkObservation(g, w, c, "running", objJSON(op.Result))
	}
	state := "failed"
	if op.Status == "succeeded" {
		state = "completed"
	} else if op.Status != "failed" && op.Status != "not_executed" {
		return "", errors.New("security: original command outcome remains unknown")
	}
	return e.recordWorkObservation(g, w, c, state, objJSON(op.Result))
}

// claimSecurityWorkResume admits exactly one machine continuation for an
// original terminal observation, under the existing task's absolute deadline.
func (e *Engine) claimSecurityWorkResume(ctx context.Context, g WorkGoal) (out SecurityExecutionContext, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var goalRow nativeWorkGoal
			if err := tx.First(&goalRow, "id = ? AND session_id = ?", g.ID, g.SessionID).Error; err != nil {
				return err
			}
			var goal WorkGoal
			if err := decodeWorkGoal(goalRow, &goal); err != nil {
				return err
			}
			if goal.closure == nil || goal.Status != "running" {
				return errors.New("security: active canonical goal required for continuation")
			}
			var observation nativeWorkObservation
			var op nativeOperation
			found := false
			for _, item := range goal.Items {
				if item.Watch == nil || item.Watch.EvidenceID == "" || item.Watch.State == "running" {
					continue
				}
				if err := tx.First(&observation, "id = ? AND goal_id = ? AND session_id = ? AND operation_id = ? AND status IN ?", item.Watch.EvidenceID, goal.ID, goal.SessionID, item.Watch.OperationID, []string{"completed", "failed"}).Error; err != nil {
					return err
				}
				var count int64
				if err := tx.Model(&securityWorkResumeRow{}).Where("observation_id = ?", observation.ID).Count(&count).Error; err != nil {
					return err
				}
				if count != 0 {
					continue
				}
				if err := tx.First(&op, "id = ? AND goal_id = ? AND session_id = ?", observation.OperationID, goal.ID, goal.SessionID).Error; err != nil {
					return err
				}
				if observation.Adapter != "shell-v1" || item.Watch.Adapter != observation.Adapter || op.Tool != "shell" || op.OwnerKind != "agent" || op.Handle != item.Watch.Handle || observation.At.IsZero() || observation.At.Before(op.StartedAt) || observation.Status == "completed" && op.Status != "succeeded" || observation.Status == "failed" && op.Status != "failed" && op.Status != "not_executed" {
					return security.ErrConflict
				}
				found = true
				break
			}
			if !found {
				return errors.New("security: no new trusted original-operation event to resume")
			}
			step, stepExists := goal.closure.Steps[op.StepID]
			if !stepExists || step.Revision != op.StepRevision || goal.closure.ActiveAttempts[op.StepID] != op.AttemptID || op.StoreID != storeID || op.RecoveryEpoch != epoch || op.GoalRevision != goal.closure.GoalRevision || op.PlanRevision != goal.closure.PlanRevision || op.OrphanState != "" && op.RiskResolvedAt == nil || op.Status != "succeeded" && op.Status != "failed" && op.Status != "not_executed" {
				return security.ErrConflict
			}
			var task securityTaskRow
			if err := tx.First(&task, "id = ? AND goal_id = ? AND session_id = ?", op.SecurityTaskID, goal.ID, goal.SessionID).Error; err != nil {
				return err
			}
			now := time.Now().UTC()
			if task.StoreID != storeID || task.RecoveryEpoch != epoch || task.BackgroundPolicy != "monitored_background" || task.State != security.TaskIdle || !task.ExpiresAt.After(now) {
				return errors.New("security: original task cannot automatically resume; human continuation required")
			}
			if valid, err := runningOperationAuthorityValid(tx, op, now); err != nil || !valid {
				return errors.New("security: original continuation authority expired or changed")
			}
			active, err := transitionSecurityTask(tx, storeID, epoch, SecurityTaskAction{ActorID: "runtime", ActionID: "work-resume:" + observation.ID, ProjectID: task.ProjectID, SessionID: task.SessionID, GoalID: task.GoalID, TaskID: task.ID, ExpectedRevision: task.StateRevision, Reason: "trusted original-operation observation"}, security.TaskActive, now)
			if err != nil {
				return err
			}
			root := "work_resume_" + hash(observation.ID)[:32]
			binding, err := bindSecurityTaskTurn(tx, task.ID, storeID, epoch, root, "", active.ExecutionRevision, now)
			if err != nil {
				return err
			}
			owner, err := acquireExecutionOwner(tx, binding.ID, uid(), "agent", binding.OwnerGeneration, now)
			if err != nil {
				return err
			}
			row := securityWorkResumeRow{ObservationID: observation.ID, StoreID: storeID, RecoveryEpoch: epoch, ProjectID: task.ProjectID, SessionID: task.SessionID, GoalID: task.GoalID, TaskID: task.ID, StepID: op.StepID, AttemptID: op.AttemptID, OperationID: op.ID, RootTurnID: root, OwnerBindingID: owner.BindingID, At: now}
			if err = tx.Create(&row).Error; err != nil {
				return err
			}
			out = SecurityExecutionContext{Managed: true, ProjectID: task.ProjectID, SessionID: task.SessionID, GoalID: task.GoalID, SourceMessageID: task.SourceMessageID, Task: active, Owner: owner}
			return nil
		})
	})
	if err == nil {
		manager := e.securityOwnerEngine()
		if manager == nil {
			return out, errors.New("security: runtime owner unavailable")
		}
		manager.securityOwners.Store(out.Owner.BindingID, &liveSecurityOwner{owner: out.Owner})
		manager.startSecurityLifecycle()
	}
	return out, err
}
