package ai

import (
	"context"
	"errors"

	"google.golang.org/adk/v2/workflow"
)

// Compatibility statuses are projections of ADK execution outcomes. They do
// not drive scheduling; ADK's graph owns runnable, running and settled nodes.
func sreExecutionStatus(err error) string {
	status := workflow.NodeCompleted
	if errors.Is(err, context.Canceled) {
		status = workflow.NodeCancelled
	} else if err != nil {
		status = workflow.NodeFailed
	}
	switch status {
	case workflow.NodeCancelled:
		return "cancelled"
	case workflow.NodeFailed:
		return "failed"
	default:
		return "completed"
	}
}

// Only these business facts may refine the execution outcome: an unresolved
// resource effect, an incomplete sample, or a missing exact frozen action.
func sreAttemptOutcome(a SREStepAttempt, step SREPlanStep, err error) (string, error) {
	status := sreExecutionStatus(err)
	if status == "completed" {
		status = "succeeded"
	}
	for _, op := range a.Operations {
		if SREOperationBlocksResume(op) {
			if err == nil {
				err = errors.New(SREExecutionSummary(a))
			}
			return "unknown", err
		}
	}
	if err == nil && sreReadCheckIncomplete(a) {
		return "failed", errors.New("只读检查未完成，可重新检查；尚未取得完整结果。")
	}
	if err == nil && step.Role == SREExecutor {
		success := false
		for _, op := range a.Operations {
			success = success || op.Status == "succeeded" && step.Action != nil && op.Call.Name == step.Action.Tool && sameSREArguments(op.Call.Arguments, step.Action.Arguments)
		}
		if !success {
			return "failed", errors.New("执行员没有完成绑定的实际操作")
		}
	}
	return status, err
}

// Project SDK role waits into the task's compatibility view in one place.
// One resumed role cannot clear another role's outstanding input/approval.
func projectSREAttemptStatus(t *SRETask, attemptID, status string) {
	for i := range t.Attempts {
		if t.Attempts[i].ID == attemptID {
			t.Attempts[i].Status = status
		}
	}
	if t.Status != "active" && t.Status != "waiting_approval" {
		return
	}
	run := t.ActiveRun()
	t.Status = "active"
	for _, a := range t.Attempts {
		if run != nil && a.PlanRunID != run.ID {
			continue
		}
		if a.Status == "waiting_approval" || a.Status == "waiting_input" {
			t.Status = "waiting_approval"
			return
		}
	}
}

// The effect ledger commits before the SDK output event. If interruption lands
// in that window, a proven completed effect must still never be dispatched
// again. This is a business deduplication rule, not a second node scheduler.
func sreImportableResult(a SREStepAttempt, step SREPlanStep, legacy bool) bool {
	if !SREAttemptCompleted(a, step) {
		return false
	}
	if legacy || a.ReusedFromAttemptID != "" {
		return true
	}
	for _, op := range a.Operations {
		if op.Status == "succeeded" && op.Risk != "readonly" {
			return true
		}
	}
	return false
}
