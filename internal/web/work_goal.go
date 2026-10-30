package web

import (
	"context"
	"errors"
	"github.com/Clean-Lakes/Lake/internal/extensions"
)

// This is a host-owned, versioned adapter with a single fixed read operation.
// It does not change call_mcp_tool's write classification or trust annotations.
func (b *Server) workReleaseBridge(ctx context.Context, id, name string, args Object) (any, error) {
	b.Store.Session(id)
	options := b.Store.Options(id)
	if name != "work_release_capability" && (options["silentCommands"] != true || options["blockUnreferencedAssets"] == true) {
		return nil, errors.New("当前会话未允许后台 MCP 状态读取")
	}
	server, err := b.Extensions.Store.FindServer(stringOf(args["server_id"]))
	if err != nil {
		return nil, err
	}
	if !server.Enabled || server.Transport == "stdio" && options["denyLocalExecution"] == true {
		return nil, errors.New("MCP 服务或运行权限不可用")
	}
	if server.WorkObserver != "release-v1" {
		return nil, errors.New("此 MCP 服务尚未配置可信的发布状态观察适配器")
	}
	revision := extensions.ServerRevision(server)
	if name == "work_release_capability" {
		return Object{"adapter": "release-v1", "configurationRevision": revision}, nil
	}
	if stringOf(args["configurationRevision"]) != revision {
		return nil, errors.New("MCP 服务配置已变更，原观察权限失效")
	}
	order := stringOf(args["order_id"])
	if order == "" || len(order) > 256 {
		return nil, errors.New("原发布任务句柄无效")
	}
	return b.Extensions.Call(ctx, server.ID, "get_release_status", map[string]any{"order_id": order})
}
