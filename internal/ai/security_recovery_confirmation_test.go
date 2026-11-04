package ai

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func recoveryReviewFixture(t *testing.T) (*SecurityHome, SecurityRecoveryReview) {
	return recoveryReviewFixtureWithLegacy(t, false)
}

func TestSecurityRecoveryPolicyExplicitlyReconfirmsCatalogWithoutFakeImpact(t *testing.T) {
	h, review := recoveryReviewFixtureVariant(t, false, false)
	if len(review.Impacts) != 0 || len(review.Policies) != 1 || len(review.Policies[0].CatalogResources) != 1 {
		t.Fatal("no-impact catalog review missing")
	}
	resource := review.Policies[0].CatalogResources[0]
	if !resource.RequiresConfirmation {
		t.Fatal("old-epoch catalog was automatically approved")
	}
	in := SecurityRecoveryPolicyConfirmation{Action: recoveryAction(review, "confirm-policy-catalog"), ProjectID: "project", SourceDigest: review.Policies[0].SourceDigest, Policy: security.ProjectPolicy{ProjectID: "project", SchemaVersion: 1, Mode: "restricted", ResourceIDs: []string{"asset"}, Rules: []security.Rule{{Capability: "file.read", Effect: security.EffectDeny}}}}
	if _, err := h.ConfirmSecurityRecoveryPolicy(context.Background(), in); err == nil {
		t.Fatal("policy silently reapproved whole asset map")
	}
	in.Resources = []security.ResourceRevision{resource.Resource}
	confirmed, err := h.ConfirmSecurityRecoveryPolicy(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	if !confirmed.ReviewComplete || len(confirmed.Impacts) != 0 || len(confirmed.WriteBlockedResourceIDs) != 0 || confirmed.Policies[0].CatalogResources[0].RequiresConfirmation {
		t.Fatal("catalog confirmation invented impact or remained stale")
	}
	err = h.withSecurityRecoveryReview(context.Background(), func(tx *gorm.DB, journal securityRestoreJournal) error {
		var current securityResourceRevisionRow
		if err := tx.First(&current, "project_id = ? AND resource_id = ?", "project", "asset").Error; err != nil {
			return err
		}
		if current.StoreID != journal.After.StoreID || current.RecoveryEpoch != journal.After.RecoveryEpoch || recoveryResourceReference(current) != resource.Resource {
			t.Fatal("explicit resource reference not rebound exactly")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSecurityRecoveryCatalogConfirmationRejectsRepointedCurrentAsset(t *testing.T) {
	h, review := recoveryReviewFixtureVariant(t, false, false)
	web, err := sql.Open("sqlite", filepath.Join(filepath.Dir(h.RuntimeRoot), "lake-web.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = web.Exec(`UPDATE resourceConnections SET config='{"host":"192.0.2.99","credentialRef":"fixture-ref"}' WHERE resourceId='asset'`)
	web.Close()
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.ConfirmSecurityRecoveryPolicy(context.Background(), SecurityRecoveryPolicyConfirmation{Action: recoveryAction(review, "reject-current-target-change"), ProjectID: "project", SourceDigest: review.Policies[0].SourceDigest, Resources: []security.ResourceRevision{review.Policies[0].CatalogResources[0].Resource}, Policy: security.ProjectPolicy{ProjectID: "project", SchemaVersion: 1, Mode: "restricted", ResourceIDs: []string{"asset"}}})
	if err == nil {
		t.Fatal("restored ID was rebound to a different current target")
	}
	current, err := h.SecurityRecoveryReview(context.Background())
	if err != nil || current.Policies[0].Confirmed {
		t.Fatal("failed catalog reconciliation confirmed policy", err)
	}
}

func recoveryReviewFixtureWithLegacy(t *testing.T, legacy bool) (*SecurityHome, SecurityRecoveryReview) {
	return recoveryReviewFixtureVariant(t, legacy, true)
}

func recoveryReviewFixtureVariant(t *testing.T, legacy, unresolved bool) (*SecurityHome, SecurityRecoveryReview) {
	t.Helper()
	h, checkpoint := checkpointFixture(t)
	db, raw, err := openSecurityRecoverySQL(filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(append(securityPolicyModels(), &nativeOperation{}, &nativeWorkGoal{})...); err != nil {
		t.Fatal(err)
	}
	resource := security.ResourceRevision{ID: "asset", ConnectionRevision: 1, ConnectionDigest: security.ContentDigest([]byte("connection-reference")), State: "ready"}
	if err = db.Create(&securityResourceRevisionRow{ProjectID: "project", ResourceID: resource.ID, StoreID: h.control.StoreID, RecoveryEpoch: h.control.RecoveryEpoch, ConnectionRevision: 1, ConnectionDigest: resource.ConnectionDigest, State: "ready"}).Error; err != nil {
		t.Fatal(err)
	}
	descriptor := security.PreparedOperation{FormatVersion: security.DescriptorVersion, ID: "unresolved", Actor: "agent", StoreID: h.control.StoreID, RecoveryEpoch: h.control.RecoveryEpoch, ProjectID: "project", SessionID: "session", GoalID: "goal", GoalRevision: 1, PlanRevision: 1, StepID: "step", StepRevision: 1, AttemptID: "attempt", TaskID: "task", ExecutionRevision: 1, RootTurnID: "turn", CallID: "call", Tool: "write", RegistryVersion: security.RegistryVersion, TargetKind: security.TargetResource, Resources: []security.ResourceRevision{resource}, Capabilities: []string{"file.write"}, Proof: security.ProofStructured, ArgumentsDigest: security.ContentDigest([]byte("args")), PreviewDigest: security.ContentDigest([]byte("preview")), PolicyRevision: 1, OwnerID: "owner", OwnerGeneration: 1, Scope: security.OperationScope{FilePath: "/tmp/fixture"}}
	digest, err := security.OperationDigest(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	status := "succeeded"
	if unresolved {
		status = "unknown"
	}
	if err = db.Create(&nativeOperation{ID: descriptor.ID, SessionID: "session", RootTurnID: "turn", CallID: "call", Tool: "write", Status: status, Risk: "write", ResourceID: "asset", ResourceConnectionRevision: 1, StoreID: h.control.StoreID, RecoveryEpoch: h.control.RecoveryEpoch, SecurityDescriptor: js(descriptor), DescriptorDigest: digest}).Error; err != nil {
		t.Fatal(err)
	}
	goal := WorkGoal{ID: "goal", SessionID: "session", Status: "running", Title: "original plan", Revision: 1, Items: []WorkItem{{ID: "step", Title: "original step", Status: "running"}}, DeadlineAt: time.Now().Add(time.Hour)}
	if err = db.Create(&nativeWorkGoal{ID: goal.ID, SessionID: goal.SessionID, Status: goal.Status, Revision: 1, Data: js(goal)}).Error; err != nil {
		t.Fatal(err)
	}
	if legacy {
		if err = recordLegacySessionPolicy(db, h.control.StoreID, h.control.RecoveryEpoch, "project", "session", "web", Permissions{SilentReadFiles: true, SilentReadSQL: true}); err != nil {
			t.Fatal(err)
		}
	}
	raw.Close()
	web, err := sql.Open("sqlite", filepath.Join(filepath.Dir(h.RuntimeRoot), "lake-web.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = web.Exec(`CREATE TABLE projects(id TEXT PRIMARY KEY);INSERT INTO projects VALUES('project');CREATE TABLE resources(id TEXT PRIMARY KEY,projectId TEXT,kind TEXT);INSERT INTO resources VALUES('asset','project','ssh');CREATE TABLE resourceConnections(resourceId TEXT PRIMARY KEY,config TEXT);INSERT INTO resourceConnections VALUES('asset','{"host":"192.0.2.1","credentialRef":"fixture-ref"}')`)
	web.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = CreateSecurityCheckpoint(context.Background(), h.Home, checkpoint); err != nil {
		t.Fatal(err)
	}
	db, raw, err = openSecurityRecoverySQL(filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	goal.Title, goal.Revision = "newer plan retained", 2
	if legacy {
		if err = db.Model(&securityLegacySessionPolicyRow{}).Where("session_id = ?", "session").Updates(map[string]any{"revision": 2, "data": js(Permissions{DenyLocalExecution: true})}).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err = db.Model(&nativeWorkGoal{}).Where("id = ?", "goal").Updates(map[string]any{"data": js(goal), "revision": 2}).Error; err != nil {
		t.Fatal(err)
	}
	raw.Close()
	if _, err = RestoreSecurityBackup(context.Background(), h.Home, checkpoint, false); err != nil {
		t.Fatal(err)
	}
	view, err := OpenSecurityReadOnlyHome(h.Home, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { view.Close() })
	review, err := view.SecurityRecoveryReview(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return view, review
}

func TestSecurityRecoveryLegacySessionPermissionsRequireExplicitNarrowConfirmation(t *testing.T) {
	h, review := recoveryReviewFixtureWithLegacy(t, true)
	if len(review.LegacyPolicies) != 1 || len(review.LegacyPolicies[0].PriorPolicies) != 2 {
		t.Fatal("legacy effective permissions not preserved")
	}
	prior := review.LegacyPolicies[0]
	in := SecurityRecoveryLegacyConfirmation{Action: recoveryAction(review, "legacy-confirm"), SessionID: prior.SessionID, SourceDigest: prior.SourceDigest, Permissions: Permissions{SilentReadFiles: true}}
	if _, err := h.ConfirmSecurityRecoveryLegacyPolicy(context.Background(), in); err == nil {
		t.Fatal("old backup revived newer explicit denial")
	}
	in.Permissions = Permissions{DenyLocalExecution: true}
	out, err := h.ConfirmSecurityRecoveryLegacyPolicy(context.Background(), in)
	if err != nil || !out.LegacyPolicies[0].Confirmed || out.LegacyPolicies[0].ConfirmedRevision != 3 {
		t.Fatal("explicit legacy reconfirmation failed", err)
	}
	err = h.withSecurityRecoveryReview(context.Background(), func(tx *gorm.DB, journal securityRestoreJournal) error {
		var row securityLegacySessionPolicyRow
		if err := tx.First(&row, "session_id = ?", "session").Error; err != nil {
			return err
		}
		if row.RecoveryEpoch != journal.After.RecoveryEpoch || row.Source != "web" || row.Revision != 3 {
			t.Fatal("legacy policy migrated to wrong authority context")
		}
		var p Permissions
		if err := decodeSecurityJSON(row.Data, &p); err != nil {
			return err
		}
		if p.SilentReadFiles || !p.DenyLocalExecution {
			t.Fatal("legacy denial changed")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func recoveryAction(review SecurityRecoveryReview, id string) SecurityRecoveryAction {
	return SecurityRecoveryAction{ActorID: "local-user", ActionID: id, RecoveryID: review.RecoveryID, RecoveryEpoch: review.RecoveryEpoch, ExpectedRevision: review.Revision}
}

func TestSecurityRecoveryMappingPoliciesCASAndDurableWriteBlocks(t *testing.T) {
	h, review := recoveryReviewFixture(t)
	ctx := context.Background()
	if len(review.Impacts) != 2 || len(review.Policies) != 1 || review.ReviewComplete {
		t.Fatal("missing original recovery requirements")
	}
	for _, impact := range review.Impacts {
		in := SecurityRecoveryMapping{Action: recoveryAction(review, "map-"+impact.ID), ImpactID: impact.ID, RecordDigest: impact.RecordDigest, ResourceIDs: []string{"asset"}}
		updated, err := h.MapSecurityRecoveryImpact(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		again, err := h.MapSecurityRecoveryImpact(ctx, in)
		if err != nil || again.Revision != updated.Revision {
			t.Fatal("mapping not idempotent", err)
		}
		in.ResourceIDs = []string{"different"}
		if _, err = h.MapSecurityRecoveryImpact(ctx, in); err == nil {
			t.Fatal("reused action accepted changed mapping")
		}
		review = updated
	}
	if len(review.WriteBlockedResourceIDs) != 1 || review.WriteBlockedResourceIDs[0] != "asset" {
		t.Fatal("unknown effects lost resource write blocks")
	}
	policy := review.Policies[0]
	in := SecurityRecoveryPolicyConfirmation{Action: recoveryAction(review, "confirm-policy"), ProjectID: policy.ProjectID, SourceDigest: policy.SourceDigest, Policy: security.ProjectPolicy{ProjectID: policy.ProjectID, SchemaVersion: 1, Mode: "restricted", ResourceIDs: []string{"asset"}, Rules: []security.Rule{{Capability: "file.read", Effect: security.EffectAllow}, {Capability: "file.write", Effect: security.EffectAsk, Confirmation: security.ConfirmSingle}}}}
	updated, err := h.ConfirmSecurityRecoveryPolicy(ctx, in)
	if err != nil || !updated.ReviewComplete || updated.ReadyForActivation != SecurityEnforcementStatus().Ready {
		t.Fatal("review state incorrect or untested entrypoints enabled", err)
	}
	if !SecurityEnforcementStatus().Ready {
		if _, err = h.ActivateSecurityRecovery(ctx, recoveryAction(updated, "activate")); err == nil {
			t.Fatal("missing compiled coverage did not block activation")
		}
	}
	err = h.withSecurityRecoveryReview(ctx, func(tx *gorm.DB, _ securityRestoreJournal) error {
		if err := CheckSecurityRecoveryWriteBlocks(tx, []string{"asset"}); !errors.Is(err, ErrUnresolvedResourceEffect) {
			t.Fatal("mapped unknown resource writes allowed", err)
		}
		if err := CheckSecurityRecoveryWriteBlocks(tx, []string{"unrelated"}); err != nil {
			t.Fatal("unrelated resource incorrectly blocked", err)
		}
		if err := CheckSecurityRecoveryWriteBlocks(tx, nil); !errors.Is(err, ErrUnresolvedResourceEffect) {
			t.Fatal("resource-free mutation bypassed preserved write blocks", err)
		}
		var count int64
		if err := tx.Model(&nativeOperation{}).Where("id = ? AND status = ?", "unresolved", "unknown").Count(&count).Error; err != nil || count != 1 {
			t.Fatal("original unknown execution status overwritten", err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	control, _ := ReadSecurityControl(h.Home)
	if control.Gate != "closed" {
		t.Fatal("confirmation changed execution gate")
	}
}

func TestSecurityRecoveryMappingRejectsMissingProofSubsetsAndStaleRevision(t *testing.T) {
	h, review := recoveryReviewFixture(t)
	impact := review.Impacts[0]
	in := SecurityRecoveryMapping{Action: recoveryAction(review, "map"), ImpactID: impact.ID, RecordDigest: impact.RecordDigest}
	if _, err := h.MapSecurityRecoveryImpact(context.Background(), in); err == nil {
		t.Fatal("resource subset accepted")
	}
	in.ResourceIDs = []string{"asset"}
	in.Action.ExpectedRevision++
	if _, err := h.MapSecurityRecoveryImpact(context.Background(), in); err == nil {
		t.Fatal("stale revision accepted")
	}
	legacy := securityRecoveryImpactRow{OperationID: "unknown", ScopeState: "unverified"}
	if _, err := verifiedRecoveryDescriptor(legacy); err == nil {
		t.Fatal("legacy unknown scope inferred without original proof")
	}
}

func TestSecurityRecoveryPreservesConflictingWorkGoalsAsReadOnlyNamespaces(t *testing.T) {
	h, _ := recoveryReviewFixture(t)
	history, err := h.SecurityRecoveryWorkHistory(context.Background(), "session", 20)
	if err != nil || len(history) != 2 {
		t.Fatal("original work goal histories lost", err)
	}
	ids := map[string]bool{}
	newer := false
	for _, row := range history {
		if row.OriginalGoalID != "goal" || !IsRecoveryWorkGoalID(row.ReadOnlyID) || row.Goal.Status != "paused" || row.Goal.ActiveItemID != "" || ids[row.ReadOnlyID] {
			t.Fatal("mutable/conflicting archive goal identity")
		}
		ids[row.ReadOnlyID] = true
		newer = newer || row.Goal.Title == "newer plan retained"
	}
	if !newer {
		t.Fatal("newer goal was replaced by old backup")
	}
}
