package workflow

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var workflowToolName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,127}$`)

type CompiledV2 struct {
	Definition  DefinitionV2 `json:"definition"`
	Order       []NodeV2     `json:"order"`
	MaxParallel int          `json:"max_parallel"`
	MaxExpanded int          `json:"max_expanded"`
}

// CompileV2 performs only static checks. It does not load resources, invoke
// tools, approve operations or mutate the v1 workflow engine.
func CompileV2(def DefinitionV2) (CompiledV2, error) {
	if def.Version != 2 || strings.TrimSpace(def.Name) == "" || len(def.Name) > 120 || strings.ContainsAny(def.Name, "\x00\n\r") || len(def.Description) > 2000 {
		return CompiledV2{}, errors.New("工作流 v2 标识或说明无效")
	}
	if len(def.Nodes) == 0 || len(def.Nodes) > 32 {
		return CompiledV2{}, errors.New("工作流 v2 需要 1–32 个节点")
	}
	parallel := def.MaxParallel
	if parallel == 0 {
		parallel = 4
	}
	if parallel < 1 || parallel > 4 {
		return CompiledV2{}, errors.New("工作流 v2 最大并行数必须为 1–4")
	}
	byID := make(map[string]NodeV2, len(def.Nodes))
	outputs := make(map[string]string, len(def.Nodes))
	maxExpanded := 0
	for _, node := range def.Nodes {
		if !stepIDPattern.MatchString(node.ID) || len(node.Name) > 120 {
			return CompiledV2{}, fmt.Errorf("工作流 v2 节点 ID 或名称无效: %q", node.ID)
		}
		if _, exists := byID[node.ID]; exists {
			return CompiledV2{}, fmt.Errorf("工作流 v2 节点 ID 重复: %q", node.ID)
		}
		if node.When != "" && node.When != "all_success" && node.When != "any_failure" && node.When != "always" {
			return CompiledV2{}, fmt.Errorf("节点 %q 条件无效", node.ID)
		}
		if node.When == "any_failure" && len(node.DependsOn) == 0 {
			return CompiledV2{}, fmt.Errorf("节点 %q 的失败条件没有依赖", node.ID)
		}
		output, err := nodeOutputType(node)
		if err != nil {
			return CompiledV2{}, fmt.Errorf("节点 %q: %w", node.ID, err)
		}
		if node.ForEach != nil {
			if node.ForEach.MaxItems < 1 || node.ForEach.MaxItems > 32 {
				return CompiledV2{}, fmt.Errorf("节点 %q 扇出上限必须为 1–32", node.ID)
			}
			if node.ForEach.ElementType != "" && !validValueType(node.ForEach.ElementType) {
				return CompiledV2{}, fmt.Errorf("节点 %q 扇出元素类型无效", node.ID)
			}
			maxExpanded += node.ForEach.MaxItems
			output = "array"
		} else {
			maxExpanded++
		}
		byID[node.ID], outputs[node.ID] = node, output
	}
	if maxExpanded > 32 {
		return CompiledV2{}, errors.New("工作流 v2 最坏情况下展开节点超过 32")
	}
	for _, node := range def.Nodes {
		deps := make(map[string]bool, len(node.DependsOn))
		for _, dep := range node.DependsOn {
			if dep == node.ID || deps[dep] {
				return CompiledV2{}, fmt.Errorf("节点 %q 依赖重复或指向自身", node.ID)
			}
			if _, exists := byID[dep]; !exists {
				return CompiledV2{}, fmt.Errorf("节点 %q 依赖不存在: %q", node.ID, dep)
			}
			deps[dep] = true
		}
		if err := validateNodeInputs(node, deps, outputs); err != nil {
			return CompiledV2{}, fmt.Errorf("节点 %q: %w", node.ID, err)
		}
	}
	state := make(map[string]uint8, len(def.Nodes))
	order := make([]NodeV2, 0, len(def.Nodes))
	var visit func(string) error
	visit = func(id string) error {
		if state[id] == 1 {
			return fmt.Errorf("工作流 v2 存在依赖环: %q", id)
		}
		if state[id] == 2 {
			return nil
		}
		state[id] = 1
		for _, dep := range byID[id].DependsOn {
			if err := visit(dep); err != nil {
				return err
			}
		}
		state[id] = 2
		order = append(order, byID[id])
		return nil
	}
	for _, node := range def.Nodes {
		if err := visit(node.ID); err != nil {
			return CompiledV2{}, err
		}
	}
	return CompiledV2{Definition: def, Order: order, MaxParallel: parallel, MaxExpanded: maxExpanded}, nil
}

func nodeOutputType(node NodeV2) (string, error) {
	fixed := ""
	switch node.Kind {
	case "ssh_check":
		fixed = "string"
		if node.Target == nil || !readChecks[node.Check] || node.Command != nil || node.Request != nil || node.Specialist != "" || node.Tool != "" || len(node.Inputs) != 0 {
			return "", errors.New("SSH 检查节点字段无效")
		}
	case "ssh_command":
		fixed = "object"
		if node.Target == nil || node.Command == nil || node.Check != "" || node.Request != nil || node.Specialist != "" || node.Tool != "" || len(node.Inputs) != 0 {
			return "", errors.New("SSH 命令节点字段无效")
		}
	case "code_task":
		fixed = "string"
		if node.Request == nil || node.Target != nil || node.Command != nil || node.Check != "" || node.Specialist != "" || node.Tool != "" || len(node.Inputs) != 0 {
			return "", errors.New("代码专员节点字段无效")
		}
	case "specialist_task":
		fixed = "string"
		if node.Request == nil || !workflowToolName.MatchString(node.Specialist) || node.Target != nil || node.Command != nil || node.Check != "" || node.Tool != "" || len(node.Inputs) != 0 {
			return "", errors.New("专员节点字段无效")
		}
	case "tool_call":
		if !workflowToolName.MatchString(node.Tool) || node.Target != nil || node.Command != nil || node.Request != nil || node.Check != "" || node.Specialist != "" || !validValueType(node.OutputType) || len(node.Inputs) > 32 {
			return "", errors.New("工具调用节点字段无效")
		}
		for key := range node.Inputs {
			if !workflowToolName.MatchString(key) {
				return "", errors.New("工具输入名称无效")
			}
		}
		return node.OutputType, nil
	default:
		return "", errors.New("仅支持 ssh_check、ssh_command、code_task、specialist_task、tool_call")
	}
	if node.OutputType != "" && node.OutputType != fixed {
		return "", errors.New("节点输出类型与类型约定不符")
	}
	return fixed, nil
}

func validateNodeInputs(node NodeV2, deps map[string]bool, outputs map[string]string) error {
	for label, value := range map[string]*ValueV2{"target": node.Target, "command": node.Command, "request": node.Request} {
		if value == nil {
			continue
		}
		if err := validateValue(*value, "string", deps, outputs, node.ForEach); err != nil {
			return fmt.Errorf("%s: %w", label, err)
		}
		if value.Literal != nil {
			literal := value.Literal.(string)
			if label == "target" && (!validResourceReference(literal) || strings.HasPrefix(literal, "$")) {
				return errors.New("SSH 目标资源无效")
			}
			if label == "command" && (strings.TrimSpace(literal) == "" || len(literal) > 2048 || strings.ContainsAny(literal, "\x00\n\r")) {
				return errors.New("SSH 命令无效")
			}
			if label == "request" && (strings.TrimSpace(literal) == "" || len(literal) > 8192) {
				return errors.New("专员请求无效")
			}
		}
	}
	for key, value := range node.Inputs {
		if err := validateValue(value, "", deps, outputs, node.ForEach); err != nil {
			return fmt.Errorf("输入 %q: %w", key, err)
		}
	}
	if node.ForEach != nil {
		if err := validateReference(node.ForEach.Ref, "array", deps, outputs); err != nil {
			return fmt.Errorf("扇出来源: %w", err)
		}
	}
	return nil
}

func validateValue(value ValueV2, expected string, deps map[string]bool, outputs map[string]string, each *ForEachV2) error {
	if !validValueType(value.Type) || expected != "" && value.Type != expected {
		return errors.New("输入类型无效")
	}
	choices := 0
	if value.Literal != nil {
		choices++
	}
	if value.Ref != nil {
		choices++
	}
	if value.Item {
		choices++
	}
	if choices != 1 {
		return errors.New("输入必须且只能是字面量或结果引用")
	}
	if value.Item {
		if each == nil || each.ElementType == "" || value.Type != each.ElementType {
			return errors.New("扇出元素类型不匹配")
		}
		return nil
	}
	if value.Ref != nil {
		return validateReference(*value.Ref, value.Type, deps, outputs)
	}
	if !literalMatches(value.Type, value.Literal) {
		return errors.New("字面量与声明类型不符")
	}
	return nil
}

func validateReference(ref ResultRefV2, expected string, deps map[string]bool, outputs map[string]string) error {
	if ref.Node == "" || !deps[ref.Node] || !validJSONPointer(ref.Path) || ref.Type != expected {
		return errors.New("结果引用未声明依赖或类型不匹配")
	}
	source := outputs[ref.Node]
	if ref.Path == "" {
		if source != expected {
			return errors.New("结果引用来源类型不匹配")
		}
	} else if source != "object" && source != "array" {
		return errors.New("结果引用路径需要对象或数组来源")
	}
	return nil
}
