package ai

import (
	"errors"
	"gorm.io/gorm"
	"time"
)

// SuperTaskView is derived from the canonical work/closure ledger. It never
// grants execution authority and has no independent persisted completion bit.
type SuperTaskView struct {
	TaskID           string        `json:"taskId"`
	SessionID        string        `json:"sessionId"`
	ProjectID        string        `json:"projectId,omitempty"`
	Title            string        `json:"title"`
	State            string        `json:"state"`
	AcceptanceState  string        `json:"acceptanceState"`
	Revision         int64         `json:"revision"`
	GoalRevision     int64         `json:"goalRevision,omitempty"`
	PlanRevision     int64         `json:"planRevision,omitempty"`
	OriginRootTurnID string        `json:"originRootTurnId"`
	Resources        []WorkBinding `json:"resources,omitempty"`
	DeadlineAt       time.Time     `json:"deadlineAt"`
	Reason           string        `json:"reason,omitempty"`
	Summary          string        `json:"summary,omitempty"`
}

var errSuperBinding = errors.New("superagent: invalid host binding")
var errSuperConflict = errors.New("superagent: revision conflict")

type SuperTaskDetail struct {
	RoleID string        `json:"roleId,omitempty"`
	Task   SuperTaskView `json:"task"`
	Goal   WorkGoal      `json:"goal"`
}

func (e *Engine) SuperTaskDetail(sessionID, taskID string) (SuperTaskDetail, error) {
	store, err := e.adkStore()
	if err != nil {
		return SuperTaskDetail{}, err
	}
	var out SuperTaskDetail
	err = store.DB.Transaction(func(tx *gorm.DB) error {
		var err error
		out.Task, err = projectSuperTaskTx(tx, sessionID, taskID)
		if err != nil {
			return err
		}
		var row nativeWorkGoal
		if err = tx.First(&row, "id = ? AND session_id = ?", taskID, sessionID).Error; err != nil {
			return err
		}
		return decodeWorkGoal(row, &out.Goal)
	})
	return out, err
}

// ProjectSuperTaskState is a read-only projection. The caller obtains closure
// from WorkClosureView, never from a worker report or a model-supplied object.
func ProjectSuperTaskState(goal WorkGoal, closure GoalClosureView, now time.Time) (SuperTaskView, error) {
	view := SuperTaskView{TaskID: goal.ID, SessionID: goal.SessionID, Title: goal.Title,
		Revision: goal.Revision, OriginRootTurnID: goal.OriginRootTurnID,
		DeadlineAt: goal.DeadlineAt, Resources: append([]WorkBinding(nil), goal.ResourceBindings...),
		AcceptanceState: "not_evaluated", Summary: utf8Prefix(goal.Summary, 2000)}
	if goal.ID == "" || goal.SessionID == "" || closure.GoalID != goal.ID {
		return view, errSuperBinding
	}
	if goal.closure != nil {
		view.ProjectID = goal.closure.ProjectID
		view.GoalRevision, view.PlanRevision = goal.closure.GoalRevision, goal.closure.PlanRevision
	}
	if len(view.Resources) == 0 && goal.Binding.Runtime != "" {
		view.Resources = []WorkBinding{goal.Binding}
	}
	switch goal.Status {
	case "pending", "idle", "queued":
		view.State = "queued"
	case "running", "waiting_external", "waiting_user", "paused", "blocked", "failed", "cancelled":
		view.State = goal.Status
	case "completed":
		view.State = "blocked"
		view.Reason = "acceptance_required"
	default:
		return view, errors.New("superagent: unknown canonical task state")
	}
	if closure.Managed {
		view.AcceptanceState = "insufficient"
		if !closure.AcceptanceRequired && closure.UnresolvedOperations == 0 && closure.UncoveredAttempts == 0 && len(closure.MissingStepIDs) == 0 {
			view.AcceptanceState = "pass"
			if goal.Status == "completed" && closure.Status == "completed" {
				view.State, view.Reason = "completed", ""
			}
		}
	}
	if !goal.DeadlineAt.IsZero() && !now.Before(goal.DeadlineAt) && !workTerminal(view.State) {
		view.State, view.Reason = "paused", "deadline_expired"
	}
	return view, nil
}

func (e *Engine) SuperTask(sessionID, taskID string) (SuperTaskView, error) {
	store, err := e.adkStore()
	if err != nil {
		return SuperTaskView{}, err
	}
	var out SuperTaskView
	err = store.DB.Transaction(func(tx *gorm.DB) error {
		var err error
		out, err = projectSuperTaskTx(tx, sessionID, taskID)
		return err
	})
	return out, err
}

func projectSuperTaskTx(tx *gorm.DB, sessionID, taskID string) (SuperTaskView, error) {
	var row nativeWorkGoal
	if err := tx.First(&row, "id = ? AND session_id = ?", taskID, sessionID).Error; err != nil {
		return SuperTaskView{}, err
	}
	var goal WorkGoal
	if err := decodeWorkGoal(row, &goal); err != nil {
		return SuperTaskView{}, err
	}
	var closure GoalClosureView
	if err := readWorkClosureTx(tx, sessionID, taskID, &closure); err != nil {
		return SuperTaskView{}, err
	}
	view, err := ProjectSuperTaskState(goal, closure, time.Now().UTC())
	if err != nil {
		return view, err
	}
	if !workTerminal(goal.Status) && tx.Migrator().HasTable(&superBudgetRow{}) {
		paused, err := superBudgetPausedTx(tx, goal.ID, goal.RoundLimit)
		if err != nil {
			return view, err
		}
		if paused {
			view.State, view.Reason, view.Summary = "paused", superBudgetPauseReason, SuperBudgetPauseSummary
		} else if view.State == "blocked" && goal.Status == "blocked" && goal.Summary == SuperTokenLimitRemovedSummary {
			view.Reason = superTokenLimitRemovedReason
		}
	}
	if view.ProjectID == "" && tx.Migrator().HasTable(&superWorkerRow{}) {
		var w superWorkerRow
		lookup := tx.First(&w, "task_id = ? AND session_id = ?", taskID, sessionID).Error
		if lookup == nil {
			view.ProjectID = w.ProjectID
		} else if !errors.Is(lookup, gorm.ErrRecordNotFound) {
			return view, lookup
		}
	}
	if view.ProjectID == "" && tx.Migrator().HasTable(&superLegacyAliasRow{}) {
		var alias superLegacyAliasRow
		lookup := tx.First(&alias, "canonical_id = ? AND session_id = ?", taskID, sessionID).Error
		if lookup == nil {
			view.ProjectID = alias.ProjectID
		} else if !errors.Is(lookup, gorm.ErrRecordNotFound) {
			return view, lookup
		}
	}
	return view, nil
}
