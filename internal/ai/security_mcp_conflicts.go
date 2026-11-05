package ai

import (
	"encoding/json"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// User-approved isolation policy: remote MCP conflicts are scoped to the
// frozen server ID across projects, rather than unrelated asset operations.
// Unknown legacy MCP calls without a verifiable identity still block all MCP.
func checkMCPServiceWriteBlock(tx *gorm.DB, serverID string) error {
	if serverID == "" {
		return ErrUnresolvedResourceEffect
	}
	var operations []nativeOperation
	err := tx.Where("tool = ? AND (status IN ? OR (orphan_state <> '' AND risk_resolved_at IS NULL)) AND (closure_state IS NULL OR closure_state <> ?)", "call_mcp_tool", []string{"dispatched", "running", "unknown"}, "reconciled").Find(&operations).Error
	if err != nil {
		return err
	}
	for _, op := range operations {
		var descriptor security.PreparedOperation
		if json.Unmarshal([]byte(op.SecurityDescriptor), &descriptor) != nil {
			return ErrUnresolvedResourceEffect
		}
		digest, err := security.OperationDigest(descriptor)
		if err != nil || digest != op.DescriptorDigest || descriptor.ID != op.ID || descriptor.Tool != op.Tool || descriptor.CallID != op.CallID || descriptor.StoreID != op.StoreID || descriptor.RecoveryEpoch != op.RecoveryEpoch || descriptor.ProjectID != op.ProjectID || descriptor.SessionID != op.SessionID || descriptor.GoalID != op.GoalID || descriptor.TaskID != op.SecurityTaskID || descriptor.RootTurnID != op.RootTurnID || descriptor.MCPServerID == "" {
			return ErrUnresolvedResourceEffect
		}
		if descriptor.MCPServerID == serverID {
			return ErrUnresolvedResourceEffect
		}
	}
	return nil
}

// Recovery activation/write blocks remain separate. This dispatch check only
// chooses the conflict namespace for an already validated operation descriptor.
func checkSecurityOperationConflicts(tx *gorm.DB, o security.PreparedOperation) error {
	if o.Tool == "call_mcp_tool" && o.MCPServerID != "" && !o.LocalExecution && len(o.Resources) == 0 {
		return checkMCPServiceWriteBlock(tx, o.MCPServerID)
	}
	ids := securityCatalogResources(o.Resources)
	if len(ids) == 0 {
		ids = []string{""}
	}
	for _, id := range ids {
		if err := CheckResourceWriteBlock(tx, id); err != nil {
			return err
		}
	}
	return nil
}
