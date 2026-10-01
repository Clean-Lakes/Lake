package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/credential"
	mcpclient "github.com/cloudwego/eino/lake/extension/mcp"
	"github.com/cloudwego/eino/schema"
	jsonschema "github.com/eino-contrib/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpTool struct {
	info     *schema.ToolInfo
	session  *mcp.ClientSession
	server   string
	original string
	approve  func(string, string, string) (bool, error)
	lakeID   string
	check    func(context.Context) error
}

func (t *mcpTool) Info(context.Context) (*schema.ToolInfo, error) { return t.info, nil }

func (t *mcpTool) InvokableRun(ctx context.Context, arguments string, _ ...tool.Option) (string, error) {
	if t.check != nil {
		if err := t.check(ctx); err != nil {
			return "", err
		}
	}
	if err := authorizeToolAction(ctx, t.lakeID, "", t.info.Name, "external", t.info.Name, "mcp", arguments, t.approve); err != nil {
		return "", err
	}
	if t.check != nil {
		if err := t.check(ctx); err != nil {
			return "", err
		}
	}
	var args any
	if err := json.Unmarshal([]byte(arguments), &args); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	result, err := mcpclient.CallTool(ctx, t.session, t.original, args)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	if len(data) > 64*1024 {
		return string(data[:64*1024]) + `... (结果已截断)`, nil
	}
	return string(data), nil
}

func connectMCP(ctx context.Context, cfg mcpServerConfig, roots ...string) (*mcp.ClientSession, func(), error) {
	root := ""
	if len(roots) > 0 {
		root = roots[0]
	}
	root, err := settingsRoot(root)
	if err != nil {
		return nil, nil, err
	}
	vault := credential.FileVault{Root: root}
	return mcpclient.Connect(ctx, mcpclient.Config{Transport: cfg.Transport, Command: cfg.Command, Args: cfg.Args, URL: cfg.URL, SecretRef: cfg.SecretRef}, vault.LoadMCPSecrets)
}

func listMCPTools(ctx context.Context, session *mcp.ClientSession) ([]*mcp.Tool, error) {
	return mcpclient.ListTools(ctx, session)
}

func mcpToolName(server, name string) string {
	var b strings.Builder
	b.WriteString("mcp_")
	b.WriteString(server)
	b.WriteByte('_')
	for _, r := range name {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

func makeMCPTool(server mcpServerConfig, session *mcp.ClientSession, remote *mcp.Tool, approve func(string, string, string) (bool, error), lakeIDs ...string) (*mcpTool, error) {
	data, err := json.Marshal(remote.InputSchema)
	if err != nil {
		return nil, err
	}
	var params jsonschema.Schema
	if err := json.Unmarshal(data, &params); err != nil {
		return nil, err
	}
	if len(data) == 0 || string(data) == "null" {
		params.Type = "object"
	}
	lakeID := "global"
	if len(lakeIDs) > 0 && lakeIDs[0] != "" {
		lakeID = lakeIDs[0]
	}
	return &mcpTool{info: &schema.ToolInfo{Name: mcpToolName(server.Name, remote.Name), Desc: remote.Description, ParamsOneOf: schema.NewParamsOneOfByJSONSchema(&params)}, session: session, server: server.Name, original: remote.Name, approve: approve, lakeID: lakeID, check: server.Check}, nil
}

type mcpToolDisplay struct {
	Name   string
	Server string
	Tool   string
}

func mcpToolCatalog(tools []tool.BaseTool) []mcpToolDisplay {
	items := make([]mcpToolDisplay, 0, len(tools))
	for _, candidate := range tools {
		if remote, ok := candidate.(*mcpTool); ok {
			items = append(items, mcpToolDisplay{Name: remote.info.Name, Server: remote.server, Tool: remote.original})
		}
	}
	return items
}

func loadMCPTools(ctx context.Context, root string, approve func(string, string, string) (bool, error), lakeIDs ...string) ([]tool.BaseTool, func(), []string) {
	servers, err := configuredMCPServers(root)
	if err != nil {
		return nil, func() {}, []string{err.Error()}
	}
	var tools []tool.BaseTool
	var closes []func()
	var warnings []string
	seen := map[string]bool{}
	for _, server := range servers {
		if !server.Enabled {
			continue
		}
		if err := checkMCPConfig(ctx, server); err != nil {
			warnings = append(warnings, pluginWarning(err))
			continue
		}
		session, closeSession, err := connectMCP(ctx, server, root)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("MCP %s 连接失败: %v", server.Name, err))
			continue
		}
		listCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		remotes, err := listMCPTools(listCtx, session)
		cancel()
		if err != nil {
			closeSession()
			warnings = append(warnings, fmt.Sprintf("MCP %s 工具发现失败: %v", server.Name, err))
			continue
		}
		closes = append(closes, closeSession)
		for _, remote := range remotes {
			name := mcpToolName(server.Name, remote.Name)
			if seen[name] {
				warnings = append(warnings, "MCP 工具命名冲突: "+name)
				continue
			}
			seen[name] = true
			t, err := makeMCPTool(server, session, remote, approve, lakeIDs...)
			if err != nil {
				warnings = append(warnings, "MCP 工具无法解析: "+name)
				continue
			}
			tools = append(tools, t)
		}
	}
	return tools, func() {
		for _, closeSession := range closes {
			closeSession()
		}
	}, warnings
}

func testMCPServer(root string, cfg mcpServerConfig, out io.Writer) error {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	session, closeSession, err := connectMCP(ctx, cfg, root)
	if err != nil {
		return err
	}
	defer closeSession()
	list, err := listMCPTools(ctx, session)
	if err != nil {
		return err
	}
	names := make([]string, 0, len(list))
	for _, t := range list {
		names = append(names, t.Name)
	}
	return json.NewEncoder(out).Encode(map[string]any{"connected": true, "tools": names})
}
