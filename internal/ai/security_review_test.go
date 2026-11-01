package ai

import (
	"github.com/Clean-Lakes/Lake/internal/security"
	"testing"
	"time"
)

// Regression from the independent closure review: human acceptance must not
// silently hide an original failed operation whose attempt was never verified.
func TestSecurityReviewHumanAcceptanceCannotSkipPreparedFailedAttempt(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	goal := managedGoalFixture(t, e, "review-manual-failure", true)
	goal, attempt := managedAttemptFixture(t, e, goal, "")
	managedProofFixture(t, e, goal, attempt, "failed", `{"exitCode":1}`)
	if _, err := e.RecordHumanWorkAcceptance(goal.SessionID, goal.ID, goal.Items[0].ID, "local-user", "human-after-unverified-failure", "source", goal.Revision, []string{"services", "tiles", "equal", "preserved"}, "checked"); err == nil {
		t.Fatal("human acceptance hid an original failure behind a prepared attempt")
	}
	store, _ := e.adkStore()
	var original workExecutionAttempt
	if err := store.DB.First(&original, "id = ?", attempt).Error; err != nil {
		t.Fatal(err)
	}
	if original.State == "succeeded" {
		t.Fatal("human acceptance forged original execution success")
	}
}

// Persisted step acceptance does not make a bounded-age observation permanent.
func TestSecurityReviewGoalRejectsExpiredAcceptedEvidence(t *testing.T) {
	for _, manual := range []bool{false, true} {
		name := "automatic"
		if manual {
			name = "manual"
		}
		t.Run(name, func(t *testing.T) {
			e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
			goal := managedGoalFixture(t, e, "review-expiry-"+name, manual)
			step := goal.closure.Steps[goal.Items[0].ID]
			for i := range step.Criteria {
				step.Criteria[i].MaxAgeSeconds = 2
				if !manual {
					step.Criteria[i].SourceDigest = security.ObservationSourceDigest("observe_data", hash("fixed sql.health"), "target-db", 1)
				}
			}
			if err := e.ConfigureWorkAcceptance(goal.SessionID, goal.ID, "project", "local-user", "bounded-evidence-contract", goal.Revision, map[string]WorkStepContract{goal.Items[0].ID: step}); err != nil {
				t.Fatal(err)
			}
			_, goal, _ = e.workRow(goal.SessionID, goal.ID)
			goal, attempt := managedAttemptFixture(t, e, goal, "")
			op := managedProofFixture(t, e, goal, attempt, "succeeded", `{"service":2,"tiles":1442,"differences":0,"existingPreserved":true}`)
			store, _ := e.adkStore()
			if !manual {
				op.Tool, op.ArgsHash = "observe_data", hash("fixed sql.health")
				descriptor := security.PreparedOperation{FormatVersion: security.DescriptorVersion, RegistryVersion: security.RegistryVersion, ID: op.ID, Actor: "agent", Tool: op.Tool, ArgumentsDigest: op.ArgsHash, PreviewDigest: op.ArgsHash, StoreID: "fixture-store", RecoveryEpoch: "fixture-epoch", ProjectID: "project", SessionID: op.SessionID, TaskID: op.SecurityTaskID, GoalID: op.GoalID, GoalRevision: op.GoalRevision, PlanRevision: op.PlanRevision, StepID: op.StepID, StepRevision: op.StepRevision, AttemptID: attempt, RootTurnID: op.RootTurnID, CallID: "fixed-health", OwnerID: op.OwnerID, OwnerGeneration: op.OwnerGeneration, ExecutionRevision: 1, PolicyRevision: 1, TargetKind: security.TargetResource, Resources: []security.ResourceRevision{{ID: "target-db", ConnectionRevision: 1, ConnectionDigest: hash("actual-db"), State: "ready"}}, Capabilities: []string{"db.read"}, Proof: security.ProofStructured, Scope: security.OperationScope{ProbeID: "sql.health", ProbeVersion: securityProbeVersion}}
				digest, err := security.OperationDigest(descriptor)
				if err != nil {
					t.Fatal(err)
				}
				if err = store.DB.Model(&nativeOperation{}).Where("id = ?", op.ID).Updates(map[string]any{"tool": op.Tool, "args_hash": op.ArgsHash, "security_descriptor": js(descriptor), "descriptor_digest": digest, "store_id": "fixture-store", "recovery_epoch": "fixture-epoch"}).Error; err != nil {
					t.Fatal(err)
				}
			}
			accepted, err := e.VerifyWorkStep(goal.SessionID, goal.ID, goal.Items[0].ID, goal.Revision)
			if err != nil {
				t.Fatal(err)
			}
			_, goal, _ = e.workRow(goal.SessionID, goal.ID)
			if manual {
				accepted, err = e.RecordHumanWorkAcceptance(goal.SessionID, goal.ID, goal.Items[0].ID, "local-user", "bounded-human-acceptance", "source", goal.Revision, []string{"services", "tiles", "equal", "preserved"}, "checked")
				if err != nil {
					t.Fatal(err)
				}
				_, goal, _ = e.workRow(goal.SessionID, goal.ID)
			}
			if goal.Items[0].Status != "completed" {
				t.Fatal("fixture did not first pass current evidence")
			}
			past := time.Now().UTC().Add(-time.Hour)
			if err = store.DB.Model(&workAcceptanceRecord{}).Where("id = ?", accepted).Update("at", past).Error; err != nil {
				t.Fatal(err)
			}
			if err = store.DB.Model(&nativeEvidence{}).Where("operation_id = ? AND status = ?", op.ID, "completed").Update("at", past).Error; err != nil {
				t.Fatal(err)
			}
			if _, err = e.VerifyWorkGoal(goal.SessionID, goal.ID, goal.Revision); err != nil {
				t.Fatal(err)
			}
			_, goal, _ = e.workRow(goal.SessionID, goal.ID)
			if goal.Status == "completed" {
				t.Fatal("expired accepted observation completed current goal")
			}
			view, err := e.WorkClosureView(goal.SessionID, goal.ID)
			if err != nil || !view.AcceptanceRequired {
				t.Fatal("projection hid expired proof", view, err)
			}
		})
	}
}

func TestSecurityReviewFailedMutatingProfileKeepsUnresolvedEffects(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	goal := managedGoalFixture(t, e, "review-failed-profile", true)
	goal, attempt := managedAttemptFixture(t, e, goal, "")
	op := managedProofFixture(t, e, goal, attempt, "dispatched", "")
	op.Tool = "shell"
	op.permit = &SecurityPermit{operation: security.PreparedOperation{Proof: security.ProofCommandProfile, CommandProfileID: "service_restart", CommandProfileVersion: security.CommandProfileVersion, Capabilities: []string{"terminal.execute", "service.restart"}}}
	if err := e.finishNativeOperation(&op, Config{}, map[string]any{"exitCode": 1, "stderr": "service failed after stopping old instance"}, nil); err != nil {
		t.Fatal(err)
	}
	store, _ := e.adkStore()
	var original nativeOperation
	if err := store.DB.First(&original, "id = ?", op.ID).Error; err != nil {
		t.Fatal(err)
	}
	if original.Status != "failed" || original.OrphanState == "" || original.RiskResolvedAt != nil {
		t.Fatal("failed mutating profile silently cleared effect uncertainty", original.Status, original.OrphanState)
	}
	if err := CheckResourceWriteBlock(store.DB, op.ResourceID); err != ErrUnresolvedResourceEffect {
		t.Fatal("partial restart no longer blocked conflicting mutation", err)
	}
}
