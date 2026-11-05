package ai

import (
	"errors"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func TestToolResultObserved(t *testing.T) {
	for _, test := range []struct {
		name, tool, data string
		want             bool
	}{
		{"malformed", "read", `uncommitted`, false},
		{"null", "read", `null`, false},
		{"blank", "read", `"  "`, false},
		{"empty object", "read", `{}`, false},
		{"empty rows", "execute_sql", `[]`, true},
		{"zero count", "execute_sql", `{"count":0}`, true},
		{"empty catalog", "list_mcp_servers", `{"servers":[]}`, true},
		{"MCP zero", "call_mcp_tool", `{"structuredContent":{"count":0}}`, true},
		{"MCP empty rows", "call_mcp_tool", `{"structuredContent":[]}`, true},
		{"MCP text", "call_mcp_tool", `{"content":[{"type":"text","text":"0 releases"}]}`, true},
		{"MCP image", "call_mcp_tool", `{"content":[{"type":"image","data":"fixture"}]}`, true},
		{"MCP error", "call_mcp_tool", `{"isError":true,"content":[{"type":"text","text":"denied"}]}`, false},
		{"MCP empty", "call_mcp_tool", `{"content":[]}`, false},
		{"MCP blank text", "call_mcp_tool", `{"content":[{"type":"text","text":" "}]}`, false},
		{"MCP malformed block", "call_mcp_tool", `{"content":[{}]}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := toolResultObserved(test.tool, test.data); got != test.want {
				t.Fatalf("observed = %v, want %v", got, test.want)
			}
		})
	}
}

func TestWorkToolDiscoveryVerifiesOwnCatalogWithoutBypassingRevocation(t *testing.T) {
	e := managedEngineFixture(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"})
	ctx := t.Context()
	if err := e.BootstrapSecurityMCP(ctx, []SecurityMCPUpdate{{ID: "server", MetadataDigest: hash("endpoint"), StorageDigest: hash("file"), Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	binding, err := e.PutSecurityMCPBinding(ctx, SecurityMCPBindingAction{SecurityPolicyAction: SecurityPolicyAction{ActorID: "user", ActionID: "bind", ProjectID: "project"}, ServerID: "server", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	descriptor := security.PreparedOperation{Tool: "list_mcp_tools", ProjectID: "project", StoreID: storeID, RecoveryEpoch: epoch, MCPServerID: "server", MCPConfigRevision: 1, MCPCatalogRevision: 0, MCPBindingRevision: binding.Revision}
	catalog := map[string]any{"tools": []map[string]any{{"name": "inspect", "description": "fixture"}}}
	if err := e.RecordSecurityMCPCatalog(ctx, "server", 1, catalog); err != nil {
		t.Fatal(err)
	}
	if valid, err := currentWorkToolResultAuthorityTx(db, descriptor, js(catalog)); err != nil || !valid {
		t.Fatal("discovery invalidated its own observation", valid, err)
	}
	for name, mutate := range map[string]func(*gorm.DB) error{
		"changed schema": func(tx *gorm.DB) error {
			return tx.Model(&securityMCPRevisionRow{}).Where("id = ?", "server").Update("catalog_digest", hash("changed schema")).Error
		},
		"changed endpoint": func(tx *gorm.DB) error {
			return tx.Model(&securityMCPRevisionRow{}).Where("id = ?", "server").Update("config_revision", 2).Error
		},
		"disabled server": func(tx *gorm.DB) error {
			return tx.Model(&securityMCPRevisionRow{}).Where("id = ?", "server").Update("enabled", false).Error
		},
		"changed project binding": func(tx *gorm.DB) error {
			return tx.Model(&securityMCPBindingRow{}).Where("project_id = ? AND server_id = ?", "project", "server").Update("revision", binding.Revision+1).Error
		},
	} {
		t.Run(name, func(t *testing.T) {
			rollback := errors.New("rollback fixture")
			err := db.Transaction(func(tx *gorm.DB) error {
				if err := mutate(tx); err != nil {
					return err
				}
				if valid, err := currentWorkToolResultAuthorityTx(tx, descriptor, js(catalog)); err != nil || valid {
					t.Errorf("revoked catalog accepted: %v %v", valid, err)
				}
				return rollback
			})
			if !errors.Is(err, rollback) {
				t.Fatal(err)
			}
		})
	}
}
