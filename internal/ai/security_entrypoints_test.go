package ai

import (
	"encoding/json"
	"os"
	"testing"
)

// This inventory is a coverage fixture, not a runtime permission registry.
// The actual capability evaluator is delivered in phase 3.
func TestSecurityEntrypointInventory(t *testing.T) {
	var manifest struct {
		Tools []struct {
			Name   string `json:"name"`
			Family string `json:"family"`
		} `json:"tools"`
	}
	data, err := os.ReadFile("../../docs/security/tool-entrypoints.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, row := range manifest.Tools {
		if names[row.Name] || row.Family == "" {
			t.Fatal("invalid tool inventory", row.Name)
		}
		names[row.Name] = true
	}
	actual := map[string]bool{}
	var embeddedNames []struct {
		Name string `json:"name"`
	}
	data, err = embedded.ReadFile("tool-catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &embeddedNames); err != nil {
		t.Fatal(err)
	}
	list := extendedTools()
	for _, tool := range embeddedNames {
		list = append(list, Tool{Name: tool.Name})
	}
	list = append(list, workTools()...)
	list = append(list, naturalRecallTools()...)
	list = append(list, kubernetesActionTools()...)
	list = append(list, kubernetesQueryTool(), pilotChoiceTool(), pilotReadRecoveryTool())
	list = append(list, delegationTools()...)
	list = append(list, sreTeamTools()...)
	list = append(list, projectMemoryTools()...)
	list = append(list, projectMemoryTools(Config{MemorySchemaVersion: 2})...)
	list = append(list, sreCoordinationTool(), sreReplyTool(), clusterObservationTool(), clusterLogObservationTool(), journalObservationTool())
	for _, role := range []string{"host", "application", "data", "verify"} {
		list = append(list, observationTools(role)...)
	}
	for _, profile := range []string{"core", "terminal2", "db-query-editor"} {
		list = append(list, Catalog(profile)...)
	}
	for _, tool := range list {
		actual[tool.Name] = true
		if !names[tool.Name] {
			t.Error("tool missing from security inventory:", tool.Name)
		}
	}
	for name := range names {
		if !actual[name] {
			t.Error("retired tool remains in inventory:", name)
		}
	}
	t.Logf("%d static tools covered; dynamic MCP server/tool/config identity remains a separate entry family", len(actual))
}
