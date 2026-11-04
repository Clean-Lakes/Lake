package ai

import (
	"errors"
	"slices"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// A legacy project's defaults cannot replace each session's effective settings.
// Explicit project rules only narrow. Host-inherited catalog policies express
// the old resource-level permission as the exact prepared operation's scope.
// Unknown old reference boundaries still require explicit migration confirmation.
func applyLegacySessionPolicyTx(tx *gorm.DB, in *security.EvaluationInput) error {
	if in.Policy.Mode != "legacy" {
		return nil
	}
	o := in.Operation
	var row securityLegacySessionPolicyRow
	if err := tx.First(&row, "session_id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ?", o.SessionID, o.ProjectID, o.StoreID, o.RecoveryEpoch).Error; err != nil {
		return err
	}
	if row.Revision < 1 {
		return security.ErrConflict
	}
	var permissions Permissions
	if err := decodeSecurityJSON(row.Data, &permissions); err != nil {
		return err
	}
	if permissions.BlockUnreferencedAssets && mcpRequiresUnrestrictedResources(o.Tool, in.LocalExecution) {
		return errMCPReferencedResourcesOnly
	}
	in.Policy.DenyLocal = in.Policy.DenyLocal || permissions.DenyLocalExecution
	if permissions.BlockUnreferencedAssets && len(o.Resources) > 0 {
		var boundaries []securityBoundaryRow
		if err := tx.Where("session_id = ? AND project_id = ? AND restrict_resources = ? AND recovery_epoch = ? AND store_id = ?", o.SessionID, o.ProjectID, true, o.RecoveryEpoch, o.StoreID).Find(&boundaries).Error; err != nil {
			return err
		}
		if len(boundaries) == 0 {
			return errors.New("security: legacy referenced-resource scope needs explicit migration confirmation")
		}
	}
	inherited, err := inheritedSuperCatalogPolicyTx(tx, in.Policy)
	if err != nil {
		return err
	}
	rules := append([]security.Rule(nil), in.Policy.Rules...)
	for i := range rules {
		rule := &rules[i]
		if rule.Effect == security.EffectDeny {
			continue
		}
		if inherited && slices.Contains(o.Capabilities, rule.Capability) {
			rule.Limits = inheritedSuperOperationLimits(o.Scope)
		}
		allowed := false
		switch rule.Capability {
		case "file.read", "cluster.logs":
			allowed = permissions.SilentReadFiles
		case "file.write":
			allowed = permissions.SilentWriteFiles
		case "file.delete":
			allowed = permissions.SilentCommands
		case "db.read":
			allowed = permissions.SilentReadSQL
		case "terminal.open":
			allowed = permissions.SilentTerminalCreation || permissions.SilentCommands
		case "terminal.execute", "terminal.input", "terminal.interrupt", "terminal.close", "command.diagnostics", "service.restart":
			allowed = permissions.SilentCommands
		case "resource.list", "resource.resolve", "cluster.read", "memory.read", "artifact.read", "session.read", "task.read", "workflow.read", "schedule.read", "network.fetch", "network.search", "terminal.read", "mcp.discover", "task.control":
			allowed = true
		case "local.execute":
			allowed = !permissions.DenyLocalExecution
		}
		if !allowed && rule.Effect == security.EffectAllow {
			rule.Effect = security.EffectAsk
			rule.Grantable = false
			rule.Confirmation = security.ConfirmSingle
		}
	}
	in.Policy.Rules = rules
	return nil
}
