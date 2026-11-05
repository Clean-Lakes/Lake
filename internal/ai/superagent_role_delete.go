package ai

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

var ErrSpecialistDeleted = errors.New("专员已删除，请选择其他专员或创建新的专员")
var ErrSpecialistRevision = errors.New("专员信息已更新，请关闭确认框后重试")

// Retirement is canonical metadata, not deletion of task or operation history.
// Recheck it in dispatch transactions so an in-flight Router cannot revive a role.
func checkSuperRoleAvailableTx(tx *gorm.DB, project, role string) error {
	var count int64
	if err := tx.Model(&superRoleRow{}).Where("id = ? AND project_id = ? AND deleted_at IS NOT NULL", role, project).Count(&count).Error; err != nil {
		return err
	}
	if count != 0 {
		return ErrSpecialistDeleted
	}
	return nil
}

// DeleteSuperSpecialist is host-only. Fence admission before stopping the
// existing channel; retrying the same revision also completes an interrupted stop.
func (e *Engine) DeleteSuperSpecialist(ctx context.Context, project, roleID string, revision int64) error {
	if project == "" || roleID == "" || revision < 0 {
		return errSuperBinding
	}
	db, err := e.superStore()
	if err != nil {
		return err
	}
	var channel superChannelRow
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var role superRoleRow
		if err := tx.First(&role, "id = ? AND project_id = ?", roleID, project).Error; err != nil {
			return err
		}
		if role.DeletedAt == nil {
			if role.Revision != revision {
				return ErrSpecialistRevision
			}
			result := tx.Model(&superRoleRow{}).Where("id = ? AND project_id = ? AND revision = ? AND deleted_at IS NULL", roleID, project, revision).Updates(map[string]any{"deleted_at": time.Now().UTC(), "revision": revision + 1})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return errSuperConflict
			}
		} else if role.Revision != revision+1 {
			return ErrSpecialistRevision
		}
		return tx.First(&channel, "role_id = ? AND project_id = ?", roleID, project).Error
	})
	if err != nil {
		return err
	}
	if err = e.stopSpecialistChannel(ctx, project, channel.HostSessionID, true); err != nil {
		return err
	}
	if e.SuperRolesChanged != nil {
		_ = e.SuperRolesChanged(ctx, project)
	}
	return nil
}

// Finish a stop interrupted after the durable retirement commit. The normal
// recovery loop runs this before leasing or delivering any further work.
func (e *Engine) reconcileDeletedSpecialists(ctx context.Context, project string) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	var channels []superChannelRow
	err = db.WithContext(ctx).Table("superagent_role_channels c").Select("c.*").
		Joins("JOIN superagent_roles r ON r.id=c.role_id AND r.project_id=c.project_id").
		Where(`c.project_id = ? AND r.deleted_at IS NOT NULL AND (
		 EXISTS (SELECT 1 FROM superagent_workers w JOIN native_work_goals g ON g.id=w.task_id AND g.session_id=COALESCE(NULLIF(w.goal_session_id,''),w.session_id)
		  WHERE w.project_id=c.project_id AND w.role_id=c.role_id AND w.parent_worker_id='' AND g.status NOT IN ('completed','failed','cancelled'))
		 OR EXISTS (SELECT 1 FROM superagent_channel_sources s JOIN superagent_events e ON e.id=s.event_id
		  WHERE s.channel_id=c.id AND e.disposition IN ('pending','staged'))
		)`, project).Scan(&channels).Error
	if err != nil {
		return err
	}
	for _, ch := range channels {
		if err := e.stopSpecialistChannel(ctx, project, ch.HostSessionID, true); err != nil {
			return err
		}
	}
	return nil
}
