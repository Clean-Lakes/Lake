package ai

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// A project explicitly opts in to the shared Home catalog. Its latest decision
// is already durable in the authority ledger. Epoch transitions default to off.
type SecurityMCPInheritance struct {
	ProjectID string
	Revision  int64
	Enabled   bool
}

const securityMCPInheritanceEvent = "mcp.inheritance"

var errMCPOutsideProject = errors.New("security: MCP server or tool unavailable in current project")
var errMCPReferencedResourcesOnly = errors.New("MCP 无法验证项目资源范围；当前会话仅允许操作已引用资源")

func mcpRequiresUnrestrictedResources(tool string, local bool) bool {
	return tool == "call_mcp_tool" || tool == "list_mcp_tools" && local
}

// Keep inherited and explicit revisions disjoint so that switching authorities
// always invalidates a prepared descriptor, even if both counters equal one.
const inheritedMCPRevisionBase int64 = 1 << 50

func securityMCPInheritanceTx(tx *gorm.DB, project, store, epoch string) (SecurityMCPInheritance, error) {
	out := SecurityMCPInheritance{ProjectID: project}
	var event securityAuthorityEvent
	err := tx.Where("kind = ? AND project_id = ? AND object_id = ? AND store_id = ? AND recovery_epoch = ?", securityMCPInheritanceEvent, project, project, store, epoch).
		Order("after_revision DESC").Take(&event).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if err := decodeSecurityJSON(event.Result, &out); err != nil {
		return out, err
	}
	if out.ProjectID != project || out.Revision != event.AfterRevision || out.Revision < 1 || out.Revision >= inheritedMCPRevisionBase {
		return out, security.ErrConflict
	}
	return out, nil
}

func anySecurityMCPInheritanceTx(tx *gorm.DB, store, epoch string) (bool, error) {
	var projects []string
	if err := tx.Model(&securityAuthorityEvent{}).Where("kind = ? AND store_id = ? AND recovery_epoch = ?", securityMCPInheritanceEvent, store, epoch).
		Distinct("project_id").Pluck("project_id", &projects).Error; err != nil {
		return false, err
	}
	for _, project := range projects {
		setting, err := securityMCPInheritanceTx(tx, project, store, epoch)
		if err != nil || setting.Enabled {
			return setting.Enabled, err
		}
	}
	return false, nil
}

func (e *Engine) SecurityMCPInheritance(ctx context.Context, project string) (SecurityMCPInheritance, error) {
	db, store, epoch, err := e.securityTaskDB()
	if err != nil {
		return SecurityMCPInheritance{}, err
	}
	return securityMCPInheritanceTx(db.WithContext(ctx), project, store, epoch)
}

func (e *Engine) PutSecurityMCPInheritance(ctx context.Context, a SecurityPolicyAction, enabled bool) (out SecurityMCPInheritance, err error) {
	if !validPolicyAction(a) {
		return out, errSecurityAction
	}
	db, store, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			request := js([]any{securityMCPInheritanceEvent, a, enabled})
			replay, err := securityActionReplay(tx, store, epoch, a.ActorID, a.ActionID, request, &out)
			if err != nil || replay {
				return err
			}
			if _, err := loadSecurityPolicy(tx, a.ProjectID, store, epoch); err != nil {
				return err
			}
			prior, err := securityMCPInheritanceTx(tx, a.ProjectID, store, epoch)
			if err != nil {
				return err
			}
			if prior.Revision != a.ExpectedRevision || prior.Revision >= inheritedMCPRevisionBase-1 {
				return security.ErrConflict
			}
			out = SecurityMCPInheritance{ProjectID: a.ProjectID, Revision: prior.Revision + 1, Enabled: enabled}
			return securityActionRecord(tx, store, epoch, a.ActorID, a.ActionID, securityMCPInheritanceEvent, a.ProjectID, request, prior.Revision, out.Revision, out, time.Now().UTC(), a.ProjectID)
		})
	})
	return out, err
}

type effectiveMCPBinding struct {
	ServerID  string
	Revision  int64
	ToolNames string
	Inherited bool
}

// All server configurations belong to Home. Only the current project's
// explicit binding overrides its decision to inherit. Stale bindings fail closed.
func effectiveMCPBindingsTx(tx *gorm.DB, project, store, epoch, server string, execution bool) ([]effectiveMCPBinding, error) {
	setting, err := securityMCPInheritanceTx(tx, project, store, epoch)
	if err != nil {
		return nil, err
	}
	q := tx.Table("security_mcp_revisions AS s").
		Joins("LEFT JOIN security_mcp_bindings AS b ON b.server_id=s.id AND b.project_id=?", project).
		Where("s.store_id=? AND s.recovery_epoch=?", store, epoch).
		Where("((b.store_id=? AND b.recovery_epoch=?) OR (? AND b.server_id IS NULL))", store, epoch, setting.Enabled)
	if execution {
		q = q.Where("s.state='ready' AND s.enabled=? AND (b.enabled=? OR b.server_id IS NULL)", true, true)
	}
	if server != "" {
		q = q.Where("s.id=?", server)
	}
	var rows []effectiveMCPBinding
	err = q.Select("s.id AS server_id, COALESCE(b.revision, ?) AS revision, COALESCE(b.tool_names, s.tool_names) AS tool_names, (b.server_id IS NULL) AS inherited", inheritedMCPRevisionBase+setting.Revision).Order("s.id").Scan(&rows).Error
	return rows, err
}

func effectiveMCPBindingTx(tx *gorm.DB, o security.PreparedOperation) (effectiveMCPBinding, []string, error) {
	rows, err := effectiveMCPBindingsTx(tx, o.ProjectID, o.StoreID, o.RecoveryEpoch, o.MCPServerID, true)
	if err != nil {
		return effectiveMCPBinding{}, nil, err
	}
	if len(rows) != 1 {
		return effectiveMCPBinding{}, nil, errMCPOutsideProject
	}
	b := rows[0]
	var names []string
	if err := decodeSecurityJSON(b.ToolNames, &names); err != nil {
		return b, nil, err
	}
	if o.MCPToolName != "" && !slices.Contains(names, o.MCPToolName) {
		return b, nil, errMCPOutsideProject
	}
	return b, names, nil
}

// Only public IDs for planning. Tool discovery and execution still use the
// current task, project policy, local execution rules and catalog permit.
func (e *Engine) SecurityProjectMCPServerIDs(ctx context.Context, project string) ([]string, error) {
	db, store, epoch, err := e.securityTaskDB()
	if err != nil {
		return nil, err
	}
	var ids []string
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		policy, err := loadSecurityPolicy(tx, project, store, epoch)
		if err != nil {
			return err
		}
		rule, ok := security.ResolveCapabilityRule(policy.Rules, "mcp.discover", "")
		if !ok || rule.Effect != security.EffectAllow {
			return nil
		}
		rows, err := effectiveMCPBindingsTx(tx, project, store, epoch, "", true)
		if err != nil {
			return err
		}
		for _, r := range rows {
			ids = append(ids, r.ServerID)
		}
		return nil
	})
	return ids, err
}
