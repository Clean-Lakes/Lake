package ai

import (
	"context"
	"errors"

	"gorm.io/gorm"
)

var ErrSuperLegacyReadOnly = errors.New("superagent: this project's legacy execution entry is read-only; send new work through Pilot")

func (e *Engine) checkSuperModelDomain(ctx context.Context, sessionID string, c Config) error {
	project := configSecurityProject(c)
	if project == "" {
		return nil
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	if !store.DB.Migrator().HasTable(&superProjectRow{}) {
		return nil
	}
	var domain superProjectRow
	err = store.DB.WithContext(ctx).First(&domain, "project_id = ?", project).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	root := sessionID
	if e.worker != nil {
		root = e.worker.parentID
	}
	if root == domain.RouterSessionID && c.superRole == "router" && c.superRouter != nil && e.worker == nil {
		return nil
	}
	token, ok := ctx.Value(superAssignmentContextKey{}).(SuperAssignmentToken)
	if !ok {
		return ErrSuperLegacyReadOnly
	}
	var worker superWorkerRow
	if err := store.DB.WithContext(ctx).First(&worker, "id = ? AND project_id = ?", token.WorkerID, project).Error; err != nil {
		return ErrSuperLegacyReadOnly
	}
	if worker.goalSession() != root || c.superTaskID != worker.TaskID {
		return ErrSuperLegacyReadOnly
	}
	if worker.SourceEventID != "" {
		var sources []superEventRow
		if err := store.DB.WithContext(ctx).Where("project_id = ? AND source_kind = ? AND (id = ? OR id IN (?))", project, "user", worker.SourceEventID, store.DB.Model(&superInboxRow{}).Select("event_id").Where("task_id = ?", worker.TaskID)).Find(&sources).Error; err != nil {
			return err
		}
		for _, source := range sources {
			if _, err := e.resolveSuperInput(ctx, source.event()); err != nil {
				return err
			}
		}
	}
	return e.checkSuperAssignmentContext(ctx)
}

func rejectSuperReadOnlyGoalTx(tx *gorm.DB, goalID string) error {
	if isSuperArchiveGoal(goalID) {
		return ErrSuperLegacyReadOnly
	}
	if !tx.Migrator().HasTable(&superLegacyAliasRow{}) {
		return nil
	}
	var count int64
	if err := tx.Model(&superLegacyAliasRow{}).Where("canonical_id = ? AND read_only = ?", goalID, true).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return ErrSuperLegacyReadOnly
	}
	return nil
}
