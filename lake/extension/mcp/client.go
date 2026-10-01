// Package mcpclient owns MCP transports so credentials never enter tool metadata.
package mcpclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

type Config struct {
	Transport string
	Command   string
	Args      []string
	URL       string
	SecretRef string
}

// SecretLoader reads a private MCP credential file at connection time.
type SecretLoader func(ref string) ([]byte, error)

type secrets struct {
	Env     map[string]string `json:"env"`
	Headers map[string]string `json:"headers"`
}

type connectOutcome struct {
	session *sdkmcp.ClientSession
	err     error
}

type headerTransport struct {
	base    http.RoundTripper
	headers map[string]string
}

func (t headerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	copy := req.Clone(req.Context())
	for name, value := range t.headers {
		copy.Header.Set(name, value)
	}
	return t.base.RoundTrip(copy)
}

func transportFor(cfg Config, load SecretLoader, ctx context.Context) (sdkmcp.Transport, error) {
	var secret secrets
	if cfg.SecretRef != "" {
		if load == nil {
			return nil, errors.New("MCP 凭据读取器未配置")
		}
		data, err := load(cfg.SecretRef)
		if err != nil {
			return nil, errors.New("MCP 凭据读取失败")
		}
		if len(data) > 65536 || len(data) > 0 && json.Unmarshal(data, &secret) != nil {
			return nil, errors.New("MCP 凭据格式无效")
		}
	}
	switch cfg.Transport {
	case "stdio":
		if strings.TrimSpace(cfg.Command) == "" {
			return nil, errors.New("MCP 启动命令为空")
		}
		cmd := exec.CommandContext(ctx, cfg.Command, cfg.Args...)
		// Do not inherit model API keys or unrelated process credentials.
		for _, key := range []string{"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "SystemRoot"} {
			if value, ok := os.LookupEnv(key); ok {
				cmd.Env = append(cmd.Env, key+"="+value)
			}
		}
		for name, value := range secret.Env {
			if strings.TrimSpace(name) == "" || strings.ContainsAny(name, "=\x00") {
				return nil, errors.New("MCP 环境变量名称无效")
			}
			cmd.Env = append(cmd.Env, name+"="+value)
		}
		return &sdkmcp.CommandTransport{Command: cmd, TerminateDuration: time.Second}, nil
	case "http":
		u, err := url.ParseRequestURI(cfg.URL)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"))) {
			return nil, errors.New("MCP URL 必须是 HTTPS，或本机 HTTP")
		}
		for name := range secret.Headers {
			if strings.TrimSpace(name) == "" || strings.ContainsAny(name, "\r\n:") {
				return nil, errors.New("MCP 请求头名称无效")
			}
		}
		httpClient := &http.Client{Timeout: 90 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		httpClient.Transport = headerTransport{base: http.DefaultTransport, headers: secret.Headers}
		return &sdkmcp.StreamableClientTransport{Endpoint: cfg.URL, HTTPClient: httpClient, DisableStandaloneSSE: true, MaxRetries: -1}, nil
	default:
		return nil, errors.New("未知 MCP 传输方式")
	}
}

// Connect negotiates the newest mutually supported SDK protocol version.
// SDK v1.7.0 supports 2026-07-28 and falls back for older servers.
func Connect(ctx context.Context, cfg Config, load SecretLoader) (*sdkmcp.ClientSession, func(), error) {
	sessionCtx, cancel := context.WithCancel(ctx)
	transport, err := transportFor(cfg, load, sessionCtx)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	client := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "lake", Version: "1.0.0"}, nil)
	ready := make(chan connectOutcome, 1)
	go func() {
		session, err := client.Connect(sessionCtx, transport, nil)
		ready <- connectOutcome{session, err}
	}()
	select {
	case result := <-ready:
		if result.err != nil {
			cancel()
			return nil, nil, errors.New("MCP 连接或协议协商失败")
		}
		return result.session, func() { _ = result.session.Close(); cancel() }, nil
	case <-time.After(8 * time.Second):
		cancel()
		go closeLate(ready)
		return nil, nil, errors.New("MCP 连接超时")
	case <-ctx.Done():
		cancel()
		go closeLate(ready)
		return nil, nil, ctx.Err()
	}
}

func closeLate(ready <-chan connectOutcome) {
	if result := <-ready; result.session != nil {
		_ = result.session.Close()
	}
}

func ListTools(ctx context.Context, session *sdkmcp.ClientSession) ([]*sdkmcp.Tool, error) {
	var tools []*sdkmcp.Tool
	cursor := ""
	for pageNumber := 0; pageNumber < 10; pageNumber++ {
		page, err := session.ListTools(ctx, &sdkmcp.ListToolsParams{Cursor: cursor})
		if err != nil {
			return nil, errors.New("MCP 工具发现失败")
		}
		if len(tools)+len(page.Tools) > 100 {
			return nil, errors.New("MCP 工具数量超限")
		}
		tools = append(tools, page.Tools...)
		if page.NextCursor == "" {
			return tools, nil
		}
		if page.NextCursor == cursor {
			return nil, errors.New("MCP 工具游标重复")
		}
		cursor = page.NextCursor
	}
	return nil, errors.New("MCP 工具分页超限")
}

func CallTool(ctx context.Context, session *sdkmcp.ClientSession, name string, arguments any) (*sdkmcp.CallToolResult, error) {
	if name == "" {
		return nil, fmt.Errorf("MCP 工具名称为空")
	}
	result, err := session.CallTool(ctx, &sdkmcp.CallToolParams{Name: name, Arguments: arguments})
	if err != nil {
		return nil, errors.New("MCP 工具调用失败")
	}
	return result, nil
}
