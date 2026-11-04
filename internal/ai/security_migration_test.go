package ai

import (
	"errors"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func TestLegacyScopeClassificationNeverInfersRestrictionFromDirectory(t *testing.T) {
	empty := &TargetScope{DirectoryIDs: []string{"empty-folder"}, NeedsClarification: true}
	for _, in := range []struct {
		scope    *TargetScope
		evidence LegacyScopeEvidence
		want     string
	}{
		{nil, LegacyScopeEvidence{}, "none"},
		{nil, LegacyScopeEvidence{MissingReferenceRestriction: true}, "legacy_unclassified"},
		{empty, LegacyScopeEvidence{}, "legacy_unclassified"},
		{empty, LegacyScopeEvidence{SourceActionID: "real-navigation", NavigationOnly: true}, "navigation"},
		{empty, LegacyScopeEvidence{SourceActionID: "real-restriction", ExplicitRestriction: true}, "explicit_restriction"},
		{empty, LegacyScopeEvidence{SourceActionID: "conflict", ExplicitRestriction: true, NavigationOnly: true}, "legacy_unclassified"},
	} {
		if got := ClassifyLegacyScope(in.scope, in.evidence); got != in.want {
			t.Fatal(got, in.want)
		}
	}
}

func TestSecurityLegacyMissingReferencedScopeStagesOnceAndRepairsNone(t *testing.T) {
	db, now := taskStoreFixture(t)
	if err := stageLegacySecurityScope(db, "store", "epoch", "project", "session", nil, LegacyScopeEvidence{}, now); err != nil {
		t.Fatal(err)
	}
	evidence := LegacyScopeEvidence{MissingReferenceRestriction: true, PersistedReferenceIDs: []string{"second", "first", "first"}, DenyLocal: true}
	if err := stageLegacySecurityScope(db, "store", "epoch", "project", "session", nil, evidence, now); err != nil {
		t.Fatal(err)
	}
	_, target, err := readSecurityTarget(db, "project", "session")
	if err != nil || target.LegacyState != "legacy_unclassified" || target.Revision != 2 || target.Pending == nil || js(target.Pending.CandidateIDs) != `["first","second"]` {
		t.Fatal("saved explicit-reference setting silently became none", target, err)
	}
	if err = stageLegacySecurityScope(db, "store", "epoch", "project", "session", nil, evidence, now); err != nil {
		t.Fatal(err)
	}
	_, again, err := readSecurityTarget(db, "project", "session")
	if err != nil || again.Revision != target.Revision {
		t.Fatal("repeated startup refreshed migration state", again, err)
	}
	action := SecurityScopeAction{ActorID: "user", ActionID: "confirm", ProjectID: "project", SessionID: "session", SourceMessageID: "actual-user-confirmation", ExpectedRevision: 2}
	in := SecurityMigrationResolution{Action: action, TargetIDs: []string{"first"}, BoundaryDecision: "navigation"}
	if _, err = resolveLegacyScope(db, "store", "epoch", in, []string{"first", "second"}, now); err == nil {
		t.Fatal("navigation bypassed saved explicit reference restriction")
	}
	in.BoundaryDecision = "explicit_restriction"
	if err = db.Transaction(func(tx *gorm.DB) error {
		_, err := resolveLegacyScope(tx, "store", "epoch", in, []string{"first", "second"}, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var boundary securityBoundaryRow
	if err = db.First(&boundary, "session_id = ? AND restrict_resources = ?", "session", true).Error; err != nil || boundary.ResourceIDs != `["first"]` || !boundary.DenyLocal {
		t.Fatal("confirmation lost restriction or local deny", boundary, err)
	}
}

func TestSecurityLegacyRegisteredWorkflowBoundaryNeedsNoSyntheticConfirmation(t *testing.T) {
	db, now := taskStoreFixture(t)
	if err := db.Create(&securityBoundaryRow{ID: "workflow-boundary", ProjectID: "project", SessionID: "session", TaskID: "actual-task", OwnerKind: "task", Provenance: "workflow_template", SourceActionID: "actual-run-start", StoreID: "store", RecoveryEpoch: "epoch", Revision: 1, ResourceIDs: `["resource"]`, RestrictResources: true}).Error; err != nil {
		t.Fatal(err)
	}
	if err := stageLegacySecurityScope(db, "store", "epoch", "project", "session", nil, LegacyScopeEvidence{MissingReferenceRestriction: true}, now); err != nil {
		t.Fatal(err)
	}
	_, target, err := readSecurityTarget(db, "project", "session")
	if err != nil || target.Pending != nil || target.LegacyState != "none" {
		t.Fatal("real explicit template boundary was replaced by guessed legacy scope", target, err)
	}
}

func TestLegacyUnknownScopeRequiresExplicitResolutionAndPreservesDeny(t *testing.T) {
	db, now := taskStoreFixture(t)
	if err := db.Transaction(func(tx *gorm.DB) error {
		return stageLegacySecurityScope(tx, "store", "epoch", "project", "session", &TargetScope{DirectoryIDs: []string{"empty"}}, LegacyScopeEvidence{DenyLocal: true}, now)
	}); err != nil {
		t.Fatal(err)
	}
	_, target, err := readSecurityTarget(db, "project", "session")
	if err != nil || target.LegacyState != "legacy_unclassified" || target.Pending == nil {
		t.Fatal(target, err)
	}
	a := SecurityScopeAction{ActorID: "user", ActionID: "target-before-confirm", ProjectID: "project", SessionID: "session", SourceMessageID: "real-message", ExpectedRevision: 1}
	if _, err = updateSecurityTarget(db, "store", "epoch", SecurityTargetUpdate{Action: a, ResourceIDs: []string{"new-resource"}, Source: "explicit_selection"}, []string{"new-resource"}, now); err == nil {
		t.Fatal("unknown legacy scope silently removed")
	}
	a.ActionID = "confirm-navigation"
	in := SecurityMigrationResolution{Action: a, TargetIDs: []string{"new-resource"}, BoundaryDecision: "navigation"}
	var resolved SecuritySessionTarget
	if err = db.Transaction(func(tx *gorm.DB) error {
		var err error
		resolved, err = resolveLegacyScope(tx, "store", "epoch", in, []string{"new-resource"}, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if resolved.LegacyState != "navigation" || resolved.Pending != nil || resolved.Current == nil || resolved.Current.ResourceIDs[0] != "new-resource" {
		t.Fatal(resolved)
	}
	var boundaries []securityBoundaryRow
	if err = db.Find(&boundaries).Error; err != nil || len(boundaries) != 1 || !boundaries[0].DenyLocal || boundaries[0].RestrictResources {
		t.Fatal("local deny lost or empty directory became permanent restriction", boundaries, err)
	}
	if err = db.Transaction(func(tx *gorm.DB) error {
		again, err := resolveLegacyScope(tx, "store", "epoch", in, []string{"new-resource"}, now.Add(time.Second))
		if err != nil {
			return err
		}
		if again.Revision != resolved.Revision {
			t.Fatal("duplicate resolution changed revision")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	in.TargetIDs = []string{"different-resource"}
	if _, err = resolveLegacyScope(db, "store", "epoch", in, []string{"new-resource", "different-resource"}, now); !errors.Is(err, security.ErrConflict) {
		t.Fatal("action replay changed migration decision", err)
	}
}

func TestSecurityTargetPendingSwitchPreservesLastTargetButBlocksInheritance(t *testing.T) {
	db, now := taskStoreFixture(t)
	a := SecurityScopeAction{ActorID: "user", ActionID: "select", ProjectID: "project", SessionID: "session", SourceMessageID: "message", ExpectedRevision: 0}
	var target SecuritySessionTarget
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		target, err = updateSecurityTarget(tx, "store", "epoch", SecurityTargetUpdate{Action: a, ResourceIDs: []string{"first"}, Source: "explicit_selection"}, []string{"first"}, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	a.ActionID, a.SourceMessageID, a.ExpectedRevision = "switch", "next-message", target.Revision
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		target, err = updateSecurityTarget(tx, "store", "epoch", SecurityTargetUpdate{Action: a, Pending: &SecurityPendingTarget{Reason: "TARGET_AMBIGUOUS", SourceMessageID: a.SourceMessageID, CandidateIDs: []string{"second", "third"}}}, []string{"first", "second", "third"}, now.Add(time.Second))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if target.Current.ResourceIDs[0] != "first" || target.Pending == nil {
		t.Fatal("failed switch overwrote old target or lost pending guard", target)
	}
	_, latest, err := readSecurityTarget(db, "project", "session")
	if err != nil || latest.Pending == nil {
		t.Fatal(latest, err)
	}
	if _, _, err = readSecurityTarget(db, "other-project", "session"); err == nil {
		t.Fatal("cross-project target read")
	}
}

func TestSecurityBoundaryCASCannotModifyParentOrProject(t *testing.T) {
	db, now := taskStoreFixture(t)
	rows := []securityBoundaryRow{
		{ID: "parent", ProjectID: "project", SessionID: "session", OwnerKind: "parent", StoreID: "store", RecoveryEpoch: "epoch", Revision: 1, ResourceIDs: `["first"]`, RestrictResources: true},
		{ID: "project-boundary", ProjectID: "project", SessionID: "session", OwnerKind: "project", StoreID: "store", RecoveryEpoch: "epoch", Revision: 1, ResourceIDs: `["first"]`, RestrictResources: true},
		{ID: "session-boundary", ProjectID: "project", SessionID: "session", OwnerKind: "session", StoreID: "store", RecoveryEpoch: "epoch", Revision: 1, ResourceIDs: `["first"]`, RestrictResources: true},
	}
	if err := db.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"parent", "project-boundary"} {
		in := SecurityBoundaryUpdate{Action: SecurityScopeAction{ActorID: "user", ActionID: id, ProjectID: "project", SessionID: "session", SourceMessageID: "message", ExpectedRevision: 1}, BoundaryID: id, ResourceIDs: []string{"second"}}
		if _, err := updateSecurityBoundary(db, "store", "epoch", in, []string{"second"}, now); err == nil {
			t.Fatal("lower-level action changed hard parent/project restriction", id)
		}
	}
	in := SecurityBoundaryUpdate{Action: SecurityScopeAction{ActorID: "user", ActionID: "session-update", ProjectID: "project", SessionID: "session", SourceMessageID: "message", ExpectedRevision: 1}, BoundaryID: "session-boundary", ResourceIDs: []string{"second"}}
	if err := db.Transaction(func(tx *gorm.DB) error {
		out, err := updateSecurityBoundary(tx, "store", "epoch", in, []string{"first", "second"}, now)
		if err != nil {
			return err
		}
		if out.Revision != 2 || !out.RestrictResources {
			t.Fatal(out)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	in.Action.ActionID = "stale"
	if _, err := updateSecurityBoundary(db, "store", "epoch", in, []string{"second"}, now); !errors.Is(err, security.ErrConflict) {
		t.Fatal("stale boundary CAS", err)
	}
}
