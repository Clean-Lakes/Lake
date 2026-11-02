package ai

import (
	"context"
	"encoding/json"
	"sync"
)

type superSREGraphKey struct{}
type superSREGraph struct {
	rootStep string
	resume   func() error
	once     sync.Once
	err      error
}

func (g *superSREGraph) finish() error { g.once.Do(func() { g.err = g.resume() }); return g.err }

func (e *Engine) prepareSuperSREGraph(ctx context.Context, plan SREPlanRevision) (context.Context, func() error, error) {
	if _, ok := ctx.Value(superAssignmentContextKey{}).(SuperAssignmentToken); !ok {
		return ctx, func() error { return nil }, nil
	}
	resume, err := e.parkSuperInvocation(ctx, "waiting_children")
	if err != nil {
		return ctx, nil, err
	}
	g := &superSREGraph{resume: resume}
	if len(plan.Steps) > 0 {
		last := plan.Steps[len(plan.Steps)-1]
		if last.Role == SRECoordinator && last.Kind == "summarize" {
			g.rootStep = last.ID
		}
	}
	return context.WithValue(ctx, superSREGraphKey{}, g), g.finish, nil
}

func (e *Engine) admitSuperSRERole(ctx context.Context, sessionID string, task SRETask, step SREPlanStep, runID, attemptID string, presentationOnly bool) (context.Context, string, func(), error) {
	g, ok := ctx.Value(superSREGraphKey{}).(*superSREGraph)
	if !ok {
		return ctx, "", func() {}, nil
	} // A coordinator's own bounded planning turn.
	if presentationOnly && step.ID == g.rootStep {
		if err := g.finish(); err != nil {
			return ctx, "", nil, err
		}
		return ctx, "", func() {}, nil
	}
	token, ok := ctx.Value(superAssignmentContextKey{}).(SuperAssignmentToken)
	if !ok {
		return ctx, "", nil, errSuperBinding
	}
	db, err := e.superStore()
	if err != nil {
		return ctx, "", nil, err
	}
	var parent superWorkerRow
	if err = db.WithContext(ctx).First(&parent, "id = ?", token.WorkerID).Error; err != nil {
		return ctx, "", nil, err
	}
	id := hash(js([]any{"sre-child", parent.TaskID, task.ID, runID, attemptID, step.ID}))[:32]
	if parent.Protocol == "workflow" {
		var row securityWorkflowRunRow
		if err = db.WithContext(ctx).First(&row, "goal_id = ? AND session_id = ? AND state = ?", parent.TaskID, sessionID, "running").Error; err != nil {
			return ctx, "", nil, err
		}
		var binding SecurityWorkflowRunBinding
		if err = json.Unmarshal([]byte(row.Data), &binding); err != nil {
			return ctx, "", nil, err
		}
		id = binding.ChildScopeIDs[step.ID]
		if id == "" {
			return ctx, "", nil, errSuperBinding
		}
	}
	role := step.Capability
	if role == "" {
		role = "host"
	}
	w := &agentWorker{runID: id, role: role, assets: append([]string(nil), step.ResourceIDs...)}
	if err = e.reserveSuperChildren(ctx, []*agentWorker{w}, true); err != nil {
		return ctx, "", nil, err
	}
	child, release, err := e.claimSuperChild(ctx, id)
	return child, id, release, err
}
