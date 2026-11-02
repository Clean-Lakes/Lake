package ai

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func managedWorkflowFixture(t *testing.T) (*Engine, SecurityWorkflowDefinition, SecurityWorkflowRunInput) {
	t.Helper()
	e := managedEngineFixture(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"})
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	home := e.securityHome()
	resource := securityResourceRevisionRow{ProjectID: "project", ResourceID: "resource", StoreID: home.control.StoreID, RecoveryEpoch: home.control.RecoveryEpoch, ConnectionRevision: 1, ConnectionDigest: security.ContentDigest([]byte("actual-connection")), ConnectionIdentity: "host:22/account-ref", State: "ready"}
	if err = store.DB.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	policy := security.ProjectPolicy{ProjectID: "project", SchemaVersion: 1, Mode: "restricted", ResourceIDs: []string{"resource"}, Rules: []security.Rule{{Capability: "file.read", Effect: security.EffectAsk, Grantable: true, Confirmation: security.ConfirmEither}}}
	if _, err = e.PutSecurityProjectPolicy(context.Background(), SecurityPolicyAction{ActorID: "user", ActionID: "workflow-policy", ProjectID: "project", ExpectedRevision: 1}, policy); err != nil {
		t.Fatal(err)
	}
	definition := SecurityWorkflowDefinition{ProjectID: "project", WorkflowID: "workflow", TemplateVersion: 1, TemplateDigest: security.ContentDigest([]byte("actual-template")), Goal: "Inspect actual health", Steps: []SecurityWorkflowStep{{ID: "inspect", Title: "Read actual health", Role: "investigator", ResourceIDs: []string{"resource"}}}, Acceptance: map[string]WorkStepContract{"inspect": {Required: true, Criteria: []security.AcceptanceCriterion{{ID: "healthy", Target: "resource", ConnectionRevision: 1, SourceDigest: security.ObservationSourceDigest("read", security.ContentDigest([]byte("reviewed-query")), "resource", 1), Method: "json_equal", Pointer: "/healthy", Expected: json.RawMessage(`true`)}}}}}
	definition, err = e.PutSecurityWorkflowDefinition(context.Background(), SecurityWorkflowDefinitionAction{ActorID: "user", ActionID: "confirm-workflow", ProjectID: "project", WorkflowID: "workflow"}, definition)
	if err != nil {
		t.Fatal(err)
	}
	in := SecurityWorkflowRunInput{RunID: "actual-run", WorkflowID: "workflow", ProjectID: "project", SessionID: "case", TemplateVersion: 1, TemplateDigest: definition.TemplateDigest, ActorID: "user", ActionID: "run-workflow", SourceKind: "workflow_run", SourceEventID: "actual-run", ExpiresAt: time.Now().UTC().Add(20 * time.Minute)}
	return e, definition, in
}

func TestSecurityWorkflowRunFrozenIdentitySingleClaimAndOriginalSREAttempt(t *testing.T) {
	e, definition, in := managedWorkflowFixture(t)
	ctx := context.Background()
	binding, err := e.BeginSecurityWorkflowRun(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	again, err := e.BeginSecurityWorkflowRun(ctx, in)
	if err != nil || again.Task.ID != binding.Task.ID || !again.Task.ExpiresAt.Equal(binding.Task.ExpiresAt) {
		t.Fatal("run replay replaced authority", again, err)
	}
	if binding.Task.ID == "" || binding.SourceMessageID != "" || binding.SourceKind != "workflow_run" || binding.SourceEventID != in.RunID || len(binding.Resources) != 1 || binding.Resources[0].ConnectionIdentity == "" {
		t.Fatal("generated workflow was misclassified as a user source", binding)
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []struct {
		id   string
		want bool
	}{{binding.ChildScopeIDs["inspect"], true}, {"unregistered-worker", false}, {binding.ChildScopeIDs["inspect"][:16], false}} {
		ok, err := securityTaskAllowsFutureChildScope(db, binding.Task.ID, candidate.id, storeID, epoch)
		if err != nil || ok != candidate.want {
			t.Fatal("future child delegation was not exact", candidate, ok, err)
		}
	}
	if _, err = e.ActivateSecurityWorkflowRun(ctx, in.RunID); err != nil {
		t.Fatal(err)
	}
	if _, err = e.ActivateSecurityWorkflowRun(ctx, in.RunID); err == nil {
		t.Fatal("same durable run admitted twice")
	}
	plan := SREPlanRevision{ID: "actual-plan", Goal: definition.Goal, Steps: []SREPlanStep{{ID: "inspect", Description: definition.Steps[0].Title, Role: SREInvestigator, ResourceIDs: []string{"resource"}}}}
	task := SRETask{ID: "actual-sre-task", SessionID: "case", ProjectID: "project", Status: "active", Plans: []SREPlanRevision{plan}}
	repo := &srePolicyRepository{task: task}
	e.SetSRERepository(repo)
	if err = e.BindSecuritySREPlan(ctx, "case", task.ID); err != nil {
		t.Fatal(err)
	}
	execution, err := e.prepareSecuritySRERole(ctx, "case", task, plan.Steps[0], "actual-sre-attempt", false)
	if err != nil {
		t.Fatal(err)
	}
	if execution.Task.ID != binding.Task.ID || execution.GoalID != binding.GoalID || execution.StepID != "inspect" || execution.AttemptID == "" {
		t.Fatal("SRE lost original workflow task/goal", execution)
	}
	scope, err := e.claimSecurityWorkflowChildScope(ctx, execution, task.ID, "actual-sre-attempt")
	if err != nil || scope != binding.ChildScopeIDs["inspect"] {
		t.Fatal("actual first worker lost frozen delegation", scope, err)
	}
	if repeated, err := e.claimSecurityWorkflowChildScope(ctx, execution, task.ID, "actual-sre-attempt"); err != nil || repeated != scope {
		t.Fatal("same attempt changed scope", repeated, err)
	}
	if retry, err := e.claimSecurityWorkflowChildScope(ctx, execution, task.ID, "unassociated-retry"); err == nil || retry != "" {
		t.Fatal("unassociated retry copied prior child delegation", retry, err)
	}
	store, _ := e.adkStore()
	var mapped securitySREAttemptBinding
	if err = store.DB.First(&mapped, "sre_attempt_id = ?", "actual-sre-attempt").Error; err != nil || mapped.AttemptID != execution.AttemptID {
		t.Fatal(mapped, err)
	}
	if _, err = e.prepareSecuritySRERole(ctx, "case", task, plan.Steps[0], "actual-sre-attempt", false); err != nil {
		t.Fatal("exact SRE callback could not retain original attempt", err)
	}
	if _, err = e.prepareSecuritySRERole(ctx, "case", task, plan.Steps[0], "different-sre-attempt", false); err == nil {
		t.Fatal("new SRE attempt silently borrowed original attempt")
	}
	var operations int64
	if err = store.DB.Model(&nativeOperation{}).Count(&operations).Error; err != nil || operations != 0 {
		t.Fatal("workflow preparation created duplicate execution ledger", operations, err)
	}
	if err = e.verifySecuritySRERole(execution, plan.Steps[0]); err == nil {
		t.Fatal("empty SRE report passed real business acceptance")
	}
	repo.task.Plans[0].Steps[0].Role = SREExecutor
	if err = e.BindSecuritySREPlan(ctx, "case", task.ID); err == nil {
		t.Fatal("role changed after user confirmation")
	}
}

func TestSecurityWorkflowRunRollbackAndChangedConnectionStayClosed(t *testing.T) {
	e, _, in := managedWorkflowFixture(t)
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	in.RunID, in.SourceEventID = "rollback-run", "rollback-run"
	rollback := errors.New("injected after workflow creation")
	if err = db.Transaction(func(tx *gorm.DB) error {
		if _, err := CreateSecurityWorkflowRunTx(tx, storeID, epoch, in, time.Now().UTC()); err != nil {
			return err
		}
		return rollback
	}); !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	for _, model := range []any{&securityWorkflowRunRow{}, &securityTaskRow{}, &nativeWorkGoal{}} {
		var count int64
		if err = db.Model(model).Count(&count).Error; err != nil || count != 0 {
			t.Fatal("partial run survived rollback", model, count, err)
		}
	}
	if err = db.Model(&securityResourceRevisionRow{}).Where("resource_id = ?", "resource").Update("connection_revision", 2).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = e.BeginSecurityWorkflowRun(context.Background(), in); err == nil {
		t.Fatal("stale acceptance admitted changed target connection")
	}
	var count int64
	if err = db.Model(&securityWorkflowRunRow{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal(count, err)
	}
}

func TestSecurityWorkflowOnlyOptionalTrustedSummaryHasNoResourceAttempt(t *testing.T) {
	for _, required := range []bool{false, true} {
		t.Run(map[bool]string{false: "optional", true: "required"}[required], func(t *testing.T) {
			e, definition, in := managedWorkflowFixture(t)
			definition.TemplateVersion = 2
			definition.TemplateDigest = security.ContentDigest([]byte("template-with-summary"))
			definition.Steps = append(definition.Steps, SecurityWorkflowStep{ID: "summary", Title: "Summarize accepted facts", Role: "coordinator", ResourceIDs: []string{"resource"}, DependsOn: []string{"inspect"}})
			contract := definition.Acceptance["inspect"]
			contract.Required = required
			definition.Acceptance["summary"] = contract
			var err error
			definition, err = e.PutSecurityWorkflowDefinition(context.Background(), SecurityWorkflowDefinitionAction{ActorID: "user", ActionID: "add-summary", ProjectID: "project", WorkflowID: "workflow", ExpectedRevision: 1}, definition)
			if err != nil {
				t.Fatal(err)
			}
			in.TemplateVersion, in.TemplateDigest = 2, definition.TemplateDigest
			if _, err = e.BeginSecurityWorkflowRun(context.Background(), in); err != nil {
				t.Fatal(err)
			}
			if _, err = e.ActivateSecurityWorkflowRun(context.Background(), in.RunID); err != nil {
				t.Fatal(err)
			}
			plan := SREPlanRevision{ID: "actual-plan", Goal: definition.Goal, Steps: []SREPlanStep{{ID: "inspect", Description: definition.Steps[0].Title, Role: SREInvestigator, ResourceIDs: []string{"resource"}}, {ID: "summary", Kind: "summarize", Description: "Summarize accepted facts", Role: SRECoordinator, ResourceIDs: []string{"resource"}, DependsOn: []string{"inspect"}}}}
			task := SRETask{ID: "actual-sre-task", SessionID: "case", ProjectID: "project", Status: "active", Plans: []SREPlanRevision{plan}}
			e.SetSRERepository(&srePolicyRepository{task: task})
			if err = e.BindSecuritySREPlan(context.Background(), "case", task.ID); err != nil {
				t.Fatal(err)
			}
			pure, err := e.securitySREPresentationOnly(context.Background(), "case", task, plan.Steps[1])
			if err != nil || pure == required {
				t.Fatal("required business acceptance became presentation", pure, err)
			}
			if !required {
				ctx, err := e.prepareSecuritySRERole(context.Background(), "case", task, plan.Steps[1], "summary-attempt", true)
				if err != nil || ctx.Task.ID != "" || ctx.AttemptID != "" {
					t.Fatal("pure summary received resource execution authority", ctx, err)
				}
				store, _ := e.adkStore()
				var count int64
				if err = store.DB.Model(&workExecutionAttempt{}).Count(&count).Error; err != nil || count != 0 {
					t.Fatal("pure summary fabricated canonical attempt", count, err)
				}
				if err = store.DB.Model(&workAcceptanceRecord{}).Count(&count).Error; err != nil || count != 0 {
					t.Fatal("pure summary fabricated acceptance", count, err)
				}
			}
		})
	}
}
