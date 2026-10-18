package ai

import (
	"encoding/json"
	"fmt"
	"strings"
)

func ValidSRERole(role SREAgentRole) bool {
	return role == SRECoordinator || role == SREInvestigator || role == SREExecutor || role == SREVerifier
}
func SRETaskActive(status string) bool {
	return status == "draft" || status == "active" || status == "waiting_input" || status == "waiting_approval" || status == "paused"
}

func TransitionSRETask(task *SRETask, next string) error {
	if task.Status == next {
		return nil
	}
	allowed := map[string]string{
		"draft":            " active paused cancelled failed waiting_input",
		"active":           " waiting_input waiting_approval paused completed failed cancelled",
		"waiting_input":    " active paused cancelled failed",
		"waiting_approval": " active paused cancelled failed",
		"paused":           " active cancelled failed",
	}
	if !strings.Contains(allowed[task.Status]+" ", " "+next+" ") {
		return sreError(409, "任务状态不能从 "+task.Status+" 变更为 "+next)
	}
	if next == "completed" && !CanCompleteSRETask(*task) {
		return sreError(409, "任务尚未满足验收条件")
	}
	task.Status = next
	return nil
}

var sreActTools = map[string]bool{"shell": true, "docker_container_action": true, "execute_sql": true, "redis_command": true, "write": true, "edit": true, "append": true}
var sreProbeTools = map[string]bool{"observe_host": true, "observe_logs": true, "observe_journal": true, "observe_data": true, "observe_cluster": true, "observe_cluster_logs": true}

func ValidateSREPlan(plan SREPlanRevision, scope []string) error {
	if strings.TrimSpace(plan.Goal) == "" || len(plan.Goal) > 4000 || len(plan.Steps) < 1 || len(plan.Steps) > 32 {
		return sreError(400, "计划须有目标和 1–32 个步骤")
	}
	if !strings.Contains(" query investigation recovery change ", " "+plan.TaskType+" ") {
		return sreError(400, "无效的任务类型")
	}
	allowed := map[string]bool{}
	for _, id := range scope {
		allowed[id] = true
	}
	if len(plan.Scope) == 0 {
		return sreError(400, "计划必须声明资源范围")
	}
	planScope := map[string]bool{}
	for _, id := range plan.Scope {
		if !allowed[id] || planScope[id] {
			return sreError(400, "计划资源不在任务范围内或重复")
		}
		planScope[id] = true
	}
	steps := map[string]SREPlanStep{}
	for _, step := range plan.Steps {
		if !identifier.MatchString(step.ID) || steps[step.ID].ID != "" || strings.TrimSpace(step.Description) == "" || len(step.Description) > 4000 || !ValidSRERole(step.Role) {
			return sreError(400, "无效或重复的计划步骤")
		}
		if len(step.ResourceIDs) > 8 || len(step.ResourceIDs) == 0 {
			return sreError(400, "每步需有 1–8 个明确资源")
		}
		seen := map[string]bool{}
		for _, id := range step.ResourceIDs {
			if !planScope[id] || seen[id] {
				return sreError(400, "步骤资源超出计划范围或重复")
			}
			seen[id] = true
		}
		if (step.Kind == "observe" && step.Role != SREInvestigator) || (step.Kind == "act" && step.Role != SREExecutor) || (step.Kind == "verify" && step.Role != SREVerifier) || ((step.Kind == "analyze" || step.Kind == "summarize") && step.Role != SRECoordinator) {
			return sreError(400, "步骤职责与角色不匹配")
		}
		if !strings.Contains(" observe act verify analyze summarize ", " "+step.Kind+" ") {
			return sreError(400, "无效的步骤类型")
		}
		if step.Kind == "observe" && !strings.Contains(" host application data ", " "+step.Capability+" ") {
			return sreError(400, "调查能力须为 host、application 或 data")
		}
		if len(step.CompletionChecks) == 0 {
			return sreError(400, "每步必须写明完成条件")
		}
		if step.Kind == "act" {
			if step.Action == nil || !sreActTools[step.Action.Tool] || step.Action.Arguments == nil || step.Action.Reason == "" || step.Action.Impact == "" || step.Action.Rollback == "" || step.Action.StopCondition == "" {
				return sreError(400, "操作需有受支持工具、参数、依据、影响、回退和停止条件")
			}
		}
		if step.Action != nil {
			if step.Kind != "act" {
				return sreError(400, "只有执行步骤允许操作")
			}
			for k := range step.Action.Arguments {
				if strings.HasPrefix(k, "__") || k == "approved" {
					return sreError(400, "计划不能携带授权或身份参数")
				}
			}
			ref := str(step.Action.Arguments["asset_ref"])
			if len(step.ResourceIDs) != 1 || ref != assetAlias(step.ResourceIDs[0]) {
				return sreError(400, "执行步骤须绑定一个资源及其工具引用")
			}
		}
		steps[step.ID] = step
	}
	visiting, done := map[string]bool{}, map[string]bool{}
	var visit func(string) error
	visit = func(id string) error {
		if visiting[id] {
			return sreError(400, "计划依赖存在循环")
		}
		if done[id] {
			return nil
		}
		step, ok := steps[id]
		if !ok {
			return sreError(400, "计划依赖不存在")
		}
		visiting[id] = true
		deps := map[string]bool{}
		for _, dep := range step.DependsOn {
			if deps[dep] {
				return sreError(400, "计划依赖重复")
			}
			deps[dep] = true
			if err := visit(dep); err != nil {
				return err
			}
		}
		delete(visiting, id)
		done[id] = true
		return nil
	}
	for id := range steps {
		if err := visit(id); err != nil {
			return err
		}
	}
	hasAction, hasVerification := false, false
	for _, step := range plan.Steps {
		hasAction = hasAction || step.Kind == "act"
		hasVerification = hasVerification || step.Kind == "verify"
	}
	if hasAction && (plan.TaskType != "change" && plan.TaskType != "recovery" || !hasVerification || len(plan.Acceptance) == 0) {
		return sreError(400, "变更必须使用 change/recovery 类型，并包含独立验证步骤和验收条件")
	}
	if hasAction {
		memo := map[string]bool{}
		known := map[string]bool{}
		var depends func(string, string) bool
		depends = func(id, target string) bool {
			key := id + ":" + target
			if known[key] {
				return memo[key]
			}
			known[key] = true
			for _, dep := range steps[id].DependsOn {
				if dep == target || depends(dep, target) {
					memo[key] = true
					return true
				}
			}
			return false
		}
		for _, action := range plan.Steps {
			if action.Kind != "act" {
				continue
			}
			covered := false
			for _, v := range plan.Steps {
				if v.Kind == "verify" && depends(v.ID, action.ID) {
					covered = true
				}
			}
			if !covered {
				return sreError(400, "每个变更步骤必须有依赖于它的独立验证")
			}
		}
	}
	if len(plan.Acceptance) > 8 {
		return sreError(400, "最多 8 项验收条件")
	}
	checks := map[string]bool{}
	for _, check := range plan.Acceptance {
		if !identifier.MatchString(check.ID) || checks[check.ID] || check.Description == "" {
			return sreError(400, "无效或重复的验收条件")
		}
		checks[check.ID] = true
		if check.Kind == "manual_attestation" {
			if check.Probe != nil {
				return sreError(400, "人工确认不能附带自动操作")
			}
			continue
		}
		if check.Kind != "number_threshold" && check.Kind != "boolean_probe" {
			return sreError(400, "未知的验收检查类型")
		}
		if !planScope[check.ResourceID] || check.Probe == nil || !sreProbeTools[check.Probe.Tool] || str(check.Probe.Arguments["asset_ref"]) != assetAlias(check.ResourceID) || check.Path == "" || check.MinSamples < 1 || check.MinSamples > 12 || check.WindowSeconds < 0 || check.WindowSeconds > 60 {
			return sreError(400, "验收必须绑定资源、只读探针、结果路径及有效样本数／时间窗")
		}
		if check.WindowSeconds > 0 && check.MinSamples < 2 {
			return sreError(400, "持续观察时间窗至少需要两个样本")
		}
		if check.Path == "exitCode" || check.Path == "exit_code" || check.Path == "success" {
			return sreError(400, "采集命令成功不能充当业务恢复验收")
		}
		if check.Kind == "number_threshold" {
			if _, ok := check.Expected.(float64); !ok {
				if _, ok = check.Expected.(int); !ok {
					return sreError(400, "数值阈值必须为数字")
				}
			}
			if !strings.Contains(" lt lte eq gte gt ", " "+check.Operator+" ") {
				return sreError(400, "无效阈值比较符")
			}
		}
		if check.Kind == "boolean_probe" {
			if _, ok := check.Expected.(bool); !ok {
				return sreError(400, "布尔探针必须指定期望值")
			}
		}
	}
	return nil
}

func CanCompleteSRETask(task SRETask) bool {
	for _, a := range task.Attempts {
		for _, op := range a.Operations {
			if SREOperationBlocksResume(op) {
				return false
			}
		}
	}
	p := task.LatestPlan()
	run := task.ActiveRun()
	if p == nil || run == nil {
		return false
	}
	for _, step := range p.Steps {
		found := false
		for _, a := range task.Attempts {
			if a.PlanRunID == run.ID && a.StepID == step.ID && SREAttemptCompleted(a, step) {
				found = true
			}
		}
		if !found {
			return false
		}
	}
	if p.TaskType == "query" || p.TaskType == "investigation" {
		return task.Outcome == "supported" || task.Outcome == "inconclusive"
	}
	for _, v := range task.Verifications {
		if v.PlanRunID == run.ID && v.Verdict == "passed" {
			return true
		}
	}
	return false
}

func SREAttemptCompleted(a SREStepAttempt, step SREPlanStep) bool {
	if sreReadCheckIncomplete(a) {
		return false
	}
	for _, op := range a.Operations {
		if SREOperationBlocksResume(op) {
			return false
		}
	}
	if a.Status == "succeeded" {
		return true
	}
	if step.Kind != "act" || len(a.Operations) == 0 {
		return false
	}
	for _, op := range a.Operations {
		if op.Status != "succeeded" {
			return false
		}
	}
	return true
}

func CloneSRETask(task SRETask) SRETask {
	var out SRETask
	b, _ := json.Marshal(task)
	_ = json.Unmarshal(b, &out)
	return out
}
func SREPlanForRun(task SRETask, run SREPlanRun) (SREPlanRevision, error) {
	for _, p := range task.Plans {
		if p.ID == run.PlanRevisionID {
			return p, nil
		}
	}
	return SREPlanRevision{}, fmt.Errorf("运行绑定的计划不存在")
}
