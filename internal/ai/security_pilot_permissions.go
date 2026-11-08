package ai

import (
	"errors"

	"gorm.io/gorm"
)

// Ordinary task Workers in an activated Pilot project use that Pilot's current
// permission authority. Their own historical snapshots are never overwritten.
func effectiveLegacyPolicyTx(tx *gorm.DB, project, sessionID, storeID, epoch string) (securityLegacySessionPolicyRow, string, error) {
	source := sessionID
	if tx.Migrator().HasTable(&superWorkerRow{}) {
		var worker superWorkerRow
		err := tx.First(&worker, "session_id = ?", sessionID).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return securityLegacySessionPolicyRow{}, "", err
		}
		if err == nil {
			if worker.ProjectID != project {
				return securityLegacySessionPolicyRow{}, "", errSuperBinding
			}
			if worker.ParentWorkerID == "" && worker.Protocol != "workflow" {
				var domain superProjectRow
				err := tx.First(&domain, "project_id = ?", project).Error
				if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
					return securityLegacySessionPolicyRow{}, "", err
				}
				if err == nil {
					source = domain.RouterSessionID
				}
			}
		}
	}
	var row securityLegacySessionPolicyRow
	err := tx.First(&row, "session_id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ?", source, project, storeID, epoch).Error
	if source == sessionID {
		source = "" // Preserve existing descriptor digests for independent sessions.
	}
	return row, source, err
}
