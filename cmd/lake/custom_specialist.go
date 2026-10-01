package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/agent/specialist"
	"github.com/cloudwego/eino/lake/code"
	"github.com/cloudwego/eino/lake/credential"
	lakemodel "github.com/cloudwego/eino/lake/model"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/schema"
)

type specialistConfig struct {
	specialist.Profile
	Enabled bool `json:"enabled"`
}

func validateSpecialist(root string, p specialist.Profile) error {
	if !strings.HasPrefix(p.Name, "lake_specialist_") || len(p.Instruction) > 32000 || len(p.Description) > 2000 {
		return errors.New("自定义专员名称须以 lake_specialist_ 开头，提示词或说明过长")
	}
	if _, err := specialist.Prepare(agent.RunScope{LakeID: p.Scope.LakeID, ProjectRoot: p.Scope.ProjectRoot, AllTools: true, AllResources: true}, p); err != nil {
		return err
	}
	cfg, err := readSavedModelConfig(root)
	if err != nil {
		return err
	}
	if _, ok := cfg.ModelCatalog[p.Model]; !ok {
		return errors.New("专员模型未登记")
	}
	for _, name := range p.Tools {
		if strings.HasSuffix(name, "_agent") || strings.HasPrefix(name, "lake_specialist_") || strings.HasPrefix(name, "lake_workflow_") {
			return errors.New("专员不能递归委派或执行工作流")
		}
	}
	s, err := store.Open(context.Background(), root)
	if err != nil {
		return err
	}
	defer s.Close()
	if _, err := s.GetLake(context.Background(), p.Scope.LakeID); err != nil {
		return errors.New("专员所属湖不存在")
	}
	resources, err := s.ListResources(context.Background(), p.Scope.LakeID)
	if err != nil {
		return err
	}
	known := map[string]bool{}
	for _, r := range resources {
		known[r.ID] = true
	}
	for _, id := range p.Scope.ResourceIDs {
		if !known[id] {
			return errors.New("专员资源不属于所选湖")
		}
	}
	if p.Scope.ProjectRoot != "" {
		projects, err := s.ListCodeProjects(context.Background())
		if err != nil {
			return err
		}
		found := false
		for _, project := range projects {
			if project.Path == p.Scope.ProjectRoot && project.LakeID == p.Scope.LakeID {
				found = true
			}
		}
		if !found {
			return errors.New("专员项目必须登记在所选湖")
		}
	}
	for _, name := range p.Tools {
		known := strings.HasPrefix(name, "mcp_")
		switch name {
		case "lake_ssh", "lake_ssh_session_open", "lake_ssh_session_list", "lake_ssh_session_close", "lake_k8s_get", "lake_database_inspect", "lake_code_list", "lake_code_read", "lake_code_search", "lake_code_status", "lake_code_diff", "lake_code_edit", "lake_code_create", "lake_code_run", "lake_code_patch", "lake_code_checkpoint", "lake_code_restore":
			known = true
		}
		if !known {
			return errors.New("专员工具不在允许的运行时工具目录内")
		}
		if strings.HasPrefix(name, "lake_code_") && p.Scope.ProjectRoot == "" {
			return errors.New("代码工具需要显式绑定登记项目")
		}
	}
	return nil
}
func findSpecialist(root, name string) (specialistConfig, error) {
	settings, err := readLakeSettings(root)
	if err != nil {
		return specialistConfig{}, err
	}
	for _, p := range settings.Specialists {
		if p.Name == name {
			if !p.Enabled {
				return p, errors.New("专员已停用")
			}
			return p, nil
		}
	}
	return specialistConfig{}, errors.New("专员未登记")
}
func specialistModel(root, name string) (model.BaseChatModel, func(), error) {
	cfg, err := loadModelConfig(root, chatOptions{Model: name})
	if err != nil {
		return nil, nil, err
	}
	key, err := (credential.FileVault{Root: root}).LoadModelAPIKey(cfg.ModelProvider)
	if err != nil {
		return nil, nil, errors.New("专员模型凭据不可用")
	}
	provider := cfg.ModelProviders[cfg.ModelProvider]
	instance, err := lakemodel.New(lakemodel.Config{WireAPI: provider.WireAPI, BaseURL: provider.BaseURL, Model: cfg.Model, APIKey: key, ReasoningEffort: cfg.ModelReasoningEffort, MaxOutputTokens: cfg.MaxOutputTokens})
	if err != nil {
		clearBytes(key)
		return nil, nil, err
	}
	return instance, func() { clearBytes(key) }, nil
}

type customSpecialistTool struct {
	config      specialistConfig
	execution   specialistExecution
	scope       agent.RunScope
	tools       []tool.BaseTool
	resourceIDs map[string]string
}

func (t customSpecialistTool) Info(context.Context) (*schema.ToolInfo, error) {
	return &schema.ToolInfo{Name: t.config.Name, Desc: t.config.Description, ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{"request": {Type: schema.String, Required: true, Desc: "委派给专员的任务"}})}, nil
}
func (t customSpecialistTool) runtime(ctx context.Context) (tool.BaseTool, func(), error) {
	current, err := findSpecialist(t.execution.Root, t.config.Name)
	if err != nil {
		return nil, nil, err
	}
	old, _ := json.Marshal(t.config)
	now, _ := json.Marshal(current)
	if string(old) != string(now) {
		return nil, nil, errors.New("专员配置已变化，请重新开始会话")
	}
	if err := validateSpecialist(t.execution.Root, current.Profile); err != nil {
		return nil, nil, err
	}
	instance, cleanup, err := specialistModel(t.execution.Root, current.Model)
	if err != nil {
		return nil, nil, err
	}
	candidate, err := (specialist.Runtime{Profile: current.Profile, ParentScope: t.scope, Model: instance, Tools: t.tools, Store: t.execution.Store, ParentRunID: t.execution.SessionID, ConversationID: t.execution.ConversationID, ResourceIDsByName: t.resourceIDs}).Tool(ctx)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	return candidate, cleanup, nil
}
func (t customSpecialistTool) InvokableRun(ctx context.Context, args string, opts ...tool.Option) (string, error) {
	candidate, cleanup, err := t.runtime(ctx)
	if err != nil {
		return "", err
	}
	defer cleanup()
	return candidate.(tool.InvokableTool).InvokableRun(ctx, args, opts...)
}
func (t customSpecialistTool) Resume(ctx context.Context, id string, retry bool) (string, error) {
	candidate, cleanup, err := t.runtime(ctx)
	if err != nil {
		return "", err
	}
	defer cleanup()
	return candidate.(interface {
		Resume(context.Context, string, bool) (string, error)
	}).Resume(ctx, id, retry)
}
func specialistEnvironment(ctx context.Context, e specialistExecution, service *operate.Service, workspace *code.Workspace, approve func(string, string, string) (bool, error)) (agent.RunScope, []tool.BaseTool, map[string]string, error) {
	scope := agent.RunScope{LakeID: e.LakeID, AllTools: true}
	if workspace != nil {
		scope.ProjectRoot = workspace.Root
	}
	ids := map[string]string{}
	var tools []tool.BaseTool
	if service != nil {
		resources, err := service.ListResources(ctx)
		if err != nil {
			return scope, nil, nil, err
		}
		for _, r := range resources {
			if _, allowed := service.Anchors[r.ID]; allowed {
				scope.ResourceIDs = append(scope.ResourceIDs, r.ID)
			}
			ids[r.Name] = r.ID
			ids[service.Lake.Name+"/"+r.Name] = r.ID
		}
		ssh, err := newSSHTools(ctx, service)
		if err != nil {
			return scope, nil, nil, err
		}
		tools = append(tools, ssh...)
		k8s, err := newK8sGetTool(e.Store, scope)
		if err != nil {
			return scope, nil, nil, err
		}
		tools = append(tools, k8s)
		db, err := newDatabaseInspectTool(e.Store, scope)
		if err != nil {
			return scope, nil, nil, err
		}
		tools = append(tools, db)
	}
	if workspace != nil {
		codeTools, err := newCodeTools(ctx, workspace, approve, e)
		if err != nil {
			return scope, nil, nil, err
		}
		tools = append(tools, codeTools...)
	}
	return scope, tools, ids, nil
}
func customSpecialists(ctx context.Context, e specialistExecution, service *operate.Service, workspace *code.Workspace, approve func(string, string, string) (bool, error), extra []tool.BaseTool) ([]tool.BaseTool, error) {
	settings, err := readLakeSettings(e.Root)
	if err != nil {
		return nil, err
	}
	scope, pool, ids, err := specialistEnvironment(ctx, e, service, workspace, approve)
	if err != nil {
		return nil, err
	}
	pool = append(pool, extra...)
	var result []tool.BaseTool
	for _, p := range settings.Specialists {
		if !p.Enabled || p.Scope.LakeID != scope.LakeID {
			continue
		}
		if p.Scope.ProjectRoot != "" && p.Scope.ProjectRoot != scope.ProjectRoot {
			continue
		}
		if _, err := specialist.Prepare(scope, p.Profile); err != nil {
			continue
		}
		// Tools unavailable in this session are not advertised.
		available := map[string]bool{}
		for _, candidate := range pool {
			info, err := candidate.Info(ctx)
			if err != nil {
				return nil, err
			}
			available[info.Name] = true
		}
		valid := true
		for _, name := range p.Tools {
			if !available[name] {
				valid = false
				break
			}
		}
		if !valid {
			continue
		}
		result = append(result, customSpecialistTool{config: p, execution: e, scope: scope, tools: pool, resourceIDs: ids})
	}
	return result, nil
}
