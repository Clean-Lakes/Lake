package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cloudwego/eino/components/tool"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func callSettings(t *testing.T, root string, req any) string {
	t.Helper()
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := settingsCommand(root, bytes.NewReader(data), &out); err != nil {
		t.Fatal(err)
	}
	return out.String()
}

func TestSettingsModelPromptAndMCPPersistence(t *testing.T) {
	root := t.TempDir()
	key := "test-only-secret-value"
	callSettings(t, root, settingsRequest{Action: "model_save", Model: "test-model", Provider: "test", BaseURL: "https://example.com/anthropic", APIKey: key})
	callSettings(t, root, settingsRequest{Action: "prompt_save", Name: "ssh", Prompt: "先简述结果", Description: "远程巡检专员"})
	callSettings(t, root, settingsRequest{Action: "mcp_save", Server: mcpServerConfig{Name: "demo", Transport: "http", URL: "https://example.com/mcp", Headers: map[string]string{"Authorization": "Bearer test-only"}, Enabled: true}})
	listed := callSettings(t, root, settingsRequest{Action: "get"})
	if strings.Contains(listed, key) || strings.Contains(listed, "Bearer test-only") {
		t.Fatal("settings list exposed a credential")
	}
	if !strings.Contains(listed, `"has_key":true`) {
		t.Fatal("model key presence missing")
	}
	if got := agentPrompt(root, "ssh"); got != "先简述结果" {
		t.Fatalf("prompt = %q", got)
	}
	if got := agentDescription(root, "ssh", "default"); got != "远程巡检专员" {
		t.Fatalf("description = %q", got)
	}
	servers, err := configuredMCPServers(root)
	if err != nil || len(servers) != 1 || servers[0].SecretRef != "demo" || len(servers[0].Headers) != 0 {
		t.Fatal("MCP credential reference was not persisted")
	}
	settingsFile, err := os.ReadFile(filepath.Join(root, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(settingsFile, []byte("Bearer test-only")) {
		t.Fatal("MCP credentials leaked into settings.json")
	}
	for _, path := range []string{"config.toml", "settings.json"} {
		info, err := os.Stat(filepath.Join(root, path))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatalf("%s permissions = %o", path, info.Mode().Perm())
		}
	}
	secretFile, err := os.Stat(filepath.Join(root, "secrets", "mcp", "demo"))
	if err != nil || secretFile.Mode().Perm() != 0600 {
		t.Fatalf("MCP secret permissions: %v %v", secretFile, err)
	}
}

func TestMCPToolDiscoveryAndInvocation(t *testing.T) {
	ctx := context.Background()
	server := mcp.NewServer(&mcp.Implementation{Name: "demo", Version: "1"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "echo", Description: "Echo a value"}, func(_ context.Context, _ *mcp.CallToolRequest, input struct {
		Value string `json:"value"`
	}) (*mcp.CallToolResult, struct {
		Value string `json:"value"`
	}, error) {
		return nil, struct {
			Value string `json:"value"`
		}{Value: input.Value}, nil
	})
	clientSide, serverSide := mcp.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverSide, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer serverSession.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "lake-test", Version: "1"}, nil)
	session, err := client.Connect(ctx, clientSide, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	tools, err := listMCPTools(ctx, session)
	if err != nil || len(tools) != 1 {
		t.Fatalf("discovered %d tools: %v", len(tools), err)
	}
	wrapped, err := makeMCPTool(mcpServerConfig{Name: "demo"}, session, tools[0], func(_, _, _ string) (bool, error) { return true, nil })
	if err != nil {
		t.Fatal(err)
	}
	info, err := wrapped.Info(ctx)
	if err != nil || info.Name != "mcp_demo_echo" {
		t.Fatalf("tool info: %+v, %v", info, err)
	}
	result, err := wrapped.InvokableRun(ctx, `{"value":"hello"}`)
	if err != nil || !strings.Contains(result, "hello") {
		t.Fatalf("call: %s %v", result, err)
	}
}

func TestMCPHTTPConnectionSurvivesInitialization(t *testing.T) {
	server := mcp.NewServer(&mcp.Implementation{Name: "demo", Version: "1"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "ping"}, func(_ context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, struct{}, error) {
		return nil, struct{}{}, nil
	})
	httpServer := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil))
	defer httpServer.Close()
	session, closeSession, err := connectMCP(context.Background(), mcpServerConfig{Name: "demo", Transport: "http", URL: httpServer.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer closeSession()
	tools, err := listMCPTools(context.Background(), session)
	if err != nil || len(tools) != 1 || tools[0].Name != "ping" {
		t.Fatalf("tools=%+v err=%v", tools, err)
	}
	root := t.TempDir()
	callSettings(t, root, settingsRequest{Action: "mcp_save", Server: mcpServerConfig{Name: "demo", Transport: "http", URL: httpServer.URL, Enabled: true}})
	registered, cleanup, warnings := loadMCPTools(context.Background(), root, func(_, _, _ string) (bool, error) { return true, nil })
	defer cleanup()
	if len(warnings) != 0 || len(registered) != 1 {
		t.Fatalf("registered=%d warnings=%v", len(registered), warnings)
	}
	if _, err := registered[0].(tool.InvokableTool).InvokableRun(context.Background(), `{}`); err != nil {
		t.Fatal(err)
	}
}

func TestMCPToolDeniedBeforeRemoteCall(t *testing.T) {
	ctx := context.Background()
	server := mcp.NewServer(&mcp.Implementation{Name: "demo", Version: "1"}, nil)
	var calls atomic.Int32
	mcp.AddTool(server, &mcp.Tool{Name: "write"}, func(_ context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, struct{}, error) {
		calls.Add(1)
		return nil, struct{}{}, nil
	})
	clientSide, serverSide := mcp.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverSide, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer serverSession.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "lake-test", Version: "1"}, nil)
	session, err := client.Connect(ctx, clientSide, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	remote, err := listMCPTools(ctx, session)
	if err != nil || len(remote) != 1 {
		t.Fatalf("tools=%v err=%v", remote, err)
	}
	wrapped, err := makeMCPTool(mcpServerConfig{Name: "demo"}, session, remote[0], func(_, _, _ string) (bool, error) { return false, nil })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wrapped.InvokableRun(ctx, `{}`); err == nil || calls.Load() != 0 {
		t.Fatalf("denied MCP call reached server: calls=%d err=%v", calls.Load(), err)
	}
}
