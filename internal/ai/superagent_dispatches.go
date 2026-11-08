package ai

import (
	"context"
	"encoding/json"
	"time"
)

// PilotDispatch is a read-only view of a committed routing decision. It is
// presentation provenance, never a new user input, task, permit or model turn.
type PilotDispatch struct {
	ID, EventID, SourceMessageID, PilotSessionID string
	WorkerID, SessionID, TaskID                  string
	RoleID, RoleName, ChannelSessionID           string
	Action, Instruction                          string
	CreatedAt                                    time.Time
}

func (e *Engine) PilotDispatches(ctx context.Context, project string, workerSessions ...string) ([]PilotDispatch, error) {
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	var rows []struct {
		PilotDispatch
		RoleSnapshot string
	}
	query := db.WithContext(ctx).Table("superagent_decisions AS d").
		Select("d.id, d.event_id, v.source_event_id AS source_message_id, p.router_session_id AS pilot_session_id, w.id AS worker_id, w.session_id, w.task_id, w.role_id, r.name AS role_name, w.role_snapshot, c.host_session_id AS channel_session_id, d.action, CASE WHEN d.action='create' THEN d.title ELSE d.quote END AS instruction, d.at AS created_at").
		Joins("JOIN superagent_events v ON v.id=d.event_id AND v.project_id=? AND v.source_kind='user'", project).
		Joins("JOIN superagent_projects p ON p.project_id=v.project_id AND p.router_session_id=v.thread_ref").
		Joins("JOIN superagent_workers w ON w.task_id=d.task_id AND w.project_id=v.project_id AND w.parent_worker_id='' AND w.protocol<>'workflow'").
		Joins("JOIN superagent_roles r ON r.id=w.role_id AND r.project_id=w.project_id").
		Joins("JOIN superagent_role_channels c ON c.role_id=w.role_id AND c.project_id=w.project_id").
		Where("d.action IN ?", []string{"create", "followup"})
	if len(workerSessions) > 0 {
		query = query.Where("w.session_id IN ?", workerSessions)
	}
	err = query.Order("d.at, d.id").Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	out := make([]PilotDispatch, 0, len(rows))
	for _, row := range rows {
		var frozen SpecialistRole
		if json.Unmarshal([]byte(row.RoleSnapshot), &frozen) == nil && frozen.ID == row.RoleID && frozen.ProjectID == project && frozen.Name != "" {
			row.RoleName = frozen.Name
		}
		out = append(out, row.PilotDispatch)
	}
	return out, nil
}
