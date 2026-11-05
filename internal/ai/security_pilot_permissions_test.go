package ai

import (
	"github.com/Clean-Lakes/Lake/internal/security"
	"testing"
)

func TestPilotPermissionAuthorityIsSharedVersionedAndProjectBound(t *testing.T) {
	e := managedEngineFixture(t, Model{URL: "http://127.0.0.1:1", Name: "metadata-only"})
	ctx := t.Context()
	project := "shared"
	if err := e.InheritSuperProjectAccess(ctx, project); err != nil {
		t.Fatal(err)
	}
	if _, err := e.ActivateSuperProject(ctx, project, "pilot", nil); err != nil {
		t.Fatal(err)
	}
	p := DefaultPermissions()
	if err := e.CaptureSecurityLegacyPolicy(ctx, project, "pilot", "web", Config{Permissions: &p}); err != nil {
		t.Fatal(err)
	}
	b := SuperSourceBinding{SourceID: "user", ProjectID: project, Kind: "user", ActorRef: "owner", Revision: "1"}
	if err := e.RegisterSuperSource(ctx, b); err != nil {
		t.Fatal(err)
	}
	task := superCreateFixture(t, e, b, "request", "Inspect orders", "orders", "Inspect orders")
	old := p
	old.SilentMCPCalls = true
	if err := e.CaptureSecurityLegacyPolicy(ctx, project, task.SessionID, "web", Config{Permissions: &old}); err != nil {
		t.Fatal(err)
	}
	got, err := e.SecurityLegacySessionPolicy(ctx, project, task.SessionID)
	if err != nil || got.Source != "pilot:pilot" || got.Permissions.SilentMCPCalls {
		t.Fatal("independent Worker snapshot remained authority", got, err)
	}
	db, store, epoch, _ := e.securityTaskDB()
	op := security.PreparedOperation{ProjectID: project, SessionID: task.SessionID, StoreID: store, RecoveryEpoch: epoch, LegacyPolicySourceID: "pilot", LegacyPolicyRevision: got.Revision}
	if valid, err := runningCatalogAuthorityValid(db, op); err != nil || !valid {
		t.Fatal(valid, err)
	}
	legacy := op
	legacy.LegacyPolicySourceID = ""
	if valid, _ := runningCatalogAuthorityValid(db, legacy); valid {
		t.Fatal("old source could dispatch under shared authority")
	}
	if valid, err := runningCatalogAuthorityValid(db, legacy, true); err != nil || !valid {
		t.Fatal("old committed observations lost original permission snapshot", valid, err)
	}
	policy, err := e.SecurityProjectPolicy(ctx, project)
	if err != nil {
		t.Fatal(err)
	}
	in := security.EvaluationInput{Policy: policy, Operation: security.PreparedOperation{ProjectID: project, SessionID: task.SessionID, StoreID: store, RecoveryEpoch: epoch, Capabilities: []string{"mcp.call"}, Proof: security.ProofOpaque}}
	if err := applyLegacySessionPolicyTx(db, &in); err != nil {
		t.Fatal(err)
	}
	rule, _ := security.ResolveCapabilityRule(in.Policy.Rules, "mcp.call", "")
	if rule.Effect != security.EffectAsk {
		t.Fatal("default MCP consent widened", rule)
	}
	p.SilentMCPCalls = true
	_, err = e.UpdateSecurityLegacySessionPolicy(ctx, SecurityLegacyPolicyAction{SecurityPolicyAction: SecurityPolicyAction{ActorID: "user", ActionID: "pilot-mcp", ProjectID: project, ExpectedRevision: got.Revision}, SessionID: "pilot", Permissions: p})
	if err != nil {
		t.Fatal(err)
	}
	got, err = e.SecurityLegacySessionPolicy(ctx, project, task.SessionID)
	if err != nil || !got.Permissions.SilentMCPCalls || got.Revision <= op.LegacyPolicyRevision {
		t.Fatal(got, err)
	}
	if valid, _ := runningCatalogAuthorityValid(db, op); valid {
		t.Fatal("prepared old Pilot revision remained valid")
	}
	in.Policy = policy
	if err := applyLegacySessionPolicyTx(db, &in); err != nil {
		t.Fatal(err)
	}
	rule, _ = security.ResolveCapabilityRule(in.Policy.Rules, "mcp.call", "")
	if rule.Effect != security.EffectAllow {
		t.Fatal("explicit Pilot auto MCP not applied", rule)
	}
	if _, err := e.UpdateSecurityLegacySessionPolicy(ctx, SecurityLegacyPolicyAction{SecurityPolicyAction: SecurityPolicyAction{ActorID: "user", ActionID: "worker-override", ProjectID: project, ExpectedRevision: got.Revision}, SessionID: task.SessionID, Permissions: p}); err == nil {
		t.Fatal("Worker could override Pilot")
	}
	if _, err := e.SecurityLegacySessionPolicy(ctx, "other-project", task.SessionID); err == nil {
		t.Fatal("cross-project permission source accepted")
	}
	// Explicit project rules retain their ceiling even with Pilot auto MCP set.
	policy.Rules = []security.Rule{{Capability: "mcp.call", Effect: security.EffectAsk, Confirmation: security.ConfirmSingle}}
	explicit, err := e.PutSecurityProjectPolicy(ctx, SecurityPolicyAction{ActorID: "user", ActionID: "explicit-rule", ProjectID: project, ExpectedRevision: policy.Revision}, policy)
	if err != nil {
		t.Fatal(err)
	}
	in.Policy = explicit
	if err := applyLegacySessionPolicyTx(db, &in); err != nil {
		t.Fatal(err)
	}
	rule, _ = security.ResolveCapabilityRule(in.Policy.Rules, "mcp.call", "")
	if rule.Effect != security.EffectAsk {
		t.Fatal("Pilot bypassed explicit project rule", rule)
	}
}
