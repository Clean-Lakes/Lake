package ai

import (
	"context"
	"encoding/json"
	"gorm.io/gorm"
)

// BuildTaskAssignment maps the existing immutable assignment identity. It is
// read-only metadata, not a new assignment token or a resource capability.
func (e *Engine) BuildTaskAssignment(ctx context.Context, sessionID, taskID string) (TaskAssignmentV1, error) {
	var out TaskAssignmentV1
	c, err := e.superReadConfig(sessionID)
	if err != nil {
		return out, err
	}
	if c.superRole == "worker" && c.superTaskID != taskID {
		return out, errSuperBinding
	}
	db, err := e.superStore()
	if err != nil {
		return out, err
	}
	var w superWorkerRow
	if err = db.WithContext(ctx).Where("task_id = ? AND project_id = ? AND parent_worker_id = ''", taskID, configSecurityProject(c)).First(&w).Error; err != nil {
		return out, err
	}
	var role SpecialistRole
	if err = json.Unmarshal([]byte(w.RoleSnapshot), &role); err != nil {
		return out, err
	}
	if role.ID != w.RoleID || role.ProjectID != w.ProjectID {
		return out, errSuperBinding
	}
	page, err := e.readSuperObject(ctx, sessionID, "event", w.SourceEventID, 1, 0, 16384, "", false)
	if err != nil {
		return out, err
	}
	out = TaskAssignmentV1{Version: ContextProtocolV1, ProjectID: w.ProjectID, RoleID: w.RoleID, RoleRevision: role.Revision, TaskID: w.TaskID, WorkerID: w.ID, SessionID: w.SessionID, OriginRootTurnID: w.OriginRootTurnID, OriginalRequirement: ContextRefV1{Kind: "event", ID: page.ID, Revision: page.Revision, Hash: page.Hash}}
	return out, out.Validate()
}

// BuildTaskDigest always reads the canonical goal/acceptance projection. It does
// not persist a second completion state or copy a Worker transcript to Pilot.
func (e *Engine) BuildTaskDigest(ctx context.Context, sessionID, taskID string) (TaskDigestV1, error) {
	var out TaskDigestV1
	c, err := e.superReadConfig(sessionID)
	if err != nil {
		return out, err
	}
	if c.superRole == "worker" && c.superTaskID != taskID {
		return out, errSuperBinding
	}
	db, err := e.superStore()
	if err != nil {
		return out, err
	}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var w superWorkerRow
		if err = tx.Where("task_id = ? AND project_id = ? AND parent_worker_id = ''", taskID, configSecurityProject(c)).First(&w).Error; err != nil {
			return err
		}
		if w.TaskID != taskID {
			return errSuperBinding
		}
		out, err = e.buildTaskDigestTx(tx, w)
		return err
	})
	return out, err
}
func (e *Engine) buildTaskDigestTx(tx *gorm.DB, w superWorkerRow) (TaskDigestV1, error) {
	var out TaskDigestV1
	view, err := projectSuperTaskTx(tx, w.goalSession(), w.TaskID)
	if err != nil {
		return out, err
	}
	_, goal, err := loadSuperGoalTx(tx, w)
	if err != nil {
		return out, err
	}
	view.ProjectID = w.ProjectID
	raw := js(map[string]any{"task": view, "sourceEventId": w.SourceEventID, "originalRequirements": goal.UserText})
	// Apply the existing exact-object credential boundary before shortening
	// any text, including a secret that straddles the digest preview boundary.
	if err := e.checkSuperPayload(raw); err != nil {
		return out, err
	}
	var role SpecialistRole
	if w.RoleSnapshot != "" {
		if err := json.Unmarshal([]byte(w.RoleSnapshot), &role); err != nil {
			return out, err
		}
		if role.ID != w.RoleID || role.ProjectID != w.ProjectID {
			return out, errSuperBinding
		}
	}
	out = TaskDigestV1{Version: ContextProtocolV1, ProjectID: w.ProjectID, RoleID: w.RoleID, RoleRevision: role.Revision, TaskID: w.TaskID, WorkerID: w.ID, SessionID: w.SessionID, CanonicalRevision: view.Revision, ObservedAt: goal.UpdatedAt, State: view.State, AcceptanceState: view.AcceptanceState, Title: utf8Prefix(view.Title, 128), Summary: utf8Prefix(view.Summary, TaskDigestTextBytes), Refs: []ContextRefV1{{Kind: "task", ID: w.TaskID, Revision: view.Revision, Hash: hash(raw)}}}
	if out.ObservedAt.IsZero() {
		out.ObservedAt = w.CreatedAt
	}
	out.Truncated = len(view.Summary) > len(out.Summary) || len(view.Title) > len(out.Title)
	switch view.State {
	case "blocked", "paused", "waiting_user":
		out.NextAction = "read_current_task_before_continuing"
	case "completed", "cancelled":
		out.NextAction = "use_references_for_historical_details"
	default:
		out.NextAction = "check_current_task"
	}
	for len(js(out)) > TaskDigestBytes && len(out.Summary) > 0 {
		out.Summary = utf8Prefix(out.Summary, len(out.Summary)/2)
		out.Truncated = true
	}
	if err := out.Validate(); err != nil {
		return TaskDigestV1{}, err
	}
	return out, nil
}
