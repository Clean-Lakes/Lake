package ai

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

type SecurityMCPBinding struct {
	ProjectID, ServerID             string
	Revision                        int64
	Enabled                         bool
	ToolNames                       []string
	ConfigRevision, CatalogRevision int64
	State                           string
}
type SecurityMCPBindingAction struct {
	SecurityPolicyAction
	ServerID  string
	Enabled   bool
	ToolNames []string
}

func (e *Engine) SecurityMCPBindings(ctx context.Context, projectID string) ([]SecurityMCPBinding, error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return nil, err
	}
	var rows []securityMCPBindingRow
	if err = db.WithContext(ctx).Where("project_id = ? AND store_id = ? AND recovery_epoch = ?", projectID, storeID, epoch).Order("server_id").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := []SecurityMCPBinding{}
	for _, row := range rows {
		value := SecurityMCPBinding{ProjectID: projectID, ServerID: row.ServerID, Revision: row.Revision, Enabled: row.Enabled}
		if err = decodeSecurityJSON(row.ToolNames, &value.ToolNames); err != nil {
			return nil, err
		}
		var server securityMCPRevisionRow
		if err = db.First(&server, "id = ? AND store_id = ? AND recovery_epoch = ?", row.ServerID, storeID, epoch).Error; err != nil {
			return nil, err
		}
		value.ConfigRevision, value.CatalogRevision, value.State = server.ConfigRevision, server.CatalogRevision, server.State
		out = append(out, value)
	}
	return out, nil
}
func (e *Engine) PutSecurityMCPBinding(ctx context.Context, a SecurityMCPBindingAction) (out SecurityMCPBinding, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	if !validPolicyAction(a.SecurityPolicyAction) || a.ServerID == "" || len(a.ToolNames) > 500 {
		return out, errSecurityAction
	}
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			request := hash(js(a))
			replay, err := securityActionReplay(tx, storeID, epoch, a.ActorID, a.ActionID, request, &out)
			if replay || err != nil {
				return err
			}
			if _, err = loadSecurityPolicy(tx, a.ProjectID, storeID, epoch); err != nil {
				return err
			}
			var server securityMCPRevisionRow
			if err = tx.First(&server, "id = ? AND store_id = ? AND recovery_epoch = ?", a.ServerID, storeID, epoch).Error; err != nil {
				return err
			}
			if a.Enabled && (server.State != "ready" || !server.Enabled) {
				return security.ErrConflict
			}
			var catalog []string
			if err = decodeSecurityJSON(server.ToolNames, &catalog); err != nil {
				return err
			}
			names := slices.Clone(a.ToolNames)
			slices.Sort(names)
			if len(slices.Compact(slices.Clone(names))) != len(names) {
				return errSecurityAction
			}
			for _, name := range names {
				if a.Enabled && !slices.Contains(catalog, name) {
					return errors.New("security: MCP binding tool absent from current catalog")
				}
			}
			var row securityMCPBindingRow
			err = tx.First(&row, "project_id = ? AND server_id = ?", a.ProjectID, a.ServerID).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				row = securityMCPBindingRow{ProjectID: a.ProjectID, ServerID: a.ServerID, StoreID: storeID, RecoveryEpoch: epoch}
			} else if err != nil {
				return err
			}
			if row.StoreID != storeID || row.RecoveryEpoch != epoch || row.Revision != a.ExpectedRevision {
				return security.ErrConflict
			}
			before := row.Revision
			row.Revision++
			row.Enabled = a.Enabled
			row.ToolNames = js(names)
			if err = tx.Save(&row).Error; err != nil {
				return err
			}
			out = SecurityMCPBinding{ProjectID: row.ProjectID, ServerID: row.ServerID, Revision: row.Revision, Enabled: row.Enabled, ToolNames: names, ConfigRevision: server.ConfigRevision, CatalogRevision: server.CatalogRevision, State: server.State}
			return securityActionRecord(tx, storeID, epoch, a.ActorID, a.ActionID, "mcp.binding", a.ServerID, request, before, row.Revision, out, time.Now().UTC(), a.ProjectID)
		})
	})
	return out, err
}

type SecurityCatalogReconciliation struct {
	ProjectID         string
	Resources         []security.ResourceRevision
	Digest            string
	credentialDigests map[string]string
	view              SecurityCatalogView
}

func (e *Engine) catalogReconciliationTx(ctx context.Context, tx *gorm.DB, projectID, storeID, epoch string) (out SecurityCatalogReconciliation, err error) {
	out.ProjectID = projectID
	view, err := e.currentSecurityCatalog(ctx, SecurityCatalogQuery{ProjectID: projectID, All: true})
	if err != nil {
		return out, err
	}
	out.view = view
	out.credentialDigests = map[string]string{}
	refs := map[string]security.CredentialRevision{}
	for _, credential := range view.Credentials {
		var row securityCredentialRevisionRow
		err := tx.First(&row, "id = ?", credential.ID).Error
		if err != nil {
			return out, err
		}
		if row.StoreID != storeID || row.RecoveryEpoch != epoch || row.Locator != credential.Locator {
			return out, security.ErrConflict
		}
		revision := row.Revision
		if row.MetadataDigest != credential.MetadataDigest || row.State != "ready" {
			revision++
		}
		refs[credential.ID] = security.CredentialRevision{Reference: credential.ID, Revision: revision}
		out.credentialDigests[credential.ID] = credential.MetadataDigest
	}
	for _, resource := range view.Resources {
		var row securityResourceRevisionRow
		if err = tx.First(&row, "project_id = ? AND resource_id = ? AND store_id = ? AND recovery_epoch = ?", projectID, resource.ID, storeID, epoch).Error; err != nil {
			return out, err
		}
		digest, _, err := catalogConnectionDigest(resource, refs)
		if err != nil {
			return out, err
		}
		state := "ready"
		if resource.Disabled {
			state = "disabled"
		}
		revision := row.ConnectionRevision
		if row.State != state || row.MetadataDigest != resource.MetadataDigest || row.ConnectionDigest != digest {
			revision++
		}
		out.Resources = append(out.Resources, security.ResourceRevision{ID: resource.ID, ConnectionRevision: revision, ConnectionDigest: digest, ConnectionIdentity: resource.ConnectionIdentity, State: state, Local: resource.Local})
	}
	slices.SortFunc(out.Resources, func(a, b security.ResourceRevision) int {
		if a.ID < b.ID {
			return -1
		}
		if a.ID > b.ID {
			return 1
		}
		return 0
	})
	out.Digest = hash(js(struct {
		ProjectID, StoreID, Epoch string
		Resources                 []security.ResourceRevision
		Credentials               map[string]string
	}{projectID, storeID, epoch, out.Resources, out.credentialDigests}))
	return out, nil
}
func (e *Engine) PreviewSecurityCatalogReconciliation(ctx context.Context, projectID string) (out SecurityCatalogReconciliation, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var err error
			out, err = e.catalogReconciliationTx(ctx, tx, projectID, storeID, epoch)
			return err
		})
	})
	return out, err
}
func (e *Engine) ConfirmSecurityCatalogReconciliation(ctx context.Context, a SecurityPolicyAction, digest string) (out SecurityCatalogReconciliation, err error) {
	if !validPolicyAction(a) || len(digest) != 64 {
		return out, errSecurityAction
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			request := hash(js(struct {
				Action SecurityPolicyAction
				Digest string
			}{a, digest}))
			replay, err := securityActionReplay(tx, storeID, epoch, a.ActorID, a.ActionID, request, &out)
			if replay || err != nil {
				return err
			}
			policy, err := loadSecurityPolicy(tx, a.ProjectID, storeID, epoch)
			if err != nil {
				return err
			}
			if policy.Revision != a.ExpectedRevision {
				return security.ErrConflict
			}
			out, err = e.catalogReconciliationTx(ctx, tx, a.ProjectID, storeID, epoch)
			if err != nil {
				return err
			}
			if out.Digest != digest {
				return security.ErrConflict
			}
			for _, credential := range out.view.Credentials {
				var old securityCredentialRevisionRow
				if err = tx.First(&old, "id = ?", credential.ID).Error; err != nil {
					return err
				}
				if old.MetadataDigest != credential.MetadataDigest || old.State != "ready" {
					var resources []securityResourceRevisionRow
					if err = tx.Where("store_id = ? AND recovery_epoch = ?", storeID, epoch).Find(&resources).Error; err != nil {
						return err
					}
					for _, resource := range resources {
						var ids []string
						if decodeSecurityJSON(resource.CredentialIDs, &ids) != nil {
							return security.ErrConflict
						}
						if slices.Contains(ids, credential.ID) {
							if err = tx.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND resource_id = ?", resource.ProjectID, resource.ResourceID).Updates(map[string]any{"state": "changing", "change_id": "credential-confirm-" + a.ActionID}).Error; err != nil {
								return err
							}
						}
					}
					if err = tx.Model(&securityCredentialRevisionRow{}).Where("id = ?", credential.ID).Updates(map[string]any{"metadata_digest": credential.MetadataDigest, "revision": old.Revision + 1, "state": "ready"}).Error; err != nil {
						return err
					}
				}
			}
			for _, resource := range out.Resources {
				var metadata SecurityCatalogResource
				for _, value := range out.view.Resources {
					if value.ID == resource.ID {
						metadata = value
					}
				}
				if err = tx.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND resource_id = ?", a.ProjectID, resource.ID).Updates(map[string]any{"state": resource.State, "connection_revision": resource.ConnectionRevision, "connection_digest": resource.ConnectionDigest, "connection_identity": resource.ConnectionIdentity, "metadata_digest": metadata.MetadataDigest, "credential_ids": js(metadata.CredentialIDs), "kind": metadata.Kind, "local": metadata.Local, "change_id": ""}).Error; err != nil {
					return err
				}
			}
			return securityActionRecord(tx, storeID, epoch, a.ActorID, a.ActionID, "catalog.confirm", a.ProjectID, request, policy.Revision, policy.Revision, out, time.Now().UTC(), a.ProjectID)
		})
	})
	return out, err
}

// SecurityMCPInspectionRevision binds an explicit local-user inspection to the
// exact config frozen by its host adapter. A late response cannot bless a newly
// edited endpoint or credential configuration.
func (e *Engine) SecurityMCPInspectionRevision(ctx context.Context, serverID, metadata, storage string) (revision int64, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return 0, err
	}
	err = e.withSecurityDispatchBarrier(func() error {
		var row securityMCPRevisionRow
		if err := db.WithContext(ctx).First(&row, "id = ? AND store_id = ? AND recovery_epoch = ?", serverID, storeID, epoch).Error; err != nil {
			return err
		}
		if row.State != "ready" || !row.Enabled || row.MetadataDigest != metadata || row.StorageDigest != storage {
			return security.ErrConflict
		}
		revision = row.ConfigRevision
		return nil
	})
	return revision, err
}

type SecurityMCPReconciliation struct {
	ProjectID, ServerID, Digest, MetadataDigest, StorageDigest, State string
	ConfigRevision, BindingRevision                                   int64
	Enabled                                                           bool
}

func (e *Engine) mcpReconciliationTx(ctx context.Context, tx *gorm.DB, projectID, serverID, storeID, epoch string) (out SecurityMCPReconciliation, err error) {
	var binding securityMCPBindingRow
	if err = tx.First(&binding, "project_id = ? AND server_id = ? AND store_id = ? AND recovery_epoch = ?", projectID, serverID, storeID, epoch).Error; err != nil {
		return out, err
	}
	var row securityMCPRevisionRow
	if err = tx.First(&row, "id = ? AND store_id = ? AND recovery_epoch = ?", serverID, storeID, epoch).Error; err != nil {
		return out, err
	}
	view, err := e.currentSecurityCatalog(ctx, SecurityCatalogQuery{ProjectID: projectID, MCPServerID: serverID})
	if err != nil {
		return out, err
	}
	if view.MCPServerID != serverID || len(view.MCPMetadataDigest) != 64 || len(view.MCPStorageDigest) != 64 {
		return out, security.ErrConflict
	}
	out = SecurityMCPReconciliation{ProjectID: projectID, ServerID: serverID, MetadataDigest: view.MCPMetadataDigest, StorageDigest: view.MCPStorageDigest, State: row.State, ConfigRevision: row.ConfigRevision, BindingRevision: binding.Revision, Enabled: view.MCPEnabled}
	out.Digest = hash(js(struct {
		StoreID, Epoch string
		Snapshot       SecurityMCPReconciliation
	}{storeID, epoch, out}))
	return out, nil
}
func (e *Engine) PreviewSecurityMCPReconciliation(ctx context.Context, projectID, serverID string) (out SecurityMCPReconciliation, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var err error
			out, err = e.mcpReconciliationTx(ctx, tx, projectID, serverID, storeID, epoch)
			return err
		})
	})
	return out, err
}
func (e *Engine) ConfirmSecurityMCPReconciliation(ctx context.Context, a SecurityPolicyAction, serverID, digest string) (out SecurityMCPReconciliation, err error) {
	if !validPolicyAction(a) || serverID == "" || len(digest) != 64 {
		return out, errSecurityAction
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			request := hash(js(struct {
				Action           SecurityPolicyAction
				ServerID, Digest string
			}{a, serverID, digest}))
			replay, err := securityActionReplay(tx, storeID, epoch, a.ActorID, a.ActionID, request, &out)
			if replay || err != nil {
				return err
			}
			policy, err := loadSecurityPolicy(tx, a.ProjectID, storeID, epoch)
			if err != nil {
				return err
			}
			if policy.Revision != a.ExpectedRevision {
				return security.ErrConflict
			}
			out, err = e.mcpReconciliationTx(ctx, tx, a.ProjectID, serverID, storeID, epoch)
			if err != nil {
				return err
			}
			if out.Digest != digest {
				return security.ErrConflict
			}
			changed := tx.Model(&securityMCPRevisionRow{}).Where("id = ? AND config_revision = ? AND store_id = ? AND recovery_epoch = ?", serverID, out.ConfigRevision, storeID, epoch).Updates(map[string]any{"config_revision": out.ConfigRevision + 1, "catalog_revision": gorm.Expr("catalog_revision + 1"), "metadata_digest": out.MetadataDigest, "storage_digest": out.StorageDigest, "state": "ready", "change_id": "", "enabled": out.Enabled, "tool_names": "[]", "catalog_digest": ""})
			if changed.Error != nil {
				return changed.Error
			}
			if changed.RowsAffected != 1 {
				return security.ErrConflict
			}
			before := out.ConfigRevision
			out.ConfigRevision++
			out.State = "ready"
			return securityActionRecord(tx, storeID, epoch, a.ActorID, a.ActionID, "mcp.confirm", serverID, request, before, out.ConfigRevision, out, time.Now().UTC(), a.ProjectID)
		})
	})
	return out, err
}
