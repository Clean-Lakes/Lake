package main

import (
	"context"
	"strings"
	"testing"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/schema"
)

type registryTestTool struct{ name string }

func (t registryTestTool) Info(context.Context) (*schema.ToolInfo, error) {
	return &schema.ToolInfo{Name: t.name, Desc: "test", ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{})}, nil
}
func (t registryTestTool) InvokableRun(context.Context, string, ...tool.Option) (string, error) {
	return strings.Repeat("x", 70000), nil
}

func TestRegisterChatToolsRejectsDuplicatesAndLimitsOutput(t *testing.T) {
	ctx := context.Background()
	if _, err := registerChatTools(ctx, []tool.BaseTool{registryTestTool{"test_tool"}, registryTestTool{"test_tool"}}, "lake"); err == nil {
		t.Fatal("duplicate tool assembly succeeded")
	}
	registered, err := registerChatTools(ctx, []tool.BaseTool{registryTestTool{"test_tool"}}, "lake")
	if err != nil {
		t.Fatal(err)
	}
	result, err := registered[0].(tool.InvokableTool).InvokableRun(ctx, `{}`)
	if err != nil || len(result) > 64*1024 {
		t.Fatalf("unbounded tool result: len=%d err=%v", len(result), err)
	}
}
