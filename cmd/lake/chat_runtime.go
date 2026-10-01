package main

import (
	"context"
	"errors"
	"io"

	"github.com/cloudwego/eino/adk"
	lakemodel "github.com/cloudwego/eino/lake/model"
	"github.com/cloudwego/eino/lake/zcode"
)

func buildChatAgent(ctx context.Context, definition *adk.ChatModelAgentConfig, root string, config lakeModelConfig, key []byte, meter *lakemodel.UsageMeter, runtime string) (adk.Agent, error) {
	if runtime == "" || runtime == "eino" {
		return adk.NewChatModelAgent(ctx, definition)
	}
	if runtime != "zcode" {
		return nil, errors.New("agent-runtime 仅支持 zcode 或 eino")
	}
	provider := config.ModelProviders[config.ModelProvider]
	return zcode.New(zcode.Options{
		Root: root, Instruction: definition.Instruction, Model: config.Model, APIType: provider.WireAPI, BaseURL: provider.BaseURL, APIKey: key,
		ReasoningEffort: config.ModelReasoningEffort, ContextWindow: config.ContextWindow, MaxOutputTokens: config.MaxOutputTokens,
		Tools: definition.ToolsConfig.ToolsNodeConfig.Tools,
		ToolStopReason: func(ctx context.Context) string {
			if budget, _ := ctx.Value(presentationBudgetKey{}).(*presentationBudget); budget != nil && budget.exhausted() {
				return presentationFallbackInstruction
			}
			return ""
		},
		OnUsage: func(input, output, cacheRead, cacheWrite int64) {
			meter.RecordExternal(input, output, cacheRead, cacheWrite)
		},
	})
}

func bridgeCommand(ctx context.Context, root string, args []string, inputReader io.Reader, out io.Writer, errOut io.Writer) error {
	f := flags("lake bridge", errOut)
	conversation := f.String("conversation", "", "LAKE 会话 ID")
	runtime := f.String("agent-runtime", "zcode", "主 Agent 运行时：zcode 或 eino")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 || (*runtime != "zcode" && *runtime != "eino") {
		return errors.New("用法：lake bridge [--conversation ID] [--agent-runtime zcode|eino]")
	}
	return runBridgeConversationRuntime(ctx, root, *conversation, inputReader, out, *runtime)
}
