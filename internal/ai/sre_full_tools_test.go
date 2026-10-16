package ai

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/extensions"
)

func TestSREFullRolesInheritNormalToolCatalogAndEnabledExtensions(t *testing.T) {
	home := t.TempDir()
	store := extensions.NewStore(home)
	if err := store.SaveServer(extensions.Server{ID: "test", Name: "test", Transport: "http", URL: "http://127.0.0.1:1/mcp", Enabled: true}, true, true); err != nil {
		t.Fatal(err)
	}
	_, child, _, c, _ := sreObservationFixture(t, Model{URL: "http://localhost:1", Name: "fixture"})
	child.Bridge = func(context.Context, string, string, map[string]any, bool) (any, error) { return nil, nil }
	c.CredentialDir = filepath.Join(home, "secrets")
	c.sre.FullTools = true
	for _, role := range []SREAgentRole{SRECoordinator, SREInvestigator, SREExecutor, SREVerifier} {
		c.sre.Role = role
		names := map[string]bool{}
		for _, tool := range child.sessionCatalog(context.Background(), "own", c) {
			names[tool.Name] = true
		}
		for _, name := range []string{"shell", "open_ssh_terminal", "ssh_terminal_send", "read", "write", "execute_sql", "redis_command", "docker_container_action", "load_skill", "call_mcp_tool", "read_evidence"} {
			if !names[name] {
				t.Errorf("%s did not inherit %s", role, name)
			}
		}
		if names["delegate_investigation"] || names["sre_collaborate"] {
			t.Fatal("specialist can recursively schedule children")
		}
	}
	child.worker.finalizing = true
	if len(child.sessionCatalog(context.Background(), "own", c)) != 0 {
		t.Fatal("full catalog bypassed report phase")
	}
}

func TestSREFullToolsRefreshParentPermissionIntersection(t *testing.T) {
	_, child, parent, c, _ := sreObservationFixture(t, Model{URL: "http://localhost:1", Name: "fixture"})
	c.sre.FullTools = true
	permissions := DefaultPermissions()
	permissions.SilentCommands, permissions.SilentWriteFiles, permissions.SilentTerminalCreation = true, true, true
	c.Permissions = &permissions
	parent.state.Config.Permissions = &permissions
	args := map[string]any{"asset_ref": assetAlias("fixture-host")}
	first, err := child.scopedChildConfig(c, args)
	if err != nil || !first.Permissions.SilentCommands || !first.Permissions.SilentWriteFiles || !first.Permissions.SilentTerminalCreation {
		t.Fatal("parent authorizations were replaced with legacy read-only permissions", err)
	}
	tightened := permissions
	tightened.SilentCommands, tightened.SilentWriteFiles, tightened.SilentTerminalCreation = false, false, false
	parent.state.Config.Permissions = &tightened
	current, err := child.scopedChildConfig(c, args)
	if err != nil || current.Permissions.SilentCommands || current.Permissions.SilentWriteFiles || current.Permissions.SilentTerminalCreation {
		t.Fatal("specialist retained stale authorization", err)
	}
	tightened.DenyLocalExecution = true
	if _, err := child.scopedChildConfig(c, args); err == nil {
		t.Fatal("parent local execution prohibition was bypassed")
	}
}

func TestSREFullInvestigatorExecutesNormalShellAndRecordsEvidence(t *testing.T) {
	_, child, parent, c, _ := sreObservationFixture(t, Model{URL: "http://localhost:1", Name: "fixture"})
	c.sre.FullTools = true
	permissions := *c.Permissions
	permissions.SilentCommands = true
	permissions.SilentTerminalCreation = true
	c.Permissions = &permissions
	parent.state.Config.Permissions = &permissions
	c.targetScope = &TargetScope{ResourceIDs: []string{"fixture-host"}}
	cs, _ := child.get("own")
	value, err := child.invoke(context.Background(), cs, c, Call{ID: "custom-command", Name: "shell", Arguments: js(map[string]any{"asset_ref": assetAlias("fixture-host"), "command": "printf FULL_SPECIALIST_COMMAND", "runtime": "local"})})
	if err != nil || !strings.Contains(str(obj(value)["output"]), "FULL_SPECIALIST_COMMAND") || str(obj(value)["evidence_id"]) == "" {
		t.Fatal("normal Shell command did not produce real evidence", err, value)
	}
	if len(parent.state.View.AgentRuns[0].Evidence) != 1 || !parent.state.View.AgentRuns[0].Evidence[0].Success {
		t.Fatal("custom command was not recorded as an actual source")
	}
}

func TestNormalEngineDoesNotExposeLegacyDelegationFromAutoSetting(t *testing.T) {
	e := &Engine{}
	c := Config{Profile: "core", MultiAgentMode: "auto"}
	for _, tool := range e.sessionCatalog(context.Background(), "normal", c) {
		if tool.Name == "delegate_investigation" || tool.Name == "read_investigation" || tool.Name == "sre_collaborate" {
			t.Fatal("ordinary auto setting enabled legacy agents")
		}
	}
	if strings.Contains(Prompt(c), "parallel Scout") {
		t.Fatal("ordinary prompt still directs legacy delegation")
	}
}

func TestSREFullToolsCannotUseAnotherResourcesTerminal(t *testing.T) {
	_, child, _, c, _ := sreObservationFixture(t, Model{URL: "http://localhost:1", Name: "fixture"})
	c.sre.FullTools = true
	c.targetScope = &TargetScope{ResourceIDs: []string{"fixture-host"}}
	var executions atomic.Int32
	child.Bridge = func(_ context.Context, _, name string, _ map[string]any, _ bool) (any, error) {
		if name == "policy" {
			return map[string]any{"asset_ref": "foreign-host", "runtime": "ssh", "risk": "readonly", "fingerprint": "foreign"}, nil
		}
		executions.Add(1)
		return nil, nil
	}
	cs, _ := child.get("own")
	_, err := child.invoke(context.Background(), cs, c, Call{ID: "foreign-terminal", Name: "shell", Arguments: `{"terminal_id":"foreign-terminal","command":"printf should-not-run"}`})
	if err == nil || executions.Load() != 0 {
		t.Fatal("terminal target bypassed specialist resource scope", err)
	}
}

func TestSREFullToolsLoadSkillsAndCallEnabledMCPWithParentPolicy(t *testing.T) {
	home := t.TempDir()
	store := extensions.NewStore(home)
	if err := store.SaveSkill("check-service", "Use real service identity and log evidence.", true); err != nil {
		t.Fatal(err)
	}
	server := extensions.Server{ID: "fixture", Name: "Fixture MCP", Transport: "http", URL: "http://127.0.0.1:1/mcp", Enabled: true}
	if err := store.SaveServer(server, true, true); err != nil {
		t.Fatal(err)
	}
	_, child, parent, c, _ := sreObservationFixture(t, Model{URL: "http://localhost:1", Name: "fixture"})
	c.sre.FullTools = true
	c.sre.Step.ResourceIDs = []string{"fixture-host"}
	c.CredentialDir = filepath.Join(home, "secrets")
	p := *c.Permissions
	p.SilentCommands = true
	p.BlockUnreferencedAssets = false
	c.Permissions = &p
	parent.state.Config.Permissions = &p
	var calls atomic.Int32
	child.Bridge = func(_ context.Context, _, name string, args map[string]any, approved bool) (any, error) {
		if name != "call_mcp_tool" || !approved || str(args["configurationRevision"]) != extensions.ServerRevision(server) {
			t.Error("MCP did not follow ordinary authorization/configuration policy")
		}
		calls.Add(1)
		return map[string]any{"content": "FULL_MCP_RECORDED_RESULT"}, nil
	}
	cs, _ := child.get("own")
	value, err := child.invoke(context.Background(), cs, c, Call{ID: "skill", Name: "load_skill", Arguments: `{"name":"check-service"}`})
	if err != nil || !strings.Contains(js(value), "real service identity") {
		t.Fatal("specialist did not inherit Skills", err)
	}
	call := Call{ID: "mcp", Name: "call_mcp_tool", Arguments: `{"server_id":"fixture","tool":"inspect","arguments":{}}`}
	value, err = child.invoke(context.Background(), cs, c, call)
	if err != nil || calls.Load() != 1 || !strings.Contains(js(value), "FULL_MCP_RECORDED_RESULT") || str(obj(value)["evidence_id"]) == "" {
		t.Fatal("specialist MCP result/provenance missing", err)
	}
	tightened := p
	tightened.BlockUnreferencedAssets = true
	parent.state.Config.Permissions = &tightened
	if _, err := child.invoke(context.Background(), cs, c, call); err == nil || calls.Load() != 1 {
		t.Fatal("MCP bypassed parent's newly restricted resource policy")
	}
}

func TestSREExecutorUsesInheritedSilentWritePermission(t *testing.T) {
	_, child, parent, c, logPath := sreObservationFixture(t, Model{URL: "http://localhost:1", Name: "fixture"})
	c.sre.FullTools = true
	c.sre.Role = SREExecutor
	p := DefaultPermissions()
	p.SilentWriteFiles = true
	c.Permissions = &p
	parent.state.Config.Permissions = &p
	path := filepath.Join(filepath.Dir(logPath), "executor-write-fixture")
	cs, _ := child.get("own")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := child.invoke(ctx, cs, c, Call{ID: "write-inherited", Name: "write", Arguments: js(map[string]any{"asset_ref": assetAlias("fixture-host"), "path": path, "content": "inherited write permission"})})
	if err != nil {
		t.Fatal("executor requested another approval or failed authorized write", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "inherited write permission" {
		t.Fatal("executor did not perform the actual isolated write", err)
	}
	if cs.state.View.Pending != nil {
		t.Fatal("silent authorized write left an approval")
	}
	p.SilentWriteFiles = false
	parent.state.Config.Permissions = &p
	scoped, err := child.scopedChildConfig(c, map[string]any{"asset_ref": assetAlias("fixture-host")})
	if err != nil {
		t.Fatal(err)
	}
	kind, err := approvalKind(scoped, "write", "write", map[string]any{"asset_ref": "fixture-host"})
	if err != nil || kind != "file_write" {
		t.Fatal("revoking parent permission did not require confirmation", kind, err)
	}
}
