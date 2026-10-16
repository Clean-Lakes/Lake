package ai

import "testing"

func legacySRECollaborationFixture() SRETask {
	p := sreTestPlan()
	p.Steps[0].ID = "done"
	a, b := p.Steps[0], p.Steps[0]
	a.ID, a.Description = "services", "核对服务状态"
	b.ID, b.Description = "logs", "采集错误日志"
	p.Steps = append(p.Steps[:1], a, b, p.Steps[1])
	p.Steps[3].DependsOn = []string{"done", "services", "logs"}
	return SRETask{ID: "task", Scope: []string{"host"}, Status: "paused", Plans: []SREPlanRevision{p}, Runs: []SREPlanRun{{ID: "old", PlanRevisionID: p.ID, Status: "paused"}}, Attempts: []SREStepAttempt{{ID: "recorded", PlanRunID: "old", StepID: "done", Status: "succeeded", Evidence: []AgentEvidence{{ID: "evidence", CollectedAt: "2026-10-16T01:00:00Z"}}}}}
}
func upgradedSREPlan(t SRETask) SREPlanRevision {
	p := CloneSRETask(t).Plans[0]
	p.CollaborationVersion = 1
	p.Steps[1].Role, p.Steps[1].Kind = SREVerifier, "verify"
	return p
}
func TestSRELegacyCollaborationUpgradeEligibility(t *testing.T) {
	base := legacySRECollaborationFixture()
	if !needsSRECollaborationUpgrade(base) {
		t.Fatal("legacy independent unfinished work not detected")
	}
	last := CloneSRETask(base)
	last.Attempts = append(last.Attempts, SREStepAttempt{ID: "s", PlanRunID: "old", StepID: "services", Status: "succeeded"})
	if !needsSRECollaborationUpgrade(last) {
		t.Fatal("existing evidence cannot be independently reviewed beside the last check")
	}
	for _, name := range []string{"active", "current", "unknown", "dispatched", "no_remaining", "no_evidence", "verifier", "change", "running", "completed"} {
		t.Run(name, func(t *testing.T) {
			v := CloneSRETask(base)
			switch name {
			case "active":
				v.Status = "active"
			case "current":
				v.Plans[0].CollaborationVersion = 1
			case "unknown", "dispatched":
				v.Attempts[0].Operations = []SREOperation{{Status: name}}
			case "no_remaining":
				v.Attempts = append(v.Attempts, SREStepAttempt{ID: "s", PlanRunID: "old", StepID: "services", Status: "succeeded"})
				v.Attempts = append(v.Attempts, SREStepAttempt{ID: "l", PlanRunID: "old", StepID: "logs", Status: "succeeded"})
			case "no_evidence":
				v.Attempts = nil
				v.Plans[0].Steps[1].DependsOn = []string{"done"}
				v.Plans[0].Steps[2].DependsOn = []string{"services"}
			case "verifier":
				v.Plans[0].Steps[1].Role = SREVerifier
			case "change":
				v.Plans[0].TaskType = "change"
			case "running":
				v.Runs[0].Status = "running"
			case "completed":
				v.Status = "completed"
			}
			if needsSRECollaborationUpgrade(v) {
				t.Fatal("unsafe or unnecessary upgrade", name)
			}
		})
	}
}
func TestSRELegacyCollaborationUpgradePreservesContract(t *testing.T) {
	task := legacySRECollaborationFixture()
	if err := validateSRECollaborationUpgrade(task, upgradedSREPlan(task)); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"goal", "scope", "acceptance", "completed", "removed", "deliverable", "dependencies", "action", "serial"} {
		t.Run(name, func(t *testing.T) {
			p := upgradedSREPlan(task)
			switch name {
			case "goal":
				p.Goal = "another task"
			case "scope":
				p.Scope = []string{"other"}
			case "acceptance":
				p.Acceptance = []SRECheck{{ID: "new", Description: "new", Kind: "manual_attestation"}}
			case "completed":
				p.Steps[0].Role, p.Steps[0].Kind = SREVerifier, "verify"
			case "removed":
				p.Steps = p.Steps[1:]
				p.Steps[2].DependsOn = []string{"services", "logs"}
			case "deliverable":
				p.Steps[1].Description = "another deliverable"
			case "dependencies":
				p.Steps[3].DependsOn = []string{"done", "services"}
			case "action":
				p.Steps[1].Action = &SREAction{Tool: "write"}
			case "serial":
				p.Steps[1].Role, p.Steps[1].Kind = SREInvestigator, "observe"
			}
			if validateSRECollaborationUpgrade(task, p) == nil {
				t.Fatal("unsafe upgrade accepted", name)
			}
		})
	}
}

func TestSRELegacyCollaborationSummaryWaitsForAddedReview(t *testing.T) {
	task := legacySRECollaborationFixture()
	p := upgradedSREPlan(task)
	review := p.Steps[3]
	review.ID, review.Kind, review.Description, review.DependsOn = "peer_review", "analyze", "核对既有证据中的缺口", nil
	p.Steps = append(p.Steps, review)
	if validateSRECollaborationUpgrade(task, p) == nil {
		t.Fatal("summary ignored added peer review")
	}
	p.Steps[3].DependsOn = append(p.Steps[3].DependsOn, review.ID)
	if err := validateSRECollaborationUpgrade(task, p); err != nil {
		t.Fatal(err)
	}
}
