package zcode

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/schema"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type host struct {
	URL, Token string
	ToolNames  []string
	server     *http.Server
	listener   net.Listener
}

func startHost(ctx context.Context, opts Options, emit func(*schema.Message)) (*host, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	h := &host{Token: hex.EncodeToString(secret), ToolNames: make([]string, 0, len(opts.Tools))}
	executor, err := compose.NewToolNode(ctx, &compose.ToolsNodeConfig{Tools: opts.Tools, ExecuteSequentially: true})
	if err != nil {
		return nil, err
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "lake-host", Version: "1"}, nil)
	for _, candidate := range opts.Tools {
		_, ok := candidate.(tool.InvokableTool)
		if !ok {
			return nil, errors.New("ZCode 只能导出已注册的可调用 LAKE 工具")
		}
		info, err := candidate.Info(ctx)
		if err != nil {
			return nil, err
		}
		shape, err := info.ParamsOneOf.ToJSONSchema()
		if err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(shape)
		if err != nil {
			return nil, err
		}
		var spec jsonschema.Schema
		if shape == nil {
			spec.Type = "object"
		} else if err = json.Unmarshal(encoded, &spec); err != nil {
			return nil, err
		}
		validated, err := spec.Resolve(nil)
		if err != nil {
			return nil, err
		}
		h.ToolNames = append(h.ToolNames, "mcp__lake__"+info.Name)
		server.AddTool(&mcp.Tool{Name: info.Name, Description: info.Desc, InputSchema: &spec}, func(requestCtx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			if opts.ToolStopReason != nil && opts.ToolStopReason(ctx) != "" {
				return toolFailure(opts.ToolStopReason(ctx)), nil
			}
			var args any
			if err := json.Unmarshal(req.Params.Arguments, &args); err != nil {
				return toolFailure("无效工具参数"), nil
			}
			if err := validated.Validate(args); err != nil {
				return toolFailure("工具参数不符合已注册 schema"), nil
			}
			callID, err := store.NewActionID()
			if err != nil {
				return nil, err
			}
			proposal := schema.AssistantMessage("", []schema.ToolCall{{ID: callID, Function: schema.FunctionCall{Name: info.Name, Arguments: string(req.Params.Arguments)}}})
			emit(proposal)
			// Preserve the original tool-call context used by script jobs and
			// checkpoints; either Lake or MCP request cancellation stops work.
			callCtx, cancel := context.WithCancel(ctx)
			stop := context.AfterFunc(requestCtx, cancel)
			defer stop()
			defer cancel()
			messages, runErr := executor.Invoke(callCtx, proposal)
			var result string
			if runErr == nil {
				if len(messages) != 1 {
					runErr = errors.New("LAKE 工具未返回唯一结果")
				} else {
					result = messages[0].Content
				}
			}
			if runErr != nil {
				body, _ := json.Marshal(map[string]string{"error": runErr.Error(), "status": "failed"})
				result = string(body)
			}
			result = strings.ReplaceAll(result, string(opts.APIKey), "[redacted]")
			failed := runErr != nil || resultFailed(result)
			preview, truncated := store.ExecutionPreview(result, 256*1024)
			result = preview
			if truncated {
				status := "completed"
				if failed {
					status = "failed"
				}
				body, _ := json.Marshal(map[string]any{"status": status, "truncated": true, "preview": preview})
				result = string(body)
			}
			emit(schema.ToolMessage(result, callID, schema.WithToolName(info.Name)))
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: result}}, IsError: failed}, nil
		})
	}
	proxy, err := modelProxy(opts, h.ToolNames)
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.Handle("/mcp", mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true}))
	mux.Handle("/model/", proxy)
	guard := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+h.Token)) != 1 && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Api-Key")), []byte(h.Token)) != 1 {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		mux.ServeHTTP(w, r)
	})
	h.listener, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	h.URL = "http://" + h.listener.Addr().String()
	h.server = &http.Server{Handler: guard, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	go func() { _ = h.server.Serve(h.listener) }()
	return h, nil
}

func (h *host) Close() { _ = h.server.Close() }

func toolFailure(message string) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: message}}}
}

func resultFailed(raw string) bool {
	var value struct {
		Error  string `json:"error"`
		Status string `json:"status"`
	}
	if json.Unmarshal([]byte(raw), &value) != nil {
		return false
	}
	return value.Error != "" || value.Status == "failed" || value.Status == "denied" || value.Status == "unknown"
}
