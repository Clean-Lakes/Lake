package specialist

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/schema"
)

type Runtime struct {
	Profile           Profile
	ParentScope       agent.RunScope
	Model             model.BaseChatModel
	Tools             []tool.BaseTool
	Store             *store.Store
	ParentRunID       string
	ConversationID    string
	ResourceIDsByName map[string]string
}

// Tool creates an Eino AgentTool with a bounded profile. The AgentTool result
// returns to its caller for the Lake Agent to summarize; raw task arguments and
// results are represented in specialist_task only by SHA-256 digests.
func (r Runtime) Tool(ctx context.Context) (tool.BaseTool, error) {
	if r.Model == nil || r.Store == nil || r.ParentRunID == "" {
		return nil, errors.New("专员运行环境不完整")
	}
	prepared, err := Prepare(r.ParentScope, r.Profile)
	if err != nil {
		return nil, err
	}
	selected, err := selectTools(ctx, prepared.Scope.ToolNames, r.Tools)
	if err != nil {
		return nil, err
	}
	for i, candidate := range selected {
		info, err := candidate.Info(ctx)
		if err != nil {
			return nil, err
		}
		if !requiresNamedResource(info.Name) {
			continue
		}
		if r.ResourceIDsByName == nil {
			return nil, errors.New("专员缺少资源名到 ID 的绑定")
		}
		invokable, ok := candidate.(tool.InvokableTool)
		if !ok {
			return nil, errors.New("专员资源工具不可调用")
		}
		selected[i] = scopedResourceTool{original: invokable, scope: prepared.Scope, ids: r.ResourceIDsByName}
	}
	for i, candidate := range selected {
		invokable, ok := candidate.(tool.InvokableTool)
		if !ok {
			return nil, errors.New("专员工具不可调用")
		}
		info, err := candidate.Info(ctx)
		if err != nil {
			return nil, err
		}
		selected[i] = recordedTool{original: invokable, name: info.Name}
	}
	child, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
		Name: prepared.Name, Description: prepared.Description,
		Instruction: prepared.Instruction, Model: recordedModel{r.Model},
		MaxIterations: prepared.MaxTurns,
		ToolsConfig:   adk.ToolsConfig{EmitInternalEvents: true, ToolsNodeConfig: compose.ToolsNodeConfig{Tools: selected}},
	})
	if err != nil {
		return nil, err
	}
	delegate, ok := adk.NewAgentTool(ctx, child).(tool.InvokableTool)
	if !ok {
		return nil, errors.New("专员 AgentTool 不可调用")
	}
	return taskTool{delegate: delegate, prepared: prepared, store: r.Store, parentRunID: r.ParentRunID, conversationID: r.ConversationID, durable: true}, nil
}

func requiresNamedResource(name string) bool {
	switch name {
	case "lake_ssh", "lake_ssh_session_open", "lake_ssh_session_close", "lake_k8s_get", "lake_database_inspect", "lake_script_start", "lake_script_status", "lake_script_wait", "lake_script_cancel", "lake_script_jobs":
		return true
	default:
		return false
	}
}

type scopedResourceTool struct {
	original tool.InvokableTool
	scope    agent.RunScope
	ids      map[string]string
}

func (t scopedResourceTool) Info(ctx context.Context) (*schema.ToolInfo, error) {
	return t.original.Info(ctx)
}

func (t scopedResourceTool) InvokableRun(ctx context.Context, arguments string, opts ...tool.Option) (string, error) {
	var input struct {
		Resource string `json:"resource"`
	}
	if err := json.Unmarshal([]byte(arguments), &input); err != nil {
		return "", errors.New("专员资源参数无效")
	}
	id, known := t.ids[input.Resource]
	if known && !t.scope.AllResources {
		allowed := false
		for _, candidate := range t.scope.ResourceIDs {
			if candidate == id {
				allowed = true
				break
			}
		}
		if !allowed {
			return "", errors.New("资源超出专员范围")
		}
	}

	return t.original.InvokableRun(ctx, arguments, opts...)
}

func selectTools(ctx context.Context, allowed []string, available []tool.BaseTool) ([]tool.BaseTool, error) {
	byName := make(map[string]tool.BaseTool, len(available))
	for _, candidate := range available {
		if candidate == nil {
			return nil, errors.New("专员工具为空")
		}
		info, err := candidate.Info(ctx)
		if err != nil || info == nil || info.Name == "" {
			return nil, errors.New("专员工具元数据无效")
		}
		if _, exists := byName[info.Name]; exists {
			return nil, fmt.Errorf("专员工具重名: %s", info.Name)
		}
		byName[info.Name] = candidate
	}
	selected := make([]tool.BaseTool, 0, len(allowed))
	for _, name := range allowed {
		candidate, exists := byName[name]
		if !exists {
			return nil, fmt.Errorf("专员工具未注册: %s", name)
		}
		selected = append(selected, candidate)
	}
	return selected, nil
}

type taskTool struct {
	delegate       tool.InvokableTool
	prepared       Prepared
	store          *store.Store
	parentRunID    string
	conversationID string
	durable        bool
}

func (t taskTool) Info(ctx context.Context) (*schema.ToolInfo, error) { return t.delegate.Info(ctx) }

func (t taskTool) InvokableRun(ctx context.Context, arguments string, opts ...tool.Option) (string, error) {
	if t.delegate == nil || t.store == nil || t.parentRunID == "" {
		return "", errors.New("专员任务未配置")
	}
	id, err := store.NewActionID()
	if err != nil {
		return "", err
	}
	scope, err := json.Marshal(t.prepared.Scope)
	if err != nil {
		return "", err
	}
	requestSHA := sha256.Sum256([]byte(arguments))
	_, err = t.store.CreateSpecialistTask(ctx, store.SpecialistTaskInput{ID: id, ConversationID: t.conversationID, ParentRunID: t.parentRunID, Name: t.prepared.Name, Model: t.prepared.Model, ScopeJSON: string(scope), RequestSHA256: fmt.Sprintf("%x", requestSHA)})
	if err != nil {
		return "", err
	}
	if _, err := t.store.UpdateSpecialistTask(ctx, id, "running", ""); err != nil {
		return "", err
	}
	if t.durable {
		path, unlock, err := lockCheckpoint(t.store.Root(), id)
		if err != nil {
			return "", err
		}
		defer unlock()
		log := &executionLog{path: path, state: Checkpoint{Version: 1, TaskID: id, Prepared: t.prepared, Arguments: arguments, Tools: map[string]toolRecord{}}}
		if err := log.save(); err != nil {
			return "", err
		}
		ctx = context.WithValue(ctx, logKey{}, log)
	}
	output, runErr := t.delegate.InvokableRun(ctx, arguments, opts...)
	return t.finishExecution(ctx, id, output, runErr)
}

func (t taskTool) finish(id, output string, runErr error) (string, error) {
	status := "completed"
	responseSHA := ""
	if runErr != nil {
		status = "failed"
	} else {
		digest := sha256.Sum256([]byte(output))
		responseSHA = fmt.Sprintf("%x", digest)
	}
	// A canceled model context must not prevent the task's terminal status from
	// being stored. A short independent deadline bounds this cleanup write.
	finishCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := t.store.UpdateSpecialistTask(finishCtx, id, status, responseSHA); err != nil {
		return "", err
	}
	return output, runErr
}

// Resume uses the original task ID and only a byte-identical prepared profile.
func (t taskTool) Resume(ctx context.Context, id string, retryWrites bool) (string, error) {
	path, unlock, err := lockCheckpoint(t.store.Root(), id)
	if err != nil {
		return "", err
	}
	defer unlock()
	state, err := LoadCheckpoint(t.store.Root(), id)
	if err != nil {
		return "", err
	}
	if digest(state.Prepared) != digest(t.prepared) {
		return "", errors.New("专员配置或范围已变化，无法恢复旧任务")
	}
	task, err := t.store.GetSpecialistTask(ctx, id)
	if err != nil {
		return "", err
	}
	if task.ParentRunID != t.parentRunID || task.Name != t.prepared.Name || task.RequestSHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte(state.Arguments))) {
		return "", errors.New("专员检查点与任务元数据不匹配")
	}
	if state.Output != nil && task.Status == "completed" {
		return *state.Output, nil
	}
	if _, err = t.store.ResumeSpecialistTask(ctx, id); err != nil {
		return "", err
	}
	if state.Output != nil {
		return t.finish(id, *state.Output, nil)
	}

	log := &executionLog{path: path, state: state, retryWrites: retryWrites}
	runCtx := context.WithValue(ctx, logKey{}, log)
	output, runErr := t.delegate.InvokableRun(runCtx, state.Arguments)
	return t.finishExecution(runCtx, id, output, runErr)
}

func (t taskTool) finishExecution(ctx context.Context, id, output string, runErr error) (string, error) {
	if runErr == nil {
		if log, ok := ctx.Value(logKey{}).(*executionLog); ok {
			log.mu.Lock()
			log.state.Output = &output
			runErr = log.save()
			log.mu.Unlock()
		}
	}
	return t.finish(id, output, runErr)
}
