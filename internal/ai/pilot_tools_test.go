package ai

import "testing"

func TestPilotSelectionDependencyAndOwnership(t *testing.T) {
	_, child, _, c, _ := sreObservationFixture(t, Model{URL: "http://localhost:1", Name: "fixture"})
	first := PilotOperationCandidate{ID: "first", Tool: "read", Title: "读取配置", Arguments: map[string]any{"path": "/tmp/fixture.conf"}, Risk: "readonly"}
	second := PilotOperationCandidate{ID: "second", Tool: "read", Title: "核对配置", Arguments: map[string]any{"path": "/tmp/second.conf"}, DependsOn: []string{"first"}, Risk: "readonly"}
	req := &QuestionRequest{ID: "choice", Questions: []UserQuestion{{ID: "pilot"}}, Pilot: &PilotChoice{SessionID: "case", TaskID: "task", PlanRevisionID: "plan", StepID: "logs", AttemptID: "attempt", Role: SREInvestigator, Directions: []PilotDirection{{ID: "config", Title: "核对配置", Operations: []PilotOperationCandidate{first, second}}}}}
	repo := &srePolicyRepository{task: SRETask{ID: "task", Status: "active", Pilot: &PilotTaskPolicy{}, Plans: []SREPlanRevision{{ID: "plan"}}, Attempts: []SREStepAttempt{{ID: "attempt", StepID: "logs"}}}}
	child.sreRepository = repo
	c.sre.Pilot = repo.task.Pilot
	c.sre.TaskID = "task"
	c.sre.PlanRevisionID = "plan"
	c.sre.AttemptID = "attempt"
	c.sre.Step.ID = "logs"
	call := Call{Name: first.Tool, Arguments: js(first.Arguments)}
	if child.checkPilotCall(c, call, first.Arguments) == nil {
		t.Fatal("guided operation ran without a selection")
	}
	bad := map[string][]string{"pilot": {js(PilotSelection{Level: "command", DirectionID: "config", OperationIDs: []string{"second"}})}}
	if validateQuestionAnswers(req, bad) == nil {
		t.Fatal("dependency was omitted")
	}
	for _, selection := range []PilotSelection{{Level: "command", DirectionID: "foreign", OperationIDs: []string{"first"}}, {Level: "command", DirectionID: "config", OperationIDs: []string{"first", "first"}}, {Level: "step", DirectionID: "config"}} {
		if validateQuestionAnswers(req, map[string][]string{"pilot": {js(selection)}}) == nil {
			t.Fatal("invalid selection accepted", selection)
		}
	}
	answer := map[string][]string{"pilot": {js(PilotSelection{Level: "command", DirectionID: "config", OperationIDs: []string{"first", "second"}})}}
	if err := child.recordPilotSelection(req, answer); err != nil {
		t.Fatal(err)
	}
	if err := child.recordPilotSelection(req, answer); err != nil || len(repo.task.Pilot.Decisions) != 1 {
		t.Fatal("decision is not idempotent", err)
	}
	if err := child.checkPilotCall(c, call, first.Arguments); err != nil {
		t.Fatal("chosen operation blocked", err)
	}
	if child.checkPilotCall(c, Call{Name: second.Tool}, second.Arguments) == nil {
		t.Fatal("dependent operation ran before its prerequisite")
	}
	repo.task.Attempts[0].Operations = []SREOperation{{Status: "succeeded", Call: call}}
	if err := child.checkPilotCall(c, Call{Name: second.Tool}, second.Arguments); err != nil {
		t.Fatal("completed dependency ignored", err)
	}
	repo.task.Revision += 10
	if err := child.checkPilotCall(c, call, first.Arguments); err != nil {
		t.Fatal("unrelated task revision invalidated a choice", err)
	}
	if child.checkPilotCall(c, call, map[string]any{"path": "/tmp/unselected"}) == nil {
		t.Fatal("unselected arguments escaped the gate")
	}
	c.sre.AttemptID = "another-attempt"
	if child.checkPilotCall(c, call, first.Arguments) == nil {
		t.Fatal("another attempt borrowed the decision")
	}
}

func TestPilotDelegationNeverChangesRolePermissionsOrStepCompletion(t *testing.T) {
	for _, role := range []SREAgentRole{SRECoordinator, SREInvestigator, SREVerifier} {
		c := Config{sre: &sreRoleContext{Role: role, Pilot: &PilotTaskPolicy{AutoAdvance: true}}}
		if pilotRoleAllowed(c, "write") == nil {
			t.Fatalf("automatic mode gave %s write access", role)
		}
		if err := pilotRoleAllowed(c, "readonly"); err != nil {
			t.Fatal(err)
		}
	}
	legacy := Config{sre: &sreRoleContext{Role: SREInvestigator}}
	if err := pilotRoleAllowed(legacy, "write"); err != nil {
		t.Fatal("historical role policy changed", err)
	}
	task := SRETask{Pilot: &PilotTaskPolicy{AutoAdvance: true}}
	step := SREPlanStep{ID: "logs", Kind: "observe"}
	if pilotAttemptError(task, SREStepAttempt{}, step) == nil {
		t.Fatal("empty reply became a completed inspection")
	}
	if err := pilotAttemptError(task, SREStepAttempt{Operations: []SREOperation{{Status: "succeeded"}}}, step); err != nil {
		t.Fatal(err)
	}
}
