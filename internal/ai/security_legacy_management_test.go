package ai

import (
	"context"
	"github.com/Clean-Lakes/Lake/internal/security"
	"testing"
)

func TestSecurityLegacyCaptureBeforeActivationAndExplicitCASAfter(t *testing.T) {
	e := managedEngineFixture(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"})
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	if err = recordLegacySessionPolicy(db, storeID, epoch, "dormant", "one", "web", Permissions{SilentCommands: true}); err != nil {
		t.Fatal(err)
	}
	if err = recordLegacySessionPolicy(db, storeID, epoch, "dormant", "one", "web", Permissions{DenyLocalExecution: true}); err != nil {
		t.Fatal(err)
	}
	var row securityLegacySessionPolicyRow
	if err = db.First(&row, "session_id = ?", "one").Error; err != nil || row.Revision != 2 || row.Data != js(Permissions{DenyLocalExecution: true}) {
		t.Fatalf("stale dormant capture %+v %v", row, err)
	}
	p, err := e.SecurityProjectPolicy(context.Background(), "project")
	if err != nil {
		t.Fatal(err)
	}
	p.Mode = "legacy"
	if _, err = e.PutSecurityProjectPolicy(context.Background(), SecurityPolicyAction{ActorID: "user", ActionID: "legacy-activate", ProjectID: "project", ExpectedRevision: p.Revision}, p); err != nil {
		t.Fatal(err)
	}
	before, err := e.SecurityLegacySessionPolicy(context.Background(), "project", "case")
	if err != nil {
		t.Fatal(err)
	}
	if err = recordLegacySessionPolicy(db, storeID, epoch, "project", "case", "standalone", Permissions{DenyLocalExecution: true}); err != nil {
		t.Fatal(err)
	}
	again, err := e.SecurityLegacySessionPolicy(context.Background(), "project", "case")
	if err != nil || again.Revision != before.Revision || again.Permissions != before.Permissions {
		t.Fatal("activated capture overwritten", again, err)
	}
	a := SecurityLegacyPolicyAction{SecurityPolicyAction: SecurityPolicyAction{ActorID: "user", ActionID: "deny-local", ProjectID: "project", ExpectedRevision: before.Revision}, SessionID: "case", Permissions: Permissions{DenyLocalExecution: true}}
	updated, err := e.UpdateSecurityLegacySessionPolicy(context.Background(), a)
	if err != nil || updated.Revision != before.Revision+1 || !updated.Permissions.DenyLocalExecution {
		t.Fatal(updated, err)
	}
	replay, err := e.UpdateSecurityLegacySessionPolicy(context.Background(), a)
	if err != nil || replay.Revision != updated.Revision {
		t.Fatal("replay advanced revision", replay, err)
	}
	a.ActionID = "stale"
	if _, err = e.UpdateSecurityLegacySessionPolicy(context.Background(), a); err != security.ErrConflict {
		t.Fatal("stale accepted", err)
	}
	a.ActionID = "other-session"
	a.SessionID = "unrelated"
	if _, err = e.UpdateSecurityLegacySessionPolicy(context.Background(), a); err == nil {
		t.Fatal("unrelated session accepted")
	}
}
