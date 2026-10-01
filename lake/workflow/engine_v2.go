package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/cloudwego/eino/lake/store"
)

// ExecutorV2 is supplied by the Lake application. The engine owns ordering,
// snapshots, approvals and recovery, while each adapter rechecks its current
// resource/project authority immediately before doing work.
type ExecutorV2 interface {
	SSHCheck(context.Context, string, string) (any, error)
	SSHCommand(context.Context, string, string) (any, error)
	CodeTask(context.Context, string) (any, error)
	SpecialistTask(context.Context, string, string) (any, error)
	ToolCall(context.Context, string, map[string]any) (any, error)
}

type ApprovalV2 func(context.Context, NodeV2, json.RawMessage) (bool, error)

// ErrApprovalPending leaves a node durable in waiting_approval without treating
// missing unattended authorization as a denial.
var ErrApprovalPending = errors.New("工作流节点等待人工审批")

func StartV2(ctx context.Context, s *store.Store, saved store.WorkflowV2Definition, trigger string, executor ExecutorV2, approve ApprovalV2) (store.WorkflowV2Run, error) {
	if s == nil || executor == nil {
		return store.WorkflowV2Run{}, errors.New("工作流 v2 执行环境不完整")
	}
	var def DefinitionV2
	if err := json.Unmarshal(saved.Spec, &def); err != nil {
		return store.WorkflowV2Run{}, err
	}
	compiled, err := CompileV2(def)
	if err != nil {
		return store.WorkflowV2Run{}, err
	}
	if def.Name != saved.Name {
		return store.WorkflowV2Run{}, errors.New("工作流 v2 名称与保存记录不一致")
	}
	ids := make([]string, 0, len(compiled.Order))
	for _, node := range compiled.Order {
		ids = append(ids, node.ID)
	}
	run, err := s.CreateWorkflowV2Run(ctx, saved, trigger, ids)
	if err != nil {
		return run, err
	}
	if bound, ok := executor.(interface{ BindWorkflowRunID(string) }); ok {
		bound.BindWorkflowRunID(run.ID)
	}
	return executeV2(ctx, s, run, compiled, executor, approve)
}

func ResumeV2(ctx context.Context, s *store.Store, runID string, retryWrites bool, executor ExecutorV2, approve ApprovalV2) (store.WorkflowV2Run, error) {
	if s == nil || executor == nil {
		return store.WorkflowV2Run{}, errors.New("工作流 v2 执行环境不完整")
	}
	run, err := s.GetWorkflowV2Run(ctx, runID)
	if err != nil {
		return run, err
	}
	if bound, ok := executor.(interface{ BindWorkflowRunID(string) }); ok {
		bound.BindWorkflowRunID(run.ID)
	}
	if run.Status != "interrupted" && run.Status != "failed" && run.Status != "waiting_approval" {
		return run, errors.New("工作流 v2 只有中断、失败或等待审批时可恢复")
	}
	var def DefinitionV2
	if err := json.Unmarshal(run.Spec, &def); err != nil {
		return run, err
	}
	compiled, err := CompileV2(def)
	if err != nil {
		return run, err
	}
	byID := make(map[string]NodeV2, len(compiled.Order))
	for _, node := range compiled.Order {
		byID[node.ID] = node
	}
	// First mark every running node as uncertain. Inspect all of them before
	// deciding whether a write retry is permitted.
	for _, savedNode := range run.Nodes {
		node, exists := byID[savedNode.NodeID]
		if !exists {
			return run, errors.New("工作流 v2 快照包含未知节点")
		}
		if savedNode.Status == "running" {
			if _, err := s.TransitionWorkflowV2Node(ctx, store.WorkflowV2NodeChange{RunID: runID, NodeID: node.ID, From: "running", To: "unknown", ErrorCode: "interrupted"}); err != nil {
				return run, err
			}
		}
	}
	run, err = s.GetWorkflowV2Run(ctx, runID)
	if err != nil {
		return run, err
	}
	for _, savedNode := range run.Nodes {
		node := byID[savedNode.NodeID]
		if (savedNode.Status == "unknown" || savedNode.Status == "failed") && riskyV2(node) && !retryWrites {
			return run, fmt.Errorf("节点 %q 可能已有副作用；核对后使用 --retry-writes", node.ID)
		}
	}
	for _, savedNode := range run.Nodes {
		if savedNode.Status == "completed" || savedNode.Status == "pending" {
			continue
		}
		if _, err := s.TransitionWorkflowV2Node(ctx, store.WorkflowV2NodeChange{RunID: runID, NodeID: savedNode.NodeID, From: savedNode.Status, To: "pending", Input: json.RawMessage{}, Approval: json.RawMessage{}, Result: json.RawMessage{}}); err != nil {
			return run, err
		}
	}
	run, err = s.GetWorkflowV2Run(ctx, runID)
	if err != nil {
		return run, err
	}
	return executeV2(ctx, s, run, compiled, executor, approve)
}

func riskyV2(node NodeV2) bool { return node.Kind != "ssh_check" }

type resolvedV2Call struct {
	Target  string         `json:"target,omitempty"`
	Command string         `json:"command,omitempty"`
	Request string         `json:"request,omitempty"`
	Inputs  map[string]any `json:"inputs,omitempty"`
}

type resolvedV2Snapshot struct {
	Calls []resolvedV2Call `json:"calls"`
}
type settledV2 struct {
	node   NodeV2
	result any
	err    error
}

func executeV2(ctx context.Context, s *store.Store, run store.WorkflowV2Run, compiled CompiledV2, executor ExecutorV2, approve ApprovalV2) (store.WorkflowV2Run, error) {
	defer reportV2(context.WithoutCancel(ctx), executor, run.ID)
	if err := s.SetWorkflowV2RunStatus(ctx, run.ID, "running"); err != nil {
		return run, err
	}
	statuses := make(map[string]string, len(run.Nodes))
	outputs := make(map[string]any, len(run.Nodes))
	for _, node := range run.Nodes {
		statuses[node.NodeID] = node.Status
		if node.Status == "completed" && len(node.Result) > 0 {
			var value any
			if err := json.Unmarshal(node.Result, &value); err != nil {
				return run, err
			}
			outputs[node.NodeID] = value
		}
	}
	active := make(map[string]NodeV2)
	results := make(chan settledV2, len(compiled.Order))
	for countTerminal(statuses) < len(compiled.Order) {
		reportV2(ctx, executor, run.ID)
		launched := false
		if ctx.Err() == nil {
			for _, node := range compiled.Order {
				if statuses[node.ID] != "pending" || len(active) >= compiled.MaxParallel {
					continue
				}
				ready, shouldRun := dependencyDecisionV2(node, statuses)
				if !ready {
					continue
				}
				if !shouldRun {
					if _, err := s.TransitionWorkflowV2Node(ctx, store.WorkflowV2NodeChange{RunID: run.ID, NodeID: node.ID, From: "pending", To: "skipped", ErrorCode: "condition_false"}); err != nil {
						return run, err
					}
					statuses[node.ID] = "skipped"
					launched = true
					continue
				}
				snapshot, err := resolveV2Snapshot(node, outputs)
				if err != nil {
					if _, storeErr := s.TransitionWorkflowV2Node(ctx, store.WorkflowV2NodeChange{RunID: run.ID, NodeID: node.ID, From: "pending", To: "failed", ErrorCode: "input_unavailable"}); storeErr != nil {
						return run, storeErr
					}
					statuses[node.ID] = "failed"
					launched = true
					continue
				}
				input, err := json.Marshal(snapshot)
				if err != nil {
					return run, err
				}
				if riskyV2(node) {
					if _, err := s.TransitionWorkflowV2Node(ctx, store.WorkflowV2NodeChange{RunID: run.ID, NodeID: node.ID, From: "pending", To: "waiting_approval", Input: input}); err != nil {
						return run, err
					}
					statuses[node.ID] = "waiting_approval"
					launched = true
					if approve == nil {
						continue
					}
					allowed, approvalErr := approve(ctx, node, input)
					if errors.Is(approvalErr, ErrApprovalPending) {
						continue
					}
					outcome := "allow"
					if !allowed || approvalErr != nil {
						outcome = "deny"
					}
					approval, _ := json.Marshal(map[string]string{"outcome": outcome})
					if outcome == "deny" {
						if _, err := s.TransitionWorkflowV2Node(ctx, store.WorkflowV2NodeChange{RunID: run.ID, NodeID: node.ID, From: "waiting_approval", To: "failed", Approval: approval, ErrorCode: "approval_denied"}); err != nil {
							return run, err
						}
						statuses[node.ID] = "failed"
						continue
					}
					if _, err := s.TransitionWorkflowV2Node(ctx, store.WorkflowV2NodeChange{RunID: run.ID, NodeID: node.ID, From: "waiting_approval", To: "running", Approval: approval}); err != nil {
						return run, err
					}
				} else {
					if _, err := s.TransitionWorkflowV2Node(ctx, store.WorkflowV2NodeChange{RunID: run.ID, NodeID: node.ID, From: "pending", To: "running", Input: input}); err != nil {
						return run, err
					}
				}
				reportV2(ctx, executor, run.ID)
				statuses[node.ID] = "running"
				active[node.ID] = node
				launched = true
				go func(node NodeV2, snapshot resolvedV2Snapshot) {
					result, err := dispatchV2(ctx, node, snapshot, executor)
					results <- settledV2{node: node, result: result, err: err}
				}(node, snapshot)
			}
		}
		if len(active) == 0 {
			if ctx.Err() != nil {
				break
			}
			waiting := false
			for _, status := range statuses {
				if status == "waiting_approval" {
					waiting = true
					break
				}
			}
			if waiting {
				if err := s.SetWorkflowV2RunStatus(ctx, run.ID, "waiting_approval"); err != nil {
					return run, err
				}
				return s.GetWorkflowV2Run(ctx, run.ID)
			}
			if !launched {
				return run, errors.New("工作流 v2 依赖图无法推进")
			}
			continue
		}
		select {
		case settled := <-results:
			delete(active, settled.node.ID)
			status, code := "completed", ""
			var resultJSON json.RawMessage
			if settled.err != nil {
				status, code = "failed", "executor_error"
				if errors.Is(settled.err, ErrExecutionUnknown) {
					status, code = "unknown", "execution_unknown"
				}
			} else {
				encoded, err := json.Marshal(settled.result)
				if err != nil || len(encoded) > 64*1024 || !literalMatches(resultTypeV2(settled.node), normalizeJSONV2(encoded)) {
					status, code = "failed", "result_invalid"
				} else {
					resultJSON = encoded
				}
			}
			if ctx.Err() != nil {
				status = "cancelled"
				if riskyV2(settled.node) {
					status = "unknown"
				}
				code = "interrupted"
				resultJSON = nil
			}
			if _, err := transitionV2Final(s, run.ID, settled.node.ID, status, resultJSON, code); err != nil {
				return run, err
			}
			statuses[settled.node.ID] = status
			if status == "completed" {
				outputs[settled.node.ID] = normalizeJSONV2(resultJSON)
			}
		case <-ctx.Done():
			for _, node := range active {
				status := "cancelled"
				if riskyV2(node) {
					status = "unknown"
				}
				if _, err := transitionV2Final(s, run.ID, node.ID, status, nil, "interrupted"); err != nil {
					return run, err
				}
				statuses[node.ID] = status
			}
			clear(active)
		}
	}
	if ctx.Err() != nil {
		for _, node := range compiled.Order {
			if statuses[node.ID] != "pending" && statuses[node.ID] != "waiting_approval" {
				continue
			}
			if _, err := s.TransitionWorkflowV2Node(context.Background(), store.WorkflowV2NodeChange{RunID: run.ID, NodeID: node.ID, From: statuses[node.ID], To: "cancelled", ErrorCode: "interrupted"}); err != nil {
				return run, err
			}
			statuses[node.ID] = "cancelled"
		}
		if err := s.SetWorkflowV2RunStatus(context.Background(), run.ID, "interrupted"); err != nil {
			return run, err
		}
		return s.GetWorkflowV2Run(context.Background(), run.ID)
	}
	final := "completed"
	for _, status := range statuses {
		if status == "failed" || status == "unknown" {
			final = "failed"
			break
		}
	}
	if err := s.SetWorkflowV2RunStatus(ctx, run.ID, final); err != nil {
		return run, err
	}
	return s.GetWorkflowV2Run(ctx, run.ID)
}

func transitionV2Final(s *store.Store, runID, nodeID, status string, result json.RawMessage, code string) (store.WorkflowV2Node, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return s.TransitionWorkflowV2Node(ctx, store.WorkflowV2NodeChange{RunID: runID, NodeID: nodeID, From: "running", To: status, Result: result, ErrorCode: code})
}

func dependencyDecisionV2(node NodeV2, statuses map[string]string) (bool, bool) {
	if len(node.DependsOn) == 0 {
		return true, true
	}
	allSuccess, anyFailure := true, false
	for _, dep := range node.DependsOn {
		status := statuses[dep]
		if !terminalStep(status) {
			return false, false
		}
		if status != "completed" {
			allSuccess = false
		}
		if status == "failed" || status == "unknown" {
			anyFailure = true
		}
	}
	switch node.When {
	case "always":
		return true, true
	case "any_failure":
		return true, anyFailure
	default:
		return true, allSuccess
	}
}

func resultTypeV2(node NodeV2) string {
	if node.ForEach != nil {
		return "array"
	}
	kind, _ := nodeOutputType(node)
	return kind
}

func normalizeJSONV2(raw []byte) any { var value any; _ = json.Unmarshal(raw, &value); return value }

func resolveV2Snapshot(node NodeV2, outputs map[string]any) (resolvedV2Snapshot, error) {
	var items []any
	if node.ForEach != nil {
		source, err := resolveV2Reference(node.ForEach.Ref, outputs)
		if err != nil {
			return resolvedV2Snapshot{}, err
		}
		var ok bool
		items, ok = source.([]any)
		if !ok || len(items) > node.ForEach.MaxItems {
			return resolvedV2Snapshot{}, errors.New("扇出来源类型或数量无效")
		}
		for _, item := range items {
			if node.ForEach.ElementType != "" && !literalMatches(node.ForEach.ElementType, item) {
				return resolvedV2Snapshot{}, errors.New("扇出元素类型无效")
			}
		}
	} else {
		items = []any{nil}
	}
	snapshot := resolvedV2Snapshot{Calls: make([]resolvedV2Call, 0, len(items))}
	for _, item := range items {
		var call resolvedV2Call
		if node.Target != nil {
			value, err := resolveV2Value(*node.Target, item, outputs)
			if err != nil {
				return snapshot, err
			}
			call.Target = value.(string)
			if !validResourceReference(call.Target) || strings.HasPrefix(call.Target, "$") {
				return snapshot, errors.New("目标资源无效")
			}
		}
		if node.Command != nil {
			value, err := resolveV2Value(*node.Command, item, outputs)
			if err != nil {
				return snapshot, err
			}
			call.Command = value.(string)
			if strings.TrimSpace(call.Command) == "" || len(call.Command) > 2048 || strings.ContainsAny(call.Command, "\x00\n\r") {
				return snapshot, errors.New("SSH 命令无效")
			}
		}
		if node.Request != nil {
			value, err := resolveV2Value(*node.Request, item, outputs)
			if err != nil {
				return snapshot, err
			}
			call.Request = value.(string)
			if strings.TrimSpace(call.Request) == "" || len(call.Request) > 8192 {
				return snapshot, errors.New("专员请求无效")
			}
		}
		if node.Kind == "tool_call" {
			call.Inputs = make(map[string]any, len(node.Inputs))
			for key, value := range node.Inputs {
				resolved, err := resolveV2Value(value, item, outputs)
				if err != nil {
					return snapshot, err
				}
				call.Inputs[key] = resolved
			}
		}
		snapshot.Calls = append(snapshot.Calls, call)
	}
	return snapshot, nil
}

func resolveV2Value(value ValueV2, item any, outputs map[string]any) (any, error) {
	var resolved any
	if value.Item {
		resolved = item
	} else if value.Ref != nil {
		var err error
		resolved, err = resolveV2Reference(*value.Ref, outputs)
		if err != nil {
			return nil, err
		}
	} else {
		resolved = value.Literal
	}
	if !literalMatches(value.Type, resolved) {
		return nil, errors.New("运行时结果引用类型不匹配")
	}
	return resolved, nil
}

func resolveV2Reference(ref ResultRefV2, outputs map[string]any) (any, error) {
	value, exists := outputs[ref.Node]
	if !exists {
		return nil, errors.New("引用的节点结果尚未提交")
	}
	if ref.Path == "" {
		return value, nil
	}
	for _, part := range strings.Split(strings.TrimPrefix(ref.Path, "/"), "/") {
		part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
		switch current := value.(type) {
		case map[string]any:
			next, ok := current[part]
			if !ok {
				return nil, errors.New("结果引用路径不存在")
			}
			value = next
		case []any:
			index, err := strconv.Atoi(part)
			if err != nil || index < 0 || index >= len(current) {
				return nil, errors.New("结果引用数组索引无效")
			}
			value = current[index]
		default:
			return nil, errors.New("结果引用路径类型无效")
		}
	}
	return value, nil
}

func dispatchV2(ctx context.Context, node NodeV2, snapshot resolvedV2Snapshot, executor ExecutorV2) (any, error) {
	results := make([]any, 0, len(snapshot.Calls))
	for callIndex, call := range snapshot.Calls {
		callCtx := context.WithValue(ctx, specialistTaskKey{}, fmt.Sprintf("%s:%d", node.ID, callIndex))
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var result any
		var err error
		switch node.Kind {
		case "ssh_check":
			result, err = executor.SSHCheck(callCtx, call.Target, node.Check)
		case "ssh_command":
			result, err = executor.SSHCommand(callCtx, call.Target, call.Command)
		case "code_task":
			result, err = executor.CodeTask(callCtx, call.Request)
		case "specialist_task":
			result, err = executor.SpecialistTask(callCtx, node.Specialist, call.Request)
		case "tool_call":
			result, err = executor.ToolCall(callCtx, node.Tool, call.Inputs)
		default:
			return nil, fmt.Errorf("未知工作流 v2 节点类型: %s", node.Kind)
		}
		if err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	if node.ForEach != nil {
		return results, nil
	}
	if len(results) != 1 {
		return nil, errors.New("工作流 v2 节点没有结果")
	}
	return results[0], nil
}

func reportV2(ctx context.Context, executor ExecutorV2, runID string) {
	if reporter, ok := executor.(interface{ ReportWorkflowV2(context.Context, string) }); ok {
		reporter.ReportWorkflowV2(ctx, runID)
	}
}

type specialistTaskKey struct{}

func SpecialistTaskKey(ctx context.Context) string {
	value, _ := ctx.Value(specialistTaskKey{}).(string)
	return value
}
