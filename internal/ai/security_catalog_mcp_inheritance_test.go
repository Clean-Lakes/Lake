package ai

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/security"
)

func TestSecurityMCPInheritanceProjectScope(t *testing.T) {
	e := managedEngineFixture(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"})
	ctx := context.Background()
	action := func(project string, revision int64) SecurityPolicyAction {
		return SecurityPolicyAction{ActorID: "user", ProjectID: project, ActionID: uid(), ExpectedRevision: revision}
	}
	policy := func(project string, rev int64, rules ...security.Rule) {
		t.Helper()
		_, err := e.PutSecurityProjectPolicy(ctx, action(project, rev), security.ProjectPolicy{ProjectID: project, SchemaVersion: 1, Mode: "restricted", Rules: rules})
		if err != nil {
			t.Fatal(err)
		}
	}
	allow := security.Rule{Capability: "mcp.discover", Effect: security.EffectAllow}
	policy("project", 1, allow)
	policy("other", 0, allow)
	storage := hash("file")
	server := func(id string, enabled bool) SecurityMCPUpdate {
		return SecurityMCPUpdate{ID: id, MetadataDigest: hash(id), StorageDigest: storage, Enabled: enabled}
	}
	if err := e.BootstrapSecurityMCP(ctx, []SecurityMCPUpdate{server("gos", true), server("disabled", false)}); err != nil {
		t.Fatal(err)
	}
	checkIDs := func(project string, expected ...string) {
		t.Helper()
		got, err := e.SecurityProjectMCPServerIDs(ctx, project)
		if err != nil || !slices.Equal(got, expected) {
			t.Fatalf("%s catalog=%v, want %v: %v", project, got, expected, err)
		}
	}
	checkIDs("project")
	checkIDs("other")
	enable := action("project", 0)
	opt, err := e.PutSecurityMCPInheritance(ctx, enable, true)
	if err != nil || opt.Revision != 1 || !opt.Enabled {
		t.Fatalf("enable %+v: %v", opt, err)
	}
	if replay, err := e.PutSecurityMCPInheritance(ctx, enable, true); err != nil || replay != opt {
		t.Fatalf("replay %+v: %v", replay, err)
	}
	if _, err := e.PutSecurityMCPInheritance(ctx, action("project", 0), false); !errors.Is(err, security.ErrConflict) {
		t.Fatalf("stale revision accepted: %v", err)
	}
	if _, err := e.PutSecurityMCPInheritance(ctx, enable, false); !errors.Is(err, security.ErrConflict) {
		t.Fatalf("reused action with changed intent: %v", err)
	}
	db, store, epoch, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	if got, err := securityMCPInheritanceTx(db, "project", store, "next-epoch"); err != nil || got.Enabled || got.Revision != 0 {
		t.Fatalf("new epoch inherited old authority: %+v %v", got, err)
	}
	checkIDs("project", "gos")
	checkIDs("other")
	if _, err := e.PutSecurityMCPBinding(ctx, SecurityMCPBindingAction{SecurityPolicyAction: action("other", 0), ServerID: "gos", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	checkIDs("project", "gos")
	if err := e.MutateSecurityMCP(ctx, []string{"new"}, storage, func() ([]SecurityMCPUpdate, error) {
		return []SecurityMCPUpdate{server("new", true)}, nil
	}); err != nil {
		t.Fatal(err)
	}
	checkIDs("project", "gos", "new")
	checkIDs("other")
	if _, err := e.PutSecurityMCPBinding(ctx, SecurityMCPBindingAction{SecurityPolicyAction: action("project", 0), ServerID: "new", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	checkIDs("project", "gos")
	policy("project", 2, security.Rule{Capability: "mcp.discover", Effect: security.EffectDeny})
	checkIDs("project")
	op := security.PreparedOperation{ProjectID: "project", StoreID: store, RecoveryEpoch: epoch, MCPServerID: "gos"}
	if binding, _, err := effectiveMCPBindingTx(db, op); err != nil || !binding.Inherited {
		t.Fatalf("policy should filter the index independently of the server binding: %+v %v", binding, err)
	}
}

func TestSecurityMCPInheritanceRevalidatesLiveCatalogAndExplicitOverride(t *testing.T) {
	e := managedEngineFixture(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"})
	ctx := context.Background()
	server := SecurityMCPUpdate{ID: "shared", Enabled: true, MetadataDigest: hash("endpoint"), StorageDigest: hash("file")}
	if err := e.BootstrapSecurityMCP(ctx, []SecurityMCPUpdate{server}); err != nil {
		t.Fatal(err)
	}
	act := func(rev int64) SecurityPolicyAction {
		return SecurityPolicyAction{ProjectID: "project", ActorID: "local-user", ActionID: uid(), ExpectedRevision: rev}
	}
	if _, err := e.PutSecurityMCPInheritance(ctx, act(0), true); err != nil {
		t.Fatal(err)
	}
	if err := e.SetSecurityCatalogResolver(func(_ context.Context, q SecurityCatalogQuery) (SecurityCatalogView, error) {
		return SecurityCatalogView{MCPServerID: q.MCPServerID, MCPToolName: q.MCPToolName, MCPMetadataDigest: server.MetadataDigest, MCPStorageDigest: server.StorageDigest, MCPEnabled: true}, nil
	}); err != nil {
		t.Fatal(err)
	}
	db, store, epoch, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	base := security.PreparedOperation{ProjectID: "project", StoreID: store, RecoveryEpoch: epoch, MCPServerID: server.ID, PolicyRevision: 1}
	snapshot := func(tool string) (security.PreparedOperation, error) {
		op := base
		op.Tool, op.MCPToolName = "list_mcp_tools", tool
		if tool != "" {
			op.Tool = "call_mcp_tool"
		}
		bound, err := e.bindCurrentCatalogSnapshot(ctx, db, op)
		if err != nil {
			return op, err
		}
		var in security.EvaluationInput
		if err := applyCurrentCatalogSnapshot(bound, op, &in); err != nil {
			return op, err
		}
		op.MCPConfigRevision, op.MCPCatalogRevision, op.MCPBindingRevision = in.MCPConfigRevision, in.MCPCatalogRevision, in.MCPBindingRevision
		return op, nil
	}
	catalog := func(names ...string) map[string]any {
		tools := []map[string]any{}
		for _, name := range names {
			tools = append(tools, map[string]any{"name": name})
		}
		return map[string]any{"tools": tools}
	}
	assertValid := func(op security.PreparedOperation, want bool) {
		t.Helper()
		valid, err := runningCatalogAuthorityValid(db, op)
		if err != nil || valid != want {
			t.Fatalf("running authority valid=%v, want %v: %v", valid, want, err)
		}
	}
	assertSnapshot := func(name string) security.PreparedOperation {
		t.Helper()
		op, err := snapshot(name)
		if err != nil {
			t.Fatal(err)
		}
		return op
	}
	discover := assertSnapshot("")
	if _, err := snapshot("pretend"); err == nil {
		t.Fatal("undiscovered tool accepted")
	}
	if err := e.recordSecurityMCPCatalog(ctx, server.ID, 1, catalog("inspect", "new"), &discover); err != nil {
		t.Fatal(err)
	}
	discover = assertSnapshot("")
	call := assertSnapshot("inspect")
	if err := e.recordSecurityMCPCatalog(ctx, server.ID, 1, catalog("new", "inspect"), &discover); err != nil {
		t.Fatal(err)
	}
	assertValid(call, true)
	updated := catalog("inspect", "new")
	updated["tools"].([]map[string]any)[0]["description"] = "uses changed parameters"
	if err := e.recordSecurityMCPCatalog(ctx, server.ID, 1, updated, &discover); err != nil {
		t.Fatal(err)
	}
	assertValid(call, false)
	discover, call = assertSnapshot(""), assertSnapshot("inspect")
	if _, err := snapshot("new"); err != nil {
		t.Fatal(err)
	}
	// The first explicit override still permits "inspect", but it has a
	// different authority from the first inherited revision of this server.
	override, err := e.PutSecurityMCPBinding(ctx, SecurityMCPBindingAction{SecurityPolicyAction: act(0), ServerID: server.ID, ToolNames: []string{"inspect"}, Enabled: true})
	if err != nil || override.Revision != 1 || override.Revision == call.MCPBindingRevision {
		t.Fatalf("override %+v: %v", override, err)
	}
	assertValid(call, false)
	if err := e.recordSecurityMCPCatalog(ctx, server.ID, 1, catalog("late"), &discover); !errors.Is(err, security.ErrConflict) {
		t.Fatalf("stale discovery after narrowing authority: %v", err)
	}
	call = assertSnapshot("inspect")
	if _, err := snapshot("new"); err == nil {
		t.Fatal("override did not restrict tool")
	}
	if _, err := e.PutSecurityMCPInheritance(ctx, act(1), false); err != nil {
		t.Fatal(err)
	}
	assertValid(call, true)
	if _, err := e.PutSecurityMCPBinding(ctx, SecurityMCPBindingAction{SecurityPolicyAction: act(1), ServerID: server.ID, Enabled: false}); err != nil {
		t.Fatal(err)
	}
	assertValid(call, false)
	if _, err := snapshot(""); err == nil {
		t.Fatal("revoked explicit binding still permits discovery")
	}
}

func TestSecurityMCPInheritanceQuarantinesOutOfBandStartupChanges(t *testing.T) {
	e := managedEngineFixture(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"})
	ctx := context.Background()
	a := SecurityPolicyAction{ProjectID: "project", ActorID: "user", ActionID: uid()}
	if _, err := e.PutSecurityMCPInheritance(ctx, a, true); err != nil {
		t.Fatal(err)
	}
	newServer := SecurityMCPUpdate{ID: "unexpected", Enabled: true, MetadataDigest: hash("endpoint"), StorageDigest: hash("file")}
	if err := e.BootstrapSecurityMCP(ctx, []SecurityMCPUpdate{newServer}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.SecurityMCPInspectionRevision(ctx, newServer.ID, newServer.MetadataDigest, newServer.StorageDigest); !errors.Is(err, security.ErrConflict) {
		t.Fatalf("untrusted addition available without reconciliation: %v", err)
	}
	if err := e.SetSecurityCatalogResolver(func(_ context.Context, q SecurityCatalogQuery) (SecurityCatalogView, error) {
		return SecurityCatalogView{MCPServerID: q.MCPServerID, MCPEnabled: true, MCPMetadataDigest: newServer.MetadataDigest, MCPStorageDigest: newServer.StorageDigest}, nil
	}); err != nil {
		t.Fatal(err)
	}
	preview, err := e.PreviewSecurityMCPReconciliation(ctx, a.ProjectID, newServer.ID)
	if err != nil || preview.State != "changing" {
		t.Fatalf("preview %+v: %v", preview, err)
	}
	if _, err := e.PreviewSecurityMCPReconciliation(ctx, "unrelated", newServer.ID); err == nil {
		t.Fatal("unrelated project could reconcile global config")
	}
	a.ActionID, a.ExpectedRevision = uid(), 1
	if _, err := e.ConfirmSecurityMCPReconciliation(ctx, a, newServer.ID, preview.Digest); err != nil {
		t.Fatal(err)
	}
	if _, err := e.SecurityMCPInspectionRevision(ctx, newServer.ID, newServer.MetadataDigest, newServer.StorageDigest); err != nil {
		t.Fatalf("confirmed server still quarantined: %v", err)
	}
	newServer.MetadataDigest = hash("different endpoint")
	if err := e.BootstrapSecurityMCP(ctx, []SecurityMCPUpdate{newServer}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.SecurityMCPInspectionRevision(ctx, newServer.ID, newServer.MetadataDigest, newServer.StorageDigest); !errors.Is(err, security.ErrConflict) {
		t.Fatalf("modified global config trusted on startup: %v", err)
	}
}

func TestSecurityMCPReferencedOnlyCannotUseKnownServer(t *testing.T) {
	e := managedEngineFixture(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"})
	db, store, epoch, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	if err := recordLegacySessionPolicy(db, store, epoch, "project", "restricted-session", "web", Permissions{BlockUnreferencedAssets: true}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		tool  string
		local bool
		block bool
	}{{"call_mcp_tool", false, true}, {"call_mcp_tool", true, true}, {"list_mcp_tools", true, true}, {"list_mcp_tools", false, false}, {"list_mcp_servers", false, false}} {
		op := security.PreparedOperation{Tool: tc.tool, ProjectID: "project", SessionID: "restricted-session", StoreID: store, RecoveryEpoch: epoch, MCPServerID: "already-known"}
		if tc.tool == "list_mcp_servers" {
			op.MCPServerID = ""
		}
		in := security.EvaluationInput{Operation: op, LocalExecution: tc.local, Policy: security.ProjectPolicy{ProjectID: "project", Mode: "legacy"}}
		if err := applyLegacySessionPolicyTx(db, &in); errors.Is(err, errMCPReferencedResourcesOnly) != tc.block || (!tc.block && err != nil) {
			t.Fatalf("legacy %s local=%v: %v", tc.tool, tc.local, err)
		}
		view := SecurityCatalogView{HardReferencedOnly: true, MCPLocal: tc.local}
		tx := db.Set("lake_security_catalog", view)
		err := applyCurrentCatalogSnapshot(tx, op, &in)
		if errors.Is(err, errMCPReferencedResourcesOnly) != tc.block {
			t.Fatalf("live host %s local=%v: %v", tc.tool, tc.local, err)
		}
	}
}
