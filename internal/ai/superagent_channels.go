package ai

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// A channel is a host presentation address, never an ADK session or a permit.
type superChannelRow struct {
	ID            string `gorm:"primaryKey"`
	ProjectID     string `gorm:"uniqueIndex:super_channel_role,priority:1"`
	RoleID        string `gorm:"uniqueIndex:super_channel_role,priority:2"`
	HostSessionID string `gorm:"uniqueIndex"`
	Revision      int64
	CreatedAt     time.Time
}

func (superChannelRow) TableName() string { return "superagent_role_channels" }

type superChannelSourceRow struct {
	EventID        string `gorm:"primaryKey"`
	ChannelID      string `gorm:"index"`
	ExplicitTaskID string
}

func (superChannelSourceRow) TableName() string { return "superagent_channel_sources" }

func superChannelForEventTx(tx *gorm.DB, event superEventRow) (*superChannelRow, error) {
	var source superChannelSourceRow
	err := tx.First(&source, "event_id = ?", event.ID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var channel superChannelRow
	err = tx.First(&channel, "id = ? AND project_id = ?", source.ChannelID, event.ProjectID).Error
	if err != nil {
		return nil, err
	}
	if channel.HostSessionID != event.ThreadRef {
		var worker superWorkerRow
		if err := tx.First(&worker, "session_id = ? AND project_id = ? AND role_id = ?", event.ThreadRef, event.ProjectID, channel.RoleID).Error; err != nil {
			return nil, errSuperBinding
		}
	}
	return &channel, nil
}

type SpecialistChannel struct {
	ID                string    `json:"id"`
	ProjectID         string    `json:"projectId"`
	RoleID            string    `json:"roleId"`
	RoleName          string    `json:"roleName"`
	Duties            string    `json:"duties"`
	RoleRevision      int64     `json:"roleRevision"`
	SessionID         string    `json:"sessionId"`
	Revision          int64     `json:"revision"`
	CreatedAt         time.Time `json:"createdAt"`
	NeedsConfirmation bool      `json:"needsConfirmation,omitempty"`
}

func ensureSuperChannelTx(tx *gorm.DB, project, role string, at time.Time) (superChannelRow, error) {
	var r superRoleRow
	if err := tx.First(&r, "id = ? AND project_id = ?", role, project).Error; err != nil {
		return superChannelRow{}, err
	}
	key := hash(js([]string{project, role}))
	row := superChannelRow{ID: "channel_" + key[:32], ProjectID: project, RoleID: role, HostSessionID: "sc_" + key[:32], Revision: 1, CreatedAt: at}
	if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; err != nil {
		return row, err
	}
	var actual superChannelRow
	err := tx.First(&actual, "project_id = ? AND role_id = ?", project, role).Error
	return actual, err
}

func (e *Engine) ListSpecialistChannels(ctx context.Context, project string) ([]SpecialistChannel, error) {
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	out := []SpecialistChannel{}
	err = db.WithContext(ctx).Table("superagent_role_channels c").Select("c.id,c.project_id,c.role_id,r.name AS role_name,r.duties,r.revision AS role_revision,c.host_session_id AS session_id,c.revision,c.created_at").Joins("JOIN superagent_roles r ON r.id=c.role_id AND r.project_id=c.project_id").Where("c.project_id = ?", project).Order("c.created_at,c.id").Scan(&out).Error
	return out, err
}

func (e *Engine) SpecialistChannelForSession(ctx context.Context, project, session string) (SpecialistChannel, error) {
	db, err := e.superStore()
	if err != nil {
		return SpecialistChannel{}, err
	}
	var out SpecialistChannel
	result := db.WithContext(ctx).Table("superagent_role_channels c").Select("c.id,c.project_id,c.role_id,r.name AS role_name,r.duties,r.revision AS role_revision,c.host_session_id AS session_id,c.revision,c.created_at").Joins("JOIN superagent_roles r ON r.id=c.role_id AND r.project_id=c.project_id").Where("c.project_id = ? AND c.host_session_id = ?", project, session).Scan(&out)
	if result.Error != nil {
		return out, result.Error
	}
	if out.ID == "" {
		return out, errSuperBinding
	}
	return out, nil
}

// BindSpecialistSource is called only by the authenticated host after the real
// user message is persisted. Models cannot select a preferred role or address.
func (e *Engine) BindSpecialistSource(ctx context.Context, project, session, eventID, explicitTask string) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var channel superChannelRow
		if err := tx.First(&channel, "project_id = ? AND host_session_id = ?", project, session).Error; err != nil {
			return err
		}
		var event superEventRow
		if err := tx.First(&event, "id = ? AND project_id = ? AND source_kind = 'user'", eventID, project).Error; err != nil {
			return err
		}
		if event.ThreadRef != session {
			var worker superWorkerRow
			if err := tx.First(&worker, "session_id = ? AND project_id = ? AND role_id = ?", event.ThreadRef, project, channel.RoleID).Error; err != nil {
				return errSuperBinding
			}
		}
		if explicitTask != "" {
			var w superWorkerRow
			if err := tx.First(&w, "task_id = ? AND project_id = ? AND role_id = ? AND parent_worker_id = ''", explicitTask, project, channel.RoleID).Error; err != nil {
				return err
			}
		}
		row := superChannelSourceRow{EventID: eventID, ChannelID: channel.ID, ExplicitTaskID: explicitTask}
		var prior superChannelSourceRow
		err := tx.First(&prior, "event_id = ?", eventID).Error
		if err == nil {
			if prior != row {
				return errSuperConflict
			}
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if event.Disposition != "staged" && event.Disposition != "pending" {
			return errSuperConflict
		}
		return tx.Create(&row).Error
	})
}

// Channel workers are paged without the legacy workspace's recent-100 cap.
func (e *Engine) SpecialistChannelWorkers(ctx context.Context, project, session, after string, limit int) ([]SuperWorkerView, error) {
	if limit < 1 || limit > 100 {
		return nil, errSuperBinding
	}
	ch, err := e.SpecialistChannelForSession(ctx, project, session)
	if err != nil {
		return nil, err
	}
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	out := []SuperWorkerView{}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var rows []superWorkerRow
		if err := tx.Where("project_id = ? AND role_id = ? AND parent_worker_id = '' AND id > ?", project, ch.RoleID, after).Order("id").Limit(limit).Find(&rows).Error; err != nil {
			return err
		}
		for _, w := range rows {
			view, err := projectSuperTaskTx(tx, w.goalSession(), w.TaskID)
			if err != nil {
				return err
			}
			var a superAssignmentRow
			if err := tx.First(&a, "worker_id = ?", w.ID).Error; err != nil {
				return err
			}
			out = append(out, SuperWorkerView{ID: w.ID, RoleID: w.RoleID, RoleName: ch.RoleName, SessionID: w.SessionID, Task: view, AssignmentState: a.State})
		}
		return nil
	})
	return out, err
}

func (e *Engine) SpecialistChannelForWorker(ctx context.Context, project, session string) (SpecialistChannel, error) {
	db, err := e.superStore()
	if err != nil {
		return SpecialistChannel{}, err
	}
	var worker superWorkerRow
	if err := db.WithContext(ctx).First(&worker, "project_id = ? AND session_id = ? AND parent_worker_id = ''", project, session).Error; err != nil {
		return SpecialistChannel{}, err
	}
	ch, err := ensureSuperChannelTx(db.WithContext(ctx), project, worker.RoleID, worker.CreatedAt)
	if err != nil {
		return SpecialistChannel{}, err
	}
	return e.SpecialistChannelForSession(ctx, project, ch.HostSessionID)
}

func (e *Engine) SpecialistChannelRouting(ctx context.Context, project, session string) (bool, error) {
	ch, err := e.SpecialistChannelForSession(ctx, project, session)
	if err != nil {
		return false, err
	}
	db, err := e.superStore()
	if err != nil {
		return false, err
	}
	var count int64
	err = db.WithContext(ctx).Table("superagent_channel_sources AS s").Joins("JOIN superagent_events e ON e.id=s.event_id").Where("s.channel_id = ? AND e.project_id = ? AND e.disposition IN ?", ch.ID, project, []string{"pending", "staged"}).Count(&count).Error
	return count > 0, err
}

// Only verified host report provenance is returned; equal prose is not an ID.
func (e *Engine) SpecialistReportOrigins(ctx context.Context, project, session string, ids []string) (map[string]struct{ SessionID, CardID string }, error) {
	out := map[string]struct{ SessionID, CardID string }{}
	if len(ids) == 0 {
		return out, nil
	}
	if len(ids) > 200 {
		return nil, errSuperBinding
	}
	if _, err := e.SpecialistChannelForSession(ctx, project, session); err != nil {
		return nil, err
	}
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	var rows []struct{ ID, Payload, SessionID string }
	err = db.WithContext(ctx).Table("superagent_outbox o").Select("o.id,o.payload,w.session_id").Joins("JOIN superagent_workers w ON w.task_id=o.task_id AND w.project_id=o.project_id AND w.parent_worker_id=''").Where("o.project_id = ? AND o.channel_ref = ? AND o.id IN ?", project, session, ids).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		var payload struct {
			SourceCardID string `json:"sourceCardId"`
		}
		if err := json.Unmarshal([]byte(row.Payload), &payload); err != nil {
			return nil, err
		}
		if payload.SourceCardID != "" {
			out[row.ID] = struct{ SessionID, CardID string }{row.SessionID, payload.SourceCardID}
		}
	}
	return out, nil
}
