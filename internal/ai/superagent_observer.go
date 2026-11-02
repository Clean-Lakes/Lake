package ai

import (
	"context"
	"time"
)

type SuperBuildObservation struct {
	Available bool   `json:"available"`
	State     string `json:"state,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Handle    string `json:"handle,omitempty"`
}

func (e *Engine) ObserveTaskBuild(ctx context.Context, project, worker, item string) (SuperBuildObservation, error) {
	e.workTickMu.Lock()
	defer e.workTickMu.Unlock()
	db, err := e.superStore()
	if err != nil {
		return SuperBuildObservation{}, err
	}
	w, err := superWorkerInProject(db.WithContext(ctx), worker, project)
	if err != nil {
		return SuperBuildObservation{}, err
	}
	_, goal, err := loadSuperGoalTx(db.WithContext(ctx), w)
	if err != nil {
		return SuperBuildObservation{}, err
	}
	for _, step := range goal.Items {
		if step.ID != item {
			continue
		}
		if step.Watch == nil || step.Watch.Adapter != "release-v1" && step.Watch.Adapter != "shell-v1" {
			return SuperBuildObservation{Reason: "trusted_build_adapter_unavailable"}, nil
		}
		if workTerminal(goal.Status) || !goal.DeadlineAt.After(time.Now().UTC()) {
			return SuperBuildObservation{Reason: "original_task_inactive"}, nil
		}
		if step.Watch.Adapter == "release-v1" {
			// The existing generic MCP release bridge has no managed read
			// profile. Do not bypass Security to make a build demo work.
			return SuperBuildObservation{Reason: "managed_build_read_profile_unavailable"}, nil
		}
		config, err := e.ConfigForSession(w.goalSession())
		if err != nil {
			return SuperBuildObservation{}, err
		}
		state, err := e.observeWork(ctx, goal, step.Watch, config)
		if err != nil {
			return SuperBuildObservation{}, err
		}
		return SuperBuildObservation{Available: true, State: state, Handle: step.Watch.Handle}, nil
	}
	return SuperBuildObservation{}, errSuperBinding
}
