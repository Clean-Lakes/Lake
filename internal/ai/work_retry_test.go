package ai

import (
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
)

func TestWorkBlockedRetryDispatchesFixedSSHWithoutClearingLegacyRisk(t *testing.T) {
	e, c, commands := managedSSHFixture(t, false)
	execution, err := e.CurrentSecurityExecution(t.Context(), "case")
	if err != nil {
		t.Fatal(err)
	}
	store, _ := e.adkStore()
	row, goal, err := e.workRow("case", execution.GoalID)
	if err != nil {
		t.Fatal(err)
	}
	step, priorID := execution.StepID, execution.AttemptID
	goal.Status = "blocked"
	for i := range goal.Items {
		if goal.Items[i].ID == step {
			goal.Items[i].Status = "blocked"
		}
	}
	if err = e.writeWorkGoal(&row, &goal, false); err != nil {
		t.Fatal(err)
	}
	// A previous turn failed during preparation, before registering any I/O.
	if err = store.DB.Model(&workExecutionAttempt{}).Where("id = ?", priorID).Update("root_turn_id", "original-unstarted-root").Error; err != nil {
		t.Fatal(err)
	}
	if err = store.DB.Create(&nativeOperation{ID: "legacy-risk", SessionID: "old", Tool: "shell", Risk: "write", Status: "unknown"}).Error; err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	activate := func() {
		t.Helper()
		if _, err := e.invokeWorkTool(t.Context(), s, c, Call{ID: "activate-original-step", Name: "work_update"}, map[string]any{"item_id": step, "status": "running"}); err != nil {
			t.Fatal("blocked step could not acquire a valid retry", err)
		}
	}
	activate()
	_, resumed, _ := e.workRow("case", goal.ID)
	current := resumed.closure.ActiveAttempts[step]
	if resumed.Status != "running" || current == priorID || resumed.closure.GoalRevision != goal.closure.GoalRevision || resumed.closure.PlanRevision != goal.closure.PlanRevision {
		t.Fatal("retry changed the original contract or did not activate", resumed.Status)
	}
	activate()
	_, repeated, _ := e.workRow("case", goal.ID)
	if repeated.closure.ActiveAttempts[step] != current {
		t.Fatal("duplicate activation created another retry")
	}
	var prior, retry workExecutionAttempt
	store.DB.First(&prior, "id = ?", priorID)
	store.DB.First(&retry, "id = ?", current)
	if prior.State != "not_executed" || prior.ClosureState != "reconciled" || prior.RootTurnID != "original-unstarted-root" || retry.RetryOf != priorID {
		t.Fatal("unstarted attempt history lost", prior.State, prior.ClosureState)
	}
	var audits int64
	store.DB.Model(&securityAuthorityEvent{}).Where("kind = ? AND object_id = ?", "work.attempt.not_executed", priorID).Count(&audits)
	if audits != 1 {
		t.Fatal("missing original-attempt retirement audit", audits)
	}
	a := map[string]any{"asset_ref": assetAlias("resource"), "runtime": "ssh"}
	result, err := runFixedReadPermit(t, e, c, Call{ID: "retry-host-read", Name: "inspect_host", Arguments: js(a)})
	if err != nil || !strings.Contains(str(obj(result)["stdout"]), "owned-remote-profile") {
		t.Fatal("resumed task did not execute the original fixed SSH transport", err)
	}
	select {
	case command := <-commands:
		if !strings.Contains(command, "'/bin/ps' '-eo' 'pid,ppid,pcpu,pmem,comm'") {
			t.Fatal("retry used an unregistered command")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("resumed task never reached SSH")
	}
	var oldRisk nativeOperation
	store.DB.First(&oldRisk, "id = ?", "legacy-risk")
	if oldRisk.Status != "unknown" || oldRisk.RiskResolvedAt != nil || CheckResourceWriteBlock(store.DB, "resource") != ErrUnresolvedResourceEffect {
		t.Fatal("read-only retry cleared old write risk")
	}
	var accepted int64
	store.DB.Model(&workAcceptanceRecord{}).Where("goal_id = ? AND state = ?", goal.ID, "pass").Count(&accepted)
	if accepted != 0 {
		t.Fatal("task retry fabricated business acceptance")
	}
	// The next real turn must also be able to take a new observation. Keep all
	// old operation/evidence records; only retire their completed read attempt.
	// Generic Shell historically keeps risk=write even for a frozen diagnostic.
	// Its verified command-profile descriptor, not that old label, proves read-only.
	if err = store.DB.Model(&nativeOperation{}).Where("attempt_id = ? AND tool = ?", current, "inspect_host").Update("risk", "write").Error; err != nil {
		t.Fatal(err)
	}
	newRoot := "next-human-root"
	var nextOwner ExecutionOwner
	err = store.DB.Transaction(func(tx *gorm.DB) error {
		binding, err := bindSecurityTaskTurn(tx, execution.Task.ID, execution.Task.StoreID, execution.Task.RecoveryEpoch, newRoot, "", execution.Task.ExecutionRevision, time.Now().UTC())
		if err != nil {
			return err
		}
		nextOwner, err = acquireExecutionOwner(tx, binding.ID, uid(), "agent", binding.OwnerGeneration, time.Now().UTC())
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	e.securityOwners.Store(nextOwner.BindingID, &liveSecurityOwner{owner: nextOwner})
	s.mu.Lock()
	s.state.View.RootTurnID = newRoot
	s.mu.Unlock()
	activate()
	_, continued, _ := e.workRow("case", goal.ID)
	next := continued.closure.ActiveAttempts[step]
	if next == current {
		t.Fatal("fresh observation reused the old turn's attempt")
	}
	var completedRead, nextAttempt workExecutionAttempt
	store.DB.First(&completedRead, "id = ?", current)
	store.DB.First(&nextAttempt, "id = ?", next)
	if completedRead.State != "succeeded" || completedRead.ClosureState != "reconciled" || nextAttempt.RetryOf != current || nextAttempt.RootTurnID != newRoot {
		t.Fatal("successful read continuation lost its original provenance")
	}
	prepared, decision, err := e.PrepareCatalogOperation(t.Context(), "case", c, Call{ID: "next-host-read", Name: "inspect_host"}, a)
	if err != nil || prepared == nil || decision.Effect != "allow" || prepared.descriptor.AttemptID != next {
		t.Fatal("fresh task observation is not executable", decision.ReasonCode, err)
	}
}

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
