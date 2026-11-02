package ai

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

// SRE observation roles are bounded task extensions, not another task/result
// authority. Registration reserves the lifetime instance count before any model
// runs. The official ADK graph below owns dependencies, fan-out and fan-in.
func (e *Engine) reserveSuperChildren(ctx context.Context, workers []*agentWorker) error {
	token, ok := ctx.Value(superAssignmentContextKey{}).(SuperAssignmentToken)
	if !ok {
		return errSuperBinding
	}
	db, err := e.superStore()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := checkSuperAssignmentTx(tx, token); err != nil {
			return err
		}
		var parent superWorkerRow
		if err := tx.First(&parent, "id = ?", token.WorkerID).Error; err != nil {
			return err
		}
		if parent.ParentWorkerID != "" {
			return errors.New("superagent: child delegation depth exceeded")
		}
		var count int64
		if err := tx.Model(&superWorkerRow{}).Where("task_id = ?", parent.TaskID).Count(&count).Error; err != nil {
			return err
		}
		if count+int64(len(workers)) > 8 {
			return errors.New("superagent: task lifetime Worker instance limit is eight, including retries")
		}
		for _, w := range workers {
			roleID := hash(js([]any{parent.ProjectID, "child", w.role}))
			var role superRoleRow
			err := tx.First(&role, "id = ?", roleID).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				role = superRoleRow{ID: roleID, ProjectID: parent.ProjectID, RoleKey: w.role, Name: agentNames[w.role], Revision: 1}
				if err = tx.Create(&role).Error; err != nil {
					return err
				}
			} else if err != nil {
				return err
			}
			child := superWorkerRow{ID: w.runID, SessionID: w.runID, GoalSessionID: parent.goalSession(), TaskID: parent.TaskID, ProjectID: parent.ProjectID, ParentWorkerID: parent.ID, RoleID: roleID, ScopeID: w.runID, SourceEventID: parent.SourceEventID, OriginRootTurnID: parent.OriginRootTurnID, Revision: 1, CreatedAt: time.Now().UTC(), ConversationMode: parent.ConversationMode}
			child.ParentGeneration = token.Generation
			if err := tx.Create(&child).Error; err != nil {
				return err
			}
			if err := tx.Create(&superAssignmentRow{ID: "assignment_" + w.runID, WorkerID: child.ID, ProjectID: parent.ProjectID, State: "graph", InvocationKind: "child", CreatedAt: child.CreatedAt}).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func (e *Engine) claimSuperChild(ctx context.Context, workerID string) (context.Context, func(), error) {
	db, err := e.superStore()
	if err != nil {
		return ctx, nil, err
	}
	var w superWorkerRow
	if err = db.WithContext(ctx).First(&w, "id = ? AND parent_worker_id <> ''", workerID).Error; err != nil {
		return ctx, nil, err
	}
	if err = db.WithContext(ctx).Model(&superAssignmentRow{}).Where("worker_id = ? AND state = ?", workerID, "graph").Update("state", "queued").Error; err != nil {
		return ctx, nil, err
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		token, err := e.AcquireWorkerSlot(ctx, w.ProjectID, w.ID)
		if err == nil {
			run, release := e.beginSuperInvocation(ctx, token)
			return run, release, nil
		}
		if !errors.Is(err, ErrSuperWorkerQueued) {
			return ctx, nil, err
		}
		select {
		case <-ctx.Done():
			return ctx, nil, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (e *Engine) runInvestigationGraph(ctx context.Context, workers []*agentWorker, specs []investigationSpec, question string) error {
	plan := SREPlanRevision{Goal: question}
	lookup := map[string]int{}
	for i, w := range workers {
		step := SREPlanStep{ID: w.runID, Role: SREAgentRole(w.runID), Kind: "observe", Description: specs[i].Task}
		if w.role == "verify" {
			for _, other := range workers {
				if other.role != "verify" {
					step.DependsOn = append(step.DependsOn, other.runID)
				}
			}
		}
		plan.Steps = append(plan.Steps, step)
		lookup[w.runID] = i
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	return executeADKPlan(ctx, plan, func(actx context.Context, step SREPlanStep) error {
		i := lookup[step.ID]
		workers[i].run(actx, specs[i], question)
		return actx.Err()
	}, adkPlanSession{service: store.Sessions, id: "investigation_" + hash(js(plan))[:32]})
}

func (e *Engine) cleanupInvestigationGraph(workers []*agentWorker) {
	for _, w := range workers {
		select {
		case <-w.done:
			continue
		default:
		}
		w.cancel()
		w.child.Shutdown()
		_ = e.updateAgent(w, func(r *AgentRun) {
			r.Status = "cancelled"
			r.CanCancel = false
			r.Pending = nil
			r.FinishedAt = timestamp()
			r.Summary = "图执行中断，子任务未开始；原证据保留"
		})
		e.agentMu.Lock()
		delete(e.agentWorkers, w.runID)
		e.agentMu.Unlock()
		close(w.done)
	}
	if e.superInitialized.Load() {
		if db, err := e.superStore(); err == nil {
			for _, w := range workers {
				_ = db.Model(&superAssignmentRow{}).Where("worker_id = ? AND state IN ?", w.runID, []string{"graph", "queued"}).Updates(map[string]any{"state": "failed", "last_error": "graph_interrupted"}).Error
			}
		}
	}
}
