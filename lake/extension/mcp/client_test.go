package mcpclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

func testServer() *sdkmcp.Server {
	server := sdkmcp.NewServer(&sdkmcp.Implementation{Name: "lake-test", Version: "1"}, nil)
	sdkmcp.AddTool(server, &sdkmcp.Tool{Name: "echo"}, func(_ context.Context, _ *sdkmcp.CallToolRequest, input struct {
		Value string `json:"value"`
	}) (*sdkmcp.CallToolResult, struct {
		Value string `json:"value"`
	}, error) {
		return nil, struct {
			Value string `json:"value"`
		}{Value: input.Value}, nil
	})
	return server
}

func TestHTTPProtocolNegotiationAndCredentials(t *testing.T) {
	for _, tc := range []struct {
		name, version string
		stateless     bool
	}{
		{"modern", "2026-07-28", true},
		{"legacy", "2025-11-25", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := testServer()
			var gotHeader string
			handler := sdkmcp.NewStreamableHTTPHandler(func(*http.Request) *sdkmcp.Server { return server }, &sdkmcp.StreamableHTTPOptions{Stateless: tc.stateless})
			httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotHeader = r.Header.Get("Authorization")
				handler.ServeHTTP(w, r)
			}))
			defer httpServer.Close()
			secret := "Bearer test-token"
			loadCount := 0
			load := func(ref string) ([]byte, error) {
				if ref != "demo" {
					t.Fatalf("secret ref = %q", ref)
				}
				loadCount++
				return json.Marshal(map[string]any{"headers": map[string]string{"Authorization": secret}})
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			session, closeSession, err := Connect(ctx, Config{Transport: "http", URL: httpServer.URL, SecretRef: "demo"}, load)
			if err != nil {
				t.Fatal(err)
			}
			defer closeSession()
			if got := session.InitializeResult().ProtocolVersion; got != tc.version {
				t.Fatalf("protocol = %s, want %s", got, tc.version)
			}
			tools, err := ListTools(ctx, session)
			if err != nil || len(tools) != 1 || tools[0].Name != "echo" {
				t.Fatalf("tools = %+v, error = %v", tools, err)
			}
			result, err := CallTool(ctx, session, "echo", map[string]string{"value": "ok"})
			encoded, _ := json.Marshal(result)
			if err != nil || !strings.Contains(string(encoded), "ok") {
				t.Fatalf("result = %+v, error = %v", result, err)
			}
			if gotHeader != secret || loadCount != 1 {
				t.Fatalf("credential transport failed: header=%t loads=%d", gotHeader == secret, loadCount)
			}
			closeSession()
			if _, err := CallTool(ctx, session, "echo", map[string]string{}); err == nil {
				t.Fatal("closed session accepted tool call")
			}
		})
	}
}

func TestStdioCredentialIsolation(t *testing.T) {
	if os.Getenv("LAKE_MCP_TEST_HELPER") == "1" {
		server := sdkmcp.NewServer(&sdkmcp.Implementation{Name: "stdio-test", Version: "1"}, nil)
		sdkmcp.AddTool(server, &sdkmcp.Tool{Name: "environment"}, func(_ context.Context, _ *sdkmcp.CallToolRequest, _ struct{}) (*sdkmcp.CallToolResult, struct {
			Allowed bool `json:"allowed"`
			Blocked bool `json:"blocked"`
		}, error) {
			return nil, struct {
				Allowed bool `json:"allowed"`
				Blocked bool `json:"blocked"`
			}{os.Getenv("LAKE_MCP_TEST_HELPER") == "1", os.Getenv("LAKE_MCP_PARENT_SECRET") != ""}, nil
		})
		session, err := server.Connect(context.Background(), &sdkmcp.StdioTransport{}, nil)
		if err == nil {
			_ = session.Wait()
		}
		return
	}
	t.Setenv("LAKE_MCP_PARENT_SECRET", "test-only-secret")
	cmd, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	session, closeSession, err := Connect(ctx, Config{Transport: "stdio", Command: cmd, Args: []string{"-test.run=^TestStdioCredentialIsolation$"}, SecretRef: "helper"}, func(string) ([]byte, error) {
		return []byte(`{"env":{"LAKE_MCP_TEST_HELPER":"1"}}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer closeSession()
	result, err := CallTool(ctx, session, "environment", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(result)
	if !strings.Contains(string(data), `"allowed":true`) || !strings.Contains(string(data), `"blocked":false`) {
		t.Fatalf("stdio environment boundary: %s", data)
	}
}

func TestConnectionErrorDoesNotExposeCredential(t *testing.T) {
	secret := "Bearer test-only-connection-secret"
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != secret {
			t.Error("transport did not send credential")
		}
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(secret))
	}))
	defer httpServer.Close()
	_, _, err := Connect(context.Background(), Config{Transport: "http", URL: httpServer.URL, SecretRef: "demo"}, func(string) ([]byte, error) {
		return json.Marshal(map[string]any{"headers": map[string]string{"Authorization": secret}})
	})
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("connection error exposed credential: %v", err)
	}
}

func TestTransportRejectsUnsafeEndpointsAndSecretErrors(t *testing.T) {
	for _, endpoint := range []string{
		"http://127.0.0.1.evil.invalid/mcp",
		"http://169.254.169.254/mcp",
		"https://user:pass@example.invalid/mcp",
		"https://example.invalid/mcp?token=synthetic-secret",
	} {
		if _, err := transportFor(Config{Transport: "http", URL: endpoint}, nil, context.Background()); err == nil || strings.Contains(err.Error(), "synthetic-secret") {
			t.Fatalf("unsafe endpoint %q accepted or leaked: %v", endpoint, err)
		}
	}
	const marker = "synthetic-mcp-secret"
	_, err := transportFor(Config{Transport: "http", URL: "https://example.invalid/mcp", SecretRef: "fixture"}, func(string) ([]byte, error) {
		return nil, errors.New(marker)
	}, context.Background())
	if err == nil || strings.Contains(err.Error(), marker) {
		t.Fatalf("secret loader error leaked: %v", err)
	}
	_, err = transportFor(Config{Transport: "http", URL: "https://example.invalid/mcp", SecretRef: "fixture"}, func(string) ([]byte, error) {
		return []byte(`{"headers":{"Authorization":"` + marker + `"}}`), nil
	}, context.Background())
	if err != nil {
		t.Fatal(err)
	}
}
