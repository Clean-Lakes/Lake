package ai

import (
	"context"
	"errors"
)

const sreCollaborationVersion = 1

// Only resumable legacy investigations with independent unfinished work qualify.
// User-authored serial prerequisites, changes and current dispatches stay intact.
func needsSRECollaborationUpgrade(t SRETask) bool {
	p, run := t.LatestPlan(), t.ActiveRun()
	if p == nil || p.CollaborationVersion >= sreCollaborationVersion || (p.TaskType != "investigation" && p.TaskType != "query") || (t.Status != "paused" && t.Status != "draft" && t.Status != "waiting_input") {
		return false
	}
	if run == nil || run.PlanRevisionID != p.ID || run.Status != "paused" {
		return false
	}
	for _, a := range t.Attempts {
		for _, op := range a.Operations {
			if SREOperationBlocksResume(op) {
				return false
			}
		}
	}
	completed := sreCompletedObservations(t)
	ready := 0
	hasCoordinator := false
	for _, s := range p.Steps {
		if s.Kind == "act" || s.Action != nil || s.Role == SREVerifier || s.Role == SREExecutor {
			return false
		}
		hasCoordinator = hasCoordinator || s.Role == SRECoordinator
		if s.Kind != "observe" || completed[s.ID].ID != "" {
			continue
		}
		available := true
		for _, dep := range s.DependsOn {
			available = available && completed[dep].ID != ""
		}
		if available {
			ready++
		}
	}
	// A coordinator can also review existing completed evidence independently
	// while the investigator finishes the last pending observation.
	return ready >= 2 || ready == 1 && len(completed) > 0 && hasCoordinator
}

func sreCompletedObservations(t SRETask) map[string]SREStepAttempt {
	done := map[string]SREStepAttempt{}
	p, run := t.LatestPlan(), t.ActiveRun()
	if p == nil || run == nil || run.PlanRevisionID != p.ID {
		return done
	}
	for _, step := range p.Steps {
		if step.Kind != "observe" {
			continue
		}
		for _, a := range t.Attempts {
			if a.PlanRunID == run.ID && a.StepID == step.ID && a.Status == "succeeded" {
				done[step.ID] = a
			}
		}
	}
	return done
}

func sameSREIDs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	set := map[string]int{}
	for _, id := range a {
		set[id]++
	}
	for _, id := range b {
		set[id]--
	}
	for _, count := range set {
		if count != 0 {
			return false
		}
	}
	return true
}

func validateSRECollaborationUpgrade(t SRETask, p SREPlanRevision) error {
	old := t.LatestPlan()
	if old == nil || p.Goal != old.Goal || p.TaskType != old.TaskType || !sameSREIDs(p.Scope, old.Scope) || (len(p.Acceptance) != 0 || len(old.Acceptance) != 0) && js(p.Acceptance) != js(old.Acceptance) {
		return errors.New("协作升级不能改变原目标、范围或验收条件")
	}
	if err := ValidateSREPlan(p, t.Scope); err != nil {
		return err
	}
	done := sreCompletedObservations(t)
	steps := map[string]SREPlanStep{}
	readyRoles := map[SREAgentRole]bool{}
	for _, s := range p.Steps {
		if s.Action != nil || s.Kind == "act" || s.Role == SREExecutor {
			return errors.New("只读协作升级不能加入变更")
		}
		steps[s.ID] = s
		if done[s.ID].ID != "" {
			continue
		}
		ready := true
		for _, dep := range s.DependsOn {
			ready = ready && done[dep].ID != ""
		}
		if ready {
			readyRoles[s.Role] = true
		}
	}
	for _, original := range old.Steps {
		next, ok := steps[original.ID]
		if !ok || next.Description != original.Description || !sameSREIDs(next.ResourceIDs, original.ResourceIDs) || !sameSREIDs(next.CompletionChecks, original.CompletionChecks) {
			return errors.New("协作升级必须保留每项原交付物、资源与完成条件")
		}
		if done[original.ID].ID != "" {
			if next.Kind != original.Kind || next.Role != original.Role || next.Capability != original.Capability || !sameSREIDs(next.DependsOn, original.DependsOn) {
				return errors.New("已完成取证不可重新分配或改写")
			}
		}
		for _, dep := range original.DependsOn {
			found := false
			for _, id := range next.DependsOn {
				found = found || dep == id
			}
			if !found {
				return errors.New("协作升级不能删除原有前置依赖")
			}
		}
	}
	if len(readyRoles) < 2 {
		return errors.New("剩余独立工作仍集中于一个专员，请安排实际并行的分工")
	}
	originalIDs := map[string]bool{}
	for _, s := range old.Steps {
		originalIDs[s.ID] = true
	}
	for _, summary := range p.Steps {
		if summary.Kind != "summarize" {
			continue
		}
		terminal := true
		for _, s := range p.Steps {
			for _, dep := range s.DependsOn {
				if dep == summary.ID {
					terminal = false
				}
			}
		}
		if !terminal {
			continue
		}
		ancestors := map[string]bool{}
		var visit func(string)
		visit = func(id string) {
			if ancestors[id] {
				return
			}
			ancestors[id] = true
			for _, dep := range steps[id].DependsOn {
				visit(dep)
			}
		}
		visit(summary.ID)
		for _, s := range p.Steps {
			if !originalIDs[s.ID] && s.Kind != "summarize" && !ancestors[s.ID] {
				return errors.New("最终汇总必须等待新增的独立复核或分析")
			}
		}
	}
	return nil
}

func (e *Engine) upgradeSRECollaboration(ctx context.Context, sessionID string, task SRETask) (SRETask, error) {
	original := *task.LatestPlan()
	_, err := e.sreRepository.MutateSRETask(sessionID, task.ID, 0, "collaboration_replanning", func(t *SRETask) error {
		if !needsSRECollaborationUpgrade(*t) {
			return errors.New("任务状态已变化，无法升级协作计划")
		}
		t.AddMessage(SRECoordinator, "", "collaboration", "正在保留已有取证结果，重新安排剩余专员的分工与依赖。", "")
		t.Messages[len(t.Messages)-1].Source = "runtime"
		return nil
	})
	if err != nil {
		return task, err
	}
	done := sreCompletedObservations(task)
	prompt := "Upgrade this legacy read-only investigation for real parallel specialist collaboration. Keep the EXACT goal, taskType, scope and acceptance. Keep EVERY existing step id, description, resourceIds and completionChecks. Keep all original dependency edges. Completed observation steps are frozen, will be carried with their original evidence and timestamps, and MUST NOT run again. Redistribute only unfinished work across valid investigator/observe, verifier/verify and coordinator/analyze roles based on context; at least two ready roles must have substantive independent deliverables. You may add a useful independent review/analysis step if needed. Do not add acts, executor work, repairs, scope or permissions. The final summary must wait for needed evidence. Completed observation step IDs: "
	ids := []string{}
	for _, s := range original.Steps {
		if done[s.ID].ID != "" {
			ids = append(ids, s.ID)
		}
	}
	prompt += js(ids)
	var plan SREPlanRevision
	var roleRun string
	for tries := 0; tries < 2; tries++ {
		plan, roleRun, err = e.buildSREPlan(ctx, sessionID, task, prompt)
		if err != nil {
			return task, err
		}
		if err = validateSRECollaborationUpgrade(task, plan); err == nil {
			break
		}
		prompt += "\nUpgrade constraints failed: " + err.Error() + ". Correct the plan only; no resource operation."
	}
	if err != nil {
		return task, err
	}
	if err = ctx.Err(); err != nil {
		return task, err
	}
	return e.sreRepository.MutateSRETask(sessionID, task.ID, 0, "collaboration_plan_upgraded", func(t *SRETask) error {
		if !needsSRECollaborationUpgrade(*t) || t.LatestPlan().ID != original.ID || t.LatestPlan().Version != original.Version {
			return errors.New("任务已变化，未覆盖现有计划")
		}
		if err := validateSRECollaborationUpgrade(*t, plan); err != nil {
			return err
		}
		carried := sreCompletedObservations(*t)
		if run := t.ActiveRun(); run != nil {
			run.Status = "superseded"
			run.FinishedAt = timestamp()
		}
		plan.ID, plan.TaskID, plan.Version, plan.CreatedAt = uid(), t.ID, original.Version+1, timestamp()
		plan.CollaborationVersion = sreCollaborationVersion
		plan.ChangeReason = "旧只读计划升级为专员协作；沿用已完成取证，重新安排剩余工作。"
		// Restore the exact stored representations of completed steps.
		for i, s := range plan.Steps {
			if carried[s.ID].ID != "" {
				for _, old := range original.Steps {
					if old.ID == s.ID {
						plan.Steps[i] = old
					}
				}
			}
		}
		t.Plans = append(t.Plans, plan)
		t.Status = "draft"
		if err := StartSREPlanRun(t, plan.Version, ""); err != nil {
			return err
		}
		run := t.ActiveRun()
		for _, step := range plan.Steps {
			if a := carried[step.ID]; a.ID != "" {
				a.ReusedFromAttemptID = a.ID
				a.ID, a.PlanRunID = uid(), run.ID
				t.Attempts = append(t.Attempts, a)
			}
		}
		run.Status = "queued"
		t.AddMessage(SRECoordinator, roleRun, "plan_revision", "已沿用完成的证据，剩余专员按新分工协作。", "")
		t.Messages[len(t.Messages)-1].Source = "runtime"
		return nil
	})
}
