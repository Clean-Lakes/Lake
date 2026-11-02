package ai

import (
	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// GoalClosureView is an internal projection. It is never added to the existing
// frontend contract and never rewrites historical failures or reply timings.
type GoalClosureView struct {
	GoalID, Status                          string
	Managed                                 bool
	AcceptanceRequired                      bool
	MissingStepIDs                          []string
	UnresolvedOperations, UncoveredAttempts int64
}

func (e *Engine) WorkClosureView(sessionID, goalID string) (GoalClosureView, error) {
	out := GoalClosureView{GoalID: goalID}
	store, err := e.adkStore()
	if err != nil {
		return out, err
	}
	err = store.DB.Transaction(func(tx *gorm.DB) error {
		var row nativeWorkGoal
		if err := tx.First(&row, "id = ? AND session_id = ?", goalID, sessionID).Error; err != nil {
			return err
		}
		var goal WorkGoal
		if err := decodeWorkGoal(row, &goal); err != nil {
			return err
		}
		out.Status = goal.Status
		if goal.closure == nil {
			return nil
		}
		out.Managed = true
		if err := tx.Model(&nativeOperation{}).Where("goal_id = ? AND session_id = ?", goalID, sessionID).Where("(((status NOT IN ? OR status IS NULL) AND risk_resolved_at IS NULL) OR (orphan_state NOT IN ? AND orphan_state IS NOT NULL) OR (cancel_requested_at IS NOT NULL AND cancellation_state NOT IN ? AND risk_resolved_at IS NULL))", []string{"succeeded", "failed", "not_executed", "cancelled"}, []string{"", "resolved", "reconciled"}, []string{"stopped", "not_running", "resolved"}).Count(&out.UnresolvedOperations).Error; err != nil {
			return err
		}
		if err := tx.Model(&workExecutionAttempt{}).Where("goal_id = ? AND session_id = ? AND goal_revision = ? AND state IN ? AND closure_state NOT IN ?", goalID, sessionID, goal.closure.GoalRevision, []string{"failed", "not_executed"}, []string{"covered", "reconciled"}).Count(&out.UncoveredAttempts).Error; err != nil {
			return err
		}
		steps, err := acceptedStepsTx(tx, goal)
		if err != nil {
			return err
		}
		for _, step := range steps {
			if step.Required && step.State != security.AcceptancePass {
				out.MissingStepIDs = append(out.MissingStepIDs, step.ID)
			}
		}
		var accepted int64
		if err = tx.Model(&workAcceptanceRecord{}).Where("goal_id = ? AND session_id = ? AND goal_revision = ? AND plan_revision = ? AND scope = 'goal' AND state = 'pass'", goalID, sessionID, goal.closure.GoalRevision, goal.closure.PlanRevision).Count(&accepted).Error; err != nil {
			return err
		}
		out.AcceptanceRequired = accepted == 0 || out.UnresolvedOperations > 0 || out.UncoveredAttempts > 0 || len(out.MissingStepIDs) > 0
		if goal.Status == "completed" && out.AcceptanceRequired {
			out.Status = "blocked"
		}
		return nil
	})
	return out, err
}

func (e *Engine) CurrentWorkClosureView(sessionID string) (GoalClosureView, error) {
	s, err := e.get(sessionID)
	if err != nil {
		return GoalClosureView{}, err
	}
	s.mu.Lock()
	goalID, managed := s.state.WorkGoalID, s.state.SecurityManaged
	s.mu.Unlock()
	if !managed || goalID == "" {
		return GoalClosureView{}, nil
	}
	return e.WorkClosureView(sessionID, goalID)
}
