package ai

const SREFullAgentBudgetPolicy = "parent-loop-v1"

func fullSREAgent(c Config) bool { return c.sre != nil && c.sre.FullTools }

// A context window limits one request, not the sum of repeated input across
// an agent loop. Bound cumulative SRE usage by the parent's configured loop.
func sreRuntimeBudget(c Config) int {
	steps := c.MaxSteps
	if steps <= 0 || steps > 500 {
		steps = 500
	}
	window := c.Model.ContextWindow
	if window <= 0 {
		window = 64000
	}
	return min(window, 2000000) * steps
}

func upgradeSREBudget(task *SRETask, c Config) bool {
	_, legacy := agentUsageLimits(c)
	if task.BudgetPolicy != "" || task.TokenBudget != legacy {
		return false
	}
	task.TokenBudget = max(task.TokenBudget, sreRuntimeBudget(c))
	task.BudgetPolicy = SREFullAgentBudgetPolicy
	return true
}
