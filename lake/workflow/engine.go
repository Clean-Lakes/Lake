package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
)

type SSHExecutor interface {
	RunRead(context.Context, string, string) (sshtransport.Result, error)
	RunCommand(context.Context, string, string) (sshtransport.Result, error)
}

// StepExecutor adds model-driven goals/recovery without changing DAG ordering.
type StepExecutor interface {
	ExecuteWorkflowStep(context.Context, Step) (sshtransport.Result, error)
}

var ErrExecutionUnknown = errors.New("工作流执行结果未知，禁止自动重放")

type Progress struct {
	RunID      string          `json:"run_id"`
	Name       string          `json:"name"`
	Status     string          `json:"status"`
	StepID     string          `json:"step_id,omitempty"`
	StepName   string          `json:"step_name,omitempty"`
	Resource   string          `json:"resource,omitempty"`
	Kind       string          `json:"kind,omitempty"`
	StepStatus string          `json:"step_status,omitempty"`
	Completed  int             `json:"completed"`
	Total      int             `json:"total"`
	Message    string          `json:"message,omitempty"`
	Planning   *PlanningReview `json:"planning,omitempty"`
}

type Reporter func(Progress)

// Start executes the saved snapshot, rather than re-reading a definition in
// the middle of the run. The caller supplies Lake's authorized SSH service.
func Start(ctx context.Context, s *store.Store, saved store.WorkflowDefinition, trigger string, ssh SSHExecutor, report Reporter) (store.WorkflowRun, error) {
	return StartWithBindings(ctx, s, saved, trigger, "", nil, ssh, report)
}

// StartWithBindings resolves host inputs before creating a durable run snapshot.
// Resume later reads that snapshot, so edits to the saved workflow cannot
// redirect a partially completed run.
func StartWithBindings(ctx context.Context, s *store.Store, saved store.WorkflowDefinition, trigger, resource string, bindings map[string]string, ssh SSHExecutor, report Reporter) (store.WorkflowRun, error) {
	return StartWithTargets(ctx, s, saved, trigger, resource, bindings, nil, ssh, report)
}

func StartWithTargets(ctx context.Context, s *store.Store, saved store.WorkflowDefinition, trigger, resource string, bindings map[string]string, targets []string, ssh SSHExecutor, report Reporter) (store.WorkflowRun, error) {
	var def Definition
	if err := json.Unmarshal(saved.Spec, &def); err != nil {
		return store.WorkflowRun{}, err
	}
	var err error
	def, err = BindTargets(def, resource, bindings, targets)
	if err != nil {
		return store.WorkflowRun{}, err
	}
	if def.Name != saved.Name {
		return store.WorkflowRun{}, errors.New("工作流定义名称与数据记录不一致")
	}
	def.Planning = nil // Every new run evaluates the original saved task.
	ids := make([]string, 0, len(def.Steps))
	for _, step := range def.Steps {
		ids = append(ids, step.ID)
	}
	snapshot, err := json.Marshal(def)
	if err != nil {
		return store.WorkflowRun{}, err
	}
	run, err := s.CreateWorkflowRunWithSpec(ctx, saved.ID, trigger, ids, snapshot)
	if err != nil {
		return run, err
	}
	if tagged, ok := ssh.(interface{ SetRunID(string) }); ok {
		tagged.SetRunID(run.ID)
	}
	run, def, err = prepareExecution(ctx, s, run, def, ssh, report)
	if err != nil {
		status := "failed"
		if ctx.Err() != nil {
			status = "interrupted"
		}
		persistCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		for _, step := range def.Steps {
			if saveErr := s.SetWorkflowStepStatus(persistCtx, run.ID, step.ID, "cancelled", "", "", "执行前规划停止，未执行远端操作", nil); saveErr != nil {
				return run, saveErr
			}
		}
		if saveErr := s.SetWorkflowRunStatus(persistCtx, run.ID, status, "执行前规划停止"); saveErr != nil {
			return run, saveErr
		}
		run, saveErr := s.GetWorkflowRun(persistCtx, run.ID)
		if report != nil {
			report(Progress{RunID: run.ID, Name: run.Name, Status: status, Total: len(def.Steps), Message: "执行前规划停止"})
		}
		return run, saveErr
	}
	return execute(ctx, s, run, def, ssh, report)
}

// Resume keeps completed steps. A previously running write step has an unknown
// remote outcome, so it is never replayed without an explicit retry request.
func Resume(ctx context.Context, s *store.Store, runID string, retryWrites bool, ssh SSHExecutor, report Reporter) (store.WorkflowRun, error) {
	run, err := s.GetWorkflowRun(ctx, runID)
	if err != nil {
		return run, err
	}
	if run.Status != "interrupted" && run.Status != "failed" {
		return run, errors.New("只有中断或失败的工作流可以恢复")
	}
	var def Definition
	if err := json.Unmarshal(run.Spec, &def); err != nil {
		return run, err
	}
	if err := Validate(def); err != nil {
		return run, err
	}
	byID := make(map[string]Step, len(def.Steps))
	for _, step := range def.Steps {
		byID[step.ID] = step
	}
	statuses := make(map[string]string, len(run.Steps))
	for _, stepRun := range run.Steps {
		statuses[stepRun.StepID] = stepRun.Status
	}
	invalidated := make(map[string]bool)
	for _, stepRun := range run.Steps {
		step, ok := byID[stepRun.StepID]
		if !ok {
			return run, fmt.Errorf("运行记录中存在未知步骤 %q", stepRun.StepID)
		}
		if stepRun.Status == "running" {
			if err := s.SetWorkflowStepStatus(ctx, runID, step.ID, "unknown", "", "", "上次运行中断，远端结果未知", nil); err != nil {
				return run, err
			}
			statuses[step.ID] = "unknown"
		}
		if statuses[step.ID] == "unknown" || statuses[step.ID] == "failed" || statuses[step.ID] == "cancelled" {
			invalidated[step.ID] = true
		}
	}
	for changed := true; changed; {
		changed = false
		for _, step := range def.Steps {
			if invalidated[step.ID] {
				continue
			}
			for _, dep := range step.DependsOn {
				if invalidated[dep] {
					invalidated[step.ID] = true
					changed = true
					break
				}
			}
		}
	}
	for _, step := range def.Steps {
		if !invalidated[step.ID] {
			continue
		}
		if step.Kind != "ssh_check" && !retryWrites {
			return run, fmt.Errorf("步骤 %q 是可能已有副作用的 SSH 命令；须人工核对后使用 --retry-writes 恢复", step.ID)
		}
	}
	for _, step := range def.Steps {
		if !invalidated[step.ID] || statuses[step.ID] == "pending" {
			continue
		}
		if err := s.SetWorkflowStepStatus(ctx, runID, step.ID, "pending", "", "", "", nil); err != nil {
			return run, err
		}
	}
	run, err = s.GetWorkflowRun(ctx, runID)
	if err != nil {
		return run, err
	}
	if tagged, ok := ssh.(interface{ SetRunID(string) }); ok {
		tagged.SetRunID(run.ID)
	}
	return execute(ctx, s, run, def, ssh, report)
}

type settledStep struct {
	step   Step
	result sshtransport.Result
	err    error
}

func execute(ctx context.Context, s *store.Store, run store.WorkflowRun, def Definition, ssh SSHExecutor, report Reporter) (store.WorkflowRun, error) {
	if run.Status != "running" {
		if err := s.SetWorkflowRunStatus(ctx, run.ID, "running", ""); err != nil {
			return run, err
		}
	}
	statuses := make(map[string]string, len(run.Steps))
	for _, step := range run.Steps {
		statuses[step.StepID] = step.Status
	}
	byID := make(map[string]Step, len(def.Steps))
	for _, step := range def.Steps {
		byID[step.ID] = step
	}
	active := make(map[string]bool)
	results := make(chan settledStep, len(def.Steps))
	notify := func(step Step, status, message string) {
		if report == nil {
			return
		}
		completed := 0
		for _, value := range statuses {
			if terminalStep(value) {
				completed++
			}
		}
		report(Progress{RunID: run.ID, Name: run.Name, Status: "running", StepID: step.ID, StepName: step.Name, Resource: step.Resource, Kind: step.Kind, StepStatus: status, Completed: completed, Total: len(def.Steps), Message: message})
	}
	if report != nil {
		report(Progress{RunID: run.ID, Name: run.Name, Status: "running", Completed: countTerminal(statuses), Total: len(def.Steps)})
	}
	for countTerminal(statuses) < len(def.Steps) {
		launched := false
		if ctx.Err() == nil {
			for _, step := range def.Steps {
				if statuses[step.ID] != "pending" || active[step.ID] || len(active) >= 4 {
					continue
				}
				ready, shouldRun := dependencyDecision(step, statuses)
				if !ready {
					continue
				}
				if !shouldRun {
					if err := s.SetWorkflowStepStatus(ctx, run.ID, step.ID, "skipped", "", "", "依赖条件未满足", nil); err != nil {
						return run, err
					}
					statuses[step.ID] = "skipped"
					notify(step, "skipped", "依赖条件未满足")
					launched = true
					continue
				}
				if err := s.SetWorkflowStepStatus(ctx, run.ID, step.ID, "running", "", "", "", nil); err != nil {
					return run, err
				}
				statuses[step.ID] = "running"
				active[step.ID] = true
				notify(step, "running", "")
				launched = true
				go func(step Step) {
					stepCtx := ctx
					if step.TimeoutSeconds > 0 {
						stepCtx = sshtransport.WithCommandTimeout(ctx, time.Duration(step.TimeoutSeconds)*time.Second)
					}
					var result sshtransport.Result
					var err error
					if adaptive, ok := ssh.(StepExecutor); ok {
						result, err = adaptive.ExecuteWorkflowStep(stepCtx, step)
					} else if step.Kind == "ssh_task" {
						err = errors.New("目标步骤缺少模型执行器")
					} else if step.Kind == "ssh_check" {
						result, err = ssh.RunRead(stepCtx, step.Resource, step.Check)
					} else {
						result, err = ssh.RunCommand(stepCtx, step.Resource, step.Command)
					}
					results <- settledStep{step: step, result: result, err: err}
				}(step)
			}
		}
		if len(active) == 0 {
			if ctx.Err() != nil {
				break
			}
			if !launched {
				return run, errors.New("工作流没有可执行步骤，依赖图无法推进")
			}
			continue
		}
		settled := <-results
		delete(active, settled.step.ID)
		status, message := "completed", ""
		if settled.err != nil {
			status, message = "failed", settled.err.Error()
			if errors.Is(settled.err, ErrExecutionUnknown) {
				status = "unknown"
			}
		}
		if settled.err == nil && settled.result.ExitCode != 0 {
			status, message = "failed", fmt.Sprintf("SSH 退出码 %d", settled.result.ExitCode)
		}
		if ctx.Err() != nil {
			if settled.step.Kind != "ssh_check" {
				status, message = "unknown", "执行中断，远端命令结果未知"
			} else {
				status, message = "cancelled", "执行中断"
			}
		}
		exit := settled.result.ExitCode
		exitCode := &exit
		if settled.err != nil || status == "unknown" || status == "cancelled" {
			exitCode = nil
		}
		if err := s.SetWorkflowStepStatus(context.Background(), run.ID, settled.step.ID, status, settled.result.Stdout, settled.result.Stderr, message, exitCode); err != nil {
			return run, err
		}
		statuses[settled.step.ID] = status
		notify(settled.step, status, message)
	}
	if ctx.Err() != nil {
		for _, step := range def.Steps {
			if statuses[step.ID] != "pending" {
				continue
			}
			if err := s.SetWorkflowStepStatus(context.Background(), run.ID, step.ID, "cancelled", "", "", "执行中断", nil); err != nil {
				return run, err
			}
			statuses[step.ID] = "cancelled"
			notify(step, "cancelled", "执行中断")
		}
	}
	final := "completed"
	if ctx.Err() != nil {
		final = "interrupted"
	} else {
		for _, status := range statuses {
			if status == "failed" || status == "unknown" {
				final = "failed"
				break
			}
		}
	}
	message := ""
	if ctx.Err() != nil {
		message = ctx.Err().Error()
	}
	if err := s.SetWorkflowRunStatus(context.Background(), run.ID, final, message); err != nil {
		return run, err
	}
	run, err := s.GetWorkflowRun(context.Background(), run.ID)
	if err != nil {
		return run, err
	}
	if report != nil {
		report(Progress{RunID: run.ID, Name: run.Name, Status: final, Completed: countTerminal(statuses), Total: len(def.Steps), Message: message})
	}
	return run, nil
}

func dependencyDecision(step Step, statuses map[string]string) (bool, bool) {
	if len(step.DependsOn) == 0 {
		return true, true
	}
	allSuccess, anyFailed := true, false
	for _, id := range step.DependsOn {
		status := statuses[id]
		if !terminalStep(status) {
			return false, false
		}
		if status != "completed" {
			allSuccess = false
		}
		if status == "failed" || status == "unknown" {
			anyFailed = true
		}
	}
	switch step.When {
	case "always":
		return true, true
	case "any_failure":
		return true, anyFailed
	default:
		return true, allSuccess
	}
}

func terminalStep(status string) bool {
	return status == "completed" || status == "failed" || status == "skipped" || status == "cancelled" || status == "unknown"
}
func countTerminal(statuses map[string]string) int {
	n := 0
	for _, status := range statuses {
		if terminalStep(status) {
			n++
		}
	}
	return n
}

func Summarize(run store.WorkflowRun) string {
	var b strings.Builder
	fmt.Fprintf(&b, "工作流 %s：%s（运行 ID %s）\n", run.Name, run.Status, run.ID)
	for _, step := range run.Steps {
		fmt.Fprintf(&b, "- %s：%s", step.StepID, step.Status)
		if step.ExitCode != nil {
			fmt.Fprintf(&b, "，退出码 %d", *step.ExitCode)
		}
		if step.Error != "" {
			fmt.Fprintf(&b, "，%s", step.Error)
		}
		if text := strings.TrimSpace(step.Stdout); text != "" {
			fmt.Fprintf(&b, "\n  输出：%s", text)
		}
		if text := strings.TrimSpace(step.Stderr); text != "" {
			fmt.Fprintf(&b, "\n  错误输出：%s", text)
		}
		b.WriteByte('\n')
	}
	return b.String()
}
