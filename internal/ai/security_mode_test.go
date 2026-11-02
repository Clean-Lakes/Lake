package ai

import (
	"github.com/Clean-Lakes/Lake/internal/security"
	"testing"
)

func TestSecurityModeRequiresFrozenSnapshotCASAndCompiledCoverage(t *testing.T) {
	e := managedEngineFixture(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"})
	status, err := e.SecurityMode(t.Context(), []string{"project"})
	if err != nil || status.Mode != "legacy" || status.Revision != 0 {
		t.Fatal(status, err)
	}
	action := SecurityModeAction{ActorID: "local-user", ActionID: "shadow", Mode: "shadow", ConfirmedDigest: status.Digest}
	shadow, err := e.SetSecurityMode(t.Context(), action, []string{"project"})
	if err != nil || shadow.Mode != "shadow" || shadow.Revision != 1 {
		t.Fatal(shadow, err)
	}
	repeated, err := e.SetSecurityMode(t.Context(), action, []string{"project"})
	if err != nil || repeated.Revision != 1 {
		t.Fatal("action replay changed mode", err)
	}
	action.ActionID = "stale"
	if _, err = e.SetSecurityMode(t.Context(), action, []string{"project"}); err == nil {
		t.Fatal("stale mode CAS accepted")
	}
	action.ActionID = "enforce"
	action.Mode = "enforced"
	action.ExpectedRevision = 1
	if !SecurityEnforcementStatus().Ready {
		if _, err = e.SetSecurityMode(t.Context(), action, []string{"project"}); err == nil {
			t.Fatal("incomplete runtime coverage activated")
		}
	}
	policy, err := e.SecurityProjectPolicy(t.Context(), "project")
	if err != nil {
		t.Fatal(err)
	}
	if policy.Rules[0].Effect != security.EffectAsk {
		t.Fatal("shadow rewrote original project authority")
	}
}

func TestSecurityEnforcedHomeCannotFallBackAndNewProjectDefaultsRestricted(t *testing.T) {
	e := managedEngineFixture(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"})
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	// Exercise the post-activation invariant independently of the public,
	// compiled-proof gate. This private fixture cannot activate a real Home.
	if err = db.Create(&securityRuntimeModeRow{ID: 1, StoreID: storeID, RecoveryEpoch: epoch, Mode: "enforced", Revision: 1}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = e.securityPolicyConfigured("missing"); err == nil {
		t.Fatal("missing project fell back to legacy")
	}
	if _, err = e.securityPolicyConfigured(""); err == nil {
		t.Fatal("empty project fell back to legacy")
	}
	if err = db.Create(&securityResourceRevisionRow{ProjectID: "new-project", ResourceID: "new-local", StoreID: storeID, RecoveryEpoch: epoch, ConnectionRevision: 1, ConnectionDigest: hash("connection"), State: "ready", Local: true}).Error; err != nil {
		t.Fatal(err)
	}
	if err = e.InitializeSecurityProject(t.Context(), "new-project"); err != nil {
		t.Fatal(err)
	}
	policy, err := e.SecurityProjectPolicy(t.Context(), "new-project")
	if err != nil {
		t.Fatal(err)
	}
	if policy.Mode != "restricted" || policy.DenyLocal || len(policy.ResourceIDs) != 1 {
		t.Fatal("new project has wrong authority", policy)
	}
	localAsk := false
	for _, rule := range policy.Rules {
		if rule.Capability == "local.execute" {
			localAsk = rule.Effect == security.EffectAsk && rule.Grantable
		}
	}
	if !localAsk {
		t.Fatal("controlled local commands cannot request task authorization")
	}
	policy.DenyLocal = true
	if _, err = e.PutSecurityProjectPolicy(t.Context(), SecurityPolicyAction{ActorID: "local-user", ActionID: "deny-local", ProjectID: policy.ProjectID, ExpectedRevision: policy.Revision}, policy); err != nil {
		t.Fatal(err)
	}
	if err = e.InitializeSecurityProject(t.Context(), policy.ProjectID); err != nil {
		t.Fatal(err)
	}
	current, err := e.SecurityProjectPolicy(t.Context(), policy.ProjectID)
	if err != nil || !current.DenyLocal {
		t.Fatal("project bootstrap overwrote explicit deny", err)
	}
	if err = db.Model(&securityRuntimeModeRow{}).Where("id = 1").Update("recovery_epoch", "old-epoch").Error; err != nil {
		t.Fatal(err)
	}
	if _, err = e.securityPolicyConfigured("project"); err == nil {
		t.Fatal("old epoch mode was reused")
	}
}
