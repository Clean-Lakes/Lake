//go:build unix

package ai

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
)

func parallelChildFixture(t *testing.T, e *Engine, parent SecurityExecutionContext, scope string, asset Asset) (*Engine, Config) {
	t.Helper()
	parentSession, _ := e.get("case")
	child, err := New(filepath.Join(e.Dir, "parallel-children", scope), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(child.Shutdown)
	child.worker = &agentWorker{parent: e, parentID: "case", session: parentSession, runID: scope, turnID: parent.Owner.RootTurnID, role: "application", assets: []string{asset.ID}}
	c := Config{Model: Model{URL: "http://127.0.0.1:1", Name: "fixture"}, Profile: "core", Runtime: "local", SecurityProjectID: "project", Assets: []Asset{asset}, agentRole: "application", securityExecution: &parent, MaxSteps: 12}
	if err = child.Configure(scope, c); err != nil {
		t.Fatal(err)
	}
	s, _ := child.get(scope)
	s.mu.Lock()
	_, err = child.prepareSecurityTurnLocked(t.Context(), s, &c, TurnInput{UserText: "actual host worker step"}, "", parent.Owner.RootTurnID)
	s.state.Config = c
	s.state.Runtime = &RuntimeCheckpoint{Identity: RunIdentity{SessionID: "case", RootTurnID: parent.Owner.RootTurnID, ScopeID: scope}}
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	return child, c
}

func TestSecurityParallelStepChildrenRetainOwnAttemptWhilePeerAwaitsApproval(t *testing.T) {
	e, definition, in := managedWorkflowFixture(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{filepath.Join(dir, "first.log"), filepath.Join(dir, "second.log")}
	for i, path := range paths {
		if err = os.WriteFile(path, []byte([]string{"FIRST_BRANCH_DATA\n", "SECOND_BRANCH_DATA\n"}[i]), 0600); err != nil {
			t.Fatal(err)
		}
	}
	as := Asset{ID: "resource", Kind: "local", Name: "parallel fixed resource"}
	metadata := SecurityCatalogResource{ID: as.ID, ProjectID: "project", Kind: "local", Local: true, MetadataDigest: hash("parallel-resource"), ConnectionIdentity: "parallel-local-resource"}
	digest, _, err := catalogConnectionDigest(metadata, map[string]security.CredentialRevision{})
	if err != nil {
		t.Fatal(err)
	}
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&securityResourceRevisionRow{}).Where("resource_id = ?", as.ID).Updates(map[string]any{"local": true, "kind": "local", "metadata_digest": metadata.MetadataDigest, "connection_digest": digest, "connection_identity": metadata.ConnectionIdentity, "credential_ids": "[]"}).Error; err != nil {
		t.Fatal(err)
	}
	if err = e.SetSecurityCatalogResolver(func(context.Context, SecurityCatalogQuery) (SecurityCatalogView, error) {
		return SecurityCatalogView{ExecutionAssets: []Asset{as}, Resources: []SecurityCatalogResource{metadata}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	policy := security.ProjectPolicy{ProjectID: "project", SchemaVersion: 1, Mode: "restricted", ResourceIDs: []string{as.ID}, Rules: []security.Rule{{Capability: "file.read", Effect: security.EffectAsk, Grantable: true, Confirmation: security.ConfirmEither, Limits: security.ScopeLimits{FileRoots: []string{dir}}}, {Capability: "local.execute", Effect: security.EffectAllow, Grantable: true, Confirmation: security.ConfirmEither}}}
	if _, err = e.PutSecurityProjectPolicy(t.Context(), SecurityPolicyAction{ActorID: "user", ActionID: "parallel-policy", ProjectID: "project", ExpectedRevision: 2}, policy); err != nil {
		t.Fatal(err)
	}
	definition.Steps = append(definition.Steps, SecurityWorkflowStep{ID: "second", Title: "Read independent second branch", Role: "investigator", ResourceIDs: []string{as.ID}})
	definition.Acceptance["second"] = definition.Acceptance["inspect"]
	definition.TemplateVersion = 2
	definition.TemplateDigest = hash("actual-parallel-template")
	if definition, err = e.PutSecurityWorkflowDefinition(t.Context(), SecurityWorkflowDefinitionAction{ActorID: "user", ActionID: "confirm-parallel-plan", ProjectID: "project", WorkflowID: "workflow", ExpectedRevision: 1}, definition); err != nil {
		t.Fatal(err)
	}
	in.TemplateVersion, in.TemplateDigest = 2, definition.TemplateDigest
	binding, err := e.BeginSecurityWorkflowRun(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.ActivateSecurityWorkflowRun(t.Context(), in.RunID); err != nil {
		t.Fatal(err)
	}
	row, goal, err := e.workRow("case", binding.GoalID)
	if err != nil {
		t.Fatal(err)
	}
	firstAttempt, err := e.BeginWorkAttempt("case", goal.ID, "inspect", binding.Task.ID, binding.RootTurnID, "", "first independent branch", row.Revision)
	if err != nil {
		t.Fatal(err)
	}
	base, err := e.CurrentSecurityExecution(t.Context(), "case")
	if err != nil {
		t.Fatal(err)
	}
	first, err := e.securityExecutionForStep(t.Context(), base, "inspect", firstAttempt)
	if err != nil {
		t.Fatal(err)
	}
	row, goal, err = e.workRow("case", goal.ID)
	if err != nil {
		t.Fatal(err)
	}
	secondAttempt, err := e.BeginWorkAttempt("case", goal.ID, "second", binding.Task.ID, binding.RootTurnID, "", "second independent branch", row.Revision)
	if err != nil {
		t.Fatal(err)
	}
	second, err := e.securityExecutionForStep(t.Context(), base, "second", secondAttempt)
	if err != nil {
		t.Fatal(err)
	}
	// Bind branch one after the parent's foreground selector already points at
	// branch two: the trusted frozen tuple must survive that scheduling race.
	childOne, cOne := parallelChildFixture(t, e, first, binding.ChildScopeIDs["inspect"], as)
	childTwo, cTwo := parallelChildFixture(t, e, second, binding.ChildScopeIDs["second"], as)
	grant, err := e.IssueSecurityTaskGrant(t.Context(), SecurityTaskGrantAction{Action: SecurityTaskAction{ActorID: "user", ActionID: "allow-second-branch", ProjectID: "project", SessionID: "case", GoalID: goal.ID, TaskID: binding.Task.ID, ExpectedRevision: binding.Task.StateRevision}, Grant: security.TaskGrant{Resources: binding.Resources, AllowedChildScopes: []string{binding.ChildScopeIDs["second"]}, Capabilities: []string{"file.read", "local.execute"}, Limits: security.ScopeLimits{FileRoots: []string{dir}}, RemainingUses: 3, ExpiresAt: time.Now().UTC().Add(10 * time.Minute)}})
	if err != nil {
		t.Fatal(err)
	}
	aOne := map[string]any{"asset_ref": assetAlias(as.ID), "path": paths[0]}
	callOne := Call{ID: "waiting-branch", Name: "observe_logs", Arguments: js(aOne)}
	pending, decision, err := childOne.PrepareCatalogOperation(t.Context(), binding.ChildScopeIDs["inspect"], cOne, callOne, aOne)
	if err != nil || pending == nil || decision.Effect != security.EffectApprovalRequired {
		t.Fatal("first branch did not retain its own pending authorization", decision, err)
	}
	if err = db.Create(&nativeApproval{ID: "first-branch-waits", SessionID: "case", RootTurnID: binding.RootTurnID, ScopeID: binding.ChildScopeIDs["inspect"], CallID: callOne.ID, SecurityTaskID: binding.Task.ID, DescriptorDigest: pending.digest, StoreID: binding.Task.StoreID, RecoveryEpoch: binding.Task.RecoveryEpoch, Status: "pending", CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().Add(time.Minute)}).Error; err != nil {
		t.Fatal(err)
	}
	aTwo := map[string]any{"asset_ref": assetAlias(as.ID), "path": paths[1]}
	callTwo := Call{ID: "approved-peer", Name: "observe_logs", Arguments: js(aTwo)}
	prepared, decision, err := childTwo.PrepareCatalogOperation(t.Context(), binding.ChildScopeIDs["second"], cTwo, callTwo, aTwo)
	if err != nil || prepared == nil || decision.Effect != security.EffectAllow {
		t.Fatal("peer approval wait froze independent approved branch", decision, err)
	}
	ctx := SecurityOperationContext(t.Context(), prepared)
	sessionTwo, _ := childTwo.get(binding.ChildScopeIDs["second"])
	op, err := childTwo.dispatchNativeOperation(ctx, sessionTwo, prepared.executionConfig, callTwo, "readonly", "parallel peer", prepared.digest)
	if err != nil {
		t.Fatal(err)
	}
	result, readErr := childTwo.executeSecurityLocalFile(securityPermitContext(ctx, op.permit), prepared.executionConfig, callTwo.Name, prepared.executionArgs)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if str(obj(result)["output"]) != "SECOND_BRANCH_DATA\n" {
		t.Fatal("peer read another branch target", result)
	}
	if err = childTwo.finishNativeOperation(op, prepared.executionConfig, result, nil); err != nil {
		t.Fatal(err)
	}
	if remaining := grantRemaining(t, db, grant.ID); remaining != 2 {
		t.Fatal("peer did not share and consume original task budget exactly once", remaining)
	}
	for i, child := range []*Engine{childOne, childTwo} {
		scope := binding.ChildScopeIDs[[]string{"inspect", "second"}[i]]
		current, err := child.CurrentSecurityExecution(t.Context(), scope)
		if err != nil || current.AttemptID != []string{firstAttempt, secondAttempt}[i] {
			t.Fatal("branch adopted peer's active attempt", current, err)
		}
	}
	var operations int64
	if err = db.Model(&nativeOperation{}).Count(&operations).Error; err != nil || operations != 1 {
		t.Fatal("waiting branch executed or duplicated native ledger", operations, err)
	}
}
