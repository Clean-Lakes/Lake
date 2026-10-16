package ai

import (
	"encoding/json"
	"testing"
)

func sreTestPlan() SREPlanRevision {
	return SREPlanRevision{ID: "plan", Version: 1, Goal: "检查测试服务", TaskType: "investigation", Scope: []string{"host"}, Steps: []SREPlanStep{{ID: "observe", Role: SREInvestigator, Kind: "observe", Description: "检查状态", Capability: "host", ResourceIDs: []string{"host"}, CompletionChecks: []string{"有真实证据"}}, {ID: "summary", Role: SRECoordinator, Kind: "summarize", Description: "总结证据", DependsOn: []string{"observe"}, ResourceIDs: []string{"host"}, CompletionChecks: []string{"列出不确定性"}}}}
}
func TestSREPlanRejectsUnsafeContracts(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*SREPlanRevision)
	}{
		{"cycle", func(p *SREPlanRevision) { p.Steps[0].DependsOn = []string{"summary"} }},
		{"missing_dependency", func(p *SREPlanRevision) { p.Steps[0].DependsOn = []string{"missing"} }},
		{"wrong_role", func(p *SREPlanRevision) { p.Steps[0].Role = SREExecutor }},
		{"outside_scope", func(p *SREPlanRevision) { p.Steps[0].ResourceIDs = []string{"other"} }},
		{"unknown_kind", func(p *SREPlanRevision) { p.Steps[0].Kind = "magic" }},
		{"duplicate_step", func(p *SREPlanRevision) { p.Steps[1].ID = p.Steps[0].ID }},
		{"readonly_write", func(p *SREPlanRevision) { p.Steps[0].Action = &SREAction{Tool: "shell"} }},
		{"missing_check", func(p *SREPlanRevision) { p.Steps[0].CompletionChecks = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := sreTestPlan()
			tc.change(&p)
			if ValidateSREPlan(p, []string{"host"}) == nil {
				t.Fatal("unsafe plan accepted")
			}
		})
	}
	if err := ValidateSREPlan(sreTestPlan(), []string{"host"}); err != nil {
		t.Fatal(err)
	}
}
func TestSRECompletionRequiresActualRunAndVerification(t *testing.T) {
	p := sreTestPlan()
	p.TaskType = "recovery"
	task := SRETask{ID: "task", Status: "active", Plans: []SREPlanRevision{p}, Runs: []SREPlanRun{{ID: "run", PlanRevisionID: p.ID, Status: "running"}}, Outcome: "supported"}
	for _, s := range p.Steps {
		task.Attempts = append(task.Attempts, SREStepAttempt{ID: s.ID, StepID: s.ID, PlanRunID: "run", Status: "succeeded"})
	}
	if CanCompleteSRETask(task) {
		t.Fatal("command completion became recovery")
	}
	task.Verifications = []SREVerificationResult{{PlanRunID: "run", Verdict: "inconclusive"}}
	if CanCompleteSRETask(task) {
		t.Fatal("inconclusive became success")
	}
	task.Verifications[0].Verdict = "passed"
	if err := TransitionSRETask(&task, "completed"); err != nil {
		t.Fatal(err)
	}
	if TransitionSRETask(&task, "active") == nil {
		t.Fatal("late event revived completed task")
	}
}
func TestSREUnknownDispatchCannotBeResumed(t *testing.T) {
	task := SRETask{Status: "paused", Plans: []SREPlanRevision{sreTestPlan()}, Attempts: []SREStepAttempt{{Operations: []SREOperation{{Status: "unknown"}}}}}
	if StartSREPlanRun(&task, 1, "") == nil {
		t.Fatal("unknown write may replay")
	}
}
func TestSRECheckValuesAreTypedAndNotModelVerdicts(t *testing.T) {
	check := SRECheck{Kind: "number_threshold", Operator: "lt", Expected: 300.0}
	if pass, err := checkSREValue(check, 2400.0); err != nil || pass {
		t.Fatal("bad latency passed")
	}
	if _, err := checkSREValue(check, "240"); err == nil {
		t.Fatal("string became metric")
	}
	var raw any
	_ = json.Unmarshal([]byte(`{"rows":[{"latency":180}]}`), &raw)
	value, ok := jsonResultPath(raw, "rows.0.latency")
	if !ok {
		t.Fatal("path lost")
	}
	if pass, err := checkSREValue(check, value); err != nil || !pass {
		t.Fatal(err)
	}
}

func TestSRESuccessfulWriteSurvivesSummaryFailureAndNewPlan(t *testing.T) {
	action := &SREAction{Tool: "write", Arguments: map[string]any{"asset_ref": "host", "path": "/tmp/sre-test", "content": "ok"}}
	step := SREPlanStep{ID: "repair", Kind: "act", Role: SREExecutor, ResourceIDs: []string{"host"}, Action: action}
	attempt := SREStepAttempt{ID: "previous", StepID: "repair", PlanRunID: "old_run", Status: "failed", Operations: []SREOperation{{ID: "op", Status: "succeeded", ResourceID: "host", Call: Call{Name: "write", Arguments: js(action.Arguments)}}}}
	if !SREAttemptCompleted(attempt, step) {
		t.Fatal("summary failure erased confirmed write")
	}
	task := SRETask{Status: "draft", Plans: []SREPlanRevision{{ID: "new_plan", Version: 2, Steps: []SREPlanStep{step}}}, Runs: []SREPlanRun{{ID: "old_run", PlanRevisionID: "old_plan", Status: "superseded"}}, Attempts: []SREStepAttempt{attempt}}
	if err := StartSREPlanRun(&task, 2, ""); err != nil {
		t.Fatal(err)
	}
	if len(task.Attempts) != 2 || task.Attempts[1].ReusedFromAttemptID != "previous" || task.Attempts[1].PlanRunID != task.ActiveRun().ID {
		t.Fatal("revision would replay confirmed operation")
	}
	step.Action.Arguments["content"] = "different"
	different := SRETask{Status: "draft", Plans: []SREPlanRevision{{ID: "different", Version: 1, Steps: []SREPlanStep{step}}}, Attempts: []SREStepAttempt{attempt}}
	if err := StartSREPlanRun(&different, 1, ""); err != nil {
		t.Fatal(err)
	}
	if len(different.Attempts) != 1 {
		t.Fatal("changed operation reused an unrelated fact")
	}
}

func TestSREReportRequiresOwnSuccessfulEvidence(t *testing.T) {
	report := SRERoleReport{SchemaVersion: 1, Summary: "检查结果", Facts: []SREFact{{Statement: "实际观察", EvidenceIDs: []string{"owned"}}}}
	if err := ValidateSRERoleReport(report, []AgentEvidence{{ID: "owned", Success: true}}); err != nil {
		t.Fatal(err)
	}
	for _, evidence := range [][]AgentEvidence{nil, {{ID: "owned", Success: false}}, {{ID: "other", Success: true}}} {
		if ValidateSRERoleReport(report, evidence) == nil {
			t.Fatal("unowned or failed evidence accepted")
		}
	}
}

func TestSREVerificationFreshnessUsesActualTimestamps(t *testing.T) {
	if !sreAfter("2026-10-16T00:00:00.1Z", "2026-10-16T00:00:00Z") {
		t.Fatal("fractional timestamp compared lexically")
	}
	if sreAfter("2026-10-16T00:00:00Z", "2026-10-16T00:00:00.1Z") || sreAfter("invalid", "2026-10-16T00:00:00Z") {
		t.Fatal("stale or invalid timestamp accepted")
	}
}

func TestSREFrozenCallRejectsChangedToolTargetAndArguments(t *testing.T) {
	e := &Engine{}
	frozen := &SREAction{Tool: "write", Arguments: map[string]any{"asset_ref": "a_test", "path": "/tmp/fixture", "content": "approved"}}
	c := Config{sre: &sreRoleContext{Role: SREExecutor, Step: SREPlanStep{Action: frozen}}}
	if err := e.checkSRECall(c, Call{Name: "write"}, frozen.Arguments); err != nil {
		t.Fatal(err)
	}
	for _, args := range []map[string]any{{"asset_ref": "other", "path": "/tmp/fixture", "content": "approved"}, {"asset_ref": "a_test", "path": "/tmp/fixture", "content": "changed"}} {
		if e.checkSRECall(c, Call{Name: "write"}, args) == nil {
			t.Fatal("unapproved arguments accepted")
		}
	}
	if e.checkSRECall(c, Call{Name: "shell"}, frozen.Arguments) == nil {
		t.Fatal("tool substitution accepted")
	}
	c.sre.Role = SRECoordinator
	if e.checkSRECall(c, Call{Name: "write"}, frozen.Arguments) == nil {
		t.Fatal("coordinator operated resource")
	}
}
