package main

import (
	"context"
	"errors"
	"io"

	"github.com/cloudwego/eino/lake/opsmcp"
	"github.com/cloudwego/eino/lake/store"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func opsMCPCommand(ctx context.Context, s *store.Store, args []string, errOut io.Writer) error {
	f := flags("lake ops-mcp", errOut)
	lake := f.String("lake", "", "明确绑定的湖名")
	approval := f.Bool("require-approval", true, "逐次向 MCP 客户端请求 LAKE 审批；false 时仍受用户原有只读静默权限控制")
	if err := f.Parse(args); err != nil {
		return err
	}
	if *lake == "" || f.NArg() != 0 {
		return errors.New("用法：lake ops-mcp --lake 湖名 [--require-approval=false]")
	}
	server, err := opsmcp.New(ctx, opsmcp.Config{Store: s, Lake: *lake, RequireApproval: *approval})
	if err != nil {
		return err
	}
	return server.MCP.Run(ctx, opsmcp.ApprovalTransport{Transport: &mcp.StdioTransport{}})
}
