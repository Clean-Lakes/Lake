package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/agent"
	agenttools "github.com/cloudwego/eino/lake/agent/tools"
)

func registerChatTools(ctx context.Context, raw []tool.BaseTool, lakeID string) ([]tool.BaseTool, error) {
	registry := agenttools.NewRegistry()
	for _, candidate := range raw {
		info, err := candidate.Info(ctx)
		if err != nil || info == nil {
			return nil, fmt.Errorf("read tool metadata: %w", err)
		}
		inputSchema := json.RawMessage(`{"type":"object"}`)
		if info.ParamsOneOf != nil {
			parsed, err := info.ParamsOneOf.ToJSONSchema()
			if err != nil {
				return nil, fmt.Errorf("tool %s input schema: %w", info.Name, err)
			}
			if parsed != nil {
				inputSchema, err = json.Marshal(parsed)
				if err != nil {
					return nil, fmt.Errorf("tool %s input schema: %w", info.Name, err)
				}
			}
		}
		description := info.Desc
		if description == "" {
			description = info.Name
		}
		spec := agent.ToolSpec{Name: info.Name, Description: description, Capability: chatToolCapability(info.Name), InputSchema: inputSchema, MaxOutputBytes: 64 * 1024, Timeout: 90 * time.Second}
		if spec.Capability == "user_input" {
			spec.Timeout = 0
		}
		if spec.Capability == "delegate" || spec.Capability == "workflow" {
			spec.Timeout = 5 * time.Minute
		}
		if err := registry.Register(spec, candidate); err != nil {
			return nil, fmt.Errorf("register tool %s: %w", info.Name, err)
		}
	}
	if lakeID == "" {
		lakeID = "global"
	}
	registered := registry.List(agent.RunScope{LakeID: lakeID, AllTools: true})
	for i, candidate := range registered {
		info, err := candidate.Info(ctx)
		if err != nil {
			return nil, err
		}
		if info.Name == "lake_visual_report" {
			registered[i] = correctingReportTool{original: candidate.(tool.InvokableTool)}
		}
		if info.Name == "lake_ui" {
			registered[i] = correctingUITool{original: candidate.(tool.InvokableTool)}
		}
	}
	return registered, nil
}

func chatToolCapability(name string) string {
	switch {
	case name == "lake_ask_user":
		return "user_input"
	case name == "lake_ssh_agent", name == "lake_code_agent", strings.HasPrefix(name, "lake_specialist_"):
		return "delegate"
	case name == "lake_workflow_list", name == "lake_workflow_status":
		return "read"
	case strings.HasPrefix(name, "lake_workflow_"):
		return "workflow"
	case strings.HasPrefix(name, "mcp_"):
		return "external"
	case name == "lake_web_search", name == "lake_web_fetch", name == "lake_browser_open", name == "lake_browser_navigate":
		return "external"
	case name == "lake_code_edit", name == "lake_code_create", name == "lake_code_patch", name == "lake_code_checkpoint", name == "lake_code_restore":
		return "write"
	case name == "lake_code_run", name == "lake_ssh", name == "lake_script_run", name == "lake_script_start", name == "lake_script_cancel":
		return "execute"
	default:
		return "read"
	}
}
