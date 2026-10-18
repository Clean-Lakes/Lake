package ai

import (
	"context"
	"testing"
)

type srePolicyRepository struct {
	SRERepository
	task SRETask
}

func (r *srePolicyRepository) LoadSRETask(string, string) (SRETask, error) { return r.task, nil }
func (r *srePolicyRepository) MutateSRETask(_, _ string, _ int, _ string, fn func(*SRETask) error) (SRETask, error) {
	err := fn(&r.task)
	return r.task, err
}

func TestSRERiskGateReadTimeoutCanResampleWithoutReplayingChanges(t *testing.T) {
	for _, priorRisk := range []string{"readonly", "write", "dangerous", ""} {
		for _, nextRisk := range []string{"readonly", "write"} {
			t.Run(priorRisk+"_then_"+nextRisk, func(t *testing.T) {
				_, child, _, c, _ := sreObservationFixture(t, Model{URL: "http://localhost:1", Name: "fixture"})
				c.sre.FullTools = true
				c.sre.TaskID = "task"
				c.sre.AttemptID = "new"
				c.sre.Step.ResourceIDs = []string{"fixture-host"}
				previous := SREOperation{ID: "old", Risk: priorRisk, Status: "unknown", Result: "context deadline exceeded"}
				repo := &srePolicyRepository{task: SRETask{Status: "active", Attempts: []SREStepAttempt{{ID: "old", Operations: []SREOperation{previous}}, {ID: "new"}}}}
				child.sreRepository = repo
				call := Call{ID: "fresh", Name: "shell", Arguments: `{"command":"uptime"}`}
				err := child.PrepareSREOperation(c, call, nextRisk)
				allowed := nextRisk == "readonly" || priorRisk == "readonly"
				if (err == nil) != allowed {
					t.Fatal("incorrect preparation barrier", err)
				}
				if !allowed {
					return
				}
				if err = child.DispatchSREOperation(context.Background(), c, call); err != nil {
					t.Fatal(err)
				}
				child.finishSREOperation(c, call, map[string]any{"exitCode": 0}, nil)
				if repo.task.Attempts[0].Operations[0] != previous {
					t.Fatal("original audit changed")
				}
				if repo.task.Attempts[1].Operations[0].Status != "succeeded" {
					t.Fatal("fresh sampling did not finish")
				}
			})
		}
	}
}

func TestSREReadTimeoutRetryKeepsCallIdentityAndAudit(t *testing.T) {
	_, child, _, c, _ := sreObservationFixture(t, Model{URL: "http://localhost:1", Name: "fixture"})
	c.sre.FullTools = true
	c.sre.TaskID = "task"
	c.sre.AttemptID = "attempt"
	c.sre.Step.ResourceIDs = []string{"fixture-host"}
	repo := &srePolicyRepository{task: SRETask{Status: "active", Attempts: []SREStepAttempt{{ID: "attempt"}}}}
	child.sreRepository = repo
	call := Call{ID: "first", Name: "shell", Arguments: `{"command":"uptime"}`}
	if err := child.PrepareSREOperation(c, call, "readonly"); err != nil {
		t.Fatal(err)
	}
	if err := child.DispatchSREOperation(context.Background(), c, call); err != nil {
		t.Fatal(err)
	}
	child.finishSREOperation(c, call, nil, context.DeadlineExceeded)
	if err := child.unknownSREOperation(c, call); err != nil {
		t.Fatal("read timeout killed specialist", err)
	}
	if err := child.PrepareSREOperation(c, call, "readonly"); err == nil {
		t.Fatal("same durable call replayed")
	}
	call.ID = "second"
	if err := child.PrepareSREOperation(c, call, "readonly"); err != nil {
		t.Fatal("fresh read blocked", err)
	}
	if err := child.DispatchSREOperation(context.Background(), c, call); err != nil {
		t.Fatal(err)
	}
	child.finishSREOperation(c, call, map[string]any{"exitCode": 0, "output": "fresh sample"}, nil)
	a := repo.task.Attempts[0]
	if len(a.Operations) != 2 || a.Operations[0].Status != "unknown" || a.Operations[0].Result != "context deadline exceeded" || a.Operations[1].Status != "succeeded" || sreReadCheckIncomplete(a) {
		t.Fatal("audit lost or fresh sample not recognized", a)
	}
	if err := child.PrepareSREOperation(c, call, "readonly"); err == nil {
		t.Fatal("completed call replayed")
	}
}

func TestSREResumeAndCompletionDistinguishReadGapsRunningAndUnknownChanges(t *testing.T) {
	for _, tc := range []struct {
		risk, status string
		allowed      bool
	}{{"readonly", "unknown", true}, {"readonly", "dispatched", false}, {"write", "unknown", false}, {"dangerous", "unknown", false}, {"", "unknown", false}} {
		t.Run(tc.risk+tc.status, func(t *testing.T) {
			task := SRETask{Status: "paused", Plans: []SREPlanRevision{sreTestPlan()}, Attempts: []SREStepAttempt{{Operations: []SREOperation{{Risk: tc.risk, Status: tc.status}}}}}
			if err := StartSREPlanRun(&task, 1, ""); (err == nil) != tc.allowed {
				t.Fatal("resume decision", err)
			}
		})
	}
	a := SREStepAttempt{Status: "succeeded", Operations: []SREOperation{{Risk: "readonly", Status: "unknown"}}}
	if SREAttemptCompleted(a, SREPlanStep{Kind: "observe"}) {
		t.Fatal("model report fabricated completion after timeout")
	}
	if got := SREExecutionSummary(a); got != "只读检查未完成，可重新检查；尚未取得完整结果。" {
		t.Fatal(got)
	}
}

func TestSREDispatchRechecksUncertaintyAfterPreparation(t *testing.T) {
	for _, status := range []string{"unknown", "dispatched"} {
		t.Run(status, func(t *testing.T) {
			_, child, _, c, _ := sreObservationFixture(t, Model{URL: "http://localhost:1", Name: "fixture"})
			c.sre.FullTools = true
			c.sre.TaskID = "task"
			c.sre.AttemptID = "attempt"
			c.sre.Step.ResourceIDs = []string{"fixture-host"}
			repo := &srePolicyRepository{task: SRETask{Status: "active", Attempts: []SREStepAttempt{{ID: "attempt"}}}}
			child.sreRepository = repo
			call := Call{ID: "new-write", Name: "write", Arguments: `{"path":"/tmp/fixture"}`}
			if err := child.PrepareSREOperation(c, call, "write"); err != nil {
				t.Fatal(err)
			}
			repo.task.Attempts = append(repo.task.Attempts, SREStepAttempt{ID: "peer", Operations: []SREOperation{{ID: "peer-operation", Status: status, Risk: "write"}}})
			if err := child.DispatchSREOperation(context.Background(), c, call); err == nil {
				t.Fatal("write bypassed intervening unresolved dispatch")
			}
			if repo.task.Attempts[0].Operations[0].Status != "prepared" {
				t.Fatal("blocked write was dispatched")
			}
		})
	}
}

func TestSREOnlySuccessfulNewSampleCoversReadTimeout(t *testing.T) {
	for _, status := range []string{"prepared", "not_executed", "failed", "rejected", "succeeded"} {
		a := SREStepAttempt{Status: "succeeded", Operations: []SREOperation{{Risk: "readonly", Status: "unknown", Digest: "query"}, {Risk: "readonly", Status: status, Digest: "query"}}}
		if got := sreReadCheckIncomplete(a); got != (status != "succeeded") {
			t.Fatal("failed/unexecuted retry masked missing sample", status)
		}
	}
}
