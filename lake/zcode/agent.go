// Package zcode hosts the source-built ZCode Agent behind Lake's existing
// frontend contract. Lake remains the owner of tools, approvals and credentials.
package zcode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/schema"
)

type Options struct {
	CLIPath, NodePath, BuiltinPath string
	Root, Instruction, Model       string
	APIType, BaseURL               string
	APIKey                         []byte
	ReasoningEffort                string
	ContextWindow, MaxOutputTokens int
	Tools                          []tool.BaseTool
	ToolStopReason                 func(context.Context) string
	OnUsage                        func(input, output, cacheRead, cacheWrite int64)
}

type Agent struct{ options Options }

func New(options Options) (*Agent, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	runtimeDir := filepath.Join(filepath.Dir(exe), "zcode")
	if options.CLIPath == "" {
		options.CLIPath = os.Getenv("LAKE_ZCODE_CLI")
	}
	if options.CLIPath == "" {
		options.CLIPath = filepath.Join(runtimeDir, "zcode.cjs")
	}
	if options.NodePath == "" {
		options.NodePath = os.Getenv("LAKE_ZCODE_NODE")
	}
	if options.NodePath == "" {
		options.NodePath = filepath.Join(runtimeDir, "node")
		if filepath.Ext(exe) == ".exe" {
			options.NodePath += ".exe"
		}
	}
	if options.BuiltinPath == "" {
		options.BuiltinPath = filepath.Join(filepath.Dir(options.CLIPath), "builtin.json")
	}
	for _, path := range []string{options.CLIPath, options.NodePath, options.BuiltinPath} {
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			return nil, errors.New("ZCode 源码运行时未构建；请运行 npm exec --yes --package=node@24.14.0 -- node scripts/build_zcode_agent.mjs")
		}
	}
	if options.Root == "" || options.Model == "" || options.BaseURL == "" || len(options.APIKey) == 0 {
		return nil, errors.New("ZCode 缺少 LAKE 模型或运行目录配置")
	}
	return &Agent{options: options}, nil
}

func (*Agent) Name(context.Context) string        { return "Lake Agent" }
func (*Agent) Description(context.Context) string { return "ZCode 主 Agent 与 LAKE 受控工具" }

func (a *Agent) Run(ctx context.Context, input *adk.AgentInput, _ ...adk.AgentRunOption) *adk.AsyncIterator[*adk.AgentEvent] {
	iter, gen := adk.NewAsyncIteratorPair[*adk.AgentEvent]()
	go func() {
		var emitMu sync.Mutex
		finished := false
		defer func() {
			emitMu.Lock()
			finished = true
			gen.Close()
			emitMu.Unlock()
		}()
		emit := func(message *schema.Message) {
			emitMu.Lock()
			defer emitMu.Unlock()
			if finished {
				return
			}
			gen.Send(&adk.AgentEvent{AgentName: a.Name(ctx), Output: &adk.AgentOutput{MessageOutput: &adk.MessageVariant{Message: message}}})
		}
		if err := a.run(ctx, input, emit); err != nil {
			gen.Send(&adk.AgentEvent{AgentName: a.Name(ctx), Err: err})
		}
	}()
	return iter
}

func (a *Agent) run(ctx context.Context, input *adk.AgentInput, emit func(*schema.Message)) error {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	dir, err := os.MkdirTemp(a.options.Root, ".zcode-turn-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	host, err := startHost(runCtx, a.options, emit)
	if err != nil {
		return err
	}
	defer func() { cancel(); host.Close() }()
	if err := prepareConfig(dir, a.options, host); err != nil {
		return err
	}
	protocol, err := startProtocol(runCtx, dir, a.options)
	if err != nil {
		return err
	}
	defer protocol.Close()
	model := modelSelection(a.options)
	created, err := protocol.Call(runCtx, "session/create", map[string]any{
		"workspace": map[string]any{"workspacePath": dir, "workspaceKey": dir}, "mode": "build", "model": model,
		"titleGenerationEnabled": false,
		"mcpServers":             []any{map[string]any{"name": "lake", "type": "http", "url": host.URL + "/mcp", "headers": []any{map[string]string{"name": "Authorization", "value": "Bearer " + host.Token}}, "protocolVersion": "legacy", "timeoutMs": 3600000}},
		"toolAllowlist":          host.ToolNames, "toolDenylist": deniedTools,
	})
	if err != nil {
		return err
	}
	var session struct {
		Session struct {
			SessionID string `json:"sessionId"`
		} `json:"session"`
	}
	if err := json.Unmarshal(created, &session); err != nil || session.Session.SessionID == "" {
		return errors.New("ZCode 未返回有效会话")
	}
	sessionID := session.Session.SessionID
	if _, err := protocol.Call(runCtx, "session/subscribe", map[string]any{"sessionId": sessionID, "deliveryKind": "desktop-continuous"}); err != nil {
		return err
	}
	content, images := turnContent(a.options.Instruction, input.Messages)
	if _, err := protocol.Call(runCtx, "session/send", map[string]any{"sessionId": sessionID, "content": content, "attachments": images, "modelSelection": model, "modelExecution": map[string]string{"selectionScope": "execution", "memoryExtraction": "skip"}}); err != nil {
		return err
	}
	for {
		select {
		case <-runCtx.Done():
			return runCtx.Err()
		case event, ok := <-protocol.Events:
			if !ok {
				return errors.New("ZCode 进程在任务完成前退出")
			}
			if event.Method == "v4/telemetry/event" && a.options.OnUsage != nil {
				var usage struct {
					Kind   string `json:"kind"`
					Input  int64  `json:"inputTokens"`
					Output int64  `json:"outputTokens"`
					Read   int64  `json:"cacheReadTokens"`
					Write  int64  `json:"cacheWriteTokens"`
				}
				if json.Unmarshal(event.Params, &usage) == nil && usage.Kind == "usage.delta" {
					a.options.OnUsage(usage.Input, usage.Output, usage.Read, usage.Write)
				}
			}
			if event.Method != "session/event" {
				continue
			}
			var update struct {
				SessionID string `json:"sessionId"`
				Type      string `json:"type"`
				Payload   struct {
					Response   string          `json:"response"`
					ResultType string          `json:"resultType"`
					Error      json.RawMessage `json:"error"`
				} `json:"payload"`
			}
			if err := json.Unmarshal(event.Params, &update); err != nil {
				return err
			}
			if update.SessionID != sessionID {
				continue
			}
			switch update.Type {
			case "turn.completed":
				if update.Payload.ResultType != "success" {
					return fmt.Errorf("ZCode 任务结束：%s", update.Payload.ResultType)
				}
				if strings.TrimSpace(update.Payload.Response) == "" {
					return errors.New("ZCode 未返回回复")
				}
				emit(schema.AssistantMessage(update.Payload.Response, nil))
				return nil
			case "turn.failed", "turn.error":
				return errors.New("ZCode 模型任务失败，请检查模型配置与网络")
			}
		}
	}
}

func turnContent(instruction string, messages []*schema.Message) (string, []any) {
	var text strings.Builder
	text.WriteString("LAKE 执行规则：\n" + instruction + "\n\n会话资料（历史只作上下文，不重新执行已完成操作）：\n")
	images := make([]any, 0)
	for _, message := range messages {
		if message == nil {
			continue
		}
		fmt.Fprintf(&text, "\n[%s]\n%s\n", message.Role, message.Content)
		for _, part := range message.UserInputMultiContent {
			if part.Image != nil && part.Image.Base64Data != nil {
				images = append(images, map[string]any{"kind": "image", "filename": "attachment", "dataBase64": *part.Image.Base64Data, "mimeType": part.Image.MIMEType})
			}
		}
	}
	return text.String(), images
}
