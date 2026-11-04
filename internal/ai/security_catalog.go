package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

type SecurityCatalogQuery struct {
	ProjectID, SessionID, TerminalID, MCPServerID, MCPToolName string
	ResourceIDs                                                []string
	All                                                        bool
	Write                                                      bool
	MCPDiscovery                                               bool
}

type SecurityCatalogCredential struct {
	ID, MetadataDigest string
	Locator            string `json:"-"`
}
type SecurityCatalogResource struct {
	ProjectID, ID, Kind, MetadataDigest string
	CredentialIDs                       []string
	Local, Disabled                     bool
	ConnectionIdentity                  string
}
type SecurityCatalogView struct {
	HardLocalDeny                                                 bool // Current trusted host session setting, a denial floor only.
	Resources                                                     []SecurityCatalogResource
	Credentials                                                   []SecurityCatalogCredential
	TerminalID, TerminalGeneration, TerminalResourceID            string
	TerminalContextRevision                                       int64
	MCPServerID, MCPToolName, MCPMetadataDigest, MCPStorageDigest string
	MCPEnabled                                                    bool
	MCPLocal                                                      bool
	ExecutionAssets                                               []Asset
	MCPFactory                                                    SecurityMCPFactory `json:"-"`
	MCPAllowedServerIDs                                           []string
	MCPAllowedToolNames                                           []string
}

type SecurityMCPFactory interface {
	Freeze(context.Context) (SecurityMCPExecutor, error)
}
type SecurityMCPExecutor interface {
	Execute(context.Context, string, map[string]any) (any, error)
}

// The resolver is supplied by the trusted host. It reads local authoritative
// metadata only: no model, network, keychain or credential material reads.
type SecurityCatalogResolver func(context.Context, SecurityCatalogQuery) (SecurityCatalogView, error)

var ErrSecurityCatalogUnavailable = errors.New("security: authoritative catalog unavailable")

type securityCredentialRevisionRow struct {
	ID                                            string `gorm:"primaryKey"`
	StoreID, RecoveryEpoch, MetadataDigest, State string
	Revision                                      int64
	Locator                                       string
}

func (securityCredentialRevisionRow) TableName() string { return "security_credential_revisions" }

type securityMCPRevisionRow struct {
	ID                                                                     string `gorm:"primaryKey"`
	StoreID, RecoveryEpoch, MetadataDigest, StorageDigest, State, ChangeID string
	ConfigRevision, CatalogRevision                                        int64
	ToolNames, CatalogDigest                                               string
	Enabled                                                                bool
}

func (securityMCPRevisionRow) TableName() string { return "security_mcp_revisions" }

type securityMCPBindingRow struct {
	ProjectID                         string `gorm:"primaryKey"`
	ServerID                          string `gorm:"primaryKey"`
	StoreID, RecoveryEpoch, ToolNames string
	Revision                          int64
	Enabled                           bool
}

func (securityMCPBindingRow) TableName() string { return "security_mcp_bindings" }

type securityParentRestrictionRow struct {
	ProjectID, SessionID, GoalID, StepID, AttemptID                      string
	GoalRevision, PlanRevision, StepRevision                             int64
	TaskID                                                               string `gorm:"primaryKey"`
	ScopeID                                                              string `gorm:"primaryKey"`
	ParentOwner                                                          string
	ResourceIDs                                                          string
	StoreID, RecoveryEpoch, RoleCapabilities, AuthorityKind, AuthorityID string
	Revision, AuthorityRevision                                          int64
}

func (securityParentRestrictionRow) TableName() string { return "security_parent_restrictions" }

func securityCatalogModels() []any {
	return []any{&securityCredentialRevisionRow{}, &securityMCPRevisionRow{}, &securityMCPBindingRow{}, &securityParentRestrictionRow{}, &securityCommandTargetRow{}}
}

func catalogCredentialsTx(tx *gorm.DB, storeID, epoch string, view SecurityCatalogView, allowNew bool) (map[string]security.CredentialRevision, error) {
	refs := map[string]security.CredentialRevision{}
	for _, credential := range view.Credentials {
		if credential.ID == "" || len(credential.MetadataDigest) != 64 {
			return nil, ErrSecurityCatalogUnavailable
		}
		if _, duplicate := refs[credential.ID]; duplicate {
			return nil, security.ErrConflict
		}
		var row securityCredentialRevisionRow
		err := tx.First(&row, "id = ?", credential.ID).Error
		if errors.Is(err, gorm.ErrRecordNotFound) && allowNew {
			row = securityCredentialRevisionRow{ID: credential.ID, StoreID: storeID, RecoveryEpoch: epoch, MetadataDigest: credential.MetadataDigest, State: "ready", Revision: 1, Locator: credential.Locator}
			if err = tx.Create(&row).Error; err != nil {
				return nil, err
			}
		} else if err != nil {
			return nil, err
		}
		if row.StoreID != storeID || row.RecoveryEpoch != epoch || row.State != "ready" || row.MetadataDigest != credential.MetadataDigest || row.Revision < 1 {
			return nil, errors.New("security: credential reference changed; explicit catalog confirmation required")
		}
		if row.Locator != credential.Locator {
			return nil, security.ErrConflict
		}
		refs[credential.ID] = security.CredentialRevision{Reference: row.ID, Revision: row.Revision}
	}
	return refs, nil
}

// Compare only authority metadata. ExecutionAssets may contain legacy inline
// secrets and are deliberately excluded from authority fingerprints.
func securityCatalogMetadataDigest(view SecurityCatalogView) string {
	return hash(js(struct {
		Resources   []SecurityCatalogResource
		Credentials []SecurityCatalogCredential
	}{view.Resources, view.Credentials}))
}

func catalogConnectionDigest(resource SecurityCatalogResource, refs map[string]security.CredentialRevision) (string, []security.CredentialRevision, error) {
	credentials := make([]security.CredentialRevision, 0, len(resource.CredentialIDs))
	ids := slices.Clone(resource.CredentialIDs)
	slices.Sort(ids)
	for i, id := range ids {
		ref, ok := refs[id]
		if !ok || i > 0 && id == ids[i-1] {
			return "", nil, ErrSecurityCatalogUnavailable
		}
		credentials = append(credentials, ref)
	}
	return hash(js(struct {
		ID, ProjectID, Kind, MetadataDigest string
		Local                               bool
		Credentials                         []security.CredentialRevision
	}{resource.ID, resource.ProjectID, resource.Kind, resource.MetadataDigest, resource.Local, credentials})), credentials, nil
}

// BootstrapSecurityCatalog can rebaseline dormant, unconfigured projects after
// a compatible old reader edited them. Configured projects are quarantined on
// any mismatch; startup cannot confirm their new connection or credential.
func (e *Engine) BootstrapSecurityCatalog(ctx context.Context) error {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return e.withSecurityDispatchBarrier(func() error {
		view, err := e.currentSecurityCatalog(ctx, SecurityCatalogQuery{All: true})
		if err != nil {
			return err
		}
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			refs := map[string]security.CredentialRevision{}
			for _, credential := range view.Credentials {
				var old securityCredentialRevisionRow
				readErr := tx.First(&old, "id = ?", credential.ID).Error
				if errors.Is(readErr, gorm.ErrRecordNotFound) {
					old = securityCredentialRevisionRow{ID: credential.ID, StoreID: storeID, RecoveryEpoch: epoch, Revision: 1, MetadataDigest: credential.MetadataDigest, State: "ready", Locator: credential.Locator}
					if err := tx.Create(&old).Error; err != nil {
						return err
					}
				} else if readErr != nil {
					return readErr
				} else if old.StoreID != storeID || old.RecoveryEpoch != epoch {
					return security.ErrConflict
				} else if old.MetadataDigest != credential.MetadataDigest {
					old.Revision++
					old.MetadataDigest = credential.MetadataDigest
					if err := tx.Model(&securityCredentialRevisionRow{}).Where("id = ?", old.ID).Updates(map[string]any{"revision": old.Revision, "metadata_digest": old.MetadataDigest}).Error; err != nil {
						return err
					}
				}
				if old.Locator == "" && credential.Locator != "" {
					if err := tx.Model(&securityCredentialRevisionRow{}).Where("id = ?", old.ID).Update("locator", credential.Locator).Error; err != nil {
						return err
					}
				} else if old.Locator != credential.Locator {
					return security.ErrConflict
				}
				refs[old.ID] = security.CredentialRevision{Reference: old.ID, Revision: old.Revision}
			}
			for _, resource := range view.Resources {
				if resource.ID == "" || resource.ProjectID == "" || len(resource.MetadataDigest) != 64 {
					return ErrSecurityCatalogUnavailable
				}
				digest, _, err := catalogConnectionDigest(resource, refs)
				if err != nil {
					return err
				}
				var old securityResourceRevisionRow
				state := "ready"
				if resource.Disabled {
					state = "disabled"
				}
				var policies int64
				if err = tx.Model(&securityProjectPolicyRow{}).Where("project_id = ?", resource.ProjectID).Count(&policies).Error; err != nil {
					return err
				}
				err = tx.First(&old, "project_id = ? AND resource_id = ?", resource.ProjectID, resource.ID).Error
				if err == nil {
					if old.StoreID != storeID || old.RecoveryEpoch != epoch {
						return security.ErrConflict
					}
					mismatch := old.MetadataDigest != resource.MetadataDigest || old.ConnectionDigest != digest || old.Local != resource.Local || old.Kind != resource.Kind || old.ConnectionIdentity != resource.ConnectionIdentity || old.State != state
					if policies > 0 {
						if mismatch && old.State != "changing" {
							if err = tx.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND resource_id = ?", resource.ProjectID, resource.ID).Updates(map[string]any{"state": "changing", "change_id": "startup-" + uid()}).Error; err != nil {
								return err
							}
						}
						continue
					}
					if mismatch {
						next := old.ConnectionRevision + 1
						if err = tx.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND resource_id = ?", resource.ProjectID, resource.ID).Updates(map[string]any{"connection_revision": next, "connection_digest": digest, "metadata_digest": resource.MetadataDigest, "credential_ids": js(resource.CredentialIDs), "connection_identity": resource.ConnectionIdentity, "local": resource.Local, "kind": resource.Kind, "state": state, "change_id": ""}).Error; err != nil {
							return err
						}
						id := uid()
						if err = securityActionRecord(tx, storeID, epoch, "system", id, "catalog.legacy_rebaseline", resource.ID, js(struct {
							Before      int64
							AfterDigest string
						}{old.ConnectionRevision, digest}), old.ConnectionRevision, next, map[string]any{"resourceId": resource.ID, "connectionRevision": next}, time.Now().UTC(), resource.ProjectID); err != nil {
							return err
						}
					}
					continue
				}
				if !errors.Is(err, gorm.ErrRecordNotFound) {
					return err
				}
				if policies > 0 {
					state = "changing"
				}
				row := securityResourceRevisionRow{ProjectID: resource.ProjectID, ResourceID: resource.ID, StoreID: storeID, RecoveryEpoch: epoch, ConnectionDigest: digest, State: state, ConnectionRevision: 1, Local: resource.Local, Kind: resource.Kind, MetadataDigest: resource.MetadataDigest, CredentialIDs: js(resource.CredentialIDs), ConnectionIdentity: resource.ConnectionIdentity}
				if err = tx.Create(&row).Error; err != nil {
					return err
				}
			}
			return nil
		})
	})
}

// MutateSecurityCatalog serializes metadata changes with all managed dispatch.
// The protocol is durable changing -> Web commit -> ready. Any interruption
// leaves changing rows non-dispatchable; no network/model wait occurs here.
func (e *Engine) MutateSecurityCatalog(ctx context.Context, work func() error, targets ...string) (err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return e.withSecurityDispatchBarrier(func() (result error) {
		before, err := e.currentSecurityCatalog(ctx, SecurityCatalogQuery{All: true})
		if err != nil {
			return err
		}
		changeID := uid()
		oldRows := []securityResourceRevisionRow{}
		selected := map[string]bool{}
		beforeIDs := map[string]bool{}
		for _, resource := range before.Resources {
			beforeIDs[resource.ID] = true
			if len(targets) == 0 {
				selected[resource.ID] = true
			}
			for _, target := range targets {
				if target == resource.ID || strings.HasPrefix(target, "project:") && resource.ProjectID == strings.TrimPrefix(target, "project:") {
					selected[resource.ID] = true
				}
			}
		}
		if err = db.Transaction(func(tx *gorm.DB) error {
			for _, resource := range before.Resources {
				if !selected[resource.ID] {
					continue
				}
				var row securityResourceRevisionRow
				if err := tx.First(&row, "project_id = ? AND resource_id = ?", resource.ProjectID, resource.ID).Error; err != nil {
					return err
				}
				if row.StoreID != storeID || row.RecoveryEpoch != epoch || row.State == "changing" || row.MetadataDigest != resource.MetadataDigest {
					return security.ErrConflict
				}
				oldRows = append(oldRows, row)
				if err := tx.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND resource_id = ? AND connection_revision = ?", row.ProjectID, row.ResourceID, row.ConnectionRevision).Updates(map[string]any{"state": "changing", "change_id": changeID}).Error; err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return err
		}
		// A rejected/rolled-back Web transaction can restore the exact unchanged
		// authority state. After an ambiguous commit, only management can recover.
		rollbackUnchanged := func() {
			after, readErr := e.currentSecurityCatalog(ctx, SecurityCatalogQuery{All: true})
			if readErr != nil || securityCatalogMetadataDigest(before) != securityCatalogMetadataDigest(after) {
				return
			}
			_ = db.Transaction(func(tx *gorm.DB) error {
				for _, row := range oldRows {
					if err := tx.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND resource_id = ? AND change_id = ?", row.ProjectID, row.ResourceID, changeID).Updates(map[string]any{"state": row.State, "change_id": row.ChangeID}).Error; err != nil {
						return err
					}
				}
				return nil
			})
		}
		defer func() {
			if p := recover(); p != nil {
				rollbackUnchanged()
				panic(p)
			}
		}()
		if err = work(); err != nil {
			rollbackUnchanged()
			return err
		}
		after, err := e.currentSecurityCatalog(ctx, SecurityCatalogQuery{All: true})
		if err != nil {
			return err
		}
		return db.Transaction(func(tx *gorm.DB) error {
			filtered := SecurityCatalogView{}
			needed := map[string]bool{}
			for _, resource := range after.Resources {
				if selected[resource.ID] || !beforeIDs[resource.ID] {
					filtered.Resources = append(filtered.Resources, resource)
					for _, id := range resource.CredentialIDs {
						needed[id] = true
					}
				}
			}
			for _, ref := range after.Credentials {
				if needed[ref.ID] {
					filtered.Credentials = append(filtered.Credentials, ref)
				}
			}
			refs, err := catalogCredentialsTx(tx, storeID, epoch, filtered, true)
			if err != nil {
				return err
			}
			seen := map[string]bool{}
			prior := map[string]securityResourceRevisionRow{}
			for _, row := range oldRows {
				prior[row.ResourceID] = row
			}
			for _, resource := range filtered.Resources {
				seen[resource.ID] = true
				digest, _, err := catalogConnectionDigest(resource, refs)
				if err != nil {
					return err
				}
				var old securityResourceRevisionRow
				err = tx.First(&old, "project_id = ? AND resource_id = ?", resource.ProjectID, resource.ID).Error
				state := "ready"
				if resource.Disabled {
					state = "disabled"
				}
				if errors.Is(err, gorm.ErrRecordNotFound) {
					row := securityResourceRevisionRow{ProjectID: resource.ProjectID, ResourceID: resource.ID, StoreID: storeID, RecoveryEpoch: epoch, ConnectionDigest: digest, State: state, ConnectionRevision: 1, Local: resource.Local, Kind: resource.Kind, MetadataDigest: resource.MetadataDigest, CredentialIDs: js(resource.CredentialIDs), ConnectionIdentity: resource.ConnectionIdentity}
					if err = tx.Create(&row).Error; err != nil {
						return err
					}
					continue
				}
				if err != nil {
					return err
				}
				if old.ChangeID != changeID {
					return security.ErrConflict
				}
				revision := old.ConnectionRevision
				if old.ConnectionDigest != digest || old.Local != resource.Local || old.Kind != resource.Kind || prior[resource.ID].State != state {
					revision++
				}
				if err = tx.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND resource_id = ? AND change_id = ?", resource.ProjectID, resource.ID, changeID).Updates(map[string]any{"connection_revision": revision, "connection_digest": digest, "metadata_digest": resource.MetadataDigest, "credential_ids": js(resource.CredentialIDs), "connection_identity": resource.ConnectionIdentity, "local": resource.Local, "kind": resource.Kind, "state": state, "change_id": ""}).Error; err != nil {
					return err
				}
			}
			for _, row := range oldRows {
				if !seen[row.ResourceID] {
					if err := tx.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND resource_id = ? AND change_id = ?", row.ProjectID, row.ResourceID, changeID).Updates(map[string]any{"state": "disabled", "change_id": "", "connection_revision": gorm.Expr("connection_revision + 1")}).Error; err != nil {
						return err
					}
				}
			}
			return nil
		})
	})
}

type securityCatalogSnapshotKey struct{}

func (e *Engine) bindCurrentCatalogSnapshot(ctx context.Context, tx *gorm.DB, o security.PreparedOperation) (*gorm.DB, error) {
	write := false
	for _, capability := range o.Capabilities {
		if !securityReadOnlyCapability(capability) {
			write = true
		}
	}
	view, err := e.currentSecurityCatalog(ctx, SecurityCatalogQuery{ProjectID: o.ProjectID, SessionID: o.SessionID, ResourceIDs: securityCatalogResources(o.Resources), TerminalID: o.TerminalID, MCPServerID: o.MCPServerID, MCPToolName: o.MCPToolName, MCPDiscovery: o.Tool == "list_mcp_servers", Write: write})
	if err != nil {
		return nil, err
	}
	if o.Tool == "list_mcp_servers" {
		var bindings []securityMCPBindingRow
		if err = tx.Where("project_id = ? AND store_id = ? AND recovery_epoch = ? AND enabled = ?", o.ProjectID, o.StoreID, o.RecoveryEpoch, true).Find(&bindings).Error; err != nil {
			return nil, err
		}
		for _, binding := range bindings {
			view.MCPAllowedServerIDs = append(view.MCPAllowedServerIDs, binding.ServerID)
		}
	}
	if o.MCPServerID != "" {
		var binding securityMCPBindingRow
		if err := tx.First(&binding, "project_id = ? AND server_id = ? AND store_id = ? AND recovery_epoch = ? AND enabled = ?", o.ProjectID, o.MCPServerID, o.StoreID, o.RecoveryEpoch, true).Error; err != nil {
			return nil, err
		}
		if err := decodeSecurityJSON(binding.ToolNames, &view.MCPAllowedToolNames); err != nil {
			return nil, err
		}
	}
	return tx.Set("lake_security_catalog", view).Session(&gorm.Session{}), nil
}

func applyCurrentCatalogSnapshot(tx *gorm.DB, o security.PreparedOperation, in *security.EvaluationInput) error {
	value, present := tx.Get("lake_security_catalog")
	if !present {
		for _, resource := range o.Resources {
			var row securityResourceRevisionRow
			if err := tx.First(&row, "project_id = ? AND resource_id = ?", o.ProjectID, resource.ID).Error; err != nil {
				return err
			}
			if row.MetadataDigest != "" {
				return ErrSecurityCatalogUnavailable
			}
		}
		if o.TerminalID != "" || o.MCPServerID != "" || len(o.Credentials) > 0 {
			return ErrSecurityCatalogUnavailable
		}
		return nil
	}
	view, ok := value.(SecurityCatalogView)
	if !ok {
		return ErrSecurityCatalogUnavailable
	}
	in.SessionDenyLocal = view.HardLocalDeny
	in.LocalExecution = view.MCPLocal
	for _, resource := range view.Resources {
		if resource.Local {
			in.LocalExecution = true
		}
	}
	refs, err := catalogCredentialsTx(tx, o.StoreID, o.RecoveryEpoch, view, false)
	if err != nil {
		return err
	}
	if len(view.Resources) != len(o.Resources) {
		return ErrSecurityCatalogUnavailable
	}
	for _, resource := range view.Resources {
		if resource.ProjectID != o.ProjectID || resource.Disabled {
			return security.ErrConflict
		}
		var row securityResourceRevisionRow
		if err = tx.First(&row, "project_id = ? AND resource_id = ?", o.ProjectID, resource.ID).Error; err != nil {
			return err
		}
		digest, _, err := catalogConnectionDigest(resource, refs)
		if err != nil {
			return err
		}
		if row.State != "ready" || row.StoreID != o.StoreID || row.RecoveryEpoch != o.RecoveryEpoch || row.MetadataDigest != resource.MetadataDigest || row.ConnectionDigest != digest || row.ConnectionIdentity != resource.ConnectionIdentity {
			return security.ErrConflict
		}
	}
	for _, ref := range refs {
		in.CredentialRevisions = append(in.CredentialRevisions, ref)
	}
	in.TerminalGeneration, in.TerminalContextRevision = view.TerminalGeneration, view.TerminalContextRevision
	if o.TerminalID != view.TerminalID {
		return security.ErrConflict
	}
	if o.TerminalID != "" {
		found := false
		for _, resource := range o.Resources {
			if resource.ID == view.TerminalResourceID {
				found = true
			}
		}
		if !found {
			return security.ErrConflict
		}
	}
	if o.MCPServerID != "" {
		var binding securityMCPBindingRow
		if err = tx.First(&binding, "project_id = ? AND server_id = ? AND store_id = ? AND recovery_epoch = ? AND enabled = ?", o.ProjectID, o.MCPServerID, o.StoreID, o.RecoveryEpoch, true).Error; err != nil {
			return err
		}
		var allowed []string
		if err = decodeSecurityJSON(binding.ToolNames, &allowed); err != nil {
			return err
		}
		if o.MCPToolName != "" && !slices.Contains(allowed, o.MCPToolName) {
			return errors.New("security: MCP tool outside project binding")
		}
		var row securityMCPRevisionRow
		if err = tx.First(&row, "id = ?", o.MCPServerID).Error; err != nil {
			return err
		}
		if row.StoreID != o.StoreID || row.RecoveryEpoch != o.RecoveryEpoch || row.State != "ready" || !row.Enabled || !view.MCPEnabled || row.MetadataDigest != view.MCPMetadataDigest || row.StorageDigest != view.MCPStorageDigest {
			return security.ErrConflict
		}
		var tools []string
		if err = json.Unmarshal([]byte(row.ToolNames), &tools); err != nil {
			return err
		}
		if o.MCPToolName != "" && !slices.Contains(tools, o.MCPToolName) {
			return errors.New("security: MCP tool missing from current catalog")
		}
		in.MCPBindingRevision = binding.Revision
		view.MCPAllowedToolNames = slices.Clone(allowed)
		tx.Set("lake_security_catalog", view).Session(&gorm.Session{})
		in.MCPServerID, in.MCPToolName, in.MCPConfigRevision, in.MCPCatalogRevision = view.MCPServerID, view.MCPToolName, row.ConfigRevision, row.CatalogRevision
	}
	return nil
}

func (e *Engine) SecurityCatalogResources(ctx context.Context, projectID string) ([]security.ResourceRevision, error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return nil, err
	}
	var rows []securityResourceRevisionRow
	if err = db.WithContext(ctx).Where("project_id = ? AND store_id = ? AND recovery_epoch = ?", projectID, storeID, epoch).Order("resource_id").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]security.ResourceRevision, 0, len(rows))
	for _, r := range rows {
		out = append(out, security.ResourceRevision{ID: r.ResourceID, ConnectionRevision: r.ConnectionRevision, ConnectionDigest: r.ConnectionDigest, State: r.State, Local: r.Local, ConnectionIdentity: r.ConnectionIdentity})
	}
	return out, nil
}

func (e *Engine) ExecuteSecurityMCP(ctx context.Context, name string, args map[string]any) (any, error) {
	permit, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	if permit == nil || permit.prepared == nil || permit.operation.Tool != name || hash(js(args)) != permit.operation.ArgumentsDigest {
		return nil, errors.New("security: exact MCP permit required")
	}
	if name != "list_mcp_servers" && name != "list_mcp_tools" && name != "call_mcp_tool" {
		return nil, errors.New("security: unsupported MCP operation")
	}
	var frozen SecurityMCPExecutor
	var allowed, allowedTools []string
	err := e.validateSecurityPermitAtIO(ctx, permit.operation.ProjectID, permit.operation.SessionID, func(view SecurityCatalogView) error {
		if view.MCPFactory == nil {
			return ErrSecurityCatalogUnavailable
		}
		var err error
		frozen, err = view.MCPFactory.Freeze(ctx)
		allowed = slices.Clone(view.MCPAllowedServerIDs)
		allowedTools = slices.Clone(view.MCPAllowedToolNames)
		return err
	})
	if err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	result, err := frozen.Execute(ctx, name, args)
	if err != nil {
		return nil, err
	}
	if name == "list_mcp_servers" {
		value := obj(result)
		rows := []map[string]any{}
		if entries, ok := value["servers"].([]map[string]any); ok {
			for _, entry := range entries {
				if slices.Contains(allowed, str(entry["id"])) {
					rows = append(rows, entry)
				}
			}
		}
		return map[string]any{"servers": rows}, nil
	}
	if name == "list_mcp_tools" {
		if err = e.RecordSecurityMCPCatalog(ctx, permit.operation.MCPServerID, permit.operation.MCPConfigRevision, obj(result)); err != nil {
			return nil, err
		}
		value := obj(result)
		var entries []map[string]any
		if json.Unmarshal([]byte(js(value["tools"])), &entries) != nil {
			return nil, errors.New("security: malformed MCP catalog")
		}
		filtered := []map[string]any{}
		for _, entry := range entries {
			if slices.Contains(allowedTools, str(entry["name"])) {
				filtered = append(filtered, entry)
			}
		}
		value["tools"] = filtered
		result = value
	}
	return result, nil
}

type SecurityMCPUpdate struct {
	ID, MetadataDigest, StorageDigest   string
	Enabled, Deleted, ConnectionChanged bool
}

func (e *Engine) BootstrapSecurityMCP(ctx context.Context, updates []SecurityMCPUpdate) error {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return e.withSecurityDispatchBarrier(func() error {
		return db.Transaction(func(tx *gorm.DB) error {
			for _, update := range updates {
				var row securityMCPRevisionRow
				err := tx.First(&row, "id = ?", update.ID).Error
				if errors.Is(err, gorm.ErrRecordNotFound) {
					row = securityMCPRevisionRow{ID: update.ID, StoreID: storeID, RecoveryEpoch: epoch, MetadataDigest: update.MetadataDigest, StorageDigest: update.StorageDigest, ConfigRevision: 1, Enabled: update.Enabled, State: "ready", ToolNames: "[]"}
					var bindings int64
					if err := tx.Model(&securityMCPBindingRow{}).Where("server_id = ?", update.ID).Count(&bindings).Error; err != nil {
						return err
					}
					if bindings > 0 {
						row.State = "changing"
					}
					if err := tx.Create(&row).Error; err != nil {
						return err
					}
					continue
				}
				if err != nil {
					return err
				}
				if row.StoreID != storeID || row.RecoveryEpoch != epoch {
					return security.ErrConflict
				}
				if row.MetadataDigest == update.MetadataDigest && row.StorageDigest == update.StorageDigest && row.Enabled == update.Enabled {
					continue
				}
				var configured int64
				if err := tx.Model(&securityMCPBindingRow{}).Where("server_id = ? AND project_id IN (SELECT project_id FROM security_project_policies)", row.ID).Count(&configured).Error; err != nil {
					return err
				}
				if configured > 0 {
					if err := tx.Model(&securityMCPRevisionRow{}).Where("id = ?", row.ID).Updates(map[string]any{"state": "changing", "change_id": "startup-" + uid()}).Error; err != nil {
						return err
					}
					continue
				}
				if err := tx.Model(&securityMCPRevisionRow{}).Where("id = ?", row.ID).Updates(map[string]any{"metadata_digest": update.MetadataDigest, "storage_digest": update.StorageDigest, "enabled": update.Enabled, "config_revision": row.ConfigRevision + 1, "catalog_revision": row.CatalogRevision + 1, "tool_names": "[]", "catalog_digest": "", "state": "ready", "change_id": ""}).Error; err != nil {
					return err
				}
			}
			return nil
		})
	})
}

func (e *Engine) MutateSecurityMCP(ctx context.Context, ids []string, beforeStorage string, work func() ([]SecurityMCPUpdate, error)) error {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return e.withSecurityDispatchBarrier(func() error {
		var before []securityMCPRevisionRow
		if err = db.Where("store_id = ? AND recovery_epoch = ?", storeID, epoch).Find(&before).Error; err != nil {
			return err
		}
		for _, row := range before {
			if row.State == "ready" && row.StorageDigest != "" && row.StorageDigest != beforeStorage {
				return errors.New("security: MCP storage changed outside trusted configuration action")
			}
		}
		changeID := uid()
		if err = db.Transaction(func(tx *gorm.DB) error {
			for _, id := range ids {
				var row securityMCPRevisionRow
				readErr := tx.First(&row, "id = ?", id).Error
				if errors.Is(readErr, gorm.ErrRecordNotFound) {
					if err := tx.Create(&securityMCPRevisionRow{ID: id, StoreID: storeID, RecoveryEpoch: epoch, State: "changing", ChangeID: changeID, ToolNames: "[]"}).Error; err != nil {
						return err
					}
				} else if readErr != nil {
					return readErr
				} else {
					if row.State == "changing" || row.StoreID != storeID || row.RecoveryEpoch != epoch {
						return security.ErrConflict
					}
					if err := tx.Model(&securityMCPRevisionRow{}).Where("id = ?", id).Updates(map[string]any{"state": "changing", "change_id": changeID}).Error; err != nil {
						return err
					}
				}
			}
			return nil
		}); err != nil {
			return err
		}
		updates, err := work()
		if err != nil {
			// Restore only when the trusted local adapter proves the exact
			// pre-write file identity remains; uncertain outcomes stay changing.
			if len(updates) == len(ids) {
				safe := true
				for _, update := range updates {
					if update.StorageDigest != beforeStorage || update.ConnectionChanged {
						safe = false
					}
				}
				if safe {
					restoreErr := db.Transaction(func(tx *gorm.DB) error {
						for _, id := range ids {
							var old *securityMCPRevisionRow
							for i := range before {
								if before[i].ID == id {
									old = &before[i]
								}
							}
							if old == nil {
								if deleteErr := tx.Where("id = ? AND change_id = ?", id, changeID).Delete(&securityMCPRevisionRow{}).Error; deleteErr != nil {
									return deleteErr
								}
							} else {
								if restoreErr := tx.Model(&securityMCPRevisionRow{}).Where("id = ? AND change_id = ?", id, changeID).Updates(map[string]any{"state": old.State, "change_id": old.ChangeID}).Error; restoreErr != nil {
									return restoreErr
								}
							}
						}
						return nil
					})
					if restoreErr != nil {
						return restoreErr
					}
				}
			}
			return err
		}
		return db.Transaction(func(tx *gorm.DB) error {
			storage := ""
			for _, update := range updates {
				if !slices.Contains(ids, update.ID) {
					return security.ErrConflict
				}
				if storage != "" && storage != update.StorageDigest {
					return security.ErrConflict
				}
				storage = update.StorageDigest
				var row securityMCPRevisionRow
				if err := tx.First(&row, "id = ? AND change_id = ?", update.ID, changeID).Error; err != nil {
					return err
				}
				revision := row.ConfigRevision
				if revision == 0 || update.ConnectionChanged || row.MetadataDigest != update.MetadataDigest || row.Enabled != update.Enabled {
					revision++
				}
				changes := map[string]any{"metadata_digest": update.MetadataDigest, "storage_digest": update.StorageDigest, "enabled": update.Enabled, "config_revision": revision, "state": "ready", "change_id": ""}
				if update.Deleted {
					changes["state"] = "disabled"
				}
				if revision != row.ConfigRevision {
					changes["catalog_revision"] = row.CatalogRevision + 1
					changes["tool_names"] = "[]"
					changes["catalog_digest"] = ""
				}
				if err := tx.Model(&securityMCPRevisionRow{}).Where("id = ? AND change_id = ?", update.ID, changeID).Updates(changes).Error; err != nil {
					return err
				}
			}
			if storage != "" {
				return tx.Model(&securityMCPRevisionRow{}).Where("store_id = ? AND recovery_epoch = ?", storeID, epoch).Update("storage_digest", storage).Error
			}
			return nil
		})
	})
}

func (e *Engine) RecordSecurityMCPCatalog(ctx context.Context, serverID string, expectedConfigRevision int64, result map[string]any) error {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	names := []string{}
	var rows []map[string]any
	raw := js(result["tools"])
	if json.Unmarshal([]byte(raw), &rows) != nil {
		return errors.New("security: invalid MCP catalog")
	}
	if len(rows) > 500 {
		return errors.New("security: MCP catalog exceeds limit")
	}
	for _, row := range rows {
		if name := str(row["name"]); name != "" {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	if len(slices.Compact(slices.Clone(names))) != len(names) {
		return errors.New("security: duplicate MCP tool identity")
	}
	digest := hash(js(names))
	return e.withSecurityDispatchBarrier(func() error {
		return db.Transaction(func(tx *gorm.DB) error {
			var row securityMCPRevisionRow
			if err := tx.First(&row, "id = ? AND store_id = ? AND recovery_epoch = ? AND state = ?", serverID, storeID, epoch, "ready").Error; err != nil {
				return err
			}
			if row.ConfigRevision != expectedConfigRevision {
				return security.ErrConflict
			}
			return tx.Model(&securityMCPRevisionRow{}).Where("id = ? AND config_revision = ?", serverID, row.ConfigRevision).Updates(map[string]any{"catalog_revision": row.CatalogRevision + 1, "catalog_digest": digest, "tool_names": js(names)}).Error
		})
	})
}

// PrepareCatalogOperation resolves only host-owned identities and local
// metadata. An adapter without a demonstrated effect proof stays opaque.
func (e *Engine) PrepareCatalogOperation(ctx context.Context, sessionID string, c Config, call Call, a map[string]any) (returned *SecurityPreparedOperation, returnedDecision security.Decision, returnedErr error) {
	c = e.securityProtectedConfig(c)
	c.AuthSecrets = append(slices.Clone(c.AuthSecrets), e.securityHostSecretSnapshot()...)
	phase := "execution identity"
	defer func() {
		if returnedErr != nil {
			returnedErr = fmt.Errorf("security: catalog preparation %s: %w", phase, returnedErr)
		}
	}()
	var decision security.Decision
	execution, err := e.CurrentSecurityExecution(ctx, sessionID)
	if err != nil {
		return nil, decision, err
	}
	if !execution.Managed || execution.GoalID == "" || execution.StepID == "" || execution.AttemptID == "" {
		return nil, decision, errors.New("security: goal/step/attempt binding required: read the current goal with work_read; after plan confirmation, call work_update with its actual item_id and status=running before resource I/O. Do not invent goal, step or attempt IDs")
	}
	spec, ok := security.LookupTool(call.Name)
	if !ok {
		return nil, decision, errors.New("security: unregistered tool")
	}
	terminalID := str(a["terminal_id"])
	terminalTool := strings.HasPrefix(call.Name, "terminal_") || strings.HasPrefix(call.Name, "ssh_terminal_") || call.Name == "shell" || call.Name == "read_terminal_screen" || call.Name == "close_ssh_terminal"
	if terminalTool && terminalID == "" {
		terminalID = c.TerminalID
	}
	if !terminalTool {
		terminalID = ""
	}
	phase = "current catalog"
	view, err := e.currentSecurityCatalog(ctx, SecurityCatalogQuery{ProjectID: execution.ProjectID, SessionID: execution.SessionID, All: true, TerminalID: terminalID})
	if err != nil {
		return nil, decision, err
	}
	if len(view.ExecutionAssets) == 0 && (spec.TargetKind == security.TargetResource || spec.TargetKind == security.TargetResourceSet) {
		return nil, decision, ErrSecurityCatalogUnavailable
	}
	allowedAssets := map[string]bool{}
	for _, resource := range c.Assets {
		allowedAssets[resource.ID] = true
	}
	freshAssets := []Asset{}
	for _, resource := range view.ExecutionAssets {
		if allowedAssets[resource.ID] {
			freshAssets = append(freshAssets, resource)
		}
	}
	c.Assets = freshAssets
	expectedMetadata := map[string]string{}
	for _, resource := range view.Resources {
		expectedMetadata[resource.ID] = resource.MetadataDigest
	}
	raw, err := json.Marshal(a)
	if err != nil {
		return nil, decision, err
	}
	for _, secret := range append(slices.Clone(c.AuthSecrets), c.Model.Key) {
		if secret != "" && strings.Contains(string(raw), secret) {
			return nil, decision, errors.New("security: credential material forbidden in tool parameters")
		}
	}
	var frozenArgs map[string]any
	if err = json.Unmarshal(raw, &frozenArgs); err != nil {
		return nil, decision, err
	}
	phase = "work goal"
	_, goal, err := e.workRow(execution.SessionID, execution.GoalID)
	if err != nil {
		return nil, decision, err
	}
	if goal.closure == nil {
		return nil, decision, errors.New("security: acceptance contract required")
	}
	step, exists := goal.closure.Steps[execution.StepID]
	if !exists {
		return nil, decision, errWorkConflict
	}
	owner := execution.Owner
	if e.worker != nil {
		phase = "parent scope"
		if err = e.bindCatalogParentRestriction(ctx, execution, c); err != nil {
			return nil, decision, err
		}
	}
	op := security.PreparedOperation{FormatVersion: security.DescriptorVersion, ID: hash(execution.SessionID + "\x00" + owner.ScopeID + "\x00" + owner.RootTurnID + "\x00" + call.ID), Actor: "agent", StoreID: execution.Task.StoreID, RecoveryEpoch: execution.Task.RecoveryEpoch, ProjectID: execution.ProjectID, SessionID: execution.SessionID, GoalID: execution.GoalID, GoalRevision: goal.closure.GoalRevision, PlanRevision: goal.closure.PlanRevision, StepID: execution.StepID, StepRevision: step.Revision, AttemptID: execution.AttemptID, TaskID: execution.Task.ID, ExecutionRevision: execution.Task.ExecutionRevision, RootTurnID: owner.RootTurnID, ChildScopeID: owner.ScopeID, CallID: call.ID, Tool: call.Name, RegistryVersion: security.RegistryVersion, TargetKind: spec.TargetKind, Capabilities: spec.Capabilities, Proof: spec.Proof, ArgumentsDigest: hash(js(frozenArgs)), PreviewDigest: hash(js(frozenArgs)), OwnerID: owner.OwnerID, OwnerGeneration: owner.Generation}
	if execution.Task.Kind == "workflow" || execution.Task.Kind == "schedule" {
		op.Actor = execution.Task.Kind
	}
	if owner.ScopeID != "" {
		op.Actor = "child"
	}
	if c.sre != nil {
		phase = "SRE operation source"
		repository := e.sreRepository
		if repository == nil && e.worker != nil {
			repository = e.worker.parent.sreRepository
		}
		if repository == nil {
			return nil, decision, errors.New("security: original SRE operation repository required")
		}
		task, loadErr := repository.LoadSRETask(execution.SessionID, c.sre.TaskID)
		if loadErr != nil {
			return nil, decision, loadErr
		}
		registered := ""
		for _, attempt := range task.Attempts {
			if attempt.ID == c.sre.AttemptID {
				for _, operation := range attempt.Operations {
					if operation.Call.ID == call.ID {
						registered = operation.ID
					}
				}
			}
		}
		if registered == "" {
			return nil, decision, errors.New("security: original SRE operation binding required")
		}
		op.ID = registered
	}
	for _, key := range []string{"command", "input", "initial_input"} {
		if CatastrophicCommand(str(frozenArgs[key])) {
			op.RequireSingleConfirmation = true
		}
	}
	if call.Name == "delete" && CatastrophicDelete(str(frozenArgs["path"])) {
		op.RequireSingleConfirmation = true
	}
	op.TerminalID = str(a["terminal_id"])
	if op.TerminalID == "" {
		op.TerminalID = c.TerminalID
	}
	// Non-terminal tools must not borrow a historical terminal's authority.
	if !strings.HasPrefix(call.Name, "terminal_") && !strings.HasPrefix(call.Name, "ssh_terminal_") && call.Name != "shell" && call.Name != "read_terminal_screen" && call.Name != "close_ssh_terminal" {
		op.TerminalID = ""
	}
	if call.Name == "call_mcp_tool" || call.Name == "list_mcp_tools" {
		op.MCPServerID, op.MCPToolName = str(a["server_id"]), str(a["tool"])
	}
	var selected Asset
	if spec.TargetKind == security.TargetResource || spec.TargetKind == security.TargetResourceSet {
		refs := []string{}
		if ref := str(a["asset_ref"]); ref != "" {
			refs = append(refs, ref)
		}
		if spec.TargetKind == security.TargetResourceSet {
			for _, key := range []string{"source_asset_ref", "target_asset_ref", "from_asset_ref", "to_asset_ref"} {
				if ref := str(a[key]); ref != "" {
					refs = append(refs, ref)
				}
			}
		}
		if len(refs) == 0 && view.TerminalResourceID != "" {
			refs = []string{view.TerminalResourceID}
		}
		if len(refs) == 0 {
			target, targetErr := e.SecurityTarget(ctx, execution.ProjectID, execution.SessionID)
			if targetErr != nil {
				return nil, decision, targetErr
			}
			if target.Pending != nil || target.Current == nil || len(target.Current.ResourceIDs) != 1 {
				return nil, decision, errors.New("security: TARGET_REQUIRED: specify asset_ref from list_assets for this operation; runtime=local alone does not identify a resource. If the intended resource is already clear, retry with its exact catalog alias; otherwise ask which resource to use")
			}
			refs = target.Current.ResourceIDs
		}
		seen := map[string]bool{}
		for _, ref := range refs {
			resource, resolveErr := asset(c, ref)
			if resolveErr != nil {
				return nil, decision, resolveErr
			}
			if seen[resource.ID] {
				continue
			}
			seen[resource.ID] = true
			op.Resources = append(op.Resources, security.ResourceRevision{ID: resource.ID, Local: resource.Kind == "local"})
			if selected.ID == "" {
				selected = resource
			}
			if resource.Kind == "local" && !slices.Contains(op.Capabilities, "local.execute") {
				op.Capabilities = append(op.Capabilities, "local.execute")
			}
		}
		if view.TerminalResourceID != "" && (len(op.Resources) != 1 || op.Resources[0].ID != view.TerminalResourceID) {
			return nil, decision, errors.New("security: explicit terminal and resource do not match")
		}
		if selected.ID != "" {
			frozenArgs["asset_ref"] = assetAlias(selected.ID)
			c.AssetRef = assetAlias(selected.ID)
			if selected.Kind == "local" || selected.Kind == "ssh" {
				c.Runtime = selected.Kind
			}
		}
	}
	switch call.Name {
	case "shell", "inspect_host", "ls", "glob", "grep", "read", "edit", "multi_edit", "append", "write", "delete":
		if requested := str(frozenArgs["runtime"]); requested != "" {
			expected := selected.Kind
			if selected.Kind == "docker" {
				expected = "container"
			}
			if requested != expected {
				return nil, decision, errors.New("security: runtime does not match actual selected asset")
			}
		}
	}
	var command *security.FrozenCommand
	if call.Name == "shell" || call.Name == "terminal_execute_command" {
		profile := ""
		switch strings.TrimSpace(str(a["command"])) {
		case "df -h", "df -kP", "df -k -P":
			profile = "disk_usage"
		case "ps aux", "ps -eo pid,ppid,pcpu,pmem,comm":
			profile = "process_snapshot"
		}
		explicit := str(a["command_profile_id"])
		if explicit != "" {
			if strings.TrimSpace(str(a["command"])) != "" && profile != explicit {
				return nil, decision, errors.New("security: typed profile rejects conflicting raw Shell text; pass empty command")
			}
			profile = explicit
		}
		if profile != "" {
			compiled, compileErr := e.compileSecurityCommandProfile(ctx, c, &op, frozenArgs, selected, profile)
			if compileErr != nil {
				if explicit != "" || selected.Kind == "local" {
					return nil, decision, compileErr
				}
				op.Proof = security.ProofOpaque
			} else {
				command = compiled
			}
		} else {
			op.Proof = security.ProofOpaque
		}
	}
	for _, capability := range op.Capabilities {
		switch capability {
		case "file.read", "file.write", "file.delete":
			op.Scope.FilePath = str(a["path"])
			if op.Scope.FilePath == "" {
				op.Scope.FilePath = str(a["file_path"])
			}
			op.Scope.ExpectedContentHash = str(a["expected_content_hash"])
			op.Proof = security.ProofOpaque
		case "db.read", "db.write":
			op.Scope.DatabaseID = str(selected.Settings["database"])
			op.Scope.Schema = str(a["schema"])
			op.Scope.MaxRows = int64(num(a["limit"], 0))
			op.Scope.MaxDurationMS = int64(num(a["timeout_ms"], 0))
			op.Proof = security.ProofOpaque
		case "cluster.read", "cluster.logs", "cluster.write":
			op.Scope.ClusterID = selected.ID
			op.Scope.Namespace = str(a["namespace"])
			op.Scope.ResourceKind = str(a["resource"])
			op.Scope.Verb = str(a["verb"])
			op.Scope.LogLines = int64(num(a["tail"], 0))
			op.Scope.LogSeconds = int64(num(a["since_seconds"], 0))
			op.Proof = security.ProofOpaque
		case "network.fetch":
			op.Proof = security.ProofOpaque
		}
	}
	if call.Name == "observe_host" || call.Name == "inspect_host" || call.Name == "observe_journal" {
		op.Proof = security.ProofOpaque
	}
	phase = "bounded file preparation"
	if _, fileErr := e.prepareSecurityLocalFile(c, &op, frozenArgs); fileErr != nil {
		return nil, decision, fileErr
	}
	phase = "fixed read probe preparation"
	readProbe, probeErr := e.prepareSecurityReadProbe(ctx, c, &op, frozenArgs)
	if probeErr != nil {
		return nil, decision, probeErr
	}
	// A profile's original Shell text is never executed; the dispatcher uses
	// only this frozen executable/argv object.
	op.ArgumentsDigest, op.PreviewDigest = hash(js(frozenArgs)), hash(js(frozenArgs))
	frozenProcess := command
	if readProbe != nil {
		readProbe.argumentsDigest = op.ArgumentsDigest
		if frozenProcess == nil {
			frozenProcess = readProbe.command
		}
	}
	if frozenProcess != nil {
		actual := struct {
			Executable             string
			Arguments, Environment []string
			Directory              string
		}{frozenProcess.Executable(), frozenProcess.Arguments(), frozenProcess.Environment(), frozenProcess.Directory()}
		op.ArgumentsDigest = hash(js(actual))
		op.PreviewDigest = op.ArgumentsDigest
	}
	phase = "final authority snapshot"
	prepared, decision, err := e.PrepareSecurityOperation(ctx, SecurityOperationPreparation{Operation: op, Owner: owner, expectedMetadata: expectedMetadata, frozenResources: execution.FrozenResources})
	if err == nil {
		prepared.executionArgs, prepared.executionConfig, prepared.command = frozenArgs, c, command
		prepared.read = readProbe
	}
	return prepared, decision, err
}

func (e *Engine) SetSecurityCatalogResolver(resolver SecurityCatalogResolver) error {
	_, err := e.adkStore()
	if err != nil {
		return err
	}
	owner := e
	for owner.workParent != nil || owner.worker != nil {
		if owner.workParent != nil {
			owner = owner.workParent
		} else {
			owner = owner.worker.parent
		}
	}
	owner.adkMu.Lock()
	services := owner.adk
	owner.adkMu.Unlock()
	if services == nil {
		return ErrSecurityCatalogUnavailable
	}
	services.catalogMu.Lock()
	services.catalogResolver = resolver
	services.catalogMu.Unlock()
	return nil
}

func (e *Engine) currentSecurityCatalog(ctx context.Context, query SecurityCatalogQuery) (SecurityCatalogView, error) {
	owner := e
	for owner.workParent != nil || owner.worker != nil {
		if owner.workParent != nil {
			owner = owner.workParent
		} else {
			owner = owner.worker.parent
		}
	}
	owner.adkMu.Lock()
	services := owner.adk
	owner.adkMu.Unlock()
	if services == nil {
		return SecurityCatalogView{}, ErrSecurityCatalogUnavailable
	}
	services.catalogMu.RLock()
	resolver := services.catalogResolver
	services.catalogMu.RUnlock()
	if resolver == nil {
		return SecurityCatalogView{}, ErrSecurityCatalogUnavailable
	}
	return resolver(ctx, query)
}

func securityCatalogResources(resources []security.ResourceRevision) []string {
	ids := make([]string, 0, len(resources))
	for _, r := range resources {
		ids = append(ids, r.ID)
	}
	return ids
}

// Running operations keep the exact original catalog authority. This is a
// revocation check only; it never grants a replacement endpoint or spends uses.
func runningCatalogAuthorityValid(tx *gorm.DB, o security.PreparedOperation) (bool, error) {
	if o.CommandProfileID != "" {
		if len(o.Resources) != 1 {
			return false, nil
		}
		target, err := loadSecurityCommandTarget(tx, o.ProjectID, o.Resources[0].ID, o.StoreID, o.RecoveryEpoch)
		if err != nil {
			return false, err
		}
		if !target.Enabled || target.Revision != o.CommandTargetRevision {
			return false, nil
		}
	}
	if o.LegacyPolicyRevision > 0 {
		var legacy securityLegacySessionPolicyRow
		if err := tx.First(&legacy, "session_id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ?", o.SessionID, o.ProjectID, o.StoreID, o.RecoveryEpoch).Error; err != nil {
			return false, err
		}
		if legacy.Revision != o.LegacyPolicyRevision {
			return false, nil
		}
	}
	for _, resource := range o.Resources {
		var row securityResourceRevisionRow
		err := tx.First(&row, "project_id = ? AND resource_id = ? AND store_id = ? AND recovery_epoch = ?", o.ProjectID, resource.ID, o.StoreID, o.RecoveryEpoch).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if row.State != "ready" || row.ConnectionRevision != resource.ConnectionRevision || row.ConnectionDigest != resource.ConnectionDigest || row.ConnectionIdentity != resource.ConnectionIdentity || row.Local != resource.Local {
			return false, nil
		}
	}
	for _, credential := range o.Credentials {
		var row securityCredentialRevisionRow
		err := tx.First(&row, "id = ? AND store_id = ? AND recovery_epoch = ?", credential.Reference, o.StoreID, o.RecoveryEpoch).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if row.State != "ready" || row.Revision != credential.Revision {
			return false, nil
		}
	}
	if o.MCPServerID != "" {
		var server securityMCPRevisionRow
		err := tx.First(&server, "id = ? AND store_id = ? AND recovery_epoch = ?", o.MCPServerID, o.StoreID, o.RecoveryEpoch).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if server.State != "ready" || !server.Enabled || server.ConfigRevision != o.MCPConfigRevision || server.CatalogRevision != o.MCPCatalogRevision {
			return false, nil
		}
		var binding securityMCPBindingRow
		err = tx.First(&binding, "project_id = ? AND server_id = ? AND store_id = ? AND recovery_epoch = ?", o.ProjectID, o.MCPServerID, o.StoreID, o.RecoveryEpoch).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if !binding.Enabled || binding.Revision != o.MCPBindingRevision {
			return false, nil
		}
		var allowed []string
		if err = decodeSecurityJSON(binding.ToolNames, &allowed); err != nil {
			return false, err
		}
		if o.MCPToolName != "" && !slices.Contains(allowed, o.MCPToolName) {
			return false, nil
		}
	}
	return true, nil
}
