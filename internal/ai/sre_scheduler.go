package ai

import (
	"context"
	"errors"
)

// Independent ready roles run together. An act step owns the whole scheduling
// lane; dependencies and runtime resource locks remain authoritative.
func (e *Engine) runSREPlanSteps(ctx context.Context, sessionID, taskID, runID string, plan SREPlanRevision, completed map[string]bool) error {
	return runSRESteps(ctx, plan, completed, func(ctx context.Context, step SREPlanStep) error {
		return e.runSREStep(ctx, sessionID, taskID, runID, step)
	})
}

func runSRESteps(ctx context.Context, plan SREPlanRevision, completed map[string]bool, execute func(context.Context, SREPlanStep) error) error {
	work, cancel := context.WithCancel(ctx)
	defer cancel()
	type outcome struct {
		step SREPlanStep
		err  error
	}
	results := make(chan outcome, 4)
	running := map[string]SREPlanStep{}
	roles := map[SREAgentRole]bool{}
	var failure error
	for len(completed) < len(plan.Steps) {
		if failure == nil && ctx.Err() != nil {
			failure = ctx.Err()
			cancel()
		}
		if failure == nil {
			for _, step := range plan.Steps {
				if completed[step.ID] || running[step.ID].ID != "" || roles[step.Role] || roles[SREExecutor] {
					continue
				}
				ready := true
				for _, dep := range step.DependsOn {
					ready = ready && completed[dep]
				}
				if !ready || step.Kind == "act" && len(running) > 0 {
					continue
				}
				running[step.ID], roles[step.Role] = step, true
				go func(step SREPlanStep) { results <- outcome{step, execute(work, step)} }(step)
				if step.Kind == "act" {
					break
				}
			}
		}
		if len(running) == 0 {
			if failure != nil {
				return failure
			}
			return errors.New("计划依赖未满足")
		}
		var result outcome
		if failure != nil {
			result = <-results // Drain cancelled roles before releasing the session.
		} else {
			select {
			case result = <-results:
			case <-ctx.Done():
				failure = ctx.Err()
				cancel()
				continue
			}
		}
		delete(running, result.step.ID)
		delete(roles, result.step.Role)
		if result.err != nil && failure == nil {
			failure = result.err
			cancel()
		}
		if result.err == nil {
			completed[result.step.ID] = true
		}
		if failure != nil && len(running) == 0 {
			return failure
		}
	}
	return failure
}
