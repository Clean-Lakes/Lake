package ai

import (
	"reflect"
	"testing"
	"time"
)

func TestSuperTaskProjectionRequiresCanonicalAcceptance(t *testing.T) {
	now := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	goal := WorkGoal{ID: "goal", SessionID: "session", OriginRootTurnID: "root", Status: "completed", DeadlineAt: now.Add(time.Hour)}
	for _, tc := range []struct {
		name              string
		closure           GoalClosureView
		state, acceptance string
	}{
		{"legacy", GoalClosureView{GoalID: "goal", Status: "completed"}, "blocked", "not_evaluated"},
		{"insufficient", GoalClosureView{GoalID: "goal", Status: "completed", Managed: true, AcceptanceRequired: true}, "blocked", "insufficient"},
		{"unknown", GoalClosureView{GoalID: "goal", Status: "completed", Managed: true, UnresolvedOperations: 1}, "blocked", "insufficient"},
		{"uncovered", GoalClosureView{GoalID: "goal", Status: "completed", Managed: true, UncoveredAttempts: 1}, "blocked", "insufficient"},
		{"accepted", GoalClosureView{GoalID: "goal", Status: "completed", Managed: true}, "completed", "pass"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			view, err := ProjectSuperTaskState(goal, tc.closure, now)
			if err != nil || view.State != tc.state || view.AcceptanceState != tc.acceptance {
				t.Fatal(view, err)
			}
			if goal.Status != "completed" {
				t.Fatal("projection mutated goal")
			}
		})
	}
	if _, err := ProjectSuperTaskState(goal, GoalClosureView{GoalID: "other"}, now); err == nil {
		t.Fatal("foreign closure accepted")
	}
	goal.Status = "invented"
	if _, err := ProjectSuperTaskState(goal, GoalClosureView{GoalID: "goal"}, now); err == nil {
		t.Fatal("unknown state accepted")
	}
}

func TestSuperTaskDeadlineDoesNotRenewAuthority(t *testing.T) {
	now := time.Now().UTC()
	goal := WorkGoal{ID: "g", SessionID: "s", OriginRootTurnID: "r", Status: "waiting_external", DeadlineAt: now.Add(-time.Second)}
	view, err := ProjectSuperTaskState(goal, GoalClosureView{GoalID: "g"}, now)
	if err != nil || view.State != "paused" || view.Reason != "deadline_expired" || !view.DeadlineAt.Equal(goal.DeadlineAt) {
		t.Fatal(view, err)
	}
}

func TestSuperLegacyImportDoesNotAdoptUnresolvedOrSREWork(t *testing.T) {
	goal := WorkGoal{ID: "g", SessionID: "s", OriginRootTurnID: "r", Status: "waiting_external"}
	before := goal
	plan, err := PlanLegacyWorkImport(&goal, nil, GoalClosureView{GoalID: "g", Managed: true})
	if err != nil || !plan.CanAdopt || !plan.ReadOnly || plan.Alias.CanonicalID != "g" || !reflect.DeepEqual(goal, before) {
		t.Fatal(plan, err)
	}
	plan, err = PlanLegacyWorkImport(&goal, nil, GoalClosureView{GoalID: "g", Managed: true, UnresolvedOperations: 1})
	if err != nil || plan.CanAdopt {
		t.Fatal("unknown adopted", plan, err)
	}
	sre := SRETask{ID: "legacy", SessionID: "s", ProjectID: "p", RequestID: "r", Status: "completed", RecoveryStatus: "verified", Attempts: []SREStepAttempt{{Operations: []SREOperation{{ID: "op", Status: "unknown", ApprovalID: "approval", EvidenceIDs: []string{"evidence"}}}}}}
	plan, err = PlanLegacyWorkImport(nil, &sre, GoalClosureView{})
	if err != nil || plan.CanAdopt || !plan.ReadOnly || plan.Alias.CanonicalID != "" || !reflect.DeepEqual(plan.OperationIDs, []string{"op"}) || !reflect.DeepEqual(plan.ApprovalIDs, []string{"approval"}) {
		t.Fatal(plan, err)
	}
	if _, err = PlanLegacyWorkImport(&goal, &sre, GoalClosureView{}); err == nil {
		t.Fatal("ambiguous import accepted")
	}
}
