package ai

import (
	"context"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/extensions"
)

func TestConfiguredSkillsHonorEnabledState(t *testing.T) {
	home := t.TempDir()
	store := extensions.NewStore(home)
	if err := store.SaveSkill("service-check", "Inspect bounded logs", true); err != nil {
		t.Fatal(err)
	}
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	c := Config{CredentialDir: filepath.Join(home, "secrets")}
	if _, err := e.loadSkill(c, "service-check"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetSkillEnabled("service-check", false); err != nil {
		t.Fatal(err)
	}
	if _, err := e.loadSkill(c, "service-check"); err == nil {
		t.Fatal("disabled skill was loaded")
	}
	result, _ := e.loadSkill(c, "")
	if strings.Contains(js(result), "service-check") {
		t.Fatal("disabled skill remains discoverable")
	}
}
func TestMCPCallsRespectOperationAndLocalExecutionPermissions(t *testing.T) {
	home := t.TempDir()
	store := extensions.NewStore(home)
	server := extensions.Server{ID: "fixture", Name: "Fixture", Transport: "stdio", Command: "synthetic-not-executed", Enabled: true}
	if err := store.SaveServer(server, true, true); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	model, closeModel := fakeModel(t, func(n int, _ map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "mcp-test", Name: "call_mcp_tool", Arguments: `{"server_id":"fixture","tool":"echo","arguments":{}}`})
		}
		return response("MCP operation rejected")
	})
	defer closeModel()
	e := engineFor(t, model, func(ctx context.Context, id, name string, args map[string]any, approved bool) (any, error) {
		if name != "call_mcp_tool" || !approved || str(args["configurationRevision"]) != extensions.ServerRevision(server) {
			t.Error("MCP bridge lacked approved configuration identity")
		}
		calls.Add(1)
		return "OK", nil
	})
	s, _ := e.get("case")
	c := s.state.Config
	p := DefaultPermissions()
	c.Permissions = &p
	c.CredentialDir = filepath.Join(home, "secrets")
	call := Call{ID: "mcp-test", Name: "call_mcp_tool", Arguments: `{"server_id":"fixture","tool":"echo","arguments":{}}`}
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- e.Chat(context.Background(), "case", "call the configured MCP fixture", nil) }()
	approval := waitApproval(t, e)
	if approval.Kind != "mcp" || !strings.Contains(approval.Target, "Fixture") || calls.Load() != 0 {
		t.Fatal("MCP ran before approval")
	}
	if err := e.Decision("case", approval.ID, false, ""); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil || calls.Load() != 0 {
		t.Fatal("rejected MCP call executed")
	}
	p.SilentCommands = true
	if _, err := e.invoke(context.Background(), s, c, call); err != nil || calls.Load() != 1 {
		t.Fatalf("silent operation preference ignored: %v", err)
	}
	p.DenyLocalExecution = true
	if _, err := e.invoke(context.Background(), s, c, call); err == nil || calls.Load() != 1 {
		t.Fatal("local execution prohibition ignored")
	}
	p.DenyLocalExecution = false
	p.BlockUnreferencedAssets = true
	if _, err := e.invoke(context.Background(), s, c, call); err == nil {
		t.Fatal("MCP bypassed resource restrictions")
	}
}

func TestUnconfiguredMCPDoesNotConsumeToolBudget(t *testing.T) {
	home := t.TempDir()
	store := extensions.NewStore(home)
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, func(context.Context, string, string, map[string]any, bool) (any, error) { return nil, nil })
	c := Config{Profile: "core", CredentialDir: filepath.Join(home, "secrets")}
	count := func() int {
		n := 0
		for _, tool := range e.sessionCatalog(context.Background(), "case", c) {
			if strings.Contains(tool.Name, "mcp") {
				n++
			}
		}
		return n
	}
	if count() != 0 {
		t.Fatal("unconfigured MCP tools consumed context budget")
	}
	server := extensions.Server{ID: "fixture", Name: "Fixture", Transport: "http", URL: "http://127.0.0.1:1/mcp", Enabled: true}
	if err := store.SaveServer(server, true, true); err != nil {
		t.Fatal(err)
	}
	if count() != 3 {
		t.Fatal("enabled MCP tools unavailable")
	}
	server.Enabled = false
	if err := store.SaveServer(server, false, false); err != nil {
		t.Fatal(err)
	}
	if count() != 0 {
		t.Fatal("disabled MCP tools consumed context budget")
	}
}

func TestExtensionReferencePreservesPreviouslySelectedResourceScope(t *testing.T) {
	model, close := fakeModel(t, func(_ int, _ map[string]any) any { return response("已记录") })
	defer close()
	e := engineFor(t, model, nil)
	c := directoryTestConfig()
	c.Model = model
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	scope := &TargetScope{DirectoryIDs: []string{"new"}, Paths: []string{"Production/新k8s集群"}, ResourceIDs: []string{"node-a", "node-b"}}
	if err := e.ExecuteTurn(context.Background(), "case", TurnInput{UserText: "检查所选目录", TargetScope: scope}); err != nil {
		t.Fatal(err)
	}
	if err := e.ExecuteTurn(context.Background(), "case", TurnInput{UserText: "@service-check 继续", References: []map[string]any{{"kind": "skill", "skill_name": "service-check"}}}); err != nil {
		t.Fatal(err)
	}
	got, err := e.TargetScope("case")
	if err != nil || got == nil || len(got.ResourceIDs) != 2 || got.DirectoryIDs[0] != "new" {
		t.Fatal("extension reference cleared the selected host scope")
	}
}
