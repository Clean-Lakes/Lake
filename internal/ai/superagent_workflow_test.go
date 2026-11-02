package ai

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestSuperWorkflowRegistersOriginalGoalAndOneInvocation(t *testing.T) {
	e, _, input := managedWorkflowFixture(t)
	ctx := context.Background()
	if _, err := e.ActivateSuperProject(ctx, "project", "pilot", nil); err != nil {
		t.Fatal(err)
	}
	binding, err := e.BeginSecurityWorkflowRun(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	first, err := e.RegisterSuperWorkflow(ctx, binding)
	if err != nil {
		t.Fatal(err)
	}
	second, err := e.RegisterSuperWorkflow(ctx, binding)
	if err != nil || second.WorkerID != first.WorkerID || first.TaskID != binding.GoalID || first.SessionID != binding.SessionID {
		t.Fatal(first, second, err)
	}
	db, _ := e.superStore()
	var goals int64
	if err = db.Model(&nativeWorkGoal{}).Count(&goals).Error; err != nil || goals != 1 {
		t.Fatal("workflow created a second goal", goals, err)
	}
	forged := binding
	forged.SourceKind = "user"
	if _, err = e.RegisterSuperWorkflow(ctx, forged); err == nil {
		t.Fatal("self-reported workflow source replaced occurrence")
	}
	c, _ := e.ConfigForSession(binding.SessionID)
	if err = e.Configure(binding.SessionID, c); err != nil {
		t.Fatal(err)
	}
	c, _ = e.ConfigForSession(binding.SessionID)
	calls := 0
	if err = e.RunTaskInvestigation(ctx, "project", first.WorkerID, func(run context.Context) error {
		calls++
		if err := e.checkSuperModelDomain(run, binding.SessionID, c); err != nil {
			return err
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	bounded, cancel := context.WithTimeout(ctx, 30*time.Millisecond)
	defer cancel()
	if err = e.RunTaskInvestigation(bounded, "project", first.WorkerID, func(context.Context) error { calls++; return nil }); !errors.Is(err, context.DeadlineExceeded) || calls != 1 {
		t.Fatal("workflow invocation duplicated", calls, err)
	}
	view, err := e.SuperTask(binding.SessionID, binding.GoalID)
	if err != nil || view.State == "completed" || view.AcceptanceState == "pass" {
		t.Fatal("registration manufactured acceptance", view, err)
	}
}

func TestSuperWorkflowGraphUsesFrozenChildScopeAndParentFence(t *testing.T) {
	e, definition, input := managedWorkflowFixture(t)
	ctx := context.Background()
	if _, err := e.ActivateSuperProject(ctx, "project", "pilot", nil); err != nil {
		t.Fatal(err)
	}
	binding, err := e.BeginSecurityWorkflowRun(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := e.RegisterSuperWorkflow(ctx, binding)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.ActivateSecurityWorkflowRun(ctx, binding.RunID); err != nil {
		t.Fatal(err)
	}
	err = e.RunTaskInvestigation(ctx, "project", worker.WorkerID, func(run context.Context) error {
		step := SREPlanStep{ID: "inspect", Role: SREInvestigator, Kind: "observe", Description: definition.Steps[0].Title, ResourceIDs: []string{"resource"}}
		graph, finish, err := e.prepareSuperSREGraph(run, SREPlanRevision{Steps: []SREPlanStep{step}})
		if err != nil {
			return err
		}
		child, id, release, err := e.admitSuperSRERole(graph, binding.SessionID, SRETask{ID: "extension"}, step, "graph-run", "attempt", false)
		if err != nil {
			return err
		}
		defer release()
		if id != binding.ChildScopeIDs[step.ID] {
			t.Fatal("workflow child lost frozen identity", id)
		}
		if err = e.checkSuperAssignmentContext(child); err != nil {
			return err
		}
		if err = finish(); err != nil {
			return err
		}
		if err = e.checkSuperAssignmentContext(child); err == nil {
			t.Fatal("child continued after parent left graph wait")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSuperWorkflowDefinitionChangeFencesQueuedAndActiveWorkers(t *testing.T) {
	e, definition, input := managedWorkflowFixture(t)
	ctx := context.Background()
	if _, err := e.ActivateSuperProject(ctx, "project", "pilot", nil); err != nil {
		t.Fatal(err)
	}
	binding, err := e.BeginSecurityWorkflowRun(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := e.RegisterSuperWorkflow(ctx, binding)
	if err != nil {
		t.Fatal(err)
	}
	token, err := e.AcquireWorkerSlot(ctx, "project", worker.WorkerID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.PutSecurityWorkflowDefinition(ctx, SecurityWorkflowDefinitionAction{ActorID: "user", ActionID: "update-workflow-definition", ProjectID: "project", WorkflowID: definition.WorkflowID, ExpectedRevision: definition.Revision}, definition); err != nil {
		t.Fatal(err)
	}
	if err = e.checkSuperAssignmentContext(context.WithValue(ctx, superAssignmentContextKey{}, token)); err == nil {
		t.Fatal("old workflow definition retained execution eligibility")
	}
	if err = e.ReleaseWorkerSlot(ctx, token, "parked"); err != nil {
		t.Fatal(err)
	}
	db, _ := e.superStore()
	// Simulate a persisted queued occurrence after the old owner drained.
	if err = db.Model(&superAssignmentRow{}).Where("worker_id = ?", worker.WorkerID).Update("state", "queued").Error; err != nil {
		t.Fatal(err)
	}
	if err = e.CheckSuperagentProgress(ctx, "project"); err != nil {
		t.Fatal(err)
	}
	var assignment superAssignmentRow
	if err = db.First(&assignment, "worker_id = ?", worker.WorkerID).Error; err != nil || assignment.State != "parked" || assignment.LastError != "workflow_authority_unavailable" {
		t.Fatal(assignment, err)
	}
	if _, err = e.AcquireWorkerSlot(ctx, "project", worker.WorkerID); err == nil {
		t.Fatal("revoked workflow ran again")
	}
}
