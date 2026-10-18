package ai

import (
	"context"
	"time"
)

func (e *Engine) stream(ctx context.Context, model Model, history []Message, tools []Tool, delta func(string, string)) (modelResult, error) {
	e.setSREActivity("waiting_model", "")
	if e.worker != nil {
		w := e.worker
		select {
		case w.parent.childModelSlots <- struct{}{}:
		case <-ctx.Done():
			return modelResult{}, ctx.Err()
		}
		defer func() { <-w.parent.childModelSlots }()
	}
	select {
	case e.modelSlots <- struct{}{}:
	case <-ctx.Done():
		return modelResult{}, ctx.Err()
	}
	defer func() { <-e.modelSlots }()
	e.setSREActivity("thinking", "")
	if e.worker != nil {
		w := e.worker
		chars := historyCost(history) + len(js(tools))
		estimated := (chars + 2) / 3
		e.worker.mu.Lock()
		if e.worker.lastModelChars > 0 && e.worker.lastInput > 0 {
			estimated = max(estimated, e.worker.lastInput+(chars-e.worker.lastModelChars)/3)
		}
		e.worker.mu.Unlock()
		charge := estimated + model.MaxOutput
		if e.worker.sreTaskID != "" {
			if err := e.reserveSREBudget(w.parentID, w.sreTaskID, charge); err != nil {
				return modelResult{}, err
			}
		}
		if err := reserveAgentBudget(ctx, e.worker, charge); err != nil {
			if w.sreTaskID != "" {
				e.settleSREBudget(w.parentID, w.sreTaskID, charge, Usage{}, false)
			}
			return modelResult{}, err
		}
		requestTimeout := 45 * time.Second
		if w.sreTaskID != "" {
			requestTimeout = 5 * time.Minute
		}
		ctx, cancel := context.WithTimeout(ctx, requestTimeout)
		defer cancel()
		if ctx.Err() != nil {
			settleAgentBudget(e.worker, charge, Usage{}, false)
			if w.sreTaskID != "" {
				e.settleSREBudget(w.parentID, w.sreTaskID, charge, Usage{}, false)
			}
			return modelResult{}, ctx.Err()
		}
		result, err := Stream(ctx, model, history, tools, delta)
		budgetUsage := result.Usage
		if err != nil && (!budgetUsage.InputKnown || !budgetUsage.OutputKnown) {
			budgetUsage = Usage{}
		}
		settleAgentBudget(e.worker, charge, budgetUsage, true)
		if w.sreTaskID != "" {
			e.settleSREBudget(w.parentID, w.sreTaskID, charge, budgetUsage, true)
		}
		if result.Usage.InputKnown {
			e.worker.mu.Lock()
			e.worker.lastModelChars = chars
			e.worker.lastInput = result.Usage.Input
			e.worker.mu.Unlock()
		}
		return result, err
	}
	return Stream(ctx, model, history, tools, delta)
}
