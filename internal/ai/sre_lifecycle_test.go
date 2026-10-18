package ai

import (
	"context"
	"errors"
	"testing"
)

func TestSREAttemptLifecycleKeepsCancellationAndBusinessOutcomesSeparate(t *testing.T) {
	step := SREPlanStep{Role: SREInvestigator}
	status, err := sreAttemptOutcome(SREStepAttempt{}, step, context.Canceled)
	if status != "cancelled" || !errors.Is(err, context.Canceled) {
		t.Fatal(status, err)
	}
	status, err = sreAttemptOutcome(SREStepAttempt{Operations: []SREOperation{{Status: "unknown", Risk: "write"}}}, step, context.Canceled)
	if status != "unknown" || !errors.Is(err, context.Canceled) {
		t.Fatal("unknown effect was erased by cancellation", status, err)
	}
	status, err = sreAttemptOutcome(SREStepAttempt{Operations: []SREOperation{{Status: "unknown", Risk: "readonly"}}}, step, nil)
	if status != "failed" || err == nil {
		t.Fatal("incomplete observation passed", status, err)
	}
	status, err = sreAttemptOutcome(SREStepAttempt{}, SREPlanStep{Role: SREExecutor, Kind: "act"}, nil)
	if status != "failed" || err == nil {
		t.Fatal("model completion replaced action evidence", status, err)
	}
}

func TestSREWaitProjectionCannotClearSiblingOrResurrectStoppedTask(t *testing.T) {
	task := SRETask{Status: "active", Runs: []SREPlanRun{{ID: "run"}}, Attempts: []SREStepAttempt{{ID: "a", PlanRunID: "run", Status: "waiting_approval"}, {ID: "b", PlanRunID: "run", Status: "running"}, {ID: "old", PlanRunID: "older", Status: "waiting_input"}}}
	projectSREAttemptStatus(&task, "b", "succeeded")
	if task.Status != "waiting_approval" {
		t.Fatal("sibling wait cleared")
	}
	projectSREAttemptStatus(&task, "a", "running")
	if task.Status != "active" {
		t.Fatal("old run's wait blocked current work")
	}
	task.Status = "paused"
	projectSREAttemptStatus(&task, "a", "cancelled")
	if task.Status != "paused" {
		t.Fatal("late event resurrected paused task")
	}
}

func TestSREImportPreservesEffectCommitBeforeADKCheckpoint(t *testing.T) {
	step := SREPlanStep{Role: SRECoordinator, Kind: "analyze"}
	complete := SREStepAttempt{Status: "succeeded", Operations: []SREOperation{{Status: "succeeded", Risk: "write"}}}
	if !sreImportableResult(complete, step, false) {
		t.Fatal("successful effect would replay after checkpoint gap")
	}
	complete.Operations[0].Status = "unknown"
	if sreImportableResult(complete, step, true) {
		t.Fatal("legacy migration erased unknown effect")
	}
	complete.Operations = nil
	if sreImportableResult(complete, step, false) {
		t.Fatal("modern node scheduling used the old attempt completion flag")
	}
	if !sreImportableResult(complete, step, true) {
		t.Fatal("legacy completed result lost")
	}
}
