package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/lake/code"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/lake/workflow"
)

type workflowV2ToolRuntime struct {
	Model     model.BaseChatModel
	ModelID   string
	Workspace *code.Workspace
	Approve   func(string, string, string) (bool, error)
}

type workflowV2SpecInput struct {
	DefinitionJSON string `json:"definition_json" jsonschema:"description=完整的 v2 工作流 JSON 定义"`
}
type workflowV2AmendInput struct {
	ID             string `json:"id" jsonschema:"description=当前湖 v2 工作流 ID"`
	DefinitionJSON string `json:"definition_json" jsonschema:"description=更新后的完整 v2 JSON 定义"`
}
type workflowV2IDInput struct {
	ID string `json:"id" jsonschema:"description=工作流 ID 或当前湖内唯一名称"`
}
type workflowV2ResumeInput struct {
	RunID       string `json:"run_id" jsonschema:"description=v2 运行 ID"`
	RetryWrites bool   `json:"retry_writes,omitempty" jsonschema:"description=核对外部副作用后才可显式重试未知写节点"`
}
type workflowV2ToolOutput struct {
	ID       string                  `json:"id,omitempty"`
	Name     string                  `json:"name,omitempty"`
	Revision int                     `json:"revision,omitempty"`
	Status   string                  `json:"status,omitempty"`
	Preview  *workflowV2Preview      `json:"preview,omitempty"`
	Nodes    []workflowV2NodeStatus  `json:"nodes,omitempty"`
	Events   []store.WorkflowV2Event `json:"events,omitempty"`
	Error    string                  `json:"error,omitempty"`
}
type workflowV2NodeStatus struct {
	ID        string          `json:"id"`
	Status    string          `json:"status"`
	ErrorCode string          `json:"error_code,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
}

func workflowV2ToolRun(run store.WorkflowV2Run) workflowV2ToolOutput {
	out := workflowV2ToolOutput{ID: run.ID, Name: run.Name, Revision: run.Revision, Status: run.Status, Nodes: make([]workflowV2NodeStatus, 0, len(run.Nodes))}
	// Leave room for JSON escaping and node metadata within the tool's 64 KiB
	// output limit, even when a workflow fans out to many node results.
	resultBudget := 24000
	for _, node := range run.Nodes {
		result := node.Result
		limit := min(6000, resultBudget/max(1, len(run.Nodes)-len(out.Nodes)))
		if len(result) > limit {
			b, _ := json.Marshal(map[string]any{"preview": strings.ToValidUTF8(string(result[:limit]), "�"), "truncated": true})
			result = b
		}
		resultBudget = max(0, resultBudget-len(result))
		out.Nodes = append(out.Nodes, workflowV2NodeStatus{ID: node.NodeID, Status: node.Status, ErrorCode: node.ErrorCode, Result: result})
	}
	return out
}

func parseWorkflowV2Tool(text string) (workflow.CompiledV2, json.RawMessage, error) {
	def, err := workflow.ParseV2([]byte(text))
	if err != nil {
		return workflow.CompiledV2{}, nil, err
	}
	compiled, err := workflow.CompileV2(def)
	if err != nil {
		return workflow.CompiledV2{}, nil, err
	}
	canonical, err := json.Marshal(def)
	return compiled, canonical, err
}

func resolveWorkflowV2(ctx context.Context, s *store.Store, lakeID, id string) (store.WorkflowV2Definition, error) {
	if item, err := s.GetWorkflowV2(ctx, id); err == nil {
		if item.LakeID != lakeID {
			return item, errors.New("工作流不属于当前湖")
		}
		return item, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return store.WorkflowV2Definition{}, err
	}
	items, err := s.ListWorkflowsV2(ctx, lakeID)
	if err != nil {
		return store.WorkflowV2Definition{}, err
	}
	for _, item := range items {
		if item.Name == strings.TrimSpace(id) {
			return item, nil
		}
	}
	return store.WorkflowV2Definition{}, store.ErrNotFound
}

func newWorkflowV2Tools(s *store.Store, service *operate.Service, approve func(string, string, string) (bool, error), runtime workflowV2ToolRuntime) ([]tool.BaseTool, error) {
	validate, err := utils.InferTool[workflowV2SpecInput, workflowV2ToolOutput]("lake_workflow_v2_validate", "静态校验 v2 工作流 JSON 的节点、类型、依赖与界限；无副作用。", func(ctx context.Context, in workflowV2SpecInput) (workflowV2ToolOutput, error) {
		compiled, _, err := parseWorkflowV2Tool(in.DefinitionJSON)
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		preview, err := previewWorkflowV2(ctx, s, "", compiled)
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		return workflowV2ToolOutput{Name: compiled.Definition.Name, Preview: &preview}, nil
	})
	if err != nil {
		return nil, err
	}
	dryRun, err := utils.InferTool[workflowV2SpecInput, workflowV2ToolOutput]("lake_workflow_v2_dry_run", "预演当前湖 v2 工作流：节点顺序、目标、权限、估算模型调用；不执行工具。", func(ctx context.Context, in workflowV2SpecInput) (workflowV2ToolOutput, error) {
		compiled, _, err := parseWorkflowV2Tool(in.DefinitionJSON)
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		preview, err := previewWorkflowV2(ctx, s, service.Lake.ID, compiled)
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		return workflowV2ToolOutput{Name: compiled.Definition.Name, Preview: &preview}, nil
	})
	if err != nil {
		return nil, err
	}
	save, err := utils.InferTool[workflowV2SpecInput, workflowV2ToolOutput]("lake_workflow_v2_save", "经用户批准，在当前湖保存完整 v2 工作流定义；不会执行。", func(ctx context.Context, in workflowV2SpecInput) (workflowV2ToolOutput, error) {
		compiled, canonical, err := parseWorkflowV2Tool(in.DefinitionJSON)
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		if _, err = previewWorkflowV2(ctx, s, service.Lake.ID, compiled); err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		path := service.Lake.Name + "/" + compiled.Definition.Name
		if err = authorizeToolAction(ctx, service.Lake.ID, "", "lake_workflow_v2_save", "workflow", path, "workflow", string(canonical), approve); err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		item, err := s.CreateWorkflowV2(ctx, service.Lake.ID, compiled.Definition.Name, compiled.Definition.Description, canonical)
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		return workflowV2ToolOutput{ID: item.ID, Name: item.Name, Revision: item.Revision}, nil
	})
	if err != nil {
		return nil, err
	}
	amend, err := utils.InferTool[workflowV2AmendInput, workflowV2ToolOutput]("lake_workflow_v2_amend", "经用户批准，按 ID 更新当前湖 v2 工作流完整定义；历史运行快照不变。", func(ctx context.Context, in workflowV2AmendInput) (workflowV2ToolOutput, error) {
		prior, err := resolveWorkflowV2(ctx, s, service.Lake.ID, in.ID)
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		compiled, canonical, err := parseWorkflowV2Tool(in.DefinitionJSON)
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		if _, err = previewWorkflowV2(ctx, s, service.Lake.ID, compiled); err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		path := service.Lake.Name + "/" + prior.Name
		if err = authorizeToolAction(ctx, service.Lake.ID, "", "lake_workflow_v2_amend", "workflow", path, "workflow", string(canonical), approve); err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		item, err := s.UpdateWorkflowV2(ctx, prior.ID, compiled.Definition.Name, compiled.Definition.Description, canonical)
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		return workflowV2ToolOutput{ID: item.ID, Name: item.Name, Revision: item.Revision}, nil
	})
	if err != nil {
		return nil, err
	}
	startOrResume := func(ctx context.Context, item store.WorkflowV2Definition, runID string, retry bool) (workflowV2ToolOutput, error) {
		ssh, err := operate.NewServiceForLake(ctx, s, service.Lake.Name)
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		defer ssh.CloseSessions()
		ssh.Anchors = make(map[string]struct{}, len(service.Anchors))
		for id := range service.Anchors {
			ssh.Anchors[id] = struct{}{}
		}
		ssh.Confirm = service.Confirm
		executor := &workflowV2Executor{store: s, service: ssh, workspace: runtime.Workspace, model: runtime.Model, modelID: runtime.ModelID, approve: approve, retryWrites: retry}
		defer executor.Close()
		var approval workflow.ApprovalV2
		if approve != nil {
			approval = func(_ context.Context, node workflow.NodeV2, input json.RawMessage) (bool, error) {
				digest := sha256.Sum256(input)
				return approve("workflow", service.Lake.Name+"/"+node.ID, fmt.Sprintf("v2 %s %s input_sha256=%x", node.Kind, node.ID, digest))
			}
		}
		var run store.WorkflowV2Run
		if runID == "" {
			run, err = workflow.StartV2(ctx, s, item, "agent", executor, approval)
		} else {
			run, err = workflow.ResumeV2(ctx, s, runID, retry, executor, approval)
		}
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		return workflowV2ToolRun(run), nil
	}
	runTool, err := utils.InferTool[workflowV2IDInput, workflowV2ToolOutput]("lake_workflow_v2_run", "经用户批准，运行当前湖已保存的 v2 工作流；各风险节点仍逐项审批。", func(ctx context.Context, in workflowV2IDInput) (workflowV2ToolOutput, error) {
		item, err := resolveWorkflowV2(ctx, s, service.Lake.ID, in.ID)
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		if err = authorizeToolAction(ctx, service.Lake.ID, "", "lake_workflow_v2_run", "workflow", service.Lake.Name+"/"+item.Name, "workflow", item.ID, approve); err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		return startOrResume(ctx, item, "", false)
	})
	if err != nil {
		return nil, err
	}
	status, err := utils.InferTool[workflowV2ResumeInput, workflowV2ToolOutput]("lake_workflow_v2_status", "查询当前湖 v2 工作流运行的节点状态，不返回输入快照。", func(ctx context.Context, in workflowV2ResumeInput) (workflowV2ToolOutput, error) {
		run, err := s.GetWorkflowV2Run(ctx, in.RunID)
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		if run.LakeID != service.Lake.ID {
			return workflowV2ToolOutput{Error: "运行不属于当前湖"}, nil
		}
		return workflowV2ToolRun(run), nil
	})
	if err != nil {
		return nil, err
	}
	events, err := utils.InferTool[workflowV2ResumeInput, workflowV2ToolOutput]("lake_workflow_v2_events", "查询当前湖 v2 工作流的状态事件，不返回原始输入。", func(ctx context.Context, in workflowV2ResumeInput) (workflowV2ToolOutput, error) {
		run, err := s.GetWorkflowV2Run(ctx, in.RunID)
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		if run.LakeID != service.Lake.ID {
			return workflowV2ToolOutput{Error: "运行不属于当前湖"}, nil
		}
		list, err := s.ListWorkflowV2Events(ctx, run.ID)
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		return workflowV2ToolOutput{ID: run.ID, Events: list}, nil
	})
	if err != nil {
		return nil, err
	}
	resume, err := utils.InferTool[workflowV2ResumeInput, workflowV2ToolOutput]("lake_workflow_v2_resume", "恢复等待审批、失败或中断的 v2 工作流；未知写操作须先核对外部状态并显式 retry_writes。", func(ctx context.Context, in workflowV2ResumeInput) (workflowV2ToolOutput, error) {
		run, err := s.GetWorkflowV2Run(ctx, in.RunID)
		if err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		if run.LakeID != service.Lake.ID {
			return workflowV2ToolOutput{Error: "运行不属于当前湖"}, nil
		}
		if err = authorizeToolAction(ctx, service.Lake.ID, "", "lake_workflow_v2_resume", "workflow", service.Lake.Name+"/"+run.Name, "workflow", fmt.Sprintf("run=%s retry_writes=%t", run.ID, in.RetryWrites), approve); err != nil {
			return workflowV2ToolOutput{Error: err.Error()}, nil
		}
		return startOrResume(ctx, store.WorkflowV2Definition{}, run.ID, in.RetryWrites)
	})
	if err != nil {
		return nil, err
	}
	return []tool.BaseTool{validate, dryRun, save, amend, runTool, status, events, resume}, nil
}
