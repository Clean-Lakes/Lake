package main

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/lake/workflow"
)

type workflowCreateInput struct {
	Name          string          `json:"name" jsonschema:"description=工作流名称，当前湖内唯一"`
	Description   string          `json:"description,omitempty" jsonschema:"description=运维目标与预期结果"`
	TargetMode    string          `json:"target_mode" jsonschema:"description=必填目标模式：fixed 创建时固定主机且运行无需选择；single 运行时单选；multiple 运行时多选并对每台主机执行完整步骤图"`
	ExecutionMode string          `json:"execution_mode,omitempty" jsonschema:"description=adaptive默认模型诊断恢复；fixed显式固定执行"`
	Steps         []workflow.Step `json:"steps" jsonschema:"description=步骤列表；resource 可为当前湖的资源名或 $host 等运行时占位符"`
}

type workflowUpdateInput struct {
	CurrentName   string          `json:"current_name" jsonschema:"description=当前湖已保存的工作流名称"`
	Name          string          `json:"name" jsonschema:"description=更新后的工作流名称"`
	Description   string          `json:"description,omitempty" jsonschema:"description=更新后的完整描述"`
	TargetMode    string          `json:"target_mode,omitempty" jsonschema:"description=更新后的目标模式：fixed、single、multiple；未指定则沿用旧工作流模式"`
	ExecutionMode string          `json:"execution_mode,omitempty" jsonschema:"description=adaptive或fixed；未指定沿用旧模式"`
	Steps         []workflow.Step `json:"steps" jsonschema:"description=更新后的完整步骤列表；未改变的步骤也须包含"`
}

type workflowRunInput struct {
	Name     string            `json:"name" jsonschema:"description=当前湖中的工作流名称"`
	Resource string            `json:"resource,omitempty" jsonschema:"description=single 模式本次运行选择的一个已登记资源名；旧固定单主机工作流也可临时覆盖目标"`
	Bindings map[string]string `json:"bindings,omitempty" jsonschema:"description=旧工作流不同步骤资源的映射，键为占位符名或原固定资源名，值为当前湖已登记资源名；不是运行时多选主机"`
	Targets  []string          `json:"targets,omitempty" jsonschema:"description=target_mode=multiple 时本次运行选择的多个当前湖已登记资源名；每台主机执行完整步骤图"`
}

type workflowStatusInput struct {
	RunID string `json:"run_id" jsonschema:"description=工作流运行 ID"`
}

type workflowOutput struct {
	Workflow *store.WorkflowDefinition  `json:"workflow,omitempty"`
	Run      *store.WorkflowRun         `json:"run,omitempty"`
	Items    []store.WorkflowDefinition `json:"items,omitempty"`
	Error    string                     `json:"error,omitempty"`
}

func newWorkflowTools(s *store.Store, service *operate.Service, progress workflow.Reporter, approve func(string, string, string) (bool, error), v2Runtime ...workflowV2ToolRuntime) ([]tool.BaseTool, error) {
	list, err := utils.InferTool[struct{}, workflowOutput]("lake_workflow_list", "列出当前湖已保存的运维工作流及步骤定义。只返回真实记录。", func(ctx context.Context, _ struct{}) (workflowOutput, error) {
		items, err := s.ListWorkflows(ctx, service.Lake.Name)
		if err != nil {
			return workflowOutput{Error: err.Error()}, nil
		}
		return workflowOutput{Items: items}, nil
	})
	if err != nil {
		return nil, err
	}
	create, err := utils.InferTool[workflowCreateInput, workflowOutput]("lake_workflow_create", "在当前湖保存运维工作流，不立即运行。target_mode=fixed使用固定资源；single单选；multiple多选每台执行整套步骤。复杂操作使用kind=ssh_task并填写goal（目标、限制、验证标准），专员根据实际结果决定执行方法；简单已知步骤用ssh_check或ssh_command，命令明确失败时默认模型诊断恢复。全盘du/find等长扫描步骤设置timeout_seconds=300，多个扫描用depends_on串行，结果未知不得自动重放。execution_mode=fixed可显式关闭恢复。检查项仅hostname、uptime、os、cpu、disk、memory。", func(ctx context.Context, in workflowCreateInput) (workflowOutput, error) {
		if in.TargetMode == "" {
			return workflowOutput{Error: "创建工作流时必须指定 target_mode：fixed、single 或 multiple"}, nil
		}
		def := workflow.Definition{Name: in.Name, Description: in.Description, TargetMode: in.TargetMode, ExecutionMode: in.ExecutionMode, Steps: in.Steps}
		if err := workflow.Validate(def); err != nil {
			return workflowOutput{Error: err.Error()}, nil
		}
		if err := workflow.CheckTargets(ctx, s, service.Lake.Name, def, service.Anchors, true); err != nil {
			return workflowOutput{Error: err.Error()}, nil
		}
		body, err := json.Marshal(def)
		if err != nil {
			return workflowOutput{}, err
		}
		if err := authorizeToolAction(ctx, service.Lake.ID, "", "lake_workflow_create", "workflow", service.Lake.Name+"/"+def.Name, "workflow", string(body), approve); err != nil {
			return workflowOutput{Error: err.Error()}, nil
		}
		item, err := s.CreateWorkflow(ctx, service.Lake.Name, def.Name, def.Description, body)
		if err != nil {
			return workflowOutput{Error: err.Error()}, nil
		}
		return workflowOutput{Workflow: &item}, nil
	})
	if err != nil {
		return nil, err
	}
	update, err := utils.InferTool[workflowUpdateInput, workflowOutput]("lake_workflow_update", "修改当前湖已保存的工作流定义；必须提供更新后的完整步骤列表，仅影响今后运行，历史运行快照不变。用户要求修改或将固定主机改为 $host 占位符时使用。", func(ctx context.Context, in workflowUpdateInput) (workflowOutput, error) {
		item, err := s.ResolveWorkflow(ctx, service.Lake.Name, strings.TrimSpace(in.CurrentName))
		if err != nil {
			return workflowOutput{Error: err.Error()}, nil
		}
		var prior workflow.Definition
		if err := json.Unmarshal(item.Spec, &prior); err != nil {
			return workflowOutput{Error: err.Error()}, nil
		}
		mode := in.TargetMode
		if mode == "" {
			mode = prior.TargetMode
		}
		executionMode := in.ExecutionMode
		if executionMode == "" {
			executionMode = prior.ExecutionMode
		}
		def := workflow.Definition{Name: in.Name, Description: in.Description, TargetMode: mode, ExecutionMode: executionMode, Steps: in.Steps}
		if err := workflow.Validate(def); err != nil {
			return workflowOutput{Error: err.Error()}, nil
		}
		if err := workflow.CheckTargets(ctx, s, service.Lake.Name, def, service.Anchors, true); err != nil {
			return workflowOutput{Error: err.Error()}, nil
		}
		body, err := json.Marshal(def)
		if err != nil {
			return workflowOutput{}, err
		}
		if err := authorizeToolAction(ctx, service.Lake.ID, "", "lake_workflow_update", "workflow", service.Lake.Name+"/"+item.Name, "workflow", string(body), approve); err != nil {
			return workflowOutput{Error: err.Error()}, nil
		}
		updated, err := s.UpdateWorkflow(ctx, item.ID, def.Name, def.Description, body)
		if err != nil {
			return workflowOutput{Error: err.Error()}, nil
		}
		return workflowOutput{Workflow: &updated}, nil
	})
	if err != nil {
		return nil, err
	}
	runTool, err := utils.InferTool[workflowRunInput, workflowOutput]("lake_workflow_run", "运行已保存工作流：默认先由AI参考历史耗时与失败记录评估计划，自主延长等待或串行化同资源步骤，并保存理由；按调整后的目标和依赖执行，目标步骤由模型专员执行，明确命令失败时诊断并调整后验证，未知/审批拒绝不继续。fixed显式关闭规划及恢复。fixed目标不传参数，single用resource，multiple用targets。每次操作保留授权审批，返回结果后主Agent分析实际状态，禁止重复启动或把未知/失败算成功。", func(ctx context.Context, in workflowRunInput) (workflowOutput, error) {
		proposal, err := json.Marshal(in)
		if err != nil {
			return workflowOutput{}, err
		}
		if err := authorizeToolAction(ctx, service.Lake.ID, "", "lake_workflow_run", "workflow", service.Lake.Name+"/"+in.Name, "workflow", string(proposal), approve); err != nil {
			return workflowOutput{Error: err.Error()}, nil
		}
		runtime := workflowV2ToolRuntime{Approve: approve}
		if len(v2Runtime) > 0 {
			runtime = v2Runtime[0]
			runtime.Approve = approve
		}
		run, err := executeWorkflowRun(ctx, s, service, in, "agent", progress, runtime)
		if err != nil {
			return workflowOutput{Error: err.Error()}, nil
		}
		limitWorkflowOutput(&run)
		return workflowOutput{Run: &run}, nil
	})
	if err != nil {
		return nil, err
	}
	status, err := utils.InferTool[workflowStatusInput, workflowOutput]("lake_workflow_status", "按运行 ID 查看当前湖工作流的真实步骤状态和输出。", func(ctx context.Context, in workflowStatusInput) (workflowOutput, error) {
		run, err := s.GetWorkflowRun(ctx, in.RunID)
		if err != nil {
			return workflowOutput{Error: err.Error()}, nil
		}
		if run.LakeID != service.Lake.ID {
			return workflowOutput{Error: "该运行不属于当前湖"}, nil
		}
		limitWorkflowOutput(&run)
		return workflowOutput{Run: &run}, nil
	})
	if err != nil {
		return nil, err
	}
	runtime := workflowV2ToolRuntime{}
	if len(v2Runtime) > 0 {
		runtime = v2Runtime[0]
	}
	v2, err := newWorkflowV2Tools(s, service, approve, runtime)
	if err != nil {
		return nil, err
	}
	return append([]tool.BaseTool{list, create, update, runTool, status}, v2...), nil
}

// executeWorkflowRun is shared by the Agent tool and the desktop's explicit
// run action. Both paths use the same target checks, SSH approvals and trace.
func executeWorkflowRun(ctx context.Context, s *store.Store, service *operate.Service, in workflowRunInput, trigger string, progress workflow.Reporter, runtimes ...workflowV2ToolRuntime) (store.WorkflowRun, error) {
	item, err := s.ResolveWorkflow(ctx, service.Lake.Name, strings.TrimSpace(in.Name))
	if err != nil {
		return store.WorkflowRun{}, err
	}
	var saved workflow.Definition
	if err := json.Unmarshal(item.Spec, &saved); err != nil {
		return store.WorkflowRun{}, err
	}
	resolved, err := workflow.BindTargets(saved, strings.TrimSpace(in.Resource), in.Bindings, in.Targets)
	if err != nil {
		return store.WorkflowRun{}, err
	}
	if err := workflow.CheckTargets(ctx, s, service.Lake.Name, resolved, service.Anchors, false); err != nil {
		return store.WorkflowRun{}, err
	}
	if trigger == "desktop" {
		proposal, err := json.Marshal(in)
		if err != nil {
			return store.WorkflowRun{}, err
		}
		if err := authorizeDirectWorkflowAction(ctx, s, item.LakeID, "lake_workflow_run", item.Lake+"/"+item.Name, "desktop", string(proposal)); err != nil {
			return store.WorkflowRun{}, err
		}
	}
	ssh, err := operate.NewServiceForLake(ctx, s, item.Lake)
	if err != nil {
		return store.WorkflowRun{}, err
	}
	defer ssh.CloseSessions()
	ssh.Anchors = make(map[string]struct{}, len(service.Anchors))
	for id := range service.Anchors {
		ssh.Anchors[id] = struct{}{}
	}
	ssh.Confirm = service.Confirm
	runtime := workflowV2ToolRuntime{}
	if len(runtimes) > 0 {
		runtime = runtimes[0]
	}
	executor := &workflowAdaptiveExecutor{Service: ssh, definition: resolved, report: progress, runtime: &workflowV2Executor{store: s, service: ssh, model: runtime.Model, modelID: runtime.ModelID, approve: runtime.Approve}}
	defer executor.runtime.Close()
	return workflow.StartWithTargets(ctx, s, item, trigger, strings.TrimSpace(in.Resource), in.Bindings, in.Targets, executor, progress)
}

func limitWorkflowOutput(run *store.WorkflowRun) {
	for i := range run.Steps {
		if len(run.Steps[i].Stdout) > 2000 {
			run.Steps[i].Stdout = run.Steps[i].Stdout[:2000] + "…"
		}
		if len(run.Steps[i].Stderr) > 1000 {
			run.Steps[i].Stderr = run.Steps[i].Stderr[:1000] + "…"
		}
	}
}
