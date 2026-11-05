package ai

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"
)

func checkSuperWorkflowTx(tx *gorm.DB, w superWorkerRow, now time.Time) error {
	if w.Protocol != "workflow" {
		return nil
	}
	var run securityWorkflowRunRow
	if err := tx.First(&run, "goal_id = ? AND session_id = ? AND project_id = ? AND state IN ?", w.TaskID, w.SessionID, w.ProjectID, []string{"prepared", "running"}).Error; err != nil {
		return err
	}
	definition, err := LoadSecurityWorkflowDefinitionTx(tx, run.StoreID, run.RecoveryEpoch, run.ProjectID, run.WorkflowID, run.TemplateVersion, run.TemplateDigest)
	if err != nil {
		return err
	}
	if definition.Revision != run.DefinitionRevision {
		return errSuperConflict
	}
	if _, err := verifySecurityTaskTx(tx, run.TaskID, run.SessionID, run.GoalID, run.RootTurnID, now); err != nil {
		return err
	}
	return ValidateSecurityScheduleTaskSource(tx, run.TaskID, run.StoreID, run.RecoveryEpoch, now)
}

// The occurrence/action has already created its canonical goal, task, frozen
// definition and scoped authority. Register identity only; never ask the Router
// to reinterpret a schedule as a new human request or create a second goal.
func (e *Engine) RegisterSuperWorkflow(ctx context.Context, binding SecurityWorkflowRunBinding) (SuperRouteResult, error) {
	var out SuperRouteResult
	db, err := e.superStore()
	if err != nil {
		return out, err
	}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var domain superProjectRow
		if err := tx.First(&domain, "project_id = ?", binding.ProjectID).Error; err != nil {
			return err
		}
		var actual securityWorkflowRunRow
		if err := tx.First(&actual, "run_id = ? AND project_id = ? AND session_id = ? AND goal_id = ?", binding.RunID, binding.ProjectID, binding.SessionID, binding.GoalID).Error; err != nil {
			return err
		}
		var original SecurityWorkflowRunBinding
		if err := json.Unmarshal([]byte(actual.Data), &original); err != nil {
			return err
		}
		if js(original) != js(binding) || (actual.State != "prepared" && actual.State != "running") {
			return errSuperConflict
		}
		if _, err := verifySecurityTaskTx(tx, binding.Task.ID, binding.SessionID, binding.GoalID, binding.RootTurnID, time.Now().UTC()); err != nil {
			return err
		}
		if err := ValidateSecurityScheduleTaskSource(tx, binding.Task.ID, binding.Task.StoreID, binding.Task.RecoveryEpoch, time.Now().UTC()); err != nil {
			return err
		}
		var goal nativeWorkGoal
		if err := tx.First(&goal, "id = ? AND session_id = ?", binding.GoalID, binding.SessionID).Error; err != nil {
			return err
		}
		kind := "workflow"
		if binding.SourceKind == "schedule_occurrence" {
			kind = "schedule"
		}
		source := superSourceRow{ID: hash(js([]any{"workflow-source", binding.ProjectID, binding.WorkflowID, binding.DefinitionRevision})), ProjectID: binding.ProjectID, Kind: kind, ActorRef: "host-workflow-runtime", Revision: hash(js([]any{binding.TemplateDigest, binding.DefinitionRevision})), Enabled: true}
		var priorSource superSourceRow
		if lookup := tx.First(&priorSource, "id = ?", source.ID).Error; errors.Is(lookup, gorm.ErrRecordNotFound) {
			if err := tx.Create(&source).Error; err != nil {
				return err
			}
		} else if lookup != nil {
			return lookup
		} else if !superSourceMatches(priorSource, SuperSourceBinding{SourceID: source.ID, ProjectID: source.ProjectID, Kind: source.Kind, ActorRef: source.ActorRef, Revision: source.Revision}) {
			return errSuperConflict
		}
		eventID := hash(js([]any{"workflow-event", binding.RunID}))
		var priorEvent superEventRow
		if lookup := tx.First(&priorEvent, "id = ?", eventID).Error; errors.Is(lookup, gorm.ErrRecordNotFound) {
			payload := js(map[string]any{"workflowRunId": binding.RunID, "sourceKind": binding.SourceKind, "sourceEventId": binding.SourceEventID, "templateDigest": binding.TemplateDigest})
			if err := tx.Create(&superEventRow{ID: eventID, SourceID: source.ID, SourceKind: kind, SourceEventID: binding.RunID, ProjectID: binding.ProjectID, SourceRevision: source.Revision, ActorRef: source.ActorRef, ThreadRef: binding.SourceEventID, Kind: "workflow_occurrence", Payload: payload, PayloadHash: hash(payload), Disposition: "routed", ReceivedAt: time.Now().UTC()}).Error; err != nil {
				return err
			}
		} else if lookup != nil {
			return lookup
		} else if priorEvent.ProjectID != binding.ProjectID || priorEvent.SourceID != source.ID {
			return errSuperConflict
		}
		workerID := "workflow_" + hash(binding.RunID)[:32]
		var prior superWorkerRow
		if lookup := tx.First(&prior, "id = ?", workerID).Error; lookup == nil {
			if prior.TaskID != binding.GoalID || prior.SessionID != binding.SessionID || prior.Protocol != "workflow" {
				return errSuperConflict
			}
			out = SuperRouteResult{TaskID: prior.TaskID, WorkerID: prior.ID, SessionID: prior.SessionID}
			return nil
		} else if !errors.Is(lookup, gorm.ErrRecordNotFound) {
			return lookup
		}
		roleID := hash(js([]any{binding.ProjectID, "saved-workflow"}))
		var role superRoleRow
		if lookup := tx.First(&role, "id = ?", roleID).Error; errors.Is(lookup, gorm.ErrRecordNotFound) {
			if err := tx.Create(&superRoleRow{ID: roleID, ProjectID: binding.ProjectID, RoleKey: "workflow", Name: "工作流专员", Revision: 1}).Error; err != nil {
				return err
			}
		} else if lookup != nil {
			return lookup
		}
		if err := checkSuperRoleAvailableTx(tx, binding.ProjectID, roleID); err != nil {
			return err
		}
		w := superWorkerRow{ID: workerID, TaskID: binding.GoalID, ProjectID: binding.ProjectID, SessionID: binding.SessionID, RoleID: roleID, Protocol: "workflow", SourceEventID: eventID, OriginRootTurnID: binding.RootTurnID, Revision: 1, CreatedAt: time.Now().UTC()}
		if _, err := ensureSuperChannelTx(tx, binding.ProjectID, roleID, w.CreatedAt); err != nil {
			return err
		}
		if err := tx.Create(&w).Error; err != nil {
			return err
		}
		if err := tx.Create(&superAssignmentRow{ID: "assignment_" + workerID, WorkerID: workerID, ProjectID: binding.ProjectID, State: "queued", InvocationKind: "workflow", CreatedAt: w.CreatedAt}).Error; err != nil {
			return err
		}
		out = SuperRouteResult{TaskID: w.TaskID, WorkerID: w.ID, SessionID: w.SessionID}
		return nil
	})
	return out, err
}

// The same invocation admission/lease/budget as interactive work, with the
// original official ADK graph as the callback. No model or graph scheduler here.
func (e *Engine) RunTaskInvestigation(ctx context.Context, projectID, workerID string, run func(context.Context) error) error {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		token, err := e.AcquireWorkerSlot(ctx, projectID, workerID)
		if err == nil {
			invocation, release := e.beginSuperInvocation(ctx, token)
			defer release()
			if err := run(invocation); err != nil {
				return err
			}
			db, err := e.superStore()
			if err != nil {
				return err
			}
			w, err := superWorkerInProject(db, workerID, projectID)
			if err != nil {
				return err
			}
			_, goal, err := loadSuperGoalTx(db, w)
			if err != nil {
				return err
			}
			if goal.closure != nil && !workTerminal(goal.Status) && goal.Status != "paused" {
				_, err = e.verifyWorkGoal(invocation, w.goalSession(), goal.ID, goal.Revision)
			}
			return err
		}
		if !errors.Is(err, ErrSuperWorkerQueued) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
