package ai

import (
	"context"
	"errors"
)

const agentUsageLimit = 32000
const turnAgentUsageLimit = 128000
const agentObservationCallLimit = 12
const turnAgentTaskLimit = 24

func agentUsageLimits(c Config) (int, int) {
	// Cumulative usage across model rounds is distinct from a single request's
	// context size. Scale it with the user's configured parent context budget.
	return bounded(c.Model.ContextWindow, agentUsageLimit, 64000), bounded(c.Model.ContextWindow*4, turnAgentUsageLimit, 256000)
}

// BudgetSpent includes in-flight reservations. Wait for a reservation to settle
// before rejecting work that still fits the actual remaining allocation.
func reserveAgentBudget(ctx context.Context, w *agentWorker, charge int) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		w.session.mu.Lock()
		if w.sreTaskID != "" {
			// The durable SRE task reservation is checked by stream. Keep the
			// child journal, without imposing the legacy Scout/Beacon quotas.
			for i := range w.session.state.View.AgentRuns {
				run := &w.session.state.View.AgentRuns[i]
				if run.ID == w.runID && run.SRETaskID == w.sreTaskID {
					run.BudgetSpent += charge
					run.budgetReserved += charge
					w.session.mu.Unlock()
					return nil
				}
			}
			w.session.mu.Unlock()
			return errors.New("SRE 子智能体预算记录不存在")
		}
		if w.session.agentBudgetChanged == nil {
			w.session.agentBudgetChanged = make(chan struct{})
		}
		childLimit, turnLimit := agentUsageLimits(w.session.state.Config)
		reviewReserve := min(32000, childLimit/2)
		total, reserved, index, limit := 0, 0, -1, turnLimit
		for i, run := range w.session.state.View.AgentRuns {
			if run.RootTurnID != w.turnID {
				continue
			}
			total += run.BudgetSpent
			reserved += run.budgetReserved
			if run.ID == w.runID {
				index = i
			}
			if w.role != "verify" && run.Role == "verify" && agentActive(run.Status) {
				limit = turnLimit - reviewReserve
			}
		}
		if index < 0 {
			w.session.mu.Unlock()
			return errors.New("子任务预算记录不存在")
		}
		run := &w.session.state.View.AgentRuns[index]
		if run.BudgetSpent+charge > childLimit {
			w.session.mu.Unlock()
			return errors.New("子 Agent 用量预算已达到上限")
		}
		if total+charge <= limit {
			run.BudgetSpent += charge
			run.budgetReserved += charge
			w.session.mu.Unlock()
			return nil
		}
		if reserved == 0 || total-reserved+charge > limit {
			w.session.mu.Unlock()
			return errors.New("本轮多 Agent 用量预算已达到上限")
		}
		changed := w.session.agentBudgetChanged
		w.session.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-changed:
		}
	}
}

func settleAgentBudget(w *agentWorker, reserved int, usage Usage, sent bool) {
	spent := reserved
	if !sent {
		spent = 0
	} else if usage.Known || usage.InputKnown && usage.OutputKnown {
		spent = max(usage.Total, usage.Input+usage.Output)
	}
	w.session.mu.Lock()
	defer w.session.mu.Unlock()
	for i := range w.session.state.View.AgentRuns {
		run := &w.session.state.View.AgentRuns[i]
		if run.ID == w.runID {
			run.BudgetSpent += max(0, spent) - reserved
			run.budgetReserved -= reserved
			break
		}
	}
	if w.session.agentBudgetChanged != nil {
		close(w.session.agentBudgetChanged)
	}
	w.session.agentBudgetChanged = make(chan struct{})
}
