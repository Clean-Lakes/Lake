package ai

import (
	"context"
	"strings"
	"testing"
)

func pilotDelegationFixture(t *testing.T, level string) (*Engine, *session, Config, *srePolicyRepository) {
	t.Helper()
	_, child, _, c, _ := sreObservationFixture(t, Model{URL: "http://localhost:1", Name: "fixture"})
	direction := PilotDirection{ID: "logs", Title: "核对日志", Reason: "定位日志中的错误", Operations: []PilotOperationCandidate{{ID: "initial", Title: "读取日志", Tool: "read", Arguments: map[string]any{"path": "/tmp/first.log"}, Risk: "readonly"}}}
	policy := &PilotTaskPolicy{Decisions: []PilotChoiceDecision{{RequestID: "human", PlanRevisionID: "plan", StepID: "logs", AttemptID: "attempt", Direction: &direction, Selection: PilotSelection{Level: level, DirectionID: "logs"}, Operations: direction.Operations}}}
	repo := &srePolicyRepository{task: SRETask{ID: "task", SessionID: "case", Status: "active", Pilot: policy, Plans: []SREPlanRevision{{ID: "plan"}}, Attempts: []SREStepAttempt{{ID: "attempt", StepID: "logs"}}}}
	child.sreRepository = repo
	c.sre.Pilot = policy
	c.sre.TaskID = "task"
	c.sre.PlanRevisionID = "plan"
	c.sre.AttemptID = "attempt"
	c.sre.Step.ID = "logs"
	c.sre.Step.ResourceIDs = []string{"fixture-host"}
	c.sre.FullTools = true
	cs, err := child.get("own")
	if err != nil {
		t.Fatal(err)
	}
	return child, cs, c, repo
}

func TestPilotDirectionCanReplaceCommandsWithoutAnotherQuestion(t *testing.T) {
	child, s, c, repo := pilotDelegationFixture(t, "direction")
	direction := *repo.task.Pilot.Decisions[0].Direction
	direction.Operations = []PilotOperationCandidate{{ID: "replacement", Title: "读取其他日志", Tool: "read", Arguments: map[string]any{"path": "/tmp/alternative.log"}}}
	call := Call{Name: "pilot_offer_directions", Arguments: js(map[string]any{"directions": []PilotDirection{direction}})}
	value, err := child.offerPilotDirections(context.Background(), s, c, call)
	if err != nil || obj(value)["delegatedDirection"] != true {
		t.Fatal("direction did not continue automatically", err)
	}
	if len(repo.task.Pilot.Decisions) != 1 || len(repo.task.Pilot.DirectionBatches) != 1 {
		t.Fatal("replacement changed the human decision")
	}
	if err = child.checkPilotCall(c, Call{Name: "read"}, direction.Operations[0].Arguments); err != nil {
		t.Fatal(err)
	}
	if child.checkPilotCall(c, Call{Name: "read"}, map[string]any{"path": "/tmp/unproposed"}) == nil {
		t.Fatal("an unproposed command escaped direction bounds")
	}
	if _, err = child.offerPilotDirections(context.Background(), s, c, call); err != nil || len(repo.task.Pilot.DirectionBatches) != 1 {
		t.Fatal("repeated proposal is not idempotent", err)
	}
	changed := direction
	changed.Reason = "改做其他事情"
	if _, err = child.offerPilotDirections(context.Background(), s, c, Call{Name: "pilot_offer_directions", Arguments: js(map[string]any{"directions": []PilotDirection{changed}})}); err == nil {
		t.Fatal("direction purpose silently changed")
	}
	changed = direction
	changed.Operations = []PilotOperationCandidate{{ID: "write", Title: "修改配置", Tool: "write", Arguments: map[string]any{"path": "/tmp/config", "content": "changed"}}}
	if _, err = child.offerPilotDirections(context.Background(), s, c, Call{Name: "pilot_offer_directions", Arguments: js(map[string]any{"directions": []PilotDirection{changed}})}); err == nil {
		t.Fatal("read-only role acquired write access")
	}
}

func pilotRecoveryAttempt() SREStepAttempt {
	return SREStepAttempt{ID: "attempt", StepID: "logs", Operations: []SREOperation{
		{ID: "failed", Call: Call{Name: "grep", Arguments: `{"path":"/var/log/messages"}`}, ResourceID: "fixture-host", Risk: "readonly", Status: "unknown", DispatchedAt: "2026-10-25T10:00:00Z", FinishedAt: "2026-10-25T10:00:30Z"},
		{ID: "replacement", Call: Call{Name: "read", Arguments: `{"path":"/var/log/narrow.log"}`}, ResourceID: "fixture-host", Risk: "readonly", Status: "succeeded", DispatchedAt: "2026-10-25T10:00:31Z", FinishedAt: "2026-10-25T10:00:32Z", EvidenceIDs: []string{"evidence"}},
	}, Evidence: []AgentEvidence{{ID: "evidence", ResourceID: "fixture-host", Success: true, HasSource: true, CollectedAt: "2026-10-25T10:00:32Z"}}}
}

func TestPilotAlternativeReadEvidenceCoversGapButNotFixedCommandsOrChanges(t *testing.T) {
	for _, level := range []string{"direction", "step", "automatic", "command"} {
		t.Run(level, func(t *testing.T) {
			child, _, c, repo := pilotDelegationFixture(t, level)
			if level == "automatic" {
				repo.task.Pilot.AutoAdvance = true
			}
			repo.task.Attempts = []SREStepAttempt{pilotRecoveryAttempt()}
			if !sreReadCheckIncomplete(repo.task.Attempts[0]) {
				t.Fatal("test lost original failed read")
			}
			value, err := child.pilotReadRecovery(c, Call{Arguments: js(map[string]any{"failed_operation_id": "failed", "replacement_operation_ids": []string{"replacement"}, "reason": "改读已缩小范围的日志，取得完整原文"})})
			if level == "command" {
				if err == nil {
					t.Fatal("fixed commands silently widened")
				}
				return
			}
			if err != nil || obj(value)["read_recoveries"] == nil {
				t.Fatal(err)
			}
			if sreReadCheckIncomplete(repo.task.Attempts[0]) {
				t.Fatal("validated alternative read still failed the step")
			}
			if err = pilotAttemptError(repo.task, repo.task.Attempts[0], SREPlanStep{ID: "logs", Kind: "observe"}); err != nil {
				t.Fatal(err)
			}
			if repo.task.Attempts[0].Operations[0].Status != "unknown" {
				t.Fatal("failed audit was overwritten")
			}
		})
	}
	for _, variant := range []string{"change", "other_resource", "earlier", "unfinished", "missing_evidence", "truncated_evidence", "other_attempt"} {
		t.Run(variant, func(t *testing.T) {
			child, _, c, repo := pilotDelegationFixture(t, "step")
			a := pilotRecoveryAttempt()
			switch variant {
			case "change":
				a.Operations[0].Risk = "write"
			case "other_resource":
				a.Operations[1].ResourceID = "other"
			case "earlier":
				a.Operations[1].DispatchedAt = "2026-10-25T09:00:00Z"
			case "unfinished":
				a.Operations[1].Status = "dispatched"
			case "missing_evidence":
				a.Evidence = nil
			case "truncated_evidence":
				a.Evidence[0].SourceTruncated = true
			case "other_attempt":
				a.ID = "other"
			}
			repo.task.Attempts = []SREStepAttempt{a}
			if _, err := child.pilotReadRecovery(c, Call{Arguments: js(map[string]any{"failed_operation_id": "failed", "replacement_operation_ids": []string{"replacement"}, "reason": "替代"})}); err == nil {
				t.Fatal("invalid recovery accepted", variant)
			}
		})
	}
}

func TestPilotExplicitChoiceOverridesAutomaticDefault(t *testing.T) {
	child, _, c, repo := pilotDelegationFixture(t, "command")
	repo.task.Pilot.AutoAdvance = true
	if got := pilotExecutionMode(repo.task, "plan", "logs", "attempt"); got != "command" {
		t.Fatalf("automatic default replaced explicit choice: %s", got)
	}
	if err := child.checkPilotCall(c, Call{Name: "read"}, map[string]any{"path": "/tmp/alternative.log"}); err == nil {
		t.Fatal("automatic default widened fixed commands")
	}
	repo.task.Attempts = []SREStepAttempt{pilotRecoveryAttempt()}
	if _, err := child.pilotReadRecovery(c, Call{Arguments: js(map[string]any{"failed_operation_id": "failed", "replacement_operation_ids": []string{"replacement"}, "reason": "alternative"})}); err == nil {
		t.Fatal("automatic default covered fixed command failure")
	}
}

func TestPilotOutstandingReadContextOffersOnlyFreshCompleteCandidates(t *testing.T) {
	_, _, c, repo := pilotDelegationFixture(t, "step")
	a := pilotRecoveryAttempt()
	old := a.Operations[1]
	old.ID = "older"
	old.DispatchedAt = "2026-10-25T09:00:00Z"
	a.Operations = append(a.Operations, old)
	repo.task.Attempts = []SREStepAttempt{a}
	policy := pilotRolePolicyContext(repo.task, c)
	gaps := policy["read_gaps"].([]map[string]any)
	if len(gaps) != 1 || gaps[0]["operation_id"] != "failed" {
		t.Fatal("missing actual gap")
	}
	candidates := gaps[0]["eligible_replacement_operations"].([]map[string]any)
	if len(candidates) != 1 || candidates[0]["operation_id"] != "replacement" {
		t.Fatal("offered stale or invalid evidence", candidates)
	}
	recovery := PilotReadRecovery{FailedOperationID: "failed", ReplacementOperationIDs: []string{"replacement"}, Reason: "real alternative"}
	for _, variant := range []string{"old", "partial", "missing"} {
		sample := pilotRecoveryAttempt()
		want := ""
		switch variant {
		case "old":
			sample.Operations[1].DispatchedAt = "2026-10-25T09:00:00Z"
			want = "早于"
		case "partial":
			sample.Evidence[0].SourceTruncated = true
			want = "截断"
		case "missing":
			sample.Operations[1].EvidenceIDs = nil
			want = "来源证据"
		}
		if issue := pilotReadRecoveryIssue(sample, recovery); !strings.Contains(issue, want) {
			t.Fatalf("%s lost actionable cause: %s", variant, issue)
		}
	}
	repo.task.Attempts[0].ReadRecoveries = []PilotReadRecovery{recovery}
	if _, found := pilotRolePolicyContext(repo.task, c)["read_gaps"]; found {
		t.Fatal("resolved gap kept prompting retries")
	}
}
