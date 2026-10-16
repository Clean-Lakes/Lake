package ai

import (
	"context"
	"testing"
)

func TestSREBudgetIsParentLoopAllocationNotContextOrLegacyQuota(t *testing.T) {
	c := Config{Model: Model{ContextWindow: 64000}, MaxSteps: 40}
	if got := sreRuntimeBudget(c); got != 2560000 {
		t.Fatal("SRE budget still describes one context or the old investigation allowance", got)
	}
	s, workers := budgetWorkers("host", "application")
	s.state.Config = c
	w := workers[0]
	w.sreTaskID = "sre-task"
	s.state.View.AgentRuns[0].SRETaskID = w.sreTaskID
	s.state.View.AgentRuns[0].BudgetSpent = 57024
	s.state.View.AgentRuns[1].BudgetSpent = 250000
	if err := reserveAgentBudget(context.Background(), w, 40000); err != nil {
		t.Fatal("SRE request was still subject to legacy child/turn caps", err)
	}
	settleAgentBudget(w, 40000, Usage{Input: 30000, Output: 1000, Total: 31000, Known: true}, true)
	if s.state.View.AgentRuns[0].BudgetSpent != 88024 || s.state.View.AgentRuns[0].budgetReserved != 0 {
		t.Fatal("SRE bypassed accounting rather than replacing the old quota")
	}
}

func TestSREBudgetMigrationPreservesUsageAndExplicitAllocations(t *testing.T) {
	c := Config{Model: Model{ContextWindow: 64000}, MaxSteps: 40}
	task := SRETask{TokenBudget: 256000, BudgetSpent: 240000, Usage: Usage{Input: 200000, Output: 40000, Total: 240000, Known: true}}
	if !upgradeSREBudget(&task, c) || task.TokenBudget != 2560000 || task.BudgetPolicy != SREFullAgentBudgetPolicy || task.BudgetSpent != 240000 || task.Usage.Total != 240000 {
		t.Fatal("legacy default budget not migrated without resetting actual use", task)
	}
	c.MaxSteps = 500
	if upgradeSREBudget(&task, c) || task.TokenBudget != 2560000 {
		t.Fatal("continuation silently renewed the task allocation")
	}
	task = SRETask{TokenBudget: 10000, BudgetSpent: 9000}
	if upgradeSREBudget(&task, c) || task.TokenBudget != 10000 || task.BudgetSpent != 9000 {
		t.Fatal("explicit non-default allocation was widened")
	}
}

func TestFullSRECatalogHasNoSamplerCallQuota(t *testing.T) {
	e := &Engine{worker: &agentWorker{calls: 1000}}
	c := Config{Profile: "core", sre: &sreRoleContext{Role: SREInvestigator, FullTools: true}}
	if len(e.sreRoleCatalog(c)) == 0 {
		t.Fatal("full agent tools closed at legacy or 32-call sampling quota")
	}
	e.worker.finalizing = true
	if len(e.sreRoleCatalog(c)) != 0 {
		t.Fatal("format-only finalization still exposes execution tools")
	}
}
