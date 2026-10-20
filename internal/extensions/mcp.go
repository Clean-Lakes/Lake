package extensions

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type connection struct {
	session     *mcp.ClientSession
	fingerprint string
	cancel      context.CancelFunc
}
type Manager struct {
	Store       *Store
	mu          sync.Mutex
	connections map[string]connection
	closed      bool
}

func (c connection) close() { c.cancel(); _ = c.session.Close() }
func NewManager(store *Store) *Manager {
	return &Manager{Store: store, connections: map[string]connection{}}
}
func (m *Manager) Invalidate(id string) {
	m.mu.Lock()
	v, ok := m.connections[id]
	delete(m.connections, id)
	m.mu.Unlock()
	if ok {
		v.close()
	}
}
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	old := m.connections
	m.connections = map[string]connection{}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, v := range old {
		wg.Add(1)
		go func(c connection) { defer wg.Done(); c.close() }(v)
	}
	wg.Wait()
}

type headerTransport struct {
	endpoint *url.URL
	headers  map[string]string
}

func (t headerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != t.endpoint.Scheme || r.URL.Host != t.endpoint.Host {
		return nil, errors.New("MCP 不允许跨站发送认证请求")
	}
	clone := r.Clone(r.Context())
	clone.Header = r.Header.Clone()
	for k, v := range t.headers {
		clone.Header.Set(k, v)
	}
	return http.DefaultTransport.RoundTrip(clone)
}
func connect(ctx context.Context, c Server) (*mcp.ClientSession, context.CancelFunc, error) {
	if err := ValidateServer(c); err != nil {
		return nil, nil, err
	}
	var transport mcp.Transport
	if c.Transport == "stdio" {
		cmd := exec.Command(c.Command, c.Args...)
		cmd.Env = os.Environ()
		cmd.Stderr = io.Discard
		for k, v := range c.Env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		transport = &mcp.CommandTransport{Command: cmd, TerminateDuration: time.Second}
	} else {
		endpoint, _ := url.Parse(c.URL)
		client := &http.Client{Transport: headerTransport{endpoint, c.Headers}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		if c.Transport == "sse" {
			transport = &mcp.SSEClientTransport{Endpoint: c.URL, HTTPClient: client}
		} else {
			transport = &mcp.StreamableClientTransport{Endpoint: c.URL, HTTPClient: client, MaxRetries: -1, DisableStandaloneSSE: true}
		}
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "Lake", Version: "1"}, &mcp.ClientOptions{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	lifetime, cancel := context.WithCancel(context.Background())
	stop := context.AfterFunc(ctx, cancel)
	session, err := client.Connect(lifetime, transport, &mcp.ClientSessionOptions{ProtocolVersion: c.ProtocolVersion})
	stop()
	if err != nil || ctx.Err() != nil {
		cancel()
		if session != nil {
			_ = session.Close()
		}
		return nil, nil, errors.New("无法连接 MCP，请检查地址、命令及认证配置")
	}
	return session, cancel, nil
}
func (m *Manager) session(ctx context.Context, c Server) (*mcp.ClientSession, error) {
	if !c.Enabled {
		return nil, errors.New("MCP 服务已停用")
	}
	fingerprint, _ := json.Marshal(c)
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, errors.New("MCP 已关闭")
	}
	if old, ok := m.connections[c.ID]; ok {
		if old.fingerprint == string(fingerprint) {
			return old.session, nil
		}
		old.close()
		delete(m.connections, c.ID)
	}
	session, cancel, err := connect(ctx, c)
	if err != nil {
		return nil, err
	}
	m.connections[c.ID] = connection{session, string(fingerprint), cancel}
	return session, nil
}
func list(ctx context.Context, session *mcp.ClientSession) ([]map[string]any, error) {
	rows := []map[string]any{}
	for tool, err := range session.Tools(ctx, nil) {
		if err != nil {
			return nil, errors.New("无法读取 MCP 工具列表")
		}
		if len(rows) >= 500 {
			return nil, errors.New("MCP 工具超过 500 个，请拆分服务")
		}
		rows = append(rows, map[string]any{"name": tool.Name, "description": tool.Description, "inputSchema": tool.InputSchema})
	}
	return rows, nil
}
func (m *Manager) Tools(ctx context.Context, id string, test bool) (any, error) {
	c, err := m.Store.FindServer(id)
	if err != nil {
		return nil, err
	}
	timeout := 12 * time.Second
	if c.TimeoutMS > 0 {
		timeout = time.Duration(c.TimeoutMS) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var session *mcp.ClientSession
	if test {
		var closeLifetime context.CancelFunc
		session, closeLifetime, err = connect(ctx, c)
		if err == nil {
			defer closeLifetime()
			defer session.Close()
		}
	} else {
		session, err = m.session(ctx, c)
	}
	if err != nil {
		return nil, err
	}
	rows, err := list(ctx, session)
	if err != nil {
		if !test {
			m.Invalidate(id)
		}
		return nil, err
	}
	return scrub(map[string]any{"serverId": id, "serverName": c.Name, "tools": rows, "count": len(rows)}, c), nil
}
func (m *Manager) Call(ctx context.Context, id, name string, args map[string]any) (any, error) {
	c, err := m.Store.FindServer(id)
	if err != nil {
		return nil, err
	}
	timeout := 60 * time.Second
	if c.TimeoutMS > 0 {
		timeout = time.Duration(c.TimeoutMS) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	session, err := m.session(ctx, c)
	if err != nil {
		return nil, err
	}
	rows, err := list(ctx, session)
	if err != nil {
		m.Invalidate(id)
		return nil, err
	}
	found := false
	for _, row := range rows {
		if row["name"] == name {
			found = true
			break
		}
	}
	if !found {
		return nil, errors.New("MCP 工具不存在，请重新查看工具列表")
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		m.Invalidate(id)
		return nil, errors.New("MCP 工具调用失败或已取消")
	}
	raw, err := json.Marshal(result)
	if err != nil || len(raw) > 2_000_000 {
		return nil, errors.New("MCP 返回内容过大或格式无效")
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil, errors.New("MCP 返回内容无效")
	}
	return scrub(value, c), nil
}
func scrub(value any, c Server) any {
	secrets := []string{}
	for _, v := range c.Headers {
		if v != "" {
			secrets = append(secrets, v)
			if strings.HasPrefix(strings.ToLower(v), "bearer ") {
				secrets = append(secrets, strings.TrimSpace(v[7:]))
			}
		}
	}
	for _, v := range c.Env {
		if v != "" {
			secrets = append(secrets, v)
		}
	}
	var clean func(any) any
	clean = func(v any) any {
		switch x := v.(type) {
		case string:
			for _, secret := range secrets {
				x = strings.ReplaceAll(x, secret, "[REDACTED]")
			}
			return x
		case map[string]any:
			out := map[string]any{}
			for k, v := range x {
				out[clean(k).(string)] = clean(v)
			}
			return out
		case []any:
			for i, v := range x {
				x[i] = clean(v)
			}
			return x
		case []map[string]any:
			for i, v := range x {
				x[i] = clean(v).(map[string]any)
			}
			return x
		default:
			return v
		}
	}
	return clean(value)
}
