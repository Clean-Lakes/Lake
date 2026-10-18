package ai

import (
	"context"
	"errors"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/workflowagent"
	"google.golang.org/adk/v2/runner"
	adksession "google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/workflow"
	"google.golang.org/genai"
)

// Independent ready roles run together. An act step owns the whole scheduling
// lane; dependencies and runtime resource locks remain authoritative.
func (e *Engine) runSREPlanSteps(ctx context.Context, sessionID, taskID, runID string, plan SREPlanRevision, completed map[string]bool) error {
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	return executeADKPlan(ctx, plan, completed, func(ctx context.Context, step SREPlanStep) error {
		return e.runSREStep(ctx, sessionID, taskID, runID, step)
	}, adkPlanSession{service: store.Sessions, id: "sre_" + sessionID + "_" + taskID + "_" + runID})
}

type adkPlanSession struct {
	service adksession.Service
	id      string
}

func executeADKPlan(ctx context.Context, plan SREPlanRevision, completed map[string]bool, execute func(context.Context, SREPlanStep) error, options ...adkPlanSession) error {
	work, cancel := context.WithCancel(ctx)
	defer cancel()
	node := workflow.NewDynamicNode("sre_plan", func(actx agent.Context, _ any, emit func(*adksession.Event) error) (bool, error) {
		ctx := actx.WithAgentContext(work)
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
					if len(running) >= 4 || completed[step.ID] || running[step.ID].ID != "" || roles[step.Role] || roles[SREExecutor] {
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
					go func(step SREPlanStep) {
						node := workflow.NewFunctionNode("step_"+step.ID, func(childCtx agent.Context, _ any) (bool, error) {
							err := execute(childCtx, step)
							return err == nil, err
						}, workflow.NodeConfig{})
						_, err := workflow.RunNode[bool](ctx, node, nil, workflow.WithRunID("attempt_"+step.ID), workflow.WithUseSubBranch(), workflow.WithIsolationScope("step_"+step.ID))
						results <- outcome{step, err}
					}(step)
					if step.Kind == "act" {
						break
					}
				}
			}
			if len(running) == 0 {
				if failure != nil {
					return false, failure
				}
				return false, errors.New("计划依赖未满足")
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
				return false, failure
			}
		}
		return failure == nil, failure
	}, workflow.NodeConfig{})
	root, err := workflowagent.New(workflowagent.Config{Name: "lake_sre_plan", Edges: workflow.Chain(workflow.Start, node)})
	if err != nil {
		return err
	}
	persistence := adkPlanSession{service: adksession.InMemoryService(), id: "plan"}
	if len(options) > 0 {
		persistence = options[0]
	}
	r, err := runner.New(runner.Config{AppName: "lake_sre", Agent: root, SessionService: persistence.service, AutoCreateSession: true})
	if err != nil {
		return err
	}
	for _, err := range r.Run(work, "lake", persistence.id, &genai.Content{Role: "user", Parts: []*genai.Part{{Text: plan.Goal}}}, agent.RunConfig{}) {
		if err != nil {
			return err
		}
	}
	return nil
}
