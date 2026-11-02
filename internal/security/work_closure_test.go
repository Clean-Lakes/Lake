package security

import (
	"encoding/json"
	"testing"
	"time"
)

func closureFixture() StepVerification {
	now := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	binding := ClosureBinding{ProjectID: "p", SessionID: "s", GoalID: "g", StepID: "copy", GoalRevision: 1, PlanRevision: 1, StepRevision: 1}
	return StepVerification{Binding: binding, AttemptID: "relay", Now: now, Criteria: []AcceptanceCriterion{
		{ID: "service", Method: "json_equal", Target: "db", ConnectionRevision: 1, SourceDigest: ContentDigest([]byte("probe")), Pointer: "/service", Expected: json.RawMessage(`2`), MaxAgeSeconds: 60},
		{ID: "tiles", Method: "json_equal", Target: "db", ConnectionRevision: 1, SourceDigest: ContentDigest([]byte("probe")), Pointer: "/tiles", Expected: json.RawMessage(`1442`), MaxAgeSeconds: 60},
		{ID: "compare", Method: "json_equal", Target: "db", ConnectionRevision: 1, SourceDigest: ContentDigest([]byte("probe")), Pointer: "/differences", Expected: json.RawMessage(`0`), MaxAgeSeconds: 60},
	}, Evidence: []Evidence{{ID: "e", OperationID: "verify", AttemptID: "relay", Target: "db", ConnectionRevision: 1, SourceDigest: ContentDigest([]byte("probe")), Status: "succeeded", Binding: binding, ObservedAt: now.Add(-time.Second), Data: json.RawMessage(`{"service":2,"tiles":1442,"differences":0}`)}}}
}

func TestStepAcceptanceRequiresCurrentCommittedEvidence(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*StepVerification)
		want   AcceptanceState
	}{
		{"exact", func(*StepVerification) {}, AcceptancePass},
		{"unknown", func(v *StepVerification) { v.Unresolved = true }, AcceptanceInsufficient},
		{"other_goal", func(v *StepVerification) { v.Evidence[0].Binding.GoalID = "g2" }, AcceptanceInsufficient},
		{"other_attempt", func(v *StepVerification) { v.Evidence[0].AttemptID = "direct" }, AcceptanceInsufficient},
		{"old_plan", func(v *StepVerification) { v.Evidence[0].Binding.PlanRevision-- }, AcceptanceInsufficient},
		{"old_step", func(v *StepVerification) { v.Evidence[0].Binding.StepRevision-- }, AcceptanceInsufficient},
		{"wrong_target", func(v *StepVerification) { v.Evidence[0].Target = "source-db" }, AcceptanceInsufficient},
		{"stale", func(v *StepVerification) { v.Evidence[0].ObservedAt = v.Now.Add(-61 * time.Second) }, AcceptanceInsufficient},
		{"future", func(v *StepVerification) { v.Evidence[0].ObservedAt = v.Now.Add(time.Second) }, AcceptanceInsufficient},
		{"exit_only", func(v *StepVerification) { v.Evidence[0].Data = json.RawMessage(`{"exitCode":0}`) }, AcceptanceInsufficient},
		{"wrong_counts", func(v *StepVerification) {
			v.Evidence[0].Data = json.RawMessage(`{"service":2,"tiles":1441,"differences":0}`)
		}, AcceptanceFail},
		{"newer_mismatch", func(v *StepVerification) {
			e := v.Evidence[0]
			e.ID = "new"
			e.ObservedAt = v.Now
			e.Data = json.RawMessage(`{"service":2,"tiles":1442,"differences":1}`)
			v.Evidence = append(v.Evidence, e)
		}, AcceptanceFail},
		{"same_time_conflict", func(v *StepVerification) {
			e := v.Evidence[0]
			e.ID = "conflict"
			e.Data = json.RawMessage(`{"service":2,"tiles":1442,"differences":1}`)
			v.Evidence = append(v.Evidence, e)
		}, AcceptanceFail},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := closureFixture()
			tc.change(&in)
			got, _ := VerifyStep(in)
			if got != tc.want {
				t.Fatalf("got %s want %s", got, tc.want)
			}
		})
	}
}

func TestGoalAcceptanceCannotSkipRequiredDependencyOrUnknown(t *testing.T) {
	fixture := closureFixture()
	b := fixture.Binding
	step := GoalStepAcceptance{ID: b.StepID, Required: true, State: AcceptancePass, Binding: b}
	if VerifyGoal(b, []GoalStepAcceptance{step}, false) != AcceptancePass {
		t.Fatal("valid goal not accepted")
	}
	for _, kind := range []string{"unknown", "dependency", "missing", "other_goal", "cycle", "no_required"} {
		t.Run(kind, func(t *testing.T) {
			s := step
			unknown := false
			switch kind {
			case "unknown":
				unknown = true
			case "dependency":
				s.DependsOn = []string{"missing"}
			case "missing":
				s.State = AcceptanceInsufficient
			case "other_goal":
				s.Binding.GoalID = "g2"
			case "cycle":
				s.DependsOn = []string{s.ID}
			case "no_required":
				s.Required = false
			}
			if VerifyGoal(b, []GoalStepAcceptance{s}, unknown) == AcceptancePass {
				t.Fatal("unsafe goal accepted")
			}
		})
	}
}

func TestFailedAttemptCoverageRetainsUnknownAndGoalIdentity(t *testing.T) {
	f := closureFixture()
	failed := ClosureAttempt{ID: "direct", Binding: f.Binding, State: "failed", ClosureState: "open"}
	replacement := ClosureAttempt{ID: "relay", Binding: f.Binding, State: "succeeded", ClosureState: "open"}
	if !CanCover(failed, replacement, AcceptancePass, true, false) {
		t.Fatal("equivalent verified retry not covered")
	}
	for _, state := range []string{"unknown", "running", "prepared", "succeeded"} {
		copy := failed
		copy.State = state
		if CanCover(copy, replacement, AcceptancePass, true, false) {
			t.Fatal("unreconciled state covered", state)
		}
	}
	if CanCover(failed, replacement, AcceptancePass, true, true) || CanCover(failed, replacement, AcceptancePass, false, false) {
		t.Fatal("risk or changed contract covered")
	}
	replacement.Binding.GoalID = "g2"
	if CanCover(failed, replacement, AcceptancePass, true, false) {
		t.Fatal("other goal cleared original failure")
	}
}

func TestEvidencePointerAndMalformedJSON(t *testing.T) {
	for _, pointer := range []string{"/a~1b/0/~0", "/a~1b/00/~0", "/a~2b", "/a~1b/-/~0"} {
		_, ok := jsonPointer([]byte(`{"a/b":[{"~":1}]}`), pointer)
		if ok != (pointer == "/a~1b/0/~0") {
			t.Fatal(pointer, ok)
		}
	}
	if _, ok := jsonPointer([]byte(`{"a":1} trailing`), "/a"); ok {
		t.Fatal("partial JSON accepted")
	}
}
