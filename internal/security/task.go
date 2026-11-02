package security

import (
	"errors"
	"time"
)

// SecurityTask is an execution context, never the authority for goal acceptance.
// StateRevision fences control actions; ExecutionRevision fences prepared calls.
type SecurityTask struct {
	ID, GoalID, ProjectID, SessionID, ParentTaskID, Kind string
	StoreID, RecoveryEpoch                               string
	State                                                TaskState
	StateRevision, ExecutionRevision                     int64
	CreatedAt, ExpiresAt                                 time.Time
	ClosedReason                                         string
}

type TaskState string

const (
	TaskActive      TaskState = "active"
	TaskIdle        TaskState = "idle"
	TaskWaiting     TaskState = "waiting"
	TaskPaused      TaskState = "paused"
	TaskCompleted   TaskState = "completed"
	TaskCancelled   TaskState = "cancelled"
	TaskExpired     TaskState = "expired"
	MaxTaskLifetime           = 24 * time.Hour
)

var (
	ErrConflict    = errors.New("security revision conflict")
	ErrTaskBinding = errors.New("security task binding required")
	ErrTaskEnded   = errors.New("security task ended")
	ErrTaskExpired = errors.New("security task expired")
)

func (s TaskState) Terminal() bool {
	return s == TaskCompleted || s == TaskCancelled || s == TaskExpired
}

func validTaskState(s TaskState) bool {
	switch s {
	case TaskActive, TaskIdle, TaskWaiting, TaskPaused, TaskCompleted, TaskCancelled, TaskExpired:
		return true
	}
	return false
}

func (t SecurityTask) Validate(now time.Time) error {
	if t.ID == "" || t.GoalID == "" || t.SessionID == "" || t.StoreID == "" || t.RecoveryEpoch == "" || t.StateRevision < 1 || t.ExecutionRevision < 1 || !validTaskState(t.State) || t.CreatedAt.IsZero() || !t.ExpiresAt.After(t.CreatedAt) || t.ExpiresAt.Sub(t.CreatedAt) > MaxTaskLifetime {
		return ErrTaskBinding
	}
	if !now.Before(t.ExpiresAt) {
		return ErrTaskExpired
	}
	if t.State.Terminal() {
		return ErrTaskEnded
	}
	return nil
}

// Transition never refreshes the absolute deadline. Reopening a terminal or
// cross-epoch context requires a new task, not a transition.
func (t SecurityTask) Transition(to TaskState, expected int64, now time.Time, reason string) (SecurityTask, error) {
	if expected != t.StateRevision {
		return t, ErrConflict
	}
	if !validTaskState(to) {
		return t, ErrTaskBinding
	}
	if err := t.Validate(now); err != nil {
		if err != ErrTaskExpired || to != TaskExpired || t.State.Terminal() {
			return t, err
		}
	}
	if to == TaskExpired && now.Before(t.ExpiresAt) {
		return t, ErrTaskBinding
	}
	if to == t.State {
		return t, nil
	}
	t.State, t.StateRevision = to, t.StateRevision+1
	if to == TaskPaused || to.Terminal() {
		t.ExecutionRevision++
	}
	if to.Terminal() {
		t.ClosedReason = reason
	}
	return t, nil
}

type CurrentTarget struct {
	ResourceIDs []string
	Revision    int64
}

type TargetResolution struct {
	State             string
	Candidates        []string
	RequestedRevision int64
}

// A nil boundary permits all resources; a present empty boundary permits none.
// Navigation is deliberately absent from this object.
type ExecutionBoundary struct {
	ID, OwnerID, Source string
	Revision            int64
	ResourceIDs         []string
	DenyLocal           bool
}

func (b ExecutionBoundary) Contains(id string) bool {
	for _, allowed := range b.ResourceIDs {
		if allowed == id {
			return true
		}
	}
	return false
}
