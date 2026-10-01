package main

import (
	"context"
	"fmt"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/agent/specialist"
	"github.com/cloudwego/eino/lake/code/remote"
	"github.com/cloudwego/eino/lake/store"
)

type remoteWriteInput struct {
	Path           string `json:"path" jsonschema:"description=工作区内的相对路径"`
	ExpectedSHA256 string `json:"expected_sha256" jsonschema:"description=读取时返回的 SHA-256；新文件使用 absent"`
	Content        string `json:"content" jsonschema:"description=不超过 64 KiB 的完整新文本"`
}

func newRemoteCodeAgentTool(ctx context.Context, model model.BaseChatModel, workspace store.CodeWorkspace, service remote.Service, execution specialistExecution) (tool.BaseTool, error) {
	if !workspace.Authorized || workspace.LakeID != execution.LakeID {
		return nil, fmt.Errorf("远程代码工作区未获当前湖授权")
	}
	listTool, err := utils.InferTool[struct{}, codeToolOutput]("lake_remote_code_list", "列出当前远程代码工作区的文件，最多 200 个。", func(callCtx context.Context, _ struct{}) (codeToolOutput, error) {
		items, err := service.List(callCtx, workspace.ID)
		return codeResult(items, err), nil
	})
	if err != nil {
		return nil, err
	}
	readTool, err := utils.InferTool[codeReadInput, codeToolOutput]("lake_remote_code_read", "读取远程代码文件的完整 UTF-8 文本和 SHA-256，最多 64 KiB。", func(callCtx context.Context, in codeReadInput) (codeToolOutput, error) {
		content, err := service.Read(callCtx, workspace.ID, in.Path)
		if err != nil {
			return codeResult(nil, err), nil
		}
		return codeResult(map[string]any{"path": in.Path, "content": content, "sha256": remote.ContentSHA([]byte(content))}, nil), nil
	})
	if err != nil {
		return nil, err
	}
	writeTool, err := utils.InferTool[remoteWriteInput, codeToolOutput]("lake_remote_code_write", "按原文件 SHA-256 条件写入远程文本；每次须批准；断线后不可重试。", func(callCtx context.Context, in remoteWriteInput) (codeToolOutput, error) {
		result, err := service.Write(callCtx, workspace.ID, in.Path, in.ExpectedSHA256, []byte(in.Content))
		if err != nil {
			return codeToolOutput{Text: map[string]any{"unknown": result.Unknown}, Error: err.Error()}, nil
		}
		return codeResult(result, nil), nil
	})
	if err != nil {
		return nil, err
	}
	runTool, err := utils.InferTool[codeRunInput, codeToolOutput]("lake_remote_code_run", "在远程代码工作区运行单行命令；每次须批准；断线后结果未知。", func(callCtx context.Context, in codeRunInput) (codeToolOutput, error) {
		if execution.CommandRunner != nil {
			result, err := execution.CommandRunner(callCtx, "remote", workspace.ID, in.Command)
			return codeToolOutput{Text: result, Error: errorStringForCommand(err)}, nil
		}
		result, err := service.Run(callCtx, workspace.ID, in.Command)
		if err != nil {
			return codeToolOutput{Text: map[string]any{"unknown": result.Unknown}, Error: err.Error()}, nil
		}
		return codeResult(result, nil), nil
	})
	if err != nil {
		return nil, err
	}
	names := []string{"lake_remote_code_list", "lake_remote_code_read", "lake_remote_code_write", "lake_remote_code_run"}
	registered, err := registerChatTools(ctx, []tool.BaseTool{listTool, readTool, writeTool, runTool}, workspace.LakeID)
	if err != nil {
		return nil, err
	}
	return (specialist.Runtime{
		Profile: specialist.Profile{
			Name: "lake_code_agent", Description: agentDescription(execution.Root, "code", "代码专员：操作当前会话显式绑定的远程代码工作区。"),
			Instruction: fmt.Sprintf("你是 Lake 的远程代码专员。当前工作区为 %s@%s:%d%s。只能依据工具真实结果回答。先列出并读取相关文件，再决定修改；读取会返回 SHA-256，写入必须携带该原文件 SHA-256 或新文件标记 absent。写入和运行命令每次需要用户批准；断线后状态未知，严禁自动重试。只访问绑定目录内非敏感文件，不调用本地代码工具，也不把 SSH 运维资源等同于代码工作区。用户仅要求规划时只读文件，不运行命令或写入。", workspace.Username, workspace.Host, workspace.Port, workspace.RemoteRoot) + promptSuffix(execution.Root, "code"),
			Model:       execution.ModelID, MaxTurns: 20, Tools: names,
			Scope: agent.RunScope{LakeID: workspace.LakeID, ResourceIDs: []string{workspace.ResourceID}},
		},
		ParentScope: agent.RunScope{LakeID: workspace.LakeID, ResourceIDs: []string{workspace.ResourceID}, AllTools: true},
		Model:       model, Tools: registered, Store: execution.Store, ParentRunID: execution.SessionID, ConversationID: execution.ConversationID,
	}).Tool(ctx)
}
