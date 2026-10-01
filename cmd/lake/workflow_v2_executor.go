package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/code"
	"github.com/cloudwego/eino/lake/credential"
	lakemodel "github.com/cloudwego/eino/lake/model"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/lake/workflow"
)

// workflowV2Executor reuses Lake's resource policy and specialist tools. A model
// is loaded only if an AI node actually runs; dry-run never constructs one.
type workflowV2Executor struct {
	store       *store.Store
	service     *operate.Service
	workspace   *code.Workspace
	projectID   string
	model       model.BaseChatModel
	modelID     string
	modelKey    []byte
	approve     func(string, string, string) (bool, error)
	mu          sync.Mutex
	parentRunID string
	report      workflow.Reporter
	retryWrites bool
	definition  workflow.DefinitionV2
}

func (e *workflowV2Executor) Close() { clearBytes(e.modelKey); e.modelKey = nil }

func (e *workflowV2Executor) BindWorkflowRunID(id string) {
	e.parentRunID = id
	e.service.SetRunID(id)
	if run, err := e.store.GetWorkflowV2Run(context.Background(), id); err == nil {
		_ = json.Unmarshal(run.Spec, &e.definition)
	}
}

func (e *workflowV2Executor) ensureModel() (model.BaseChatModel, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.model != nil {
		return e.model, nil
	}
	config, err := loadModelConfig(e.store.Root(), chatOptions{})
	if err != nil {
		return nil, err
	}
	key, err := (credential.FileVault{Root: e.store.Root()}).LoadModelAPIKey(config.ModelProvider)
	if err != nil {
		return nil, errors.New("工作流专员缺少模型凭据；请运行 lake model login")
	}
	provider := config.ModelProviders[config.ModelProvider]
	instance, err := lakemodel.New(lakemodel.Config{WireAPI: provider.WireAPI, BaseURL: provider.BaseURL, Model: config.Model, APIKey: key, ReasoningEffort: config.ModelReasoningEffort, MaxOutputTokens: config.MaxOutputTokens})
	if err != nil {
		clearBytes(key)
		return nil, err
	}
	e.modelKey, e.modelID, e.model = key, config.Model, instance
	return instance, nil
}

func (e *workflowV2Executor) checkedWorkspace(ctx context.Context) (*code.Workspace, error) {
	if e.workspace == nil && e.projectID == "" {
		return nil, errors.New("代码节点需要已绑定的代码项目；运行时传入 --project <项目ID>")
	}
	path := ""
	if e.workspace != nil && e.projectID == "" {
		path = e.workspace.Root
	}
	projects, err := e.store.ListCodeProjects(ctx)
	if err != nil {
		return nil, err
	}
	for _, project := range projects {
		if project.LakeID != e.service.Lake.ID || e.projectID != "" && project.ID != e.projectID || path != "" && project.Path != path {
			continue
		}
		workspace, err := code.Open(project.Path)
		if err != nil {
			return nil, err
		}
		if workspace.Root != project.Path {
			return nil, errors.New("代码项目路径已变化")
		}
		return workspace, nil
	}
	return nil, errors.New("代码项目未登记在当前湖或路径已变化")
}

func (e *workflowV2Executor) SSHCheck(ctx context.Context, target, check string) (any, error) {
	result, err := e.service.RunRead(ctx, target, check)
	if err != nil {
		return nil, workflowKnownError(err)
	}
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("SSH 检查退出码 %d", result.ExitCode)
	}
	return result.Stdout, nil
}

func (e *workflowV2Executor) SSHCommand(ctx context.Context, target, command string) (any, error) {
	resource, err := e.store.ResolveResource(ctx, e.service.Lake.Name+"/"+target)
	if err != nil {
		return nil, err
	}
	result, err := e.service.RunCommandForResource(ctx, resource, command)
	if err != nil {
		return nil, workflowKnownError(err)
	}
	if result.ExitCode != 0 {
		if e.parentRunID == "" {
			return nil, fmt.Errorf("SSH命令退出码%d", result.ExitCode)
		}
		key := workflow.SpecialistTaskKey(ctx)
		name := key
		nodeID := strings.Split(key, ":")[0]
		for _, node := range e.definition.Nodes {
			if node.ID == nodeID {
				name = node.Name
				break
			}
		}
		goal := fmt.Sprintf("工作流目标：%s\n节点目标：%s\n原命令：%s", e.definition.Description, name, command)
		result, err = recoverWorkflowStep(ctx, e, e.parentRunID, key, resource, goal, result, false)
		if err != nil {
			return nil, err
		}
	}
	return map[string]any{"stdout": result.Stdout, "stderr": result.Stderr, "exit_code": result.ExitCode}, nil
}

func (e *workflowV2Executor) invokeSpecialist(ctx context.Context, name, request string) (any, error) {
	parentID := e.parentRunID
	if key := workflow.SpecialistTaskKey(ctx); key != "" {
		digest := sha256.Sum256([]byte(key))
		parentID = fmt.Sprintf("%s_%x", parentID, digest[:8])
	}

	if strings.HasPrefix(name, "lake_specialist_") {
		p, err := findSpecialist(e.store.Root(), name)
		if err != nil {
			return nil, err
		}
		var workspace *code.Workspace
		if p.Scope.ProjectRoot != "" {
			workspace, err = e.checkedWorkspace(ctx)
			if err != nil {
				return nil, err
			}
		}
		execution := specialistExecution{Root: e.store.Root(), LakeID: e.service.Lake.ID, SessionID: parentID, Store: e.store}
		extras, cleanup, warnings := loadMCPTools(ctx, e.store.Root(), e.approve, e.service.Lake.ID)
		defer cleanup()
		candidates, err := customSpecialists(ctx, execution, e.service, workspace, e.approve, extras)
		if err != nil {
			return nil, err
		}
		for _, candidate := range candidates {
			info, _ := candidate.Info(ctx)
			if info.Name == name {
				input, _ := json.Marshal(map[string]string{"request": request})
				return e.runSpecialistCandidate(ctx, candidate, parentID, string(input))
			}
		}
		_ = warnings
		return nil, errors.New("专员工具或范围在当前工作流中不可用")
	}
	chatModel, err := e.ensureModel()
	if err != nil {
		return nil, err
	}
	var candidate tool.BaseTool
	execution := specialistExecution{Root: e.store.Root(), LakeID: e.service.Lake.ID, SessionID: parentID, ModelID: e.modelID, Store: e.store}
	switch name {
	case "lake_code_agent":
		workspace, err := e.checkedWorkspace(ctx)
		if err != nil {
			return nil, err
		}
		candidate, err = newCodeAgentTool(ctx, chatModel, workspace, e.approve, execution)
		if err != nil {
			return nil, err
		}
	case "lake_ssh_agent":
		candidate, err = newSSHAgentTool(ctx, chatModel, e.service, execution)
		if err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("未登记的专员 %q", name)
	}
	input, err := json.Marshal(map[string]string{"request": request})
	if err != nil {
		return nil, err
	}
	return e.runSpecialistCandidate(ctx, candidate, parentID, string(input))
}

func (e *workflowV2Executor) CodeTask(ctx context.Context, request string) (any, error) {
	return e.invokeSpecialist(ctx, "lake_code_agent", request)
}

func (e *workflowV2Executor) SpecialistTask(ctx context.Context, name, request string) (any, error) {
	return e.invokeSpecialist(ctx, name, request)
}

func (e *workflowV2Executor) ToolCall(ctx context.Context, name string, inputs map[string]any) (any, error) {
	if name == "lake_script_run" {
		id, idOK := inputs["id"].(string)
		resource, resourceOK := inputs["resource"].(string)
		digest, digestOK := inputs["sha256"].(string)
		if !idOK || !resourceOK || !digestOK || len(inputs) != 3 || strings.Contains(resource, "/") {
			return nil, errors.New("脚本调用需要固定的 id、resource、sha256")
		}
		result, err := executeStoredScript(ctx, e.store, e.service, id, resource, digest)
		if err != nil {
			return nil, workflowKnownError(err)
		}
		if result.ExitCode != 0 {
			return nil, fmt.Errorf("脚本退出码%d：%s", result.ExitCode, strings.TrimSpace(boundWorkflowSSHResult(result).Stderr))
		}
		return map[string]any{"stdout": result.Stdout, "stderr": result.Stderr, "exit_code": result.ExitCode, "truncated": result.Truncated}, nil
	}
	// The workflow may name only Lake builtins with a reviewed read capability.
	// Additional tools must have their own scope and saved-version checks.
	var candidate tool.InvokableTool
	var err error
	switch name {
	case "lake_overview":
		candidate, err = newLakeOverviewTool(e.store)
	case "lake_resources":
		if lake, _ := inputs["lake"].(string); lake != e.service.Lake.Name {
			return nil, errors.New("工作流只能读取当前湖资源")
		}
		candidate, err = newLakeResourcesTool(e.store)
	case "lake_k8s_get", "lake_database_inspect":
		resourceName, ok := inputs["resource"].(string)
		if !ok || resourceName == "" || strings.Contains(resourceName, "/") {
			return nil, errors.New("工具资源必须是当前湖的资源名")
		}
		resource, err := e.store.ResolveResource(ctx, e.service.Lake.Name+"/"+resourceName)
		if err != nil {
			return nil, err
		}
		scope := agent.RunScope{LakeID: e.service.Lake.ID, ResourceIDs: []string{resource.ID}, ToolNames: []string{name}}
		inputs["resource"] = e.service.Lake.Name + "/" + resourceName
		if name == "lake_k8s_get" {
			candidate, err = newK8sGetTool(e.store, scope)
		} else {
			candidate, err = newDatabaseInspectTool(e.store, scope)
		}
	default:
		return nil, fmt.Errorf("工作流不允许调用工具 %q", name)
	}
	if err != nil {
		return nil, err
	}
	args, err := json.Marshal(inputs)
	if err != nil {
		return nil, err
	}
	result, err := candidate.InvokableRun(ctx, string(args))
	if err != nil {
		return nil, err
	}
	var decoded any
	if err := json.Unmarshal([]byte(result), &decoded); err != nil {
		return nil, err
	}
	return decoded, nil
}

func (e *workflowV2Executor) ReportWorkflowV2(ctx context.Context, runID string) {
	if e.report == nil {
		return
	}
	run, err := e.store.GetWorkflowV2Run(ctx, runID)
	if err != nil {
		return
	}
	progress := workflow.Progress{RunID: run.ID, Name: run.Name, Status: run.Status, Total: len(run.Nodes)}
	for _, node := range run.Nodes {
		if node.Status == "completed" {
			progress.Completed++
		}
		if node.Status == "running" || node.Status == "waiting_approval" {
			progress.StepID = node.NodeID
			progress.StepName = node.NodeID
			progress.StepStatus = node.Status
		}
	}
	e.report(progress)
}

func (e *workflowV2Executor) runSpecialistCandidate(ctx context.Context, candidate tool.BaseTool, parentID, input string) (string, error) {
	tasks, err := e.store.ListSpecialistTasks(ctx, parentID)
	if err != nil {
		return "", err
	}
	info, err := candidate.Info(ctx)
	if err != nil {
		return "", err
	}
	sha := fmt.Sprintf("%x", sha256.Sum256([]byte(input)))
	for i := len(tasks) - 1; i >= 0; i-- {
		task := tasks[i]
		if task.Name != info.Name || task.RequestSHA256 != sha {
			continue
		}
		if resumable, ok := candidate.(interface {
			Resume(context.Context, string, bool) (string, error)
		}); ok {
			return resumable.Resume(ctx, task.ID, e.retryWrites)
		}
		return "", errors.New("专员已有任务但当前适配器不能恢复")

	}
	return candidate.(tool.InvokableTool).InvokableRun(ctx, input)
}
