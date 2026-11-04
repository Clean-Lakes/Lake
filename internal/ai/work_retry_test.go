package ai

import (
	"testing"
	"time"
)

func TestWorkBlockedRetryRejectsDispatchedAndUnverifiedAttempts(t *testing.T) {
	for _, status := range []string{"unknown", "dispatched", "succeeded", "failed"} {
		t.Run(status, func(t *testing.T) {
			e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
			goal := managedGoalFixture(t, e, "retry")
			goal, priorID := managedAttemptFixture(t, e, goal, "")
			managedProofFixture(t, e, goal, priorID, status, "")
			row, goal, _ := e.workRow(goal.SessionID, goal.ID)
			goal.Status, goal.Items[0].Status = "blocked", "blocked"
			if err := e.writeWorkGoal(&row, &goal, false); err != nil {
				t.Fatal(err)
			}
			store, _ := e.adkStore()
			var prior workExecutionAttempt
			store.DB.First(&prior, "id = ?", priorID)
			var task securityTaskRow
			store.DB.First(&task, "id = ?", prior.SecurityTaskID)
			newRoot := "actual-next-root"
			if _, err := bindSecurityTaskTurn(store.DB, task.ID, task.StoreID, task.RecoveryEpoch, newRoot, "", task.ExecutionRevision, time.Now().UTC()); err != nil {
				t.Fatal(err)
			}
			if _, err := e.BeginWorkAttempt(goal.SessionID, goal.ID, goal.Items[0].ID, prior.SecurityTaskID, newRoot, priorID, "retry", goal.Revision); err == nil {
				t.Fatal("unverified original operation was treated as unstarted")
			}
			var unchanged workExecutionAttempt
			store.DB.First(&unchanged, "id = ?", priorID)
			_, current, _ := e.workRow(goal.SessionID, goal.ID)
			if unchanged.State != prior.State || unchanged.ClosureState != prior.ClosureState || current.Status != "blocked" || current.Revision != goal.Revision || current.closure.ActiveAttempts[goal.Items[0].ID] != priorID {
				t.Fatal("rejected retry mutated original state")
			}
		})
	}
}
