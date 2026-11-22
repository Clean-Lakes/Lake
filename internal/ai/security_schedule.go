package ai

import (
	"errors"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// Preserve the legacy schedule tables for checkpoint recovery and operation reconciliation.
type securityScheduleConfigurationRow struct {
	ID                                                                string `gorm:"primaryKey"`
	ProjectID, SessionID, StoreID, RecoveryEpoch, State, Digest, Data string
	ConfigRevision, AuthorityRevision                                 int64
	Enabled                                                           bool
}

func (securityScheduleConfigurationRow) TableName() string { return "security_schedule_configurations" }

type securityScheduleGrantRow struct {
	ID                                                                   string `gorm:"primaryKey"`
	ScheduleID, ProjectID, StoreID, RecoveryEpoch, SourceMessageID, Data string `gorm:"index"`
	ConfigRevision, AuthorityRevision, Revision, RemainingRuns           int64
	ExpiresAt                                                            time.Time
	Revoked                                                              bool
}

func (securityScheduleGrantRow) TableName() string { return "security_schedule_grants" }

type securityScheduleOccurrenceRow struct {
	ID                                                                                      string    `gorm:"primaryKey"`
	ScheduleID                                                                              string    `gorm:"uniqueIndex:schedule_occurrence,priority:1"`
	ConfigRevision                                                                          int64     `gorm:"uniqueIndex:schedule_occurrence,priority:2"`
	DueAt                                                                                   time.Time `gorm:"uniqueIndex:schedule_occurrence,priority:3"`
	StoreID, RecoveryEpoch, ProjectID, GrantID, TaskID, RunID, SessionID, Kind, State, Data string
	AuthorityRevision                                                                       int64
}

func (securityScheduleOccurrenceRow) TableName() string { return "security_schedule_occurrences" }

type securityScheduleTaskSourceRow struct {
	TaskID                                                    string `gorm:"primaryKey"`
	ScheduleID, GrantID, OccurrenceID, StoreID, RecoveryEpoch string
	ConfigRevision, AuthorityRevision                         int64
}

func (securityScheduleTaskSourceRow) TableName() string { return "security_schedule_task_sources" }
func securityScheduleModels() []any {
	return []any{&securityScheduleConfigurationRow{}, &securityScheduleGrantRow{}, &securityScheduleOccurrenceRow{}, &securityScheduleTaskSourceRow{}}
}

// ValidateSecurityScheduleTaskSource checks the original authority for
// an operation that may already have been dispatched under a legacy schedule.
func ValidateSecurityScheduleTaskSource(tx *gorm.DB, taskID, storeID, epoch string, now time.Time) error {
	var source securityScheduleTaskSourceRow
	err := tx.First(&source, "task_id = ?", taskID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		var task securityTaskRow
		if taskErr := tx.First(&task, "id = ?", taskID).Error; taskErr == nil && (task.Kind == "schedule" || task.SourceKind == "schedule_occurrence") {
			return errors.New("security: scheduled task is missing its original occurrence authority")
		} else if taskErr != nil && !errors.Is(taskErr, gorm.ErrRecordNotFound) {
			return taskErr
		}
		return nil
	}
	if err != nil {
		return err
	}
	if source.StoreID != storeID || source.RecoveryEpoch != epoch {
		return security.ErrConflict
	}
	var task securityTaskRow
	if err = tx.First(&task, "id = ? AND store_id = ? AND recovery_epoch = ?", taskID, storeID, epoch).Error; err != nil {
		return err
	}
	if task.Kind != "schedule" || task.SourceKind != "schedule_occurrence" || task.SourceEventID != source.OccurrenceID {
		return security.ErrConflict
	}
	var occurrence securityScheduleOccurrenceRow
	if err = tx.First(&occurrence, "id = ? AND task_id = ? AND schedule_id = ? AND grant_id = ? AND store_id = ? AND recovery_epoch = ? AND config_revision = ? AND authority_revision = ? AND state IN ?", source.OccurrenceID, taskID, source.ScheduleID, source.GrantID, storeID, epoch, source.ConfigRevision, source.AuthorityRevision, []string{"claimed", "materialized"}).Error; err != nil {
		return err
	}
	if occurrence.ProjectID != task.ProjectID || occurrence.SessionID != task.SessionID {
		return security.ErrConflict
	}
	var config securityScheduleConfigurationRow
	if err = tx.First(&config, "id = ? AND store_id = ? AND recovery_epoch = ? AND config_revision = ? AND authority_revision = ? AND state IN ?", source.ScheduleID, storeID, epoch, source.ConfigRevision, source.AuthorityRevision, []string{"ready", "availability_changing"}).Error; err != nil {
		return err
	}
	if config.ProjectID != task.ProjectID {
		return security.ErrConflict
	}
	var grant securityScheduleGrantRow
	return tx.First(&grant, "id = ? AND schedule_id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ? AND config_revision = ? AND authority_revision = ? AND revoked = ? AND expires_at > ?", source.GrantID, source.ScheduleID, task.ProjectID, storeID, epoch, source.ConfigRevision, source.AuthorityRevision, false, now).Error
}

var errScheduleRetired = errors.New("Lake project scheduling has been retired")
