package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/agent/specialist"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
)

type sshSessionInput struct {
	Resource string `json:"resource" jsonschema:"description=当前湖内已登记的资源名"`
}

type sshSessionOutput struct {
	Resource           string                    `json:"resource"`
	Session            *operate.SSHSessionStatus `json:"session,omitempty"`
	Closed             bool                      `json:"closed,omitempty"`
	AvailableResources []string                  `json:"available_resources,omitempty"`
	Error              string                    `json:"error,omitempty"`
}

type sshSessionsOutput struct {
	Sessions []operate.SSHSessionStatus `json:"sessions"`
}

// newSSHAgentTool gives the Lake Agent a dedicated SSH specialist. Only this
// child can invoke the SSH and session tools; every action still goes through
// operate.Service's resource scope, authorization and confirmation checks.
func newSSHTools(ctx context.Context, service *operate.Service) ([]tool.BaseTool, error) {
	openTool, err := utils.InferTool[sshSessionInput, sshSessionOutput](
		"lake_ssh_session_open",
		"建立并保持当前湖资源的 SSH 连接，直到明确关闭或退出 Lake 对话。不会执行远端命令。",
		func(callCtx context.Context, in sshSessionInput) (sshSessionOutput, error) {
			result := sshSessionOutput{Resource: in.Resource}
			status, err := service.OpenSession(callCtx, in.Resource)
			if err != nil {
				result.Error, result.AvailableResources = explainSSHResourceError(callCtx, service, in.Resource, err)
				return result, nil
			}
			result.Session = &status
			return result, nil
		},
	)
	if err != nil {
		return nil, err
	}
	listTool, err := utils.InferTool[struct{}, sshSessionsOutput](
		"lake_ssh_session_list",
		"列出当前 Lake 对话中保持连接的 SSH 会话及其状态。只报告实际连接，不要猜测。",
		func(_ context.Context, _ struct{}) (sshSessionsOutput, error) {
			statuses := service.ListSessions()
			if statuses == nil {
				statuses = []operate.SSHSessionStatus{}
			}
			return sshSessionsOutput{Sessions: statuses}, nil
		},
	)
	if err != nil {
		return nil, err
	}
	closeTool, err := utils.InferTool[sshSessionInput, sshSessionOutput](
		"lake_ssh_session_close",
		"关闭当前湖指定资源的已保持 SSH 连接。",
		func(callCtx context.Context, in sshSessionInput) (sshSessionOutput, error) {
			result := sshSessionOutput{Resource: in.Resource}
			if err := service.CloseSession(callCtx, in.Resource); err != nil {
				result.Error, result.AvailableResources = explainSSHResourceError(callCtx, service, in.Resource, err)
				return result, nil
			}
			result.Closed = true
			return result, nil
		},
	)
	if err != nil {
		return nil, err
	}
	runTool, err := utils.InferTool[sshToolInput, sshToolOutput](
		"lake_ssh",
		"通过 SSH 在当前湖主机上执行固定检查或命令。resource 为已登记资源名；check 支持 hostname、uptime、os、cpu、disk、memory；command 为其他命令，须经终端用户批准；check 与 command 只能选一个。",
		func(callCtx context.Context, in sshToolInput) (sshToolOutput, error) {
			result := sshToolOutput{Resource: in.Resource, Check: in.Check}
			if (in.Check == "") == (in.Command == "") {
				result.Error = "check 与 command 必须且只能提供一个"
				return result, nil
			}
			var output sshtransport.Result
			var err error
			if in.Command != "" {
				result.Check = "command"
				output, err = service.RunCommand(callCtx, in.Resource, in.Command)
			} else {
				output, err = service.RunRead(callCtx, in.Resource, in.Check)
			}
			if err != nil {
				result.Unknown = errors.Is(err, operate.ErrSSHExecutionUnknown)
				result.Error, result.AvailableResources = explainSSHResourceError(callCtx, service, in.Resource, err)
				return result, nil
			}
			result.Stdout, result.Stderr, result.ExitCode = output.Stdout, output.Stderr, output.ExitCode
			return result, nil
		},
	)
	if err != nil {
		return nil, err
	}
	registered, err := registerChatTools(ctx, []tool.BaseTool{openTool, listTool, closeTool, runTool}, service.Lake.ID)
	if err != nil {
		return nil, err
	}
	return registered, nil
}

func newSSHAgentTool(ctx context.Context, chatModel model.BaseChatModel, service *operate.Service, execution specialistExecution) (tool.BaseTool, error) {
	root := execution.Root
	resourceNames, err := service.ResourceNames(ctx)
	if err != nil {
		return nil, err
	}
	registered, err := newSSHTools(ctx, service)
	if err != nil {
		return nil, err
	}
	parentScope := agent.RunScope{LakeID: service.Lake.ID, AllTools: true}
	for id := range service.Anchors {
		parentScope.ResourceIDs = append(parentScope.ResourceIDs, id)
	}
	resourceIDsByName := make(map[string]string, len(resourceNames))
	resources, err := service.ListResources(ctx)
	if err != nil {
		return nil, err
	}
	for _, resource := range resources {
		resourceIDsByName[resource.Name] = resource.ID
	}
	parentRunID := execution.SessionID
	if parentRunID == "" {
		parentRunID = service.RunID
	}
	return (specialist.Runtime{
		Profile: specialist.Profile{
			Name: "lake_ssh_agent", Description: agentDescription(root, "ssh", "SSH 专员：建立、列出、关闭当前湖的持久 SSH 会话，并执行主机检查或经用户批准的命令。请将所有 SSH 连接和远端操作请求委派给我。"),
			Instruction: fmt.Sprintf("你是 Lake 的 SSH 专员，只处理当前湖 %q 中的 SSH 连接和主机操作。当前湖在本次对话中可用的资源名是 %q。只有这些名字可用；用户说‘这台服务器’且只有一台时，使用唯一的资源名。不得根据模型记忆创造资源、地址、标签或授权记录。SSH 连接保持在本次 Lake Agent 进程中；退出对话时全部关闭。工具的 resource 参数只填资源名，不带‘湖/’前缀。必须调用工具获取实际连接状态或远端结果；不得编造。用户明确要求建立或保持可复用连接时，调用 lake_ssh_session_open；问哪些连接在后台保持时调用 lake_ssh_session_list；要求断开时调用 lake_ssh_session_close。普通固定检查直接用 lake_ssh 的 check；如果此前已有保持的连接，它会自动复用，否则按次连接。不要为了普通检查额外打开持久会话。所有远端操作仍受 Lake 的资源授权控制；其他远端命令用 lake_ssh 的 command。是否需要逐次批准由 Lake 静默权限策略决定；遵从工具的审批流程，不得绕过。工具返回资源不存在时不要重试同一名字；报告实际可用名字，不要推测登记未同步。工具返回其他错误时如实说明，不要声称已经连接或执行。只总结本次 SSH 任务的结果。", service.Lake.Name, resourceNames) + promptSuffix(root, "ssh"),
			Model:       execution.ModelID, MaxTurns: 20,
			Tools: []string{"lake_ssh_session_open", "lake_ssh_session_list", "lake_ssh_session_close", "lake_ssh"},
			Scope: agent.RunScope{LakeID: service.Lake.ID, AllResources: true},
		},
		ParentScope: parentScope, Model: chatModel, Tools: registered, Store: service.Store,
		ParentRunID: parentRunID, ConversationID: execution.ConversationID,
		ResourceIDsByName: resourceIDsByName,
	}).Tool(ctx)
}

func explainSSHResourceError(ctx context.Context, service *operate.Service, resource string, err error) (string, []string) {
	if !errors.Is(err, store.ErrNotFound) {
		return err.Error(), nil
	}
	names, listErr := service.ResourceNames(ctx)
	if listErr != nil {
		return err.Error(), nil
	}
	available := "（无）"
	if len(names) > 0 {
		available = strings.Join(names, "、")
	}
	return fmt.Sprintf("资源 %q 未登记在当前湖 %q；未建立 SSH 连接，也未执行命令。当前湖可用资源：%s", resource, service.Lake.Name, available), names
}
