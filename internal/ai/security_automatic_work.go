package ai

import (
	"context"
	"errors"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// The routed user request starts ordinary work. Contract registration and task
// activation commit together, without synthesizing a human answer or a grant.
func (e *Engine) activateAutomaticSecurityWork(ctx context.Context, s *session, c Config, goal WorkGoal, proposal securityWorkConfirmationProposal, sourceID, rootID string) (WorkGoal, error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return goal, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sessionID := s.state.View.Session
	if s.cancel == nil || s.state.Runtime == nil || s.state.View.RootTurnID != rootID || s.state.SecuritySourceMessageID != sourceID || s.state.WorkGoalID != goal.ID {
		return goal, errors.New("security: original work turn ended")
	}
	var execution SecurityExecutionContext
	err = e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		if err := checkSuperContextTx(ctx, tx); err != nil {
			return err
		}
		row, current, err := loadWorkGoalTx(tx, sessionID, goal.ID, proposal.ExpectedRevision)
		if err != nil {
			return err
		}
		if row.OriginMessageID != sourceID || row.RootTurnID != rootID || row.GoalRevision != 0 || current.closure != nil || securityWorkPlanDigest(current) != proposal.PlanDigest || !proposal.TaskDeadline.After(time.Now().UTC()) {
			return security.ErrConflict
		}
		var selected securityGoalSelectionRow
		lookup := tx.First(&selected, "session_id = ?", sessionID).Error
		if lookup != nil && !errors.Is(lookup, gorm.ErrRecordNotFound) {
			return lookup
		}
		if selected.Revision != proposal.SelectionRevision || selected.GoalID != "" && selected.GoalID != goal.ID || selected.SessionID != "" && (selected.StoreID != storeID || selected.RecoveryEpoch != epoch || selected.ProjectID != configSecurityProject(c)) {
			return security.ErrConflict
		}
		actionID := "work-auto:" + goal.ID
		if err := e.configureWorkAcceptanceTx(tx, sessionID, goal.ID, configSecurityProject(c), "host", actionID, proposal.ExpectedRevision, proposal.Steps); err != nil {
			return err
		}
		if err := tx.First(&row, "id = ? AND session_id = ?", goal.ID, sessionID).Error; err != nil {
			return err
		}
		if err := decodeWorkGoal(row, &goal); err != nil {
			return err
		}
		now := time.Now().UTC()
		task, err := beginSecurityTask(tx, storeID, epoch, SecurityTaskStart{Action: SecurityTaskAction{ActorID: "host", ActionID: actionID + ":task", ProjectID: configSecurityProject(c), SessionID: sessionID, GoalID: goal.ID}, SourceMessageID: sourceID, ExpectedGoalRevision: row.GoalRevision, ExpiresAt: proposal.TaskDeadline}, now)
		if err != nil {
			return err
		}
		binding, err := bindSecurityTaskTurn(tx, task.ID, storeID, epoch, rootID, "", task.ExecutionRevision, now)
		if err != nil {
			return err
		}
		owner, err := acquireExecutionOwner(tx, binding.ID, uid(), "agent", binding.OwnerGeneration, now)
		if err != nil {
			return err
		}
		next := securityGoalSelectionRow{SessionID: sessionID, ProjectID: configSecurityProject(c), StoreID: storeID, RecoveryEpoch: epoch, GoalID: goal.ID, SourceMessageID: sourceID, GoalRevision: row.GoalRevision, Revision: selected.Revision + 1}
		if err := tx.Save(&next).Error; err != nil {
			return err
		}
		if err := securityActionRecord(tx, storeID, epoch, "host", actionID+":select", "goal.select", goal.ID, js(proposal), selected.Revision, next.Revision, next, now, configSecurityProject(c)); err != nil {
			return err
		}
		execution = SecurityExecutionContext{Managed: true, ProjectID: configSecurityProject(c), SessionID: sessionID, GoalID: goal.ID, SourceMessageID: sourceID, Task: task, Owner: owner}
		return nil
	})
	if err != nil {
		return goal, err
	}
	s.state.SelectedGoalID, s.state.WorkGoalID, s.state.SecurityTaskID = goal.ID, goal.ID, execution.Task.ID
	s.state.Config.securityExecution = &execution
	s.state.PendingGoalIntent = nil
	e.securityOwners.Store(execution.Owner.BindingID, &liveSecurityOwner{owner: execution.Owner})
	if err := e.save(s); err != nil {
		return goal, err
	}
	e.startSecurityLifecycle()
	return goal, nil
}
