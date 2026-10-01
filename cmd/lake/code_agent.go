package main

import (
	"context"
	"fmt"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/agent/specialist"
	"github.com/cloudwego/eino/lake/code"
	"github.com/cloudwego/eino/lake/store"
)

type codeListInput struct {
	Filter string `json:"filter,omitempty" jsonschema:"description=相对路径筛选"`
}
type codeReadInput struct {
	Path   string `json:"path" jsonschema:"description=项目内文件的相对路径"`
	Offset int    `json:"offset,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}
type codeSearchInput struct {
	Pattern string `json:"pattern" jsonschema:"description=Go 正则表达式"`
}
type codeEditInput struct {
	Path    string `json:"path" jsonschema:"description=项目内文件的相对路径"`
	OldText string `json:"old_text" jsonschema:"description=原文，必须恰好出现一次"`
	NewText string `json:"new_text" jsonschema:"description=替换文本"`
}
type codeCreateInput struct {
	Path    string `json:"path" jsonschema:"description=项目内新文件的相对路径，父目录须已存在"`
	Content string `json:"content" jsonschema:"description=新文件完整文本"`
}
type codeRunInput struct {
	Command string `json:"command" jsonschema:"description=项目根目录执行的 shell 命令"`
}
type codePatchInput struct {
	Files []code.PatchFile `json:"files" jsonschema:"description=1 到 8 个文件的完整新内容；delete=true 表示删除"`
}
type codeCheckpointInput struct {
	Paths []string `json:"paths" jsonschema:"description=需要保存快照的项目相对路径，最多 8 个"`
}
type codeRestoreInput struct {
	ID string `json:"id" jsonschema:"description=此前返回的检查点 ID"`
}
type codeToolOutput struct {
	Text  any    `json:"text,omitempty"`
	Error string `json:"error,omitempty"`
}

func newCodeTools(ctx context.Context, workspace *code.Workspace, approve func(kind, path, detail string) (bool, error), execution specialistExecution) ([]tool.BaseTool, error) {
	root := execution.Root
	lakeID := execution.LakeID
	if lakeID == "" {
		lakeID = "project"
	}
	sessionID := execution.SessionID
	if sessionID == "" {
		var err error
		sessionID, err = store.NewActionID()
		if err != nil {
			return nil, err
		}
	}
	checkpoints, err := code.NewCheckpointStore(root, sessionID, workspace)
	if err != nil {
		return nil, err
	}
	listTool, err := utils.InferTool[codeListInput, codeToolOutput]("lake_code_list", "列出当前代码项目的文件，最多 200 个。", func(callCtx context.Context, in codeListInput) (codeToolOutput, error) {
		files, err := workspace.List(callCtx, in.Filter, 200)
		return codeResult(files, err), nil
	})
	if err != nil {
		return nil, err
	}
	readTool, err := utils.InferTool[codeReadInput, codeToolOutput]("lake_code_read", "读取项目内文本文件与行号，最多 200 行。", func(_ context.Context, in codeReadInput) (codeToolOutput, error) {
		result, err := workspace.Read(in.Path, in.Offset, in.Limit)
		return codeResult(result, err), nil
	})
	if err != nil {
		return nil, err
	}
	searchTool, err := utils.InferTool[codeSearchInput, codeToolOutput]("lake_code_search", "按正则表达式搜索项目，返回路径和行号。", func(callCtx context.Context, in codeSearchInput) (codeToolOutput, error) {
		hits, err := workspace.Search(callCtx, in.Pattern, 100)
		return codeResult(hits, err), nil
	})
	if err != nil {
		return nil, err
	}
	statusTool, err := utils.InferTool[struct{}, codeToolOutput]("lake_code_status", "查看真实 Git 工作区状态。", func(callCtx context.Context, _ struct{}) (codeToolOutput, error) {
		result, err := workspace.GitStatus(callCtx)
		return codeResult(result, err), nil
	})
	if err != nil {
		return nil, err
	}
	diffTool, err := utils.InferTool[struct{}, codeToolOutput]("lake_code_diff", "查看真实 Git 未暂存差异。", func(callCtx context.Context, _ struct{}) (codeToolOutput, error) {
		result, err := workspace.GitDiff(callCtx)
		return codeResult(result, err), nil
	})
	if err != nil {
		return nil, err
	}
	editTool, err := utils.InferTool[codeEditInput, codeToolOutput]("lake_code_edit", "精确替换代码文件的一段文本；每次请求用户批准。", func(callCtx context.Context, in codeEditInput) (codeToolOutput, error) {
		preview, err := workspace.PreviewReplace(in.Path, in.OldText, in.NewText)
		if err != nil {
			return codeResult(nil, err), nil
		}
		if err := authorizeToolAction(callCtx, lakeID, workspace.Root, "lake_code_edit", "write", in.Path, "code-edit", fmt.Sprintf("替换原文：\n%s\n\n替换为：\n%s", in.OldText, in.NewText), approve); err != nil {
			return codeResult(nil, err), nil
		}
		return codeResult("已修改 "+in.Path, workspace.ApplyChange(preview)), nil
	})
	if err != nil {
		return nil, err
	}
	createTool, err := utils.InferTool[codeCreateInput, codeToolOutput]("lake_code_create", "在代码项目内创建文本文件；每次请求用户批准。", func(callCtx context.Context, in codeCreateInput) (codeToolOutput, error) {
		preview, err := workspace.PreviewCreate(in.Path, in.Content)
		if err != nil {
			return codeResult(nil, err), nil
		}
		if err := authorizeToolAction(callCtx, lakeID, workspace.Root, "lake_code_create", "write", in.Path, "code-create", preview.After, approve); err != nil {
			return codeResult(nil, err), nil
		}
		return codeResult("已创建 "+in.Path, workspace.ApplyChange(preview)), nil
	})
	if err != nil {
		return nil, err
	}
	runTool, err := utils.InferTool[codeRunInput, codeToolOutput]("lake_code_run", "在绑定项目的工作终端运行命令；桌面会话中保留当前目录和环境状态，每次请求用户批准。", func(callCtx context.Context, in codeRunInput) (codeToolOutput, error) {
		if in.Command == "" || len(in.Command) > 4000 {
			return codeResult(nil, fmt.Errorf("命令为空或过长")), nil
		}
		if execution.CommandRunner != nil {
			result, err := execution.CommandRunner(callCtx, "local", workspace.Root, in.Command)
			return codeToolOutput{Text: result, Error: errorStringForCommand(err)}, nil
		}
		if err := authorizeToolAction(callCtx, lakeID, workspace.Root, "lake_code_run", "execute", workspace.Root, "code-run", in.Command, approve); err != nil {
			return codeResult(nil, err), nil
		}
		result, err := workspace.Run(callCtx, in.Command)
		return codeResult(result, err), nil
	})
	if err != nil {
		return nil, err
	}
	patchTool, err := utils.InferTool[codePatchInput, codeToolOutput]("lake_code_patch", "预览并一次修改最多 8 个代码文件；展示完整差异，批准后保存检查点。", func(callCtx context.Context, in codePatchInput) (codeToolOutput, error) {
		preview, err := workspace.PreviewPatch(in.Files)
		if err != nil {
			return codeResult(nil, err), nil
		}
		if err := authorizeToolAction(callCtx, lakeID, workspace.Root, "lake_code_patch", "write", workspace.Root, "code-patch", preview.Diff, approve); err != nil {
			return codeResult(nil, err), nil
		}
		id, err := checkpoints.Apply(preview)
		return codeResult(map[string]any{"checkpoint_id": id, "diff": preview.Diff}, err), nil
	})
	if err != nil {
		return nil, err
	}
	checkpointTool, err := utils.InferTool[codeCheckpointInput, codeToolOutput]("lake_code_checkpoint", "为最多 8 个项目文件建立私有检查点。", func(callCtx context.Context, in codeCheckpointInput) (codeToolOutput, error) {
		if err := authorizeToolAction(callCtx, lakeID, workspace.Root, "lake_code_checkpoint", "write", workspace.Root, "code-checkpoint", fmt.Sprintf("为以下文件建立检查点：%v", in.Paths), approve); err != nil {
			return codeResult(nil, err), nil
		}
		id, err := checkpoints.Snapshot(in.Paths)
		return codeResult(map[string]any{"checkpoint_id": id, "paths": in.Paths}, err), nil
	})
	if err != nil {
		return nil, err
	}
	restoreTool, err := utils.InferTool[codeRestoreInput, codeToolOutput]("lake_code_restore", "预览并恢复检查点；恢复也必须批准，且会产生新的反向检查点。", func(callCtx context.Context, in codeRestoreInput) (codeToolOutput, error) {
		preview, err := checkpoints.PreviewRestore(in.ID)
		if err != nil {
			return codeResult(nil, err), nil
		}
		if err := authorizeToolAction(callCtx, lakeID, workspace.Root, "lake_code_restore", "write", workspace.Root, "code-restore", "恢复检查点 "+in.ID+"：\n"+preview.Diff, approve); err != nil {
			return codeResult(nil, err), nil
		}
		undoID, err := checkpoints.Apply(preview)
		return codeResult(map[string]any{"restored_checkpoint_id": in.ID, "undo_checkpoint_id": undoID, "diff": preview.Diff}, err), nil
	})
	if err != nil {
		return nil, err
	}
	registered, err := registerChatTools(ctx, []tool.BaseTool{listTool, readTool, searchTool, statusTool, diffTool, editTool, createTool, runTool, patchTool, checkpointTool, restoreTool}, lakeID)
	if err != nil {
		return nil, err
	}
	return registered, nil
}

func newCodeAgentTool(ctx context.Context, chatModel model.BaseChatModel, workspace *code.Workspace, approve func(kind, path, detail string) (bool, error), execution specialistExecution) (tool.BaseTool, error) {
	root := execution.Root
	lakeID := execution.LakeID
	if lakeID == "" {
		lakeID = "project"
	}
	sessionID := execution.SessionID
	if sessionID == "" {
		var err error
		sessionID, err = store.NewActionID()
		if err != nil {
			return nil, err
		}
		execution.SessionID = sessionID
	}
	registered, err := newCodeTools(ctx, workspace, approve, execution)
	if err != nil {
		return nil, err
	}
	return (specialist.Runtime{
		Profile: specialist.Profile{
			Name: "lake_code_agent", Description: agentDescription(root, "code", "代码专员：分析当前会话绑定的项目，制定方案、修改文件、执行测试和查看差异。所有代码项目请求交给我。"),
			Instruction: fmt.Sprintf("你是 Lake 的代码专员。当前项目根目录是 %q。只能依据工具的真实结果陈述代码与测试状态，不能编造。先搜索、读取相关代码，再制定简洁的修改方案；用户明确要求实现时，可使用精确编辑、新建或多文件 patch；需要回退时先预览检查点恢复差异。必要时运行测试并查看差异。用户仅要求设计或规划时，只读取代码并提供方案，不修改也不运行命令。每次写文件、建立检查点、恢复或运行命令都需工具请求用户批准；用户拒绝后停止该操作，不能换工具规避。只用项目相对路径，不读取凭据或项目外文件。回复列出实际修改、检查点 ID、验证与结果。", workspace.Root) + promptSuffix(root, "code"),
			Model:       execution.ModelID, MaxTurns: 20,
			Tools: []string{"lake_code_list", "lake_code_read", "lake_code_search", "lake_code_status", "lake_code_diff", "lake_code_edit", "lake_code_create", "lake_code_run", "lake_code_patch", "lake_code_checkpoint", "lake_code_restore"},
			Scope: agent.RunScope{LakeID: lakeID, ProjectRoot: workspace.Root},
		},
		ParentScope: agent.RunScope{LakeID: lakeID, ProjectRoot: workspace.Root, AllTools: true},
		Model:       chatModel, Tools: registered, Store: execution.Store, ParentRunID: sessionID, ConversationID: execution.ConversationID,
	}).Tool(ctx)
}

func codeResult(value any, err error) codeToolOutput {
	if err != nil {
		return codeToolOutput{Error: err.Error()}
	}
	return codeToolOutput{Text: value}
}
