package ai

import (
	"slices"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/security"
)

func TestSuperProjectInheritsCatalogAndLegacyPermissions(t *testing.T) {
	e := managedEngineFixture(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"})
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	add := func(project, id, state string) {
		t.Helper()
		if err := db.Create(&securityResourceRevisionRow{ProjectID: project, ResourceID: id, StoreID: storeID, RecoveryEpoch: epoch, State: state, ConnectionRevision: 1, ConnectionDigest: hash(id)}).Error; err != nil {
			t.Fatal(err)
		}
	}
	add("inherited", "local", "ready")
	add("inherited", "server", "ready")
	add("foreign", "foreign", "ready")
	add("inherited", "disabled", "disabled")
	if err = e.InheritSuperProjectAccess(t.Context(), "inherited"); err != nil {
		t.Fatal(err)
	}
	p, err := e.SecurityProjectPolicy(t.Context(), "inherited")
	if err != nil || p.Mode != "legacy" || !slices.Equal(p.ResourceIDs, []string{"local", "server"}) {
		t.Fatal(p, err)
	}
	if err = e.InheritSuperProjectAccess(t.Context(), "inherited"); err != nil {
		t.Fatal(err)
	}
	same, _ := e.SecurityProjectPolicy(t.Context(), "inherited")
	if same.Revision != p.Revision {
		t.Fatal("unchanged catalog churned policy")
	}
	add("inherited", "new-server", "ready")
	if err = e.InheritSuperProjectAccess(t.Context(), "inherited"); err != nil {
		t.Fatal(err)
	}
	p, _ = e.SecurityProjectPolicy(t.Context(), "inherited")
	if p.Revision != same.Revision+1 || !slices.Contains(p.ResourceIDs, "new-server") {
		t.Fatal("new catalog resource not inherited", p)
	}
	// Resolve actual permission flags through the established adapter, rather
	// than treating catalog membership as permission for every operation.
	if err = recordLegacySessionPolicy(db, storeID, epoch, "inherited", "existing", "web", Permissions{SilentReadFiles: true, DenyLocalExecution: true}); err != nil {
		t.Fatal(err)
	}
	in := security.EvaluationInput{Policy: p, Operation: security.PreparedOperation{ProjectID: "inherited", SessionID: "existing", StoreID: storeID, RecoveryEpoch: epoch, Capabilities: []string{"file.read"}, Scope: security.OperationScope{FilePath: "/actual/project-file"}}}
	if err = applyLegacySessionPolicyTx(db, &in); err != nil {
		t.Fatal(err)
	}
	for _, rule := range in.Policy.Rules {
		if rule.Capability == "file.read" && rule.Effect != security.EffectAllow {
			t.Fatal("existing read permission lost")
		}
		if rule.Capability == "file.read" && !slices.Equal(rule.Limits.FileRoots, []string{"/actual/project-file"}) {
			t.Fatal("inherited read was not bound to the actual operation", rule)
		}
		if rule.Capability == "file.write" && rule.Effect != security.EffectAsk {
			t.Fatal("write permission silently expanded")
		}
	}
	if !in.Policy.DenyLocal {
		t.Fatal("local execution deny lost")
	}
	// Even an identical user-confirmed revision stops host auto-updates.
	p, err = e.PutSecurityProjectPolicy(t.Context(), SecurityPolicyAction{ActorID: "local-user", ActionID: "explicit-policy", ProjectID: p.ProjectID, ExpectedRevision: p.Revision}, p)
	if err != nil {
		t.Fatal(err)
	}
	add("inherited", "later", "ready")
	if err = e.InheritSuperProjectAccess(t.Context(), "inherited"); err != nil {
		t.Fatal(err)
	}
	after, _ := e.SecurityProjectPolicy(t.Context(), "inherited")
	if after.Revision != p.Revision || slices.Contains(after.ResourceIDs, "later") {
		t.Fatal("explicit policy overwritten", after)
	}
}

func TestSuperProjectPreservesExplicitAccessAndRecoveryFence(t *testing.T) {
	e := managedEngineFixture(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"})
	before, _ := e.SecurityProjectPolicy(t.Context(), "project")
	if err := e.InheritSuperProjectAccess(t.Context(), "project"); err != nil {
		t.Fatal(err)
	}
	after, _ := e.SecurityProjectPolicy(t.Context(), "project")
	if js(before) != js(after) {
		t.Fatal("explicit project permissions changed")
	}
	db, storeID, epoch, _ := e.securityTaskDB()
	if err := db.Model(&securityProjectPolicyRow{}).Where("project_id = ?", "project").Update("recovery_epoch", "old-epoch").Error; err != nil {
		t.Fatal(err)
	}
	if err := e.InheritSuperProjectAccess(t.Context(), "project"); err == nil {
		t.Fatal("old authority replaced with inherited access")
	}
	if err := db.Create(&securityRuntimeModeRow{ID: 1, StoreID: storeID, RecoveryEpoch: epoch, Mode: "enforced", Revision: 1}).Error; err != nil {
		t.Fatal(err)
	}
	if err := e.InheritSuperProjectAccess(t.Context(), "missing-enforced-policy"); err == nil {
		t.Fatal("enforced Home accepted an unconfirmed project")
	}
}

func TestSuperInheritedOperationLimitsCannotAuthorizeAnotherTarget(t *testing.T) {
	cases := []struct {
		capability  string
		scope       security.OperationScope
		same, other security.ScopeLimits
	}{
		{"file.read", security.OperationScope{FilePath: "/project/exact"}, security.ScopeLimits{FileRoots: []string{"/project/exact"}}, security.ScopeLimits{FileRoots: []string{"/project/other"}}},
		{"db.read", security.OperationScope{DatabaseID: "db", Schema: "public", MaxRows: 20, MaxDurationMS: 1000}, security.ScopeLimits{DatabaseID: "db", Schemas: []string{"public"}, MaxRows: 20, MaxDurationMS: 1000}, security.ScopeLimits{DatabaseID: "other", Schemas: []string{"public"}, MaxRows: 20, MaxDurationMS: 1000}},
		{"cluster.read", security.OperationScope{ClusterID: "cluster", Namespace: "app", ResourceKind: "pods", Verb: "list"}, security.ScopeLimits{ClusterID: "cluster", Namespaces: []string{"app"}, ResourceKinds: []string{"pods"}, Verbs: []string{"list"}}, security.ScopeLimits{ClusterID: "cluster", Namespaces: []string{"other"}, ResourceKinds: []string{"pods"}, Verbs: []string{"list"}}},
	}
	for _, tc := range cases {
		t.Run(tc.capability, func(t *testing.T) {
			rule := security.Rule{Capability: tc.capability, Limits: inheritedSuperOperationLimits(tc.scope)}
			if !security.GrantLimitsFitRule(tc.same, rule, tc.capability) || security.GrantLimitsFitRule(tc.other, rule, tc.capability) {
				t.Fatal("inherited limits changed target", rule)
			}
		})
	}
}
