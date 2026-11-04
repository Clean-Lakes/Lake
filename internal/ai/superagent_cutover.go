package ai

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

type superProjectRow struct {
	ProjectID       string `gorm:"primaryKey"`
	RouterSessionID string `gorm:"uniqueIndex"`
	Version         int
	ActivatedAt     time.Time
}

func (superProjectRow) TableName() string { return "superagent_projects" }

type SuperProject struct {
	ProjectID       string `json:"projectId"`
	RouterSessionID string `json:"routerSessionId"`
	Version         int    `json:"version"`
}

// ActivateSuperProject requires a host inventory of the project's sessions.
// Live legacy work must drain before the new writer is admitted. Historical
// records remain read-only and are never restarted during metadata import.
func (e *Engine) ActivateSuperProject(ctx context.Context, projectID, routerSessionID string, legacySessionIDs []string) (SuperProject, error) {
	out := SuperProject{ProjectID: projectID, RouterSessionID: routerSessionID, Version: 1}
	if projectID == "" || !identifier.MatchString(routerSessionID) {
		return out, errSuperBinding
	}
	db, err := e.superStore()
	if err != nil {
		return out, err
	}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var prior superProjectRow
		lookup := tx.First(&prior, "project_id = ?", projectID).Error
		if lookup == nil {
			if prior.RouterSessionID != routerSessionID || prior.Version != 1 {
				return errSuperConflict
			}
			return nil
		}
		if !errors.Is(lookup, gorm.ErrRecordNotFound) {
			return lookup
		}
		var goals []nativeWorkGoal
		if len(legacySessionIDs) > 0 {
			if err := tx.Where("session_id IN ?", legacySessionIDs).Find(&goals).Error; err != nil {
				return err
			}
		}
		for _, row := range goals {
			if isSuperArchiveGoal(row.ID) {
				continue
			}
			var prior superLegacyAliasRow
			lookup := tx.First(&prior, "kind = ? AND legacy_id = ?", "work", row.ID).Error
			if lookup != nil && !errors.Is(lookup, gorm.ErrRecordNotFound) {
				return lookup
			}
			if lookup == nil && (prior.ProjectID != projectID || prior.SessionID != row.SessionID || prior.CanonicalID != row.ID || !prior.ReadOnly) {
				return errSuperConflict
			}
			if !workTerminal(row.Status) && !(lookup == nil && row.Status == "paused") {
				return errors.New("superagent: active legacy work must drain before cutover")
			}
			var g WorkGoal
			if err := decodeWorkGoal(row, &g); err != nil {
				return err
			}
			if g.closure != nil && g.closure.ProjectID != projectID {
				return errSuperBinding
			}
			if lookup == nil {
				continue
			}
			alias := superLegacyAliasRow{Kind: "work", LegacyID: g.ID, SessionID: g.SessionID, ProjectID: projectID, CanonicalID: g.ID, RequestHash: hash(js([]any{row.ID, row.SessionID, row.RootTurnID, row.OriginMessageID})), ReadOnly: true, CreatedAt: time.Now().UTC()}
			if err := tx.Create(&alias).Error; err != nil {
				return err
			}
		}
		return tx.Create(&superProjectRow{ProjectID: projectID, RouterSessionID: routerSessionID, Version: 1, ActivatedAt: time.Now().UTC()}).Error
	})
	return out, err
}
func (e *Engine) SuperProject(ctx context.Context, projectID string) (SuperProject, bool, error) {
	db, err := e.superStore()
	if err != nil {
		return SuperProject{}, false, err
	}
	var r superProjectRow
	err = db.WithContext(ctx).First(&r, "project_id = ?", projectID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return SuperProject{}, false, nil
	}
	return SuperProject{ProjectID: r.ProjectID, RouterSessionID: r.RouterSessionID, Version: r.Version}, err == nil, err
}

func (e *Engine) SuperProjects(ctx context.Context) ([]SuperProject, error) {
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	var rows []superProjectRow
	if err = db.WithContext(ctx).Order("project_id").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]SuperProject, 0, len(rows))
	for _, r := range rows {
		out = append(out, SuperProject{ProjectID: r.ProjectID, RouterSessionID: r.RouterSessionID, Version: r.Version})
	}
	return out, nil
}

func (e *Engine) SuperInputWorkers(ctx context.Context, projectID string) ([]string, error) {
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	var ids []string
	routed := db.Model(&superEventRow{}).Select("id").Where("project_id = ? AND disposition = ?", projectID, "routed")
	err = db.WithContext(ctx).Model(&superWorkerRow{}).Where("project_id = ? AND id IN (?)", projectID, db.Model(&superInboxRow{}).Select("worker_id").Where("mode = ? AND consumed_at IS NULL AND delivered_at IS NULL AND event_id IN (?)", "followup", routed)).Order("created_at, id").Limit(100).Pluck("id", &ids).Error
	return ids, err
}

func (e *Engine) ApplySuperStops(ctx context.Context, projectID string) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	var decisions []superDecisionRow
	if err = db.WithContext(ctx).Where("action = ? AND applied_at IS NULL AND task_id IN (?)", "stop", db.Model(&superWorkerRow{}).Select("task_id").Where("project_id = ?", projectID)).Order("at, id").Limit(16).Find(&decisions).Error; err != nil {
		return err
	}
	for _, d := range decisions {
		var w superWorkerRow
		if err = db.WithContext(ctx).First(&w, "task_id = ? AND project_id = ?", d.TaskID, projectID).Error; err != nil {
			return err
		}
		var event superEventRow
		if err = db.WithContext(ctx).First(&event, "id = ? AND project_id = ? AND disposition = ?", d.EventID, projectID, "routed").Error; err != nil {
			continue
		}
		_, goal, err := e.workRow(w.SessionID, w.TaskID)
		if err != nil {
			return err
		}
		if !workTerminal(goal.Status) {
			if err = e.WorkControl(ctx, w.SessionID, w.TaskID, "cancel", goal.Revision); err != nil {
				return err
			}
		}
		if err = db.WithContext(ctx).Model(&superAssignmentRow{}).Where("worker_id IN (?)", db.Model(&superWorkerRow{}).Select("id").Where("task_id = ? AND project_id = ?", w.TaskID, projectID)).Updates(map[string]any{"state": "finished", "owner_id": "", "generation": gorm.Expr("generation + 1"), "lease_until": time.Time{}}).Error; err != nil {
			return err
		}
		if err = db.WithContext(ctx).Model(&superDecisionRow{}).Where("id = ? AND applied_at IS NULL", d.ID).Update("applied_at", time.Now().UTC()).Error; err != nil {
			return err
		}
	}
	return nil
}

type SuperWorkerView struct {
	CreatedAt       time.Time     `json:"createdAt"`
	ID              string        `json:"id"`
	RoleID          string        `json:"roleId"`
	RoleName        string        `json:"roleName"`
	SessionID       string        `json:"sessionId"`
	Task            SuperTaskView `json:"task"`
	AssignmentState string        `json:"assignmentState"`
	ParentWorkerID  string        `json:"parentWorkerId,omitempty"`
}

func (e *Engine) SuperWorkerForSession(ctx context.Context, projectID, sessionID string) (SuperRouteResult, error) {
	db, err := e.superStore()
	if err != nil {
		return SuperRouteResult{}, err
	}
	var w superWorkerRow
	if err = db.WithContext(ctx).First(&w, "session_id = ? AND project_id = ?", sessionID, projectID).Error; err != nil {
		return SuperRouteResult{}, err
	}
	return SuperRouteResult{TaskID: w.TaskID, WorkerID: w.ID, SessionID: w.SessionID, RoleID: w.RoleID, Protocol: w.Protocol}, nil
}

func (e *Engine) SuperWorkerOrigin(ctx context.Context, projectID, workerID string) (SuperEvent, error) {
	db, err := e.superStore()
	if err != nil {
		return SuperEvent{}, err
	}
	w, err := superWorkerInProject(db.WithContext(ctx), workerID, projectID)
	if err != nil {
		return SuperEvent{}, err
	}
	var event superEventRow
	if err = db.WithContext(ctx).First(&event, "id = ? AND project_id = ?", w.SourceEventID, projectID).Error; err != nil {
		return SuperEvent{}, err
	}
	return event.event(), nil
}

func (e *Engine) SuperWorkerEventIDs(ctx context.Context, projectID, sessionID string) ([]string, error) {
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	var w superWorkerRow
	if err = db.WithContext(ctx).First(&w, "session_id = ? AND project_id = ?", sessionID, projectID).Error; err != nil {
		return nil, err
	}
	var ids []string
	if err = db.WithContext(ctx).Model(&superInboxRow{}).Distinct("event_id").Where("worker_id = ? AND mode = ?", w.ID, "followup").Pluck("event_id", &ids).Error; err != nil {
		return nil, err
	}
	if w.SourceEventID != "" {
		ids = append(ids, w.SourceEventID)
	}
	return ids, nil
}

func (e *Engine) SuperWorkers(ctx context.Context, projectID string) ([]SuperWorkerView, error) {
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	out := []SuperWorkerView{}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var workers []superWorkerRow
		if err := tx.Where("project_id = ? AND parent_worker_id = ''", projectID).Order("created_at DESC, id").Limit(100).Find(&workers).Error; err != nil {
			return err
		}
		for _, w := range workers {
			task, err := projectSuperTaskTx(tx, w.SessionID, w.TaskID)
			if err != nil {
				return err
			}
			task.ProjectID = projectID
			var role superRoleRow
			if err := tx.First(&role, "id = ? AND project_id = ?", w.RoleID, projectID).Error; err != nil {
				return err
			}
			var assignment superAssignmentRow
			if err := tx.First(&assignment, "worker_id = ?", w.ID).Error; err != nil {
				return err
			}
			if assignment.State == "queued" {
				task.State = "queued"
			} else if assignment.State == "waiting_user" && !workTerminal(task.State) {
				task.State = "waiting_user"
			}
			out = append(out, SuperWorkerView{ID: w.ID, CreatedAt: w.CreatedAt, RoleID: w.RoleID, RoleName: role.Name, SessionID: w.SessionID, Task: task, AssignmentState: assignment.State, ParentWorkerID: w.ParentWorkerID})
		}
		return nil
	})
	return out, err
}

func (e *Engine) SuperWorkerSource(ctx context.Context, projectID, sessionID, sourceMessageID string) (SuperEvent, error) {
	db, err := e.superStore()
	if err != nil {
		return SuperEvent{}, err
	}
	var w superWorkerRow
	if err = db.WithContext(ctx).First(&w, "session_id = ? AND project_id = ?", sessionID, projectID).Error; err != nil {
		return SuperEvent{}, err
	}
	var event superEventRow
	if err = db.WithContext(ctx).First(&event, "id = ? AND project_id = ? AND source_event_id = ?", w.SourceEventID, projectID, sourceMessageID).Error; err == nil {
		return event.event(), nil
	}
	var input superInboxRow
	if err = db.WithContext(ctx).First(&input, "worker_id = ? AND source_message_id = ? AND mode = ?", w.ID, sourceMessageID, "followup").Error; err != nil {
		return SuperEvent{}, err
	}
	if err = db.WithContext(ctx).First(&event, "id = ? AND project_id = ?", input.EventID, projectID).Error; err != nil {
		return SuperEvent{}, err
	}
	return event.event(), nil
}
