package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/workflowagent"
	"google.golang.org/adk/v2/runner"
	adksession "google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/workflow"
	"google.golang.org/genai"
)

// Structured node output is stored by ADK itself, together with NodeInfo.
// It is a result checkpoint, not a parallel Lake scheduling state machine.
type sreNodeResult struct {
	SchemaVersion int    `json:"lakeSRECheckpoint"`
	StepID        string `json:"stepId"`
	Fingerprint   string `json:"fingerprint"`
}

// The official session owns durable node outputs. Attempts remain business
// evidence/projections, and are imported only for pre-graph runs or reused acts.
func (e *Engine) runSREPlanSteps(ctx context.Context, sessionID, taskID, runID string, plan SREPlanRevision) error {
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	task, err := e.sreRepository.LoadSRETask(sessionID, taskID)
	if err != nil {
		return err
	}
	return executeADKPlan(ctx, plan, func(ctx context.Context, step SREPlanStep) error {
		return e.runSREStep(ctx, sessionID, taskID, runID, step)
	}, adkPlanSession{service: store.Sessions, id: "sre_" + sessionID + "_" + taskID + "_" + runID, importResult: func(step SREPlanStep, legacy bool) bool {
		for _, a := range task.Attempts {
			if a.PlanRunID == runID && a.StepID == step.ID && sreImportableResult(a, step, legacy) {
				return true
			}
		}
		return false
	}})
}

type adkPlanSession struct {
	service      adksession.Service
	id           string
	importResult func(SREPlanStep, bool) bool
}

// Compile only business ordering. All ready/running/completed state, fan-in,
// cancellation and peer draining belong to the ADK graph scheduler.
func srePlanDependencies(plan SREPlanRevision) ([]SREPlanStep, map[string][]string, error) {
	remaining := make(map[string]SREPlanStep, len(plan.Steps))
	known := make(map[string]bool, len(plan.Steps))
	for _, step := range plan.Steps {
		if step.ID == "" || remaining[step.ID].ID != "" {
			return nil, nil, errors.New("计划步骤 ID 为空或重复")
		}
		remaining[step.ID] = step
		known[step.ID] = true
	}
	ordered := make([]SREPlanStep, 0, len(plan.Steps))
	for len(remaining) > 0 {
		found := false
		for _, step := range plan.Steps {
			if _, exists := remaining[step.ID]; !exists {
				continue
			}
			ready := true
			for _, dep := range step.DependsOn {
				if dep == step.ID {
					return nil, nil, errors.New("计划依赖未满足")
				}
				if _, exists := remaining[dep]; exists {
					ready = false
				}
				if !known[dep] {
					return nil, nil, fmt.Errorf("未知计划依赖 %s", dep)
				}
			}
			if ready {
				ordered = append(ordered, step)
				delete(remaining, step.ID)
				found = true
			}
		}
		if !found {
			return nil, nil, errors.New("计划依赖未满足")
		}
	}
	dependencies := make(map[string][]string, len(ordered))
	lanes := map[SREAgentRole]string{}
	lastAction := ""
	for i, step := range ordered {
		deps := append([]string(nil), step.DependsOn...)
		if prior := lanes[step.Role]; prior != "" {
			deps = append(deps, prior)
		}
		if lastAction != "" {
			deps = append(deps, lastAction)
		}
		if step.Kind == "act" {
			for _, prior := range ordered[:i] {
				deps = append(deps, prior.ID)
			}
			lastAction = step.ID
		}
		seen := map[string]bool{}
		for _, dep := range deps {
			if !seen[dep] {
				dependencies[step.ID] = append(dependencies[step.ID], dep)
				seen[dep] = true
			}
		}
		lanes[step.Role] = step.ID
	}
	return ordered, dependencies, nil
}

func executeADKPlan(ctx context.Context, plan SREPlanRevision, execute func(context.Context, SREPlanStep) error, options ...adkPlanSession) error {
	ordered, deps, err := srePlanDependencies(plan)
	if err != nil {
		return err
	}
	if len(ordered) == 0 {
		return errors.New("计划没有步骤")
	}
	persistence := adkPlanSession{service: adksession.InMemoryService(), id: "plan"}
	if len(options) > 0 {
		persistence = options[0]
	}
	// Create/get through the service before execution, rather than hiding storage
	// failures as a missing checkpoint and dispatching an operation a second time.
	stored, err := persistence.service.Get(ctx, &adksession.GetRequest{AppName: "lake_sre", UserID: "lake", SessionID: persistence.id})
	if errors.Is(err, adksession.ErrNotFound) {
		if _, err = persistence.service.Create(ctx, &adksession.CreateRequest{AppName: "lake_sre", UserID: "lake", SessionID: persistence.id}); err != nil {
			return err
		}
		stored, err = persistence.service.Get(ctx, &adksession.GetRequest{AppName: "lake_sre", UserID: "lake", SessionID: persistence.id})
	}
	if err != nil {
		return err
	}
	checkpoints := map[string]sreNodeResult{}
	for event := range stored.Session.Events().All() {
		if event.Partial || event.Output == nil || event.NodeInfo == nil {
			continue
		}
		var output sreNodeResult
		raw, marshalErr := json.Marshal(event.Output)
		if marshalErr != nil {
			return marshalErr
		}
		if json.Unmarshal(raw, &output) == nil && output.SchemaVersion == 1 && output.StepID == sreStepFromNodePath(event.NodeInfo.Path) {
			checkpoints[output.StepID] = output
		}
	}
	legacy := len(checkpoints) == 0
	nodes := map[string]workflow.Node{}
	for _, step := range ordered {
		fingerprint := hash(js(step))
		cached, exists := checkpoints[step.ID]
		reused := exists
		if exists && cached.Fingerprint != fingerprint {
			return errors.New("ADK 计划检查点与当前步骤不一致")
		}
		if !exists && persistence.importResult != nil {
			reused = persistence.importResult(step, legacy)
		}
		nodes[step.ID] = workflow.NewFunctionNode("step_"+step.ID, func(actx agent.Context, _ any) (sreNodeResult, error) {
			result := sreNodeResult{SchemaVersion: 1, StepID: step.ID, Fingerprint: fingerprint}
			if !reused {
				if err := actx.Err(); err != nil {
					return sreNodeResult{}, err
				}
				if err := execute(actx, step); err != nil {
					return sreNodeResult{}, err
				}
			}
			return result, nil
		}, workflow.NodeConfig{})
	}

	edges := workflow.NewEdgeBuilder()
	for _, step := range ordered {
		predecessors := deps[step.ID]
		switch len(predecessors) {
		case 0:
			edges.Add(workflow.Start, nodes[step.ID])
		case 1:
			edges.Add(nodes[predecessors[0]], nodes[step.ID])
		default:
			join := workflow.NewJoinNode("join_" + step.ID)
			for _, dep := range predecessors {
				edges.Add(nodes[dep], join)
			}
			edges.Add(join, nodes[step.ID])
		}
	}
	// A single terminal join makes the workflow output deterministic even when
	// an imported legacy plan has several independent terminal deliverables.
	joined := workflow.NewJoinNode("sre_finished")
	for _, step := range ordered {
		edges.Add(nodes[step.ID], joined)
	}
	root, err := workflowagent.New(workflowagent.Config{Name: "lake_sre_plan", Edges: edges.Build()})
	if err != nil {
		return err
	}
	r, err := runner.New(runner.Config{AppName: "lake_sre", Agent: root, SessionService: persistence.service})
	if err != nil {
		return err
	}
	for _, err := range r.Run(ctx, "lake", persistence.id, &genai.Content{Role: "user", Parts: []*genai.Part{{Text: plan.Goal}}}, agent.RunConfig{}) {
		if err != nil {
			return err
		}
	}
	return nil
}

// Keep this parser local to migration/auditing of ADK event node paths.
func sreStepFromNodePath(path string) string {
	for _, part := range strings.Split(path, "/") {
		name, _, _ := strings.Cut(part, "@")
		if strings.HasPrefix(name, "step_") {
			return strings.TrimPrefix(name, "step_")
		}
	}
	return ""
}
