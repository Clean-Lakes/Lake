package ai

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func TestSecurityRecoveryMissingOneEntrypointRemainsClosed(t *testing.T) {
	all := append(security.RegisteredTools(), securityRequiredExecutionFamilies[:]...)
	readiness, proof := verifySecurityEnforcementCoverage(all[:len(all)-1])
	if readiness.Ready || proof.registryDigest != "" || readiness.Reason != "ENTRYPOINT_COVERAGE_INCOMPLETE" {
		t.Fatal("partial coverage attested enforcement", readiness)
	}
}

func issueRecoveryReadGrant(t *testing.T, e *Engine, sessionID, action string, limits security.ScopeLimits) {
	t.Helper()
	current, err := e.CurrentSecurityExecution(t.Context(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	db, _, _, _ := e.securityTaskDB()
	var resource securityResourceRevisionRow
	if err = db.First(&resource, "project_id = ? AND resource_id = ?", "project", "resource").Error; err != nil {
		t.Fatal(err)
	}
	_, err = e.IssueSecurityTaskGrant(t.Context(), SecurityTaskGrantAction{Action: SecurityTaskAction{ActorID: "local-user", ActionID: action, ProjectID: "project", SessionID: sessionID, GoalID: current.GoalID, TaskID: current.Task.ID, ExpectedRevision: current.Task.StateRevision}, Grant: security.TaskGrant{Resources: []security.ResourceRevision{recoveryResourceReference(resource)}, Capabilities: []string{"file.read", "local.execute"}, Limits: limits, RemainingUses: 10, ExpiresAt: time.Now().UTC().Add(10 * time.Minute)}})
	if err != nil {
		t.Fatal(err)
	}
}

func recoveryFileOperation(t *testing.T, e *Engine, c Config, sessionID, callID, path string, finish bool) nativeOperation {
	t.Helper()
	call := Call{ID: callID, Name: "read", Arguments: js(map[string]any{"asset_ref": assetAlias("resource"), "path": path})}
	a, _ := args(call)
	prepared, decision, err := e.PrepareCatalogOperation(t.Context(), sessionID, c, call, a)
	if err != nil || prepared == nil || decision.Effect != security.EffectAllow {
		t.Fatal("actual read preparation", decision, err)
	}
	s, _ := e.get(sessionID)
	ctx := SecurityOperationContext(t.Context(), prepared)
	op, err := e.dispatchNativeOperation(ctx, s, prepared.executionConfig, call, "readonly", "bounded recovery file", prepared.digest)
	if err != nil {
		t.Fatal(err)
	}
	if finish {
		result, readErr := e.executeSecurityLocalFile(securityPermitContext(ctx, op.permit), prepared.executionConfig, "read", prepared.executionArgs)
		if readErr != nil || !strings.Contains(js(result), "bounded actual content") {
			t.Fatal(result, readErr)
		}
		if err = e.finishNativeOperation(op, c, result, readErr); err != nil {
			t.Fatal(err)
		}
	}
	db, _, _, _ := e.securityTaskDB()
	var persisted nativeOperation
	if err = db.First(&persisted, "id = ?", op.ID).Error; err != nil {
		t.Fatal(err)
	}
	return persisted
}

func recoveryReconciliationFixture(t *testing.T) (*Engine, *gorm.DB, securityRestoreJournal, securityRecoveryImpactRow, nativeOperation) {
	t.Helper()
	e, c, call, _, _ := grantConfirmationFixture(t)
	a, _ := args(call)
	path := str(a["path"])
	issueRecoveryReadGrant(t, e, "case", "explicit-recovery-read", security.ScopeLimits{FileRoots: []string{filepath.Dir(path)}})
	op := recoveryFileOperation(t, e, c, "case", "verification-read", path, true)
	db, store, epoch, _ := e.securityTaskDB()
	if err := db.AutoMigrate(securityRecoveryModels()...); err != nil {
		t.Fatal(err)
	}
	var original security.PreparedOperation
	if json.Unmarshal([]byte(op.SecurityDescriptor), &original) != nil {
		t.Fatal("descriptor")
	}
	original.ID = "old-original-op"
	original.TaskID = "old-task"
	original.RecoveryEpoch = "old-epoch"
	digest, err := security.OperationDigest(original)
	if err != nil {
		t.Fatal(err)
	}
	journal := securityRestoreJournal{After: security.ControlState{StoreID: store, RecoveryEpoch: epoch, RecoveryID: "recovery"}, LedgerIndexHash: "ledger"}
	impact := securityRecoveryImpactRow{ID: "impact", RecoveryID: "recovery", Source: "incoming", SourceID: "original-checkpoint", OperationID: original.ID, OperationRef: "incoming:old-original-op", Descriptor: js(original), DescriptorDigest: digest, RecordDigest: "original-record", ScopeState: "mapped", ResourceIDs: `["resource"]`, Revision: 2}
	ref := original.Resources[0]
	for _, row := range []any{&securityRecoveryReviewRow{RecoveryID: "recovery", StoreID: store, RecoveryEpoch: epoch, LedgerIndexHash: "ledger", State: "activation_prepared", Revision: 7}, &impact, &securityRecoveryResourceBlockRow{ID: "block", RecoveryID: "recovery", ImpactID: impact.ID, ProjectID: "project", ResourceID: "resource", ConnectionRevision: ref.ConnectionRevision, ConnectionDigest: ref.ConnectionDigest, State: "blocked", Revision: 1}} {
		if err = db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	return e, db, journal, impact, op
}

func TestSecurityRecoveryVerificationRequiresOriginalCurrentProof(t *testing.T) {
	for _, change := range []string{"valid", "old-epoch", "changed-asset", "raw-proof", "mutating-envelope", "missing-evidence", "wrong-path", "different-resource"} {
		t.Run(change, func(t *testing.T) {
			_, db, journal, impact, op := recoveryReconciliationFixture(t)
			switch change {
			case "old-epoch":
				db.Model(&nativeOperation{}).Where("id = ?", op.ID).Update("recovery_epoch", "old-epoch")
			case "changed-asset":
				db.Model(&securityResourceRevisionRow{}).Where("resource_id = ?", "resource").Update("connection_revision", 2)
			case "raw-proof", "wrong-path":
				var descriptor security.PreparedOperation
				json.Unmarshal([]byte(op.SecurityDescriptor), &descriptor)
				if change == "raw-proof" {
					descriptor.Proof = security.ProofOpaque
				} else {
					descriptor.Scope.FilePath += "-other"
				}
				digest, _ := security.OperationDigest(descriptor)
				db.Model(&nativeOperation{}).Where("id = ?", op.ID).Updates(map[string]any{"security_descriptor": js(descriptor), "descriptor_digest": digest})
			case "mutating-envelope":
				var row securityTaskEnvelopeRow
				db.First(&row, "task_id = ?", op.SecurityTaskID)
				var envelope security.TaskEnvelope
				json.Unmarshal([]byte(row.Data), &envelope)
				envelope.Capabilities = append(envelope.Capabilities, "file.write")
				db.Model(&securityTaskEnvelopeRow{}).Where("task_id = ?", op.SecurityTaskID).Update("data", js(envelope))
			case "missing-evidence":
				db.Where("operation_id = ? AND status = ?", op.ID, "completed").Delete(&nativeEvidence{})
			case "different-resource":
				db.Model(&nativeOperation{}).Where("id = ?", op.ID).Update("resource_id", "other")
			}
			preview, err := recoveryReconciliationPreviewTx(db, journal, impact.ID, "resource", op.ID, time.Now().UTC())
			if change == "valid" {
				if err != nil || preview.SourceID != impact.SourceID || preview.Digest == "" || len(preview.Evidence) == 0 {
					t.Fatal(preview, err)
				}
			} else if err == nil {
				t.Fatal("invalid verification proof accepted", change)
			}
			if err = CheckSecurityRecoveryWriteBlocks(db, []string{"resource"}); !errors.Is(err, ErrUnresolvedResourceEffect) {
				t.Fatal("successful different goal automatically cleared source risk", err)
			}
		})
	}
}

func TestSecurityRecoveryActivateRestartAndExplicitEffectReconciliation(t *testing.T) {
	ctx := context.Background()
	old, c, call, _, _ := grantConfirmationFixture(t)
	a, _ := args(call)
	path := str(a["path"])
	limits := security.ScopeLimits{FileRoots: []string{filepath.Dir(path)}}
	issueRecoveryReadGrant(t, old, "case", "source-read-scope", limits)
	original := recoveryFileOperation(t, old, c, "case", "interrupted-original-read", path, false)
	home := old.securityHome()
	old.Shutdown()
	home.Close()
	dataRoot := filepath.Dir(home.RuntimeRoot)
	// The shared managed fixture writes sidecars under home/ai; place the closed
	// fixture's actual sidecars in the paired production-layout directory before
	// exercising the real offline checkpoint/restore protocol.
	if err := os.Rename(filepath.Join(home.Home, "ai"), filepath.Join(dataRoot, "ai")); err != nil {
		t.Fatal(err)
	}
	web, err := sql.Open("sqlite", filepath.Join(dataRoot, "lake-web.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = web.Exec(`CREATE TABLE projects(id TEXT PRIMARY KEY);INSERT INTO projects VALUES('project');CREATE TABLE resources(id TEXT PRIMARY KEY,projectId TEXT,kind TEXT);INSERT INTO resources VALUES('resource','project','local');CREATE TABLE resourceConnections(resourceId TEXT PRIMARY KEY,config TEXT);INSERT INTO resourceConnections VALUES('resource','{}')`)
	web.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(filepath.Join(dataRoot, "lake-web.sqlite"), 0600); err != nil {
		t.Fatal(err)
	}
	checkpoint := filepath.Join(t.TempDir(), "checkpoint")
	if _, err = CreateSecurityCheckpoint(ctx, home.Home, checkpoint); err != nil {
		t.Fatal(err)
	}
	if _, err = RestoreSecurityBackup(ctx, home.Home, checkpoint, false); err != nil {
		t.Fatal(err)
	}
	owner, err := OpenSecurityReadOnlyHome(home.Home, "")
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	review, err := owner.SecurityRecoveryReview(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, impact := range review.Impacts {
		review, err = owner.MapSecurityRecoveryImpact(ctx, SecurityRecoveryMapping{Action: recoveryAction(review, "map-"+impact.ID), ImpactID: impact.ID, RecordDigest: impact.RecordDigest, ResourceIDs: []string{"resource"}})
		if err != nil {
			t.Fatal(err)
		}
	}
	policy := security.ProjectPolicy{ProjectID: "project", SchemaVersion: 1, Mode: "restricted", ResourceIDs: []string{"resource"}, Rules: []security.Rule{{Capability: "file.read", Effect: security.EffectAsk, Grantable: true, Confirmation: security.ConfirmTask, Limits: limits}, {Capability: "local.execute", Effect: security.EffectAllow}}}
	review, err = owner.ConfirmSecurityRecoveryPolicy(ctx, SecurityRecoveryPolicyConfirmation{Action: recoveryAction(review, "reconfirm-policy"), ProjectID: "project", SourceDigest: review.Policies[0].SourceDigest, Policy: policy})
	if err != nil {
		t.Fatal(err)
	}
	for _, legacy := range review.LegacyPolicies {
		review, err = owner.ConfirmSecurityRecoveryLegacyPolicy(ctx, SecurityRecoveryLegacyConfirmation{Action: recoveryAction(review, "reconfirm-legacy-"+legacy.SessionID), SessionID: legacy.SessionID, SourceDigest: legacy.SourceDigest, Permissions: Permissions{}})
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(review.WriteBlockedResourceIDs) != 1 {
		t.Fatal("original effects not blocked")
	}
	if !SecurityEnforcementStatus().Ready {
		t.Skip("requires the real complete compiled entrypoint proof; never substitutes a test allow flag")
	}
	review, err = owner.ActivateSecurityRecovery(ctx, recoveryAction(review, "activate-verified-recovery"))
	if err != nil {
		t.Fatal(err)
	}
	owner.Close()
	active, err := OpenSecurityHome(ctx, home.Home, "")
	if err != nil {
		t.Fatal("activated Home could not restart", err)
	}
	defer active.Close()
	e, err := New(filepath.Join(dataRoot, "ai"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	e.SecurityRuntime = active
	defer e.Shutdown()
	metadata := SecurityCatalogResource{Local: true, ID: "resource", ProjectID: "project", Kind: "local", MetadataDigest: hash("fixed-metadata-resource"), ConnectionIdentity: "nonsecret-fixed-resource"}
	if err = e.SetSecurityCatalogResolver(func(context.Context, SecurityCatalogQuery) (SecurityCatalogView, error) {
		return SecurityCatalogView{ExecutionAssets: c.Assets, Resources: []SecurityCatalogResource{metadata}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	c.SecurityProjectID = "project"
	c.Model = Model{URL: "http://127.0.0.1:1", Name: "metadata-only"}
	if err = e.Configure("verify", c); err != nil {
		t.Fatal(err)
	}
	definition := SecurityWorkflowDefinition{ProjectID: "project", WorkflowID: "recovery-verification", TemplateVersion: 1, TemplateDigest: security.ContentDigest([]byte("explicit-recovery-verification-contract")), Goal: "Verify original interrupted effect", Steps: []SecurityWorkflowStep{{ID: "inspect", Title: "Read the original exact path and manually verify residual effects", Role: "investigator", ResourceIDs: []string{"resource"}}}, Acceptance: map[string]WorkStepContract{"inspect": {Required: true, VerificationMode: "manual", Criteria: []security.AcceptanceCriterion{{ID: "review", Target: "resource", TargetKind: security.TargetResource, ConnectionRevision: 1, SourceDigest: security.ContentDigest([]byte("explicit-human-original-effect-review")), Method: "human_verified"}}}}}
	definition, err = e.PutSecurityWorkflowDefinition(ctx, SecurityWorkflowDefinitionAction{ActorID: "local-user", ActionID: "new-verified-contract", ProjectID: "project", WorkflowID: definition.WorkflowID}, definition)
	if err != nil {
		t.Fatal(err)
	}
	binding, err := e.BeginSecurityWorkflowRun(ctx, SecurityWorkflowRunInput{RunID: "new-epoch-verification", WorkflowID: definition.WorkflowID, ProjectID: "project", SessionID: "verify", TemplateVersion: 1, TemplateDigest: definition.TemplateDigest, ActorID: "local-user", ActionID: "new-epoch-task", SourceKind: "workflow_run", SourceEventID: "new-epoch-verification", ExpiresAt: time.Now().UTC().Add(20 * time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.ActivateSecurityWorkflowRun(ctx, binding.RunID); err != nil {
		t.Fatal(err)
	}
	row, goal, err := e.workRow("verify", binding.GoalID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.BeginWorkAttempt("verify", goal.ID, "inspect", binding.Task.ID, binding.RootTurnID, "", "verify original source", row.Revision); err != nil {
		t.Fatal(err)
	}
	issueRecoveryReadGrant(t, e, "verify", "explicit-read-verification-grant", limits)
	proof := recoveryFileOperation(t, e, c, "verify", "read-original-path", path, true)
	review, err = e.ActiveSecurityRecoveryReview(ctx)
	if err != nil || len(review.WriteBlockedResourceIDs) != 1 {
		t.Fatal("new goal success cleared block", review, err)
	}
	beforeIndex, err := ReadRecoveryLedgerIndex(ctx, home.Home)
	if err != nil {
		t.Fatal(err)
	}
	for _, impact := range review.Impacts {
		preview, err := e.SecurityRecoveryReconciliationPreview(ctx, impact.ID, "resource", proof.ID)
		if err != nil {
			t.Fatal(err)
		}
		input := SecurityRecoveryReconciliation{Action: recoveryAction(review, "release-"+impact.ID), ImpactID: impact.ID, SourceID: impact.SourceID, RecordDigest: impact.RecordDigest, ResourceID: "resource", OperationID: proof.ID, PreviewDigest: preview.Digest, Evidence: preview.Evidence, Confirmation: preview.Confirmation}
		forged := input
		forged.SourceID = "another-source"
		if _, err = e.ReconcileSecurityRecoveryImpact(ctx, forged); err == nil {
			t.Fatal("forged source accepted")
		}
		forged = input
		forged.Evidence = append([]SecurityRecoveryEvidenceRef(nil), input.Evidence...)
		forged.Evidence[0].Digest = "forged"
		if _, err = e.ReconcileSecurityRecoveryImpact(ctx, forged); err == nil {
			t.Fatal("forged evidence accepted")
		}
		review, err = e.ReconcileSecurityRecoveryImpact(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		again, err := e.ReconcileSecurityRecoveryImpact(ctx, input)
		if err != nil || again.Revision != review.Revision {
			t.Fatal("release not idempotent", err)
		}
	}
	if len(review.WriteBlockedResourceIDs) != 0 {
		t.Fatal("all exact source blocks were not reconciled")
	}
	db, _, _, _ := e.securityTaskDB()
	if err = CheckSecurityRecoveryWriteBlocks(db, []string{"resource"}); err != nil {
		t.Fatal(err)
	}
	var preserved nativeOperation
	if err = db.First(&preserved, "id = ?", original.ID).Error; err != nil || preserved.Status != original.Status || preserved.DescriptorDigest != original.DescriptorDigest || preserved.RiskResolvedAt == nil {
		t.Fatal("original status changed or canonical risk remains", err)
	}

	var prior workExecutionAttempt
	if err = db.First(&prior, "id = ?", original.AttemptID).Error; err != nil || prior.ClosureState != "reconciled" || prior.State == "succeeded" {
		t.Fatal("effect closure failed to retain original non-success attempt", prior, err)
	}
	if err = e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	originalRow, originalGoal, err := e.workRow("case", original.GoalID)
	if err != nil {
		t.Fatal(err)
	}
	if err = e.SelectSecurityGoal(ctx, SecurityGoalSelection{ActorID: "local-user", ActionID: "continue-original-goal", ProjectID: "project", SessionID: "case", GoalID: original.GoalID, SourceMessageID: "new-actual-user-continuation", ExpectedGoalRevision: originalRow.GoalRevision}); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.View.RootTurnID = "new-actual-user-root"
	nextConfig := s.state.Config
	resumed, resumeErr := e.prepareSecurityTurnLocked(ctx, s, &nextConfig, TurnInput{StrategyMessageID: "new-actual-user-continuation", UserText: "继续核实后原来的任务", SecurityIntent: IntentContinueGoal, SecurityGoalID: original.GoalID, SecurityGoalRevision: originalRow.GoalRevision}, "new-actual-user-continuation", "new-actual-user-root")
	s.state.Config = nextConfig
	s.mu.Unlock()
	if resumeErr != nil {
		t.Fatal("new task could not resume original goal", resumeErr)
	}
	if resumed.Task.ID == original.SecurityTaskID || resumed.Task.RecoveryEpoch != active.control.RecoveryEpoch {
		t.Fatal("original goal revived old execution authority")
	}
	var inheritedGrants int64
	if err = db.Model(&securityTaskGrantRow{}).Where("task_id = ?", resumed.Task.ID).Count(&inheritedGrants).Error; err != nil || inheritedGrants != 0 {
		t.Fatal("recovery continuation inherited authority", inheritedGrants, err)
	}

	originalRow, originalGoal, err = e.workRow("case", originalGoal.ID)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := e.BeginWorkAttempt("case", originalGoal.ID, original.StepID, resumed.Task.ID, "new-actual-user-root", original.AttemptID, "explicit post-recovery retry", originalRow.Revision)
	if err != nil || retry == original.AttemptID {
		t.Fatal("reconciled original attempt was permanently unretryable", retry, err)
	}
	var accepted int64
	if err = db.Model(&workAcceptanceRecord{}).Where("goal_id = ? AND state = ?", original.GoalID, "pass").Count(&accepted).Error; err != nil || accepted != 0 {
		t.Fatal("effect reconciliation invented business acceptance", accepted, err)
	}
	afterIndex, err := ReadRecoveryLedgerIndex(ctx, home.Home)
	if err != nil || js(beforeIndex) != js(afterIndex) {
		t.Fatal("immutable recovery archive changed", err)
	}
}

func TestSecurityRecoveryPreservedOnlyEffectClosesOnlyExistingAttemptFence(t *testing.T) {
	for _, pending := range []bool{true, false} {
		t.Run(map[bool]string{true: "pending-other-source", false: "all-sources-reconciled"}[pending], func(t *testing.T) {
			_, db, journal, impact, probe := recoveryReconciliationFixture(t)
			var original security.PreparedOperation
			if json.Unmarshal([]byte(impact.Descriptor), &original) != nil {
				t.Fatal("descriptor")
			}
			original.AttemptID = "old-original-attempt"
			digest, err := security.OperationDigest(original)
			if err != nil {
				t.Fatal(err)
			}
			impact.Descriptor, impact.DescriptorDigest = js(original), digest
			if err = db.Save(&impact).Error; err != nil {
				t.Fatal(err)
			}
			attempt := workExecutionAttempt{ID: original.AttemptID, ProjectID: original.ProjectID, SessionID: original.SessionID, GoalID: original.GoalID, StepID: original.StepID, SecurityTaskID: original.TaskID, RootTurnID: original.RootTurnID, GoalRevision: original.GoalRevision, PlanRevision: original.PlanRevision, StepRevision: original.StepRevision, State: "prepared", ClosureState: "open", Revision: 1}
			if err = db.Create(&attempt).Error; err != nil {
				t.Fatal(err)
			}
			receipt := securityRecoveryReconciliationRow{ID: "receipt", RecoveryID: journal.After.RecoveryID, ImpactID: impact.ID, SourceID: impact.SourceID}
			if err = db.Create(&receipt).Error; err != nil {
				t.Fatal(err)
			}
			if !pending {
				if err = db.Model(&securityRecoveryResourceBlockRow{}).Where("id = ?", "block").Update("state", "reconciled").Error; err != nil {
					t.Fatal(err)
				}
			}
			archived := nativeOperation{ID: original.ID, SessionID: original.SessionID, GoalID: original.GoalID, StepID: original.StepID, AttemptID: original.AttemptID, SecurityTaskID: original.TaskID, RootTurnID: original.RootTurnID, GoalRevision: original.GoalRevision, PlanRevision: original.PlanRevision, StepRevision: original.StepRevision}
			if err = db.Transaction(func(tx *gorm.DB) error {
				return closeReconciledRecoveryAttemptTx(tx, journal, archived, receipt.ID, time.Now().UTC())
			}); err != nil {
				t.Fatal(err)
			}
			var after workExecutionAttempt
			if err = db.First(&after, "id = ?", attempt.ID).Error; err != nil {
				t.Fatal(err)
			}
			if after.State != "prepared" || pending && after.ClosureState != "open" || !pending && after.ClosureState != "reconciled" {
				t.Fatal("effect closure changed execution truth or ignored other source", after)
			}
			var missingOperation, missingEvidence, passes int64
			db.Model(&nativeOperation{}).Where("id = ?", original.ID).Count(&missingOperation)
			db.Model(&nativeEvidence{}).Where("operation_id = ?", original.ID).Count(&missingEvidence)
			db.Model(&workAcceptanceRecord{}).Where("goal_id = ? AND state = ?", probe.GoalID, "pass").Count(&passes)
			if missingOperation != 0 || missingEvidence != 0 || passes != 0 {
				t.Fatal("preserved-only reconciliation fabricated execution or acceptance", missingOperation, missingEvidence, passes)
			}
		})
	}
}
