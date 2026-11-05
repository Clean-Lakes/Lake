package ai

import (
	"github.com/Clean-Lakes/Lake/internal/security"
	"testing"
	"time"
)

func TestMCPServiceConflictsKeepHistoryAndIsolateRemoteServers(t *testing.T) {
	db, _, descriptor, _, _ := permitFixture(t)
	legacy := nativeOperation{ID: "legacy-host", SessionID: "legacy-session", Tool: "shell", Status: "unknown", Risk: "write", OrphanState: "manual_review"}
	if err := db.Create(&legacy).Error; err != nil {
		t.Fatal(err)
	}
	if err := checkMCPServiceWriteBlock(db, "gos"); err != nil {
		t.Fatal("old asset blocked remote MCP", err)
	}
	if err := CheckResourceWriteBlock(db, "asset"); err != ErrUnresolvedResourceEffect {
		t.Fatal("asset conflict was cleared", err)
	}
	descriptor.Tool, descriptor.TargetKind = "call_mcp_tool", security.TargetProject
	descriptor.Resources = nil
	descriptor.Proof, descriptor.Capabilities = security.ProofOpaque, []string{"mcp.call"}
	descriptor.CommandProfileID = ""
	descriptor.MCPServerID, descriptor.MCPToolName = "gos", "list_release_orders"
	descriptor.MCPConfigRevision, descriptor.MCPCatalogRevision, descriptor.MCPBindingRevision = 1, 1, 1
	descriptor.Scope = security.OperationScope{}

	if err := checkSecurityOperationConflicts(db, descriptor); err != nil {
		t.Fatal("remote MCP used global asset conflict namespace", err)
	}
	local := descriptor
	local.LocalExecution = true
	if err := checkSecurityOperationConflicts(db, local); err != ErrUnresolvedResourceEffect {
		t.Fatal("local stdio escaped asset conflict", err)
	}
	bound := descriptor
	bound.Resources = []security.ResourceRevision{{ID: "asset"}}
	if err := checkSecurityOperationConflicts(db, bound); err != ErrUnresolvedResourceEffect {
		t.Fatal("asset-bound call escaped asset conflict", err)
	}
	digest, err := security.OperationDigest(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	op := nativeOperation{ID: descriptor.ID, CallID: descriptor.CallID, ProjectID: descriptor.ProjectID, SessionID: descriptor.SessionID, GoalID: descriptor.GoalID, SecurityTaskID: descriptor.TaskID, RootTurnID: descriptor.RootTurnID, StoreID: descriptor.StoreID, RecoveryEpoch: descriptor.RecoveryEpoch, Tool: descriptor.Tool, Status: "unknown", Risk: "write", SecurityDescriptor: js(descriptor), DescriptorDigest: digest}
	if err := db.Create(&op).Error; err != nil {
		t.Fatal(err)
	}
	if err := checkMCPServiceWriteBlock(db, "gos"); err != ErrUnresolvedResourceEffect {
		t.Fatal("same MCP allowed retry", err)
	}
	if err := checkMCPServiceWriteBlock(db, "independent-mcp"); err != nil {
		t.Fatal("other MCP blocked", err)
	}
	// The current operation is excluded only by the caller's exact original ID.
	if err := checkMCPServiceWriteBlock(db.Where("id <> ?", op.ID), "gos"); err != nil {
		t.Fatal("operation blocked itself at I/O", err)
	}
	for _, status := range []string{"dispatched", "running", "failed", "succeeded"} {
		if err := db.Model(&nativeOperation{}).Where("id = ?", op.ID).Updates(map[string]any{"status": status, "orphan_state": "effects_unknown"}).Error; err != nil {
			t.Fatal(err)
		}
		if err := checkMCPServiceWriteBlock(db, "gos"); err != ErrUnresolvedResourceEffect {
			t.Fatal("unresolved effects hidden by status", status, err)
		}
	}
	if err := db.Model(&nativeOperation{}).Where("id = ?", op.ID).Updates(map[string]any{"closure_state": "reconciled", "risk_resolved_at": time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	if err := checkMCPServiceWriteBlock(db, "gos"); err != nil {
		t.Fatal("reconciled call still blocked", err)
	}
	var after nativeOperation
	if err := db.First(&after, "id = ?", legacy.ID).Error; err != nil || after.Status != "unknown" || after.OrphanState != "manual_review" {
		t.Fatal("legacy history changed", after, err)
	}
	// Unmapped/tampered MCP identities cannot be assigned to a different server.
	if err := db.Model(&nativeOperation{}).Where("id = ?", op.ID).Updates(map[string]any{"closure_state": "open", "risk_resolved_at": nil, "security_descriptor": "{}", "status": "unknown"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := checkMCPServiceWriteBlock(db, "independent-mcp"); err != ErrUnresolvedResourceEffect {
		t.Fatal("unmapped MCP escaped conflict", err)
	}
}
