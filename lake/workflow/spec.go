package workflow

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Definition is a bounded operations DAG. A step uses a resource name from
// its lake or a $name placeholder bound when the workflow starts.
type Definition struct {
	Name          string          `json:"name"`
	Description   string          `json:"description,omitempty"`
	TargetMode    string          `json:"target_mode,omitempty"`    // fixed, single, multiple
	ExecutionMode string          `json:"execution_mode,omitempty"` // adaptive (default) or fixed
	Steps         []Step          `json:"steps"`
	Planning      *PlanningReview `json:"planning,omitempty"`
}

type Step struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Kind           string   `json:"kind"` // ssh_check, ssh_command or ssh_task
	Goal           string   `json:"goal,omitempty"`
	Resource       string   `json:"resource"`
	Check          string   `json:"check,omitempty"`
	Command        string   `json:"command,omitempty"`
	TimeoutSeconds int      `json:"timeout_seconds,omitempty" jsonschema:"description=单次SSH执行最长秒数，默认20，可设置1至3600；全盘扫描建议300，不改变连接建立或人工取消期限"`
	DependsOn      []string `json:"depends_on,omitempty"`
	When           string   `json:"when,omitempty"` // all_success, any_failure, always
}

var stepIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
var resourceSlotPattern = regexp.MustCompile(`^\$[a-z][a-z0-9_-]{0,63}$`)
var readChecks = map[string]bool{"hostname": true, "uptime": true, "os": true, "cpu": true, "disk": true, "memory": true}

func Validate(def Definition) error {
	if def.ExecutionMode != "" && def.ExecutionMode != "adaptive" && def.ExecutionMode != "fixed" {
		return errors.New("工作流 execution_mode 仅支持 adaptive 或 fixed")
	}
	if strings.TrimSpace(def.Name) == "" || len(def.Name) > 120 || strings.ContainsAny(def.Name, "\x00\n\r") {
		return errors.New("工作流名称无效")
	}
	if len(def.Description) > 2000 {
		return errors.New("工作流描述过长")
	}
	if len(def.Steps) == 0 || len(def.Steps) > 32 {
		return errors.New("工作流需要 1–32 个步骤")
	}
	if def.TargetMode != "" && def.TargetMode != "fixed" && def.TargetMode != "single" && def.TargetMode != "multiple" {
		return fmt.Errorf("工作流目标模式 %q 无效", def.TargetMode)
	}
	resourceKeys := make(map[string]bool)
	byID := make(map[string]Step, len(def.Steps))
	for _, step := range def.Steps {
		if !stepIDPattern.MatchString(step.ID) {
			return fmt.Errorf("步骤 ID %q 无效", step.ID)
		}
		if _, exists := byID[step.ID]; exists {
			return fmt.Errorf("步骤 ID %q 重复", step.ID)
		}
		if strings.TrimSpace(step.Name) == "" || len(step.Name) > 120 {
			return fmt.Errorf("步骤 %q 名称无效", step.ID)
		}
		if !validResourceReference(step.Resource) {
			return fmt.Errorf("步骤 %q 资源名无效", step.ID)
		}
		if def.TargetMode == "fixed" && strings.HasPrefix(step.Resource, "$") {
			return fmt.Errorf("固定目标工作流的步骤 %q 不能使用运行时占位符", step.ID)
		}
		resourceKeys[step.Resource] = true
		if len(step.Goal) > 4000 {
			return fmt.Errorf("步骤 %q 目标过长", step.ID)
		}
		if step.TimeoutSeconds < 0 || step.TimeoutSeconds > 3600 {
			return fmt.Errorf("步骤 %q timeout_seconds 必须为0或1–3600", step.ID)
		}
		switch step.Kind {
		case "ssh_task":
			if strings.TrimSpace(step.Goal) == "" || step.Command != "" || step.Check != "" || def.ExecutionMode == "fixed" {
				return fmt.Errorf("步骤 %q 的目标任务需要 goal 且不能使用固定执行模式或命令", step.ID)
			}
		case "ssh_check":
			if !readChecks[step.Check] || step.Command != "" {
				return fmt.Errorf("步骤 %q 检查项无效", step.ID)
			}
		case "ssh_command":
			if step.Check != "" || strings.TrimSpace(step.Command) == "" || len(step.Command) > 2048 {
				return fmt.Errorf("步骤 %q 命令无效", step.ID)
			}
			for _, r := range step.Command {
				if r < 0x20 || r == 0x7f {
					return fmt.Errorf("步骤 %q 命令包含控制字符", step.ID)
				}
			}
		default:
			return fmt.Errorf("步骤 %q 类型无效", step.ID)
		}
		if step.When != "" && step.When != "all_success" && step.When != "any_failure" && step.When != "always" {
			return fmt.Errorf("步骤 %q 条件无效", step.ID)
		}
		byID[step.ID] = step
	}
	if (def.TargetMode == "single" || def.TargetMode == "multiple") && len(resourceKeys) != 1 {
		return errors.New("单选或多选工作流的所有步骤必须引用同一个目标")
	}
	state := make(map[string]uint8, len(def.Steps))
	var visit func(string) error
	visit = func(id string) error {
		if state[id] == 1 {
			return fmt.Errorf("工作流存在依赖环，涉及 %q", id)
		}
		if state[id] == 2 {
			return nil
		}
		state[id] = 1
		seen := make(map[string]bool)
		for _, dep := range byID[id].DependsOn {
			if dep == id || seen[dep] {
				return fmt.Errorf("步骤 %q 依赖重复或指向自身", id)
			}
			seen[dep] = true
			if _, ok := byID[dep]; !ok {
				return fmt.Errorf("步骤 %q 依赖不存在的 %q", id, dep)
			}
			if err := visit(dep); err != nil {
				return err
			}
		}
		state[id] = 2
		return nil
	}
	for _, step := range def.Steps {
		if err := visit(step.ID); err != nil {
			return err
		}
	}
	return nil
}

// TargetModeOf keeps workflows created before target modes compatible.
func TargetModeOf(def Definition) string {
	if def.TargetMode != "" {
		return def.TargetMode
	}
	keys := make(map[string]bool)
	hasSlot := false
	for _, step := range def.Steps {
		keys[step.Resource] = true
		hasSlot = hasSlot || strings.HasPrefix(step.Resource, "$")
	}
	if hasSlot && len(keys) == 1 {
		return "single"
	}
	if hasSlot {
		return "bindings"
	}
	return "fixed"
}

func validResourceReference(value string) bool {
	if resourceSlotPattern.MatchString(value) {
		return true
	}
	return value != "" && !strings.HasPrefix(value, "$") && !strings.ContainsAny(value, "/\\\x00\n\r") && strings.TrimSpace(value) == value
}

// Bind resolves optional run-time resource names without changing the saved
// definition. Fixed resource names may also be replaced via bindings.
func Bind(def Definition, resource string, bindings map[string]string) (Definition, error) {
	return BindTargets(def, resource, bindings, nil)
}

// BindTargets prepares one immutable run snapshot. In multiple mode it copies
// the full step graph once per selected host, keeping dependencies host-local.
func BindTargets(def Definition, resource string, bindings map[string]string, targets []string) (Definition, error) {
	if err := Validate(def); err != nil {
		return Definition{}, err
	}
	if def.TargetMode == "multiple" {
		if resource != "" || len(bindings) != 0 {
			return Definition{}, errors.New("多选工作流请使用 targets 指定主机")
		}
		if len(targets) == 0 {
			return Definition{}, errors.New("多选工作流运行时至少需要选择一台主机")
		}
		if len(targets)*len(def.Steps) > 32 {
			return Definition{}, errors.New("所选主机产生的总步骤超过 32；请减少主机数量")
		}
		seen := make(map[string]bool)
		resolved := def
		resolved.TargetMode = "fixed"
		resolved.Steps = make([]Step, 0, len(targets)*len(def.Steps))
		for hostIndex, target := range targets {
			if !validResourceReference(target) || strings.HasPrefix(target, "$") {
				return Definition{}, fmt.Errorf("第 %d 个运行目标无效", hostIndex+1)
			}
			if seen[target] {
				return Definition{}, fmt.Errorf("运行目标 %q 重复", target)
			}
			seen[target] = true
			stepIDs := make(map[string]string, len(def.Steps))
			for stepIndex, step := range def.Steps {
				stepIDs[step.ID] = fmt.Sprintf("t%d_s%d", hostIndex+1, stepIndex+1)
			}
			for _, original := range def.Steps {
				step := original
				step.ID = stepIDs[original.ID]
				step.Name = limitStepName(target + " · " + original.Name)
				step.Resource = target
				step.DependsOn = make([]string, len(original.DependsOn))
				for i, dependency := range original.DependsOn {
					step.DependsOn[i] = stepIDs[dependency]
				}
				resolved.Steps = append(resolved.Steps, step)
			}
		}
		return resolved, Validate(resolved)
	}
	if len(targets) != 0 {
		return Definition{}, errors.New("该工作流未启用运行时多选主机")
	}
	if def.TargetMode == "fixed" && (resource != "" || len(bindings) != 0) {
		return Definition{}, errors.New("固定目标工作流请先修改定义，再更换主机")
	}
	if resource != "" && len(bindings) != 0 {
		return Definition{}, errors.New("不能同时使用单主机参数和多资源绑定")
	}
	used := make(map[string]bool)
	keys := make(map[string]bool)
	for _, step := range def.Steps {
		keys[strings.TrimPrefix(step.Resource, "$")] = true
	}
	if resource != "" {
		if !validResourceReference(resource) || strings.HasPrefix(resource, "$") {
			return Definition{}, errors.New("运行目标必须是湖中已登记的资源名")
		}
		if len(keys) != 1 {
			return Definition{}, errors.New("该工作流使用多个资源；请按原资源名分别绑定目标")
		}
		for key := range keys {
			bindings = map[string]string{key: resource}
		}
	}
	resolved := def
	resolved.TargetMode = "fixed"
	resolved.Steps = append([]Step(nil), def.Steps...)
	for i := range resolved.Steps {
		step := &resolved.Steps[i]
		key := strings.TrimPrefix(step.Resource, "$")
		if target, ok := bindings[key]; ok {
			if !validResourceReference(target) || strings.HasPrefix(target, "$") {
				return Definition{}, fmt.Errorf("资源绑定 %q 的目标无效", key)
			}
			step.Resource = target
			used[key] = true
		} else if strings.HasPrefix(step.Resource, "$") {
			return Definition{}, fmt.Errorf("运行时需要提供资源绑定 %q", key)
		}
	}
	for key := range bindings {
		if !used[key] {
			return Definition{}, fmt.Errorf("资源绑定 %q 不对应任何工作流步骤", key)
		}
	}
	return resolved, Validate(resolved)
}

func limitStepName(name string) string {
	if len(name) <= 120 {
		return name
	}
	var result strings.Builder
	for _, r := range name {
		if result.Len()+len(string(r))+3 > 120 {
			break
		}
		result.WriteRune(r)
	}
	return result.String() + "..."
}
