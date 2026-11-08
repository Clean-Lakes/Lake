package ai

import (
	"context"
	"errors"
)

type SuperReplyAuthor struct {
	Kind             string `json:"kind"`
	Name             string `json:"name"`
	RoleID           string `json:"roleId,omitempty"`
	WorkerID         string `json:"workerId"`
	SessionID        string `json:"sessionId"`
	TaskID           string `json:"taskId"`
	ChannelSessionID string `json:"channelSessionId,omitempty"`
}

// Report IDs are the host's durable message IDs. Resolve their source from the
// canonical outbox/Worker binding, including already delivered historical rows.
// Reply prose and model-provided role names cannot assign an author.
func (e *Engine) SuperReplyAuthors(ctx context.Context, project, channel string, messageIDs []string) (map[string]SuperReplyAuthor, error) {
	out := map[string]SuperReplyAuthor{}
	if len(messageIDs) == 0 {
		return out, nil
	}
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	domain, active, err := e.SuperProject(ctx, project)
	if err != nil {
		return nil, err
	}
	if !active || domain.RouterSessionID != channel {
		return nil, errors.New("superagent: reply channel outside project")
	}
	for start := 0; start < len(messageIDs); start += 200 {
		end := min(start+200, len(messageIDs))
		var rows []struct{ ReportID, WorkerID, SessionID, TaskID, Name, RoleID, ChannelSessionID string }
		err = db.WithContext(ctx).Table("superagent_outbox AS o").Select("o.id AS report_id, w.id AS worker_id, w.session_id, w.task_id, r.name, w.role_id,c.host_session_id AS channel_session_id").
			Joins("JOIN superagent_workers w ON w.task_id=o.task_id AND w.project_id=o.project_id AND w.parent_worker_id='' ").
			Joins("JOIN superagent_roles r ON r.id=w.role_id AND r.project_id=w.project_id").
			Joins("LEFT JOIN superagent_role_channels c ON c.role_id=w.role_id AND c.project_id=w.project_id").
			Where("o.project_id=? AND o.channel_ref=? AND o.id IN ? AND o.task_id<>'' AND o.state IN ?", project, channel, messageIDs[start:end], []string{"sending", "unknown", "delivered"}).Scan(&rows).Error
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			if _, duplicate := out[row.ReportID]; duplicate {
				return nil, errSuperConflict
			}
			out[row.ReportID] = SuperReplyAuthor{Kind: "specialist", Name: row.Name, RoleID: row.RoleID, WorkerID: row.WorkerID, SessionID: row.SessionID, TaskID: row.TaskID, ChannelSessionID: row.ChannelSessionID}
		}
	}
	return out, nil
}
