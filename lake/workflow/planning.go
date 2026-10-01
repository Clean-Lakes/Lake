package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/cloudwego/eino/lake/store"
)

// PlanningExecutor can tune execution parameters, but cannot replace the task.
type PlanningExecutor interface {
	PlanWorkflow(context.Context, Definition, []store.WorkflowRun) (PlanProposal, error)
}

type PlanProposal struct {
	Adjustments []PlanChange `json:"adjustments"`
}

type PlanChange struct {
	StepID         string   `json:"step_id"`
	TimeoutSeconds int      `json:"timeout_seconds,omitempty"`
	AddDependsOn   []string `json:"add_depends_on,omitempty"`
	Reason         string   `json:"reason"`
	EvidenceRunIDs []string `json:"evidence_run_ids,omitempty"`
}

type PlanningReview struct {
	Status      string           `json:"status"` // adjusted, unchanged, unavailable
	Message     string           `json:"message"`
	Adjustments []PlanAdjustment `json:"adjustments,omitempty"`
}

type PlanAdjustment struct {
	StepID               string   `json:"step_id"`
	StepName             string   `json:"step_name"`
	TimeoutBeforeSeconds int      `json:"timeout_before_seconds"`
	TimeoutSeconds       int      `json:"timeout_seconds"`
	DependsOnBefore      []string `json:"depends_on_before,omitempty"`
	DependsOn            []string `json:"depends_on,omitempty"`
	WaitFor              []string `json:"wait_for,omitempty"`
	Reason               string   `json:"reason"`
	EvidenceRunIDs       []string `json:"evidence_run_ids,omitempty"`
}

func effectiveTimeout(step Step) int {
	if step.TimeoutSeconds > 0 {
		return step.TimeoutSeconds
	}
	return 20
}

// ApplyPlan owns all mutations. No model-supplied full definition is accepted.
func ApplyPlan(def Definition, proposal PlanProposal) (Definition, *PlanningReview, error) {
	if len(proposal.Adjustments) > len(def.Steps) {
		return def, nil, errors.New("规划调整数量超过步骤数")
	}
	result := def
	result.Steps = append([]Step(nil), def.Steps...)
	byID := make(map[string]int, len(def.Steps))
	for i, step := range def.Steps {
		byID[step.ID] = i
		result.Steps[i].DependsOn = append([]string(nil), step.DependsOn...)
	}
	review := &PlanningReview{Status: "unchanged", Message: "AI 已检查执行计划，无需调整"}
	seen := map[string]bool{}
	for _, change := range proposal.Adjustments {
		i, ok := byID[change.StepID]
		if !ok || seen[change.StepID] {
			return def, nil, errors.New("规划步骤不存在或重复")
		}
		seen[change.StepID] = true
		before := def.Steps[i]
		after := &result.Steps[i]
		if strings.TrimSpace(change.Reason) == "" || len(change.Reason) > 800 || len(change.EvidenceRunIDs) > 5 {
			return def, nil, errors.New("规划调整需要有界原因和证据")
		}
		if change.TimeoutSeconds != 0 {
			if change.TimeoutSeconds < effectiveTimeout(before) || change.TimeoutSeconds > 3600 {
				return def, nil, errors.New("规划只能在3600秒内延长执行期限")
			}
			after.TimeoutSeconds = change.TimeoutSeconds
		}
		if len(change.AddDependsOn) > len(def.Steps) || len(change.AddDependsOn) > 0 && before.When != "" && before.When != "all_success" {
			return def, nil, errors.New("规划不能改变条件分支")
		}
		deps := map[string]bool{}
		for _, id := range before.DependsOn {
			deps[id] = true
		}
		for _, id := range change.AddDependsOn {
			index, exists := byID[id]
			if !exists || id == before.ID || def.Steps[index].Resource != before.Resource || def.Steps[index].When != "" && def.Steps[index].When != "all_success" {
				return def, nil, errors.New("规划依赖必须是原资源上的成功步骤")
			}
			if !deps[id] {
				after.DependsOn = append(after.DependsOn, id)
				deps[id] = true
			}
		}
		if effectiveTimeout(before) == effectiveTimeout(*after) && len(before.DependsOn) == len(after.DependsOn) {
			continue
		}
		waitFor := []string{}
		for _, id := range after.DependsOn[len(before.DependsOn):] {
			waitFor = append(waitFor, def.Steps[byID[id]].Name)
		}
		review.Adjustments = append(review.Adjustments, PlanAdjustment{StepID: before.ID, StepName: before.Name, TimeoutBeforeSeconds: effectiveTimeout(before), TimeoutSeconds: effectiveTimeout(*after), DependsOnBefore: append([]string(nil), before.DependsOn...), DependsOn: append([]string(nil), after.DependsOn...), WaitFor: waitFor, Reason: strings.TrimSpace(change.Reason), EvidenceRunIDs: append([]string(nil), change.EvidenceRunIDs...)})
	}
	if err := Validate(result); err != nil {
		return def, nil, err
	}
	if len(review.Adjustments) > 0 {
		review.Status = "adjusted"
		review.Message = fmt.Sprintf("AI 已调整 %d 项执行配置", len(review.Adjustments))
	}
	result.Planning = review
	return result, review, nil
}

func prepareExecution(ctx context.Context, s *store.Store, run store.WorkflowRun, def Definition, ssh SSHExecutor, report Reporter) (store.WorkflowRun, Definition, error) {
	planner, ok := ssh.(PlanningExecutor)
	if !ok || def.ExecutionMode == "fixed" {
		return run, def, nil
	}
	if err := s.SetWorkflowRunStatus(ctx, run.ID, "running", ""); err != nil {
		return run, def, err
	}
	run.Status = "running"
	if report != nil {
		report(Progress{RunID: run.ID, Name: run.Name, Status: "planning", Total: len(def.Steps), Message: "AI 正在检查执行计划和历史结果"})
	}
	history, err := s.ListWorkflowHistory(ctx, run.WorkflowID, run.ID, 5)
	var proposal PlanProposal
	if err == nil {
		proposal, err = planner.PlanWorkflow(ctx, def, history)
	}
	var review *PlanningReview
	if err == nil {
		err = ValidatePlanEvidence(def, proposal, history)
	}
	if err == nil {
		def, review, err = ApplyPlan(def, proposal)
	}
	if ctx.Err() != nil {
		return run, def, ctx.Err()
	}
	if err != nil {
		review = &PlanningReview{Status: "unavailable", Message: "AI 执行计划评估未完成，沿用原计划"}
		def.Planning = review
	}
	snapshot, err := json.Marshal(def)
	if err != nil {
		return run, def, err
	}
	reviewJSON, err := json.Marshal(review)
	if err != nil {
		return run, def, err
	}
	if err := s.SavePendingWorkflowPlan(ctx, run.ID, snapshot, reviewJSON); err != nil {
		return run, def, err
	}
	run.Spec = snapshot
	if report != nil {
		report(Progress{RunID: run.ID, Name: run.Name, Status: "running", Total: len(def.Steps), Message: review.Message, Planning: review})
	}
	return run, def, nil
}

type PlanEvidence struct {
	RunID          string `json:"run_id"`
	StepID         string `json:"step_id"`
	Status         string `json:"status"`
	ElapsedMillis  int64  `json:"elapsed_ms"`
	TimeoutSeconds int    `json:"timeout_seconds"`
	TimedOut       bool   `json:"timed_out"`
	ExitCode       *int   `json:"exit_code,omitempty"`
}

// Only matching operations are evidence. Remote stdout/stderr is not sent to
// the planner: duration/status suffice and cannot smuggle instructions.
func PlanningEvidence(def Definition, history []store.WorkflowRun) []PlanEvidence {
	current := map[string]Step{}
	for _, step := range def.Steps {
		current[step.ID] = step
	}
	evidence := []PlanEvidence{}
	for _, run := range history {
		var prior Definition
		if json.Unmarshal(run.Spec, &prior) != nil {
			continue
		}
		old := map[string]Step{}
		for _, step := range prior.Steps {
			old[step.ID] = step
		}
		for _, result := range run.Steps {
			step, exists := current[result.StepID]
			previous, wasPresent := old[result.StepID]
			if !exists || !wasPresent || step.Resource != previous.Resource || step.Kind != previous.Kind || step.Command != previous.Command || step.Check != previous.Check || step.Goal != previous.Goal {
				continue
			}
			elapsed := int64(0)
			if result.StartedAt != nil && result.FinishedAt != nil {
				elapsed = max(0, result.FinishedAt.Sub(*result.StartedAt).Milliseconds())
			}
			timeout := strings.Contains(result.Error, "deadline exceeded") || strings.Contains(result.Error, "超时") && !strings.Contains(result.Error, "取消")
			evidence = append(evidence, PlanEvidence{RunID: run.ID, StepID: result.StepID, Status: result.Status, ElapsedMillis: elapsed, TimeoutSeconds: effectiveTimeout(previous), TimedOut: timeout, ExitCode: result.ExitCode})
		}
	}
	return evidence
}

func ValidatePlanEvidence(def Definition, proposal PlanProposal, history []store.WorkflowRun) error {
	allowed := map[string]bool{}
	for _, evidence := range PlanningEvidence(def, history) {
		allowed[evidence.StepID+"/"+evidence.RunID] = true
	}
	for _, change := range proposal.Adjustments {
		for _, id := range change.EvidenceRunIDs {
			if !allowed[change.StepID+"/"+id] {
				return errors.New("规划引用了不属于该操作的历史证据")
			}
		}
	}
	return nil
}
