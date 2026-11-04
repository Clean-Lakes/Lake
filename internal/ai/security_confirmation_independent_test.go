package ai

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
)

// The default UI contract is session-targeted human verification. Its source
// operations still refer to concrete assets, whose current identity must not
// change between human acceptance and final goal aggregation.
func TestSecurityIndependentManualSessionAcceptanceRejectsRepointedAsset(t *testing.T) {
	t.Run("primary", func(t *testing.T) { independentManualRepointedAsset(t, false) })
	t.Run("secondary", func(t *testing.T) { independentManualRepointedAsset(t, true) })
}

func independentManualRepointedAsset(t *testing.T, secondary bool) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	goal := managedGoalFixture(t, e, "independent-manual-asset", true)
	stepID := goal.Items[0].ID
	step := WorkStepContract{VerificationMode: "manual", Required: true, Criteria: []security.AcceptanceCriterion{{ID: "actual-result", Method: "human_verified", TargetKind: security.TargetSession, Target: goal.SessionID, SourceDigest: hash("confirmed-business-condition"), Expected: json.RawMessage(`"actual target verified"`)}}}
	if err := e.ConfigureWorkAcceptance(goal.SessionID, goal.ID, "project", "local-user", "session-manual-contract", goal.Revision, map[string]WorkStepContract{stepID: step}); err != nil {
		t.Fatal(err)
	}
	_, goal, _ = e.workRow(goal.SessionID, goal.ID)
	goal, attempt := managedAttemptFixture(t, e, goal, "")
	op := managedProofFixture(t, e, goal, attempt, "succeeded", `{"actualTarget":"old target"}`)
	store, _ := e.adkStore()
	repointed := "target-db"
	if secondary {
		var original securityResourceRevisionRow
		if err := store.DB.First(&original, "project_id = ? AND resource_id = ?", "project", "target-db").Error; err != nil {
			t.Fatal(err)
		}
		original.ResourceID = "secondary-db"
		original.ConnectionDigest = hash("secondary-connection")
		if err := store.DB.Create(&original).Error; err != nil {
			t.Fatal(err)
		}
		var descriptor security.PreparedOperation
		if err := json.Unmarshal([]byte(op.SecurityDescriptor), &descriptor); err != nil {
			t.Fatal(err)
		}
		descriptor.Tool = "scp_transfer"
		descriptor.TargetKind = security.TargetResourceSet
		descriptor.Capabilities = []string{"transfer.copy"}
		descriptor.Resources = append(descriptor.Resources, security.ResourceRevision{ID: original.ResourceID, ConnectionRevision: original.ConnectionRevision, ConnectionDigest: original.ConnectionDigest, State: "ready"})
		digest, err := security.OperationDigest(descriptor)
		if err != nil {
			t.Fatal(err)
		}
		if err = store.DB.Model(&nativeOperation{}).Where("id = ?", op.ID).Updates(map[string]any{"tool": descriptor.Tool, "security_descriptor": js(descriptor), "descriptor_digest": digest}).Error; err != nil {
			t.Fatal(err)
		}
		repointed = original.ResourceID
	}
	if _, err := e.VerifyWorkStep(goal.SessionID, goal.ID, stepID, goal.Revision); err != nil {
		t.Fatal(err)
	}
	_, goal, _ = e.workRow(goal.SessionID, goal.ID)
	if _, err := e.RecordHumanWorkAcceptance(goal.SessionID, goal.ID, stepID, "local-user", "verified-original-target", "source", goal.Revision, []string{"actual-result"}, "人工已核实原目标"); err != nil {
		t.Fatal(err)
	}
	_, goal, _ = e.workRow(goal.SessionID, goal.ID)
	if err := store.DB.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND resource_id = ?", "project", repointed).Update("connection_revision", 2).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := e.VerifyWorkGoal(goal.SessionID, goal.ID, goal.Revision); err != nil {
		t.Fatal(err)
	}
	_, current, _ := e.workRow(goal.SessionID, goal.ID)
	if current.Status == "completed" {
		t.Fatal("session-targeted manual acceptance completed a goal after its original execution asset was repointed")
	}
}

func TestSecurityIndependentModeDoesNotTreatNonemptyDescriptorAsVerifiedEffectScope(t *testing.T) {
	e := managedEngineFixture(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"})
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	if err = store.DB.Create(&nativeOperation{ID: "unverifiable-original", SessionID: "case", ProjectID: "project", Status: "unknown", Risk: "write", SecurityDescriptor: `{}`, DescriptorDigest: hash("unrelated bytes")}).Error; err != nil {
		t.Fatal(err)
	}
	status, err := e.SecurityMode(t.Context(), []string{"project"})
	if err != nil {
		t.Fatal(err)
	}
	if status.Precondition == "READY" {
		t.Fatal("mode activation treated a merely nonempty, unverifiable descriptor as a proven effect scope")
	}
}

func TestSecurityIndependentGenericResolutionCannotChangePendingRecoverySourceFacts(t *testing.T) {
	e, db, _, impact, proof := recoveryReconciliationFixture(t)
	var descriptor security.PreparedOperation
	if err := json.Unmarshal([]byte(impact.Descriptor), &descriptor); err != nil {
		t.Fatal(err)
	}
	original := proof
	original.ID = impact.OperationID
	original.Status = "unknown"
	original.SecurityTaskID = descriptor.TaskID
	original.StoreID = descriptor.StoreID
	original.RecoveryEpoch = descriptor.RecoveryEpoch
	original.SecurityDescriptor = impact.Descriptor
	original.DescriptorDigest = impact.DescriptorDigest
	if err := db.Create(&original).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&securityRecoveryImpactRow{}).Where("id = ?", impact.ID).Update("record_digest", recoveryImpactRecordDigest(original)).Error; err != nil {
		t.Fatal(err)
	}
	err := e.ResolveOperation(original.SessionID, original.ID, "failed", "人工通过普通旧入口核实")
	if err == nil {
		t.Fatal("ordinary operation resolution changed immutable pending source facts and made source-bound recovery reconciliation unreleasable")
	}
	if !strings.Contains(err.Error(), "source-bound recovery reconciliation") {
		t.Fatal("resolution refused for an unrelated reason", err)
	}
	var current nativeOperation
	if err = db.First(&current, "id = ?", original.ID).Error; err != nil {
		t.Fatal(err)
	}
	if recoveryImpactRecordDigest(current) != recoveryImpactRecordDigest(original) {
		t.Fatal("refusal changed canonical original source facts")
	}
	var block securityRecoveryResourceBlockRow
	if err = db.First(&block, "impact_id = ?", impact.ID).Error; err != nil || block.State != "blocked" {
		t.Fatal("ordinary resolution cleared the source block", err)
	}
	// Startup must preserve the same immutable dispatched facts for source
	// reconciliation, while retaining normal interrupted-call handling elsewhere.
	original.Status = "dispatched"
	if err = db.Model(&nativeOperation{}).Where("id = ?", original.ID).Update("status", original.Status).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&securityRecoveryImpactRow{}).Where("id = ?", impact.ID).Update("record_digest", recoveryImpactRecordDigest(original)).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Create(&nativeOperation{ID: "ordinary-interrupted-call", SessionID: "ordinary", Status: "dispatched"}).Error; err != nil {
		t.Fatal(err)
	}
	if err = recoverDispatchedSecurityOperations(db); err != nil {
		t.Fatal(err)
	}
	if err = db.First(&current, "id = ?", original.ID).Error; err != nil || recoveryImpactRecordDigest(current) != recoveryImpactRecordDigest(original) {
		t.Fatal("restart changed the source-linked original", err)
	}
	var ordinary nativeOperation
	if err = db.First(&ordinary, "id = ?", "ordinary-interrupted-call").Error; err != nil || ordinary.Status != "unknown" {
		t.Fatal("startup stopped handling ordinary interrupted operations", err)
	}
	if err = db.Delete(&ordinary).Error; err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	_, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	adapter := &independentRecoveryCleanupCounter{calls: &calls}
	if err = ReconcileOrphanedExecutions(t.Context(), db, storeID, epoch, time.Now().UTC(), func(string, string) OrphanCleanupAdapter { return adapter }); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 0 {
		t.Fatal("ordinary cleanup touched a pending recovery source")
	}
	if err = db.First(&current, "id = ?", original.ID).Error; err != nil || recoveryImpactRecordDigest(current) != recoveryImpactRecordDigest(original) {
		t.Fatal("orphan scanning changed immutable source facts", err)
	}
}

type independentRecoveryCleanupCounter struct{ calls *atomic.Int32 }

func (c *independentRecoveryCleanupCounter) Cancel(context.Context, ExecutionCleanup) (CancellationObservation, error) {
	c.calls.Add(1)
	return CancellationConfirmed, nil
}
func (c *independentRecoveryCleanupCounter) Observe(context.Context, ExecutionCleanup) (OrphanObservation, error) {
	c.calls.Add(1)
	return OrphanObservation{Stopped: true, EffectsKnown: true, Status: "failed"}, nil
}
