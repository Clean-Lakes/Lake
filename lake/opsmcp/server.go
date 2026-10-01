// Package opsmcp exposes a deliberately small, bound operations API to external
// agents. It never accepts a command, credential, or approval in tool arguments.
package opsmcp

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type Config struct {
	Store           *store.Store
	Lake            string
	RequireApproval bool
	// Factory is an injection point for transport-counting integration tests.
	Factory func(context.Context) (*operate.Service, error)
}

// ApprovalTransport advertises the initialized MCP protocol used by this
// prototype. MCP 2026-07-28 requires resumable inputRequests rather than the
// server-initiated form elicitation implemented here; do not claim that version.
type ApprovalTransport struct{ mcp.Transport }

func (ApprovalTransport) SupportsProtocolVersion(version string) bool {
	return version <= "2025-11-25"
}

type Server struct {
	MCP     *mcp.Server
	config  Config
	lake    store.Lake
	anchors map[string]struct{}
	mu      sync.Mutex
	runs    map[string]struct{}
}

type lakeInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type hostInfo struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Host         string `json:"host"`
	Port         int    `json:"port"`
	Environment  string `json:"environment"`
	ExecuteAuthz bool   `json:"execute_authz"`
}
type readInput struct {
	ResourceID string `json:"resource_id" jsonschema:"ID from lake_resources; only hosts frozen in the bound lake are valid"`
	Check      string `json:"check" jsonschema:"Fixed check: hostname, uptime, os, cpu, disk, memory"`
}
type readOutput struct {
	RunID      string `json:"run_id"`
	ResourceID string `json:"resource_id"`
	Check      string `json:"check"`
	Status     string `json:"status"`
	Stdout     string `json:"stdout,omitempty"`
	Stderr     string `json:"stderr,omitempty"`
	ExitCode   *int   `json:"exit_code,omitempty"`
	Truncated  bool   `json:"truncated,omitempty"`
	Error      string `json:"error,omitempty"`
}
type journalInput struct {
	RunID string `json:"run_id" jsonschema:"Run ID returned by lake_ssh_read in this MCP process"`
}
type journalItem struct {
	ActionID string `json:"action_id"`
	Target   string `json:"target"`
	Event    string `json:"event"`
	Detail   string `json:"detail"`
	ExitCode *int   `json:"exit_code,omitempty"`
}

func New(ctx context.Context, config Config) (*Server, error) {
	if config.Store == nil || strings.TrimSpace(config.Lake) == "" {
		return nil, errors.New("运维 MCP 必须明确绑定一个湖")
	}
	lake, err := config.Store.GetLakeByName(ctx, config.Lake)
	if err != nil {
		return nil, err
	}
	base, err := operate.NewServiceForLake(ctx, config.Store, lake.Name)
	if err != nil {
		return nil, err
	}
	s := &Server{config: config, lake: lake, anchors: base.Anchors, runs: make(map[string]struct{})}
	s.MCP = mcp.NewServer(&mcp.Implementation{Name: "lake-operations", Version: "0.1.0"}, nil)
	// Refuse stateless discovery before it can initialize SDK session state.
	// This prototype uses the legacy handshake for form elicitation.
	s.MCP.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			if method == "server/discover" {
				return nil, &jsonrpc.Error{Code: -32601, Message: "LAKE approval prototype uses initialized MCP <= 2025-11-25"}
			}
			if init, ok := req.(*mcp.InitializeRequest); ok && init.Params.ProtocolVersion > "2025-11-25" {
				return nil, &jsonrpc.Error{Code: -32602, Message: "Use legacy MCP protocol <= 2025-11-25"}
			}
			return next(ctx, method, req)
		}
	})
	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(false)}
	mcp.AddTool(s.MCP, &mcp.Tool{Name: "lake_lakes", Description: "List the single lake explicitly bound by the user to this MCP server. Does not change the current lake.", Annotations: readOnly},
		func(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, any, error) {
			return nil, map[string]any{"lakes": []lakeInfo{{ID: lake.ID, Name: lake.Name}}}, nil
		})
	mcp.AddTool(s.MCP, &mcp.Tool{Name: "lake_resources", Description: "List frozen SSH hosts in the bound lake, including current execution authorization. Never returns credentials.", Annotations: readOnly}, s.resources)
	mcp.AddTool(s.MCP, &mcp.Tool{Name: "lake_ssh_read", Description: "Run exactly one fixed read-only SSH check via LAKE authorization and journal. No arbitrary commands. Server approval may require MCP form elicitation; unsupported clients fail closed. Do not retry a denied check.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)}}, s.read)
	mcp.AddTool(s.MCP, &mcp.Tool{Name: "lake_journal", Description: "Read bounded LAKE audit events for a run returned by this MCP process.", Annotations: readOnly}, s.journal)
	return s, nil
}

func boolPtr(v bool) *bool { return &v }

func (s *Server) resources(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
	resources, err := s.config.Store.ListResources(ctx, s.lake.ID)
	if err != nil {
		return nil, nil, err
	}
	hosts := make([]hostInfo, 0, len(resources))
	for _, r := range resources {
		if _, ok := s.anchors[r.ID]; ok && r.Kind == "host" {
			hosts = append(hosts, hostInfo{ID: r.ID, Name: r.Name, Host: r.SSH.Host, Port: r.SSH.Port, Environment: r.Env, ExecuteAuthz: r.ExecuteAuthz})
		}
	}
	return nil, map[string]any{"lake": s.lake.Name, "hosts": hosts}, nil
}

func (s *Server) read(ctx context.Context, req *mcp.CallToolRequest, in readInput) (*mcp.CallToolResult, any, error) {
	if _, ok := s.anchors[in.ResourceID]; !ok {
		return nil, nil, errors.New("资源不在绑定湖的冻结范围内")
	}
	switch in.Check {
	case "hostname", "uptime", "os", "cpu", "disk", "memory":
	default:
		return nil, nil, errors.New("仅支持固定只读检查")
	}
	resource, err := s.config.Store.GetResource(ctx, in.ResourceID)
	if err != nil {
		return nil, nil, err
	}
	if resource.LakeID != s.lake.ID || resource.Kind != "host" {
		return nil, nil, errors.New("资源身份已变更")
	}
	var service *operate.Service
	if s.config.Factory != nil {
		service, err = s.config.Factory(ctx)
	} else {
		service, err = operate.NewServiceForLake(ctx, s.config.Store, s.lake.Name)
	}
	if err != nil {
		return nil, nil, err
	}
	service.Anchors = s.anchors
	service.RequireReadApproval = s.config.RequireApproval
	service.Confirm = func(approvalCtx context.Context, target, command string) (bool, error) {
		answer, err := req.Session.Elicit(approvalCtx, &mcp.ElicitParams{
			Mode: "form", Message: fmt.Sprintf("LAKE 固定只读检查\n目标：%s\n命令：%s\n批准仅覆盖此次执行；执行前再次校验授权。", target, command),
			RequestedSchema: map[string]any{"type": "object", "properties": map[string]any{"approved": map[string]any{"type": "boolean", "title": "批准本次检查"}}, "required": []string{"approved"}},
		})
		if err != nil {
			return false, errors.New("客户端未完成 LAKE MCP 审批；检查未执行")
		}
		approved, _ := answer.Content["approved"].(bool)
		return answer.Action == "accept" && approved, nil
	}
	s.mu.Lock()
	s.runs[service.RunID] = struct{}{}
	s.mu.Unlock()
	execCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	result, runErr := service.RunReadForResource(execCtx, resource, in.Check)
	out := readOutput{RunID: service.RunID, ResourceID: in.ResourceID, Check: in.Check, Status: "completed", Truncated: result.Truncated}
	if runErr != nil {
		out.Status = "failed"
		out.Error, _ = store.ExecutionPreview(runErr.Error(), 2048)
		return &mcp.CallToolResult{IsError: true}, out, nil
	}
	out.Stdout, _ = store.ExecutionPreview(result.Stdout, 8192)
	out.Stderr, _ = store.ExecutionPreview(result.Stderr, 4096)
	out.Truncated = out.Truncated || len(out.Stdout) < len(result.Stdout) || len(out.Stderr) < len(result.Stderr)
	out.ExitCode = &result.ExitCode
	if result.ExitCode != 0 {
		out.Status = "failed"
	}
	return &mcp.CallToolResult{IsError: result.ExitCode != 0}, out, nil
}

func (s *Server) journal(ctx context.Context, _ *mcp.CallToolRequest, in journalInput) (*mcp.CallToolResult, any, error) {
	s.mu.Lock()
	_, ok := s.runs[in.RunID]
	s.mu.Unlock()
	if !ok {
		return nil, nil, errors.New("只能查询本 MCP 进程创建的运行")
	}
	entries, err := s.config.Store.ListJournal(ctx, store.JournalFilter{RunID: in.RunID, Limit: 50})
	if err != nil {
		return nil, nil, err
	}
	items := make([]journalItem, 0, len(entries))
	for _, e := range entries {
		items = append(items, journalItem{ActionID: e.ActionID, Target: e.TargetPath, Event: e.Event, Detail: e.Detail, ExitCode: e.ExitCode})
	}
	return nil, map[string]any{"run_id": in.RunID, "events": items}, nil
}
