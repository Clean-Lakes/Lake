package security

import (
	"errors"
	"testing"
	"time"
)

func TestTaskTransitionsFenceExecutionWithoutRefreshingTTL(t *testing.T) {
	now := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	task := SecurityTask{ID: "t", GoalID: "g", SessionID: "s", StoreID: "store", RecoveryEpoch: "epoch", State: TaskActive, StateRevision: 1, ExecutionRevision: 1, CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	for _, state := range []TaskState{TaskWaiting, TaskActive, TaskIdle, TaskActive} {
		var err error
		task, err = task.Transition(state, task.StateRevision, now.Add(time.Second), "")
		if err != nil || task.ExecutionRevision != 1 || !task.ExpiresAt.Equal(now.Add(time.Hour)) {
			t.Fatal(task, err)
		}
	}
	paused, err := task.Transition(TaskPaused, task.StateRevision, now.Add(time.Second), "")
	if err != nil || paused.ExecutionRevision != 2 {
		t.Fatal(paused, err)
	}
	resumed, err := paused.Transition(TaskActive, paused.StateRevision, now.Add(2*time.Second), "")
	if err != nil || resumed.ExecutionRevision != 2 {
		t.Fatal(resumed, err)
	}
	if _, err = paused.Transition(TaskActive, task.StateRevision, now, ""); !errors.Is(err, ErrConflict) {
		t.Fatal("stale action", err)
	}
	ended, err := resumed.Transition(TaskCancelled, resumed.StateRevision, now, "cancelled")
	if err != nil || ended.ExecutionRevision != 3 {
		t.Fatal(ended, err)
	}
	if _, err = ended.Transition(TaskActive, ended.StateRevision, now, ""); !errors.Is(err, ErrTaskEnded) {
		t.Fatal("terminal context reopened", err)
	}
	if _, err = task.Transition(TaskActive, task.StateRevision, task.ExpiresAt, ""); !errors.Is(err, ErrTaskExpired) {
		t.Fatal("expiry boundary accepted", err)
	}
	if _, err = task.Transition(TaskExpired, task.StateRevision, task.ExpiresAt, ""); err != nil {
		t.Fatal(err)
	}
}

func TestNavigationDoesNotCreateAnExecutionBoundary(t *testing.T) {
	var absent *ExecutionBoundary
	empty := &ExecutionBoundary{ID: "confirmed-empty", Revision: 1}
	if absent != nil || empty.Contains("r") {
		t.Fatal("empty boundary widened")
	}
	selected := CurrentTarget{ResourceIDs: []string{"r"}, Revision: 1}
	if empty.Contains(selected.ResourceIDs[0]) {
		t.Fatal("selection granted access")
	}
}
