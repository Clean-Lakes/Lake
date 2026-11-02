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
			if !workTerminal(row.Status) {
				return errors.New("superagent: active legacy work must drain before cutover")
			}
			var g WorkGoal
			if err := decodeWorkGoal(row, &g); err != nil {
				return err
			}
			if g.closure != nil && g.closure.ProjectID != projectID {
				return errSuperBinding
			}
			alias := superLegacyAliasRow{Kind: "work", LegacyID: g.ID, SessionID: g.SessionID, ProjectID: projectID, CanonicalID: g.ID, RequestHash: hash(row.Data), CreatedAt: time.Now().UTC()}
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

type SuperWorkerView struct {
	ID              string        `json:"id"`
	RoleID          string        `json:"roleId"`
	RoleName        string        `json:"roleName"`
	SessionID       string        `json:"sessionId"`
	Task            SuperTaskView `json:"task"`
	AssignmentState string        `json:"assignmentState"`
	ParentWorkerID  string        `json:"parentWorkerId,omitempty"`
}

func (e *Engine) SuperWorkers(ctx context.Context, projectID string) ([]SuperWorkerView, error) {
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	out := []SuperWorkerView{}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var workers []superWorkerRow
		if err := tx.Where("project_id = ?", projectID).Order("created_at DESC, id").Limit(100).Find(&workers).Error; err != nil {
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
			}
			out = append(out, SuperWorkerView{ID: w.ID, RoleID: w.RoleID, RoleName: role.Name, SessionID: w.SessionID, Task: task, AssignmentState: assignment.State, ParentWorkerID: w.ParentWorkerID})
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
