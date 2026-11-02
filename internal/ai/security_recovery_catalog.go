package ai

import (
	"context"
	"errors"
	"path/filepath"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func recoveryResourceReference(row securityResourceRevisionRow) security.ResourceRevision {
	return security.ResourceRevision{ID: row.ResourceID, ConnectionRevision: row.ConnectionRevision, ConnectionDigest: row.ConnectionDigest, ConnectionIdentity: row.ConnectionIdentity, State: row.State, Local: row.Local}
}

func recoveryPolicyCatalogResources(tx *gorm.DB, journal securityRestoreJournal, projectID string) ([]SecurityRecoveryPolicyResource, error) {
	var rows []securityResourceRevisionRow
	if err := tx.Where("project_id = ?", projectID).Order("resource_id").Find(&rows).Error; err != nil {
		return nil, err
	}
	result := make([]SecurityRecoveryPolicyResource, 0, len(rows))
	for _, row := range rows {
		result = append(result, SecurityRecoveryPolicyResource{Resource: recoveryResourceReference(row), Kind: row.Kind, RequiresConfirmation: row.StoreID != journal.After.StoreID || row.RecoveryEpoch != journal.After.RecoveryEpoch || row.State != "ready"})
	}
	return result, nil
}

// Confirmation is explicit per exact immutable resource reference. This is not
// BootstrapSecurityResources and never invents an impact or classifies legacy
// navigation. Current Web identity must still equal the verified incoming asset.
func confirmRecoveryPolicyCatalog(ctx context.Context, tx *gorm.DB, home string, journal securityRestoreJournal, projectID string, resourceIDs []string, confirmed []security.ResourceRevision) error {
	var catalog []securityResourceRevisionRow
	if err := tx.Where("project_id = ?", projectID).Order("resource_id").Find(&catalog).Error; err != nil {
		return err
	}
	known := map[string]securityResourceRevisionRow{}
	for _, row := range catalog {
		known[row.ResourceID] = row
	}
	for _, id := range resourceIDs {
		if _, exists := known[id]; !exists {
			return errors.New("security: current catalog has no verified resource revision; explicit asset migration is required")
		}
	}
	web, err := openSecurityReadOnly(filepath.Join(filepath.Dir(journal.After.RuntimeRoot), "lake-web.sqlite"))
	if err != nil {
		return err
	}
	rows, err := web.QueryContext(ctx, "SELECT id FROM resources WHERE projectId=?", projectID)
	if err != nil {
		web.Close()
		return err
	}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			web.Close()
			return err
		}
		if _, exists := known[id]; !exists {
			rows.Close()
			web.Close()
			return errors.New("security: catalog asset lacks original identity proof; explicit asset migration is required")
		}
	}
	err = rows.Err()
	rows.Close()
	web.Close()
	if err != nil {
		return err
	}
	provided := map[string]security.ResourceRevision{}
	for _, resource := range confirmed {
		if _, exists := known[resource.ID]; !exists {
			return errSecurityAction
		}
		if _, duplicate := provided[resource.ID]; duplicate {
			return errSecurityAction
		}
		provided[resource.ID] = resource
	}
	for _, current := range catalog {
		id := current.ResourceID
		ref, explicit := provided[id]
		if explicit && ref != recoveryResourceReference(current) {
			return security.ErrConflict
		}
		if current.StoreID == journal.After.StoreID && current.RecoveryEpoch == journal.After.RecoveryEpoch && current.State == "ready" {
			continue
		}
		if !explicit {
			return errors.New("security: exact current catalog resource references require explicit recovery confirmation")
		}
		if err := confirmRecoveryPolicyCatalogResource(ctx, tx, home, journal, projectID, current, ref); err != nil {
			return err
		}
	}
	return nil
}

func confirmRecoveryPolicyCatalogResource(ctx context.Context, tx *gorm.DB, home string, journal securityRestoreJournal, projectID string, current securityResourceRevisionRow, ref security.ResourceRevision) error {
	sourceStore, sourceEpoch := journal.SourceStoreID, journal.SourceRecoveryEpoch
	if sourceStore == "" || sourceEpoch == "" {
		cp, err := VerifySecurityCheckpoint(ctx, journal.Source)
		if err != nil {
			return errors.New("security: original source identity proof unavailable")
		}
		digest, err := checkpointManifestHash(journal.Source)
		if err != nil || digest != journal.SourceManifestHash {
			return security.ErrConflict
		}
		sourceStore, sourceEpoch = cp.StoreID, cp.RecoveryEpoch
	}
	directory := filepath.Join(home, "security", "recoveries", journal.After.RecoveryID, "incoming")
	sourceSQL, err := openSecurityReadOnlyMode(filepath.Join(directory, "adk", "sessions.sqlite"), true)
	if err != nil {
		return err
	}
	defer sourceSQL.Close()
	sourceDB, err := gorm.Open(sqlite.New(sqlite.Config{DriverName: "sqlite", Conn: sourceSQL}), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		return err
	}
	var original securityResourceRevisionRow
	if err = sourceDB.WithContext(ctx).First(&original, "project_id = ? AND resource_id = ?", projectID, ref.ID).Error; err != nil {
		return errors.New("security: original resource catalog proof unavailable")
	}
	if original.StoreID != sourceStore || original.RecoveryEpoch != sourceEpoch || original.State != "ready" || recoveryResourceReference(original) != ref || current.StoreID != sourceStore || current.RecoveryEpoch != sourceEpoch || current.Kind != original.Kind || current.MetadataDigest != original.MetadataDigest || current.CredentialIDs != original.CredentialIDs {
		return security.ErrConflict
	}
	before, err := recoveryCatalogResource(filepath.Join(directory, "lake-web.sqlite"), ref.ID)
	if err != nil {
		return err
	}
	currentAsset, err := recoveryCatalogResource(filepath.Join(filepath.Dir(journal.After.RuntimeRoot), "lake-web.sqlite"), ref.ID)
	if err != nil {
		return err
	}
	if before != currentAsset || before.project != projectID || original.Kind != "" && original.Kind != before.kind {
		return errors.New("security: current catalog connection changed; explicit asset reconciliation required")
	}
	changed := tx.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND resource_id = ? AND store_id = ? AND recovery_epoch = ? AND connection_revision = ? AND connection_digest = ? AND state = ?", projectID, ref.ID, sourceStore, sourceEpoch, ref.ConnectionRevision, ref.ConnectionDigest, "ready").Updates(map[string]any{"store_id": journal.After.StoreID, "recovery_epoch": journal.After.RecoveryEpoch})
	if changed.Error != nil {
		return changed.Error
	}
	if changed.RowsAffected != 1 {
		return security.ErrConflict
	}
	return nil
}
