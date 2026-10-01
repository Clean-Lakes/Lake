package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cloudwego/eino/lake/store"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestSourceZCodeKeepsLakeFrontendApprovalAndPersistence(t *testing.T) {
	if os.Getenv("LAKE_ZCODE_INTEGRATION") != "1" {
		t.Skip("Build bin/zcode and set LAKE_ZCODE_INTEGRATION=1")
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(cwd, "..", "..", "bin", "zcode")
	if os.Getenv("LAKE_ZCODE_CLI") == "" {
		t.Setenv("LAKE_ZCODE_CLI", filepath.Join(path, "zcode.cjs"))
	}
	if os.Getenv("LAKE_ZCODE_NODE") == "" {
		t.Setenv("LAKE_ZCODE_NODE", filepath.Join(path, "node"))
	}
	for _, approve := range []bool{true, false} {
		t.Run(fmt.Sprintf("approve=%t", approve), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			root := t.TempDir()
			db, err := store.Open(ctx, root)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			lake, err := db.CreateLake(ctx, "fixture-lake", "")
			if err != nil {
				t.Fatal(err)
			}
			if err := db.UseLake(ctx, lake.ID); err != nil {
				t.Fatal(err)
			}
			conversation, err := db.CreateConversation(ctx, lake.Name)
			if err != nil {
				t.Fatal(err)
			}
			var executions, requests atomic.Int32
			tools := mcp.NewServer(&mcp.Implementation{Name: "fixture", Version: "1"}, nil)
			mcp.AddTool(tools, &mcp.Tool{Name: "inspect"}, func(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, map[string]string, error) {
				executions.Add(1)
				return nil, map[string]string{"hostname": "fixture-host"}, nil
			})
			toolServer := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return tools }, nil))
			defer toolServer.Close()
			callSettings(t, root, settingsRequest{Action: "mcp_save", Server: mcpServerConfig{Name: "fixture", Transport: "http", URL: toolServer.URL, Enabled: true}})
			modelServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer test-key" {
					t.Error("host did not use vault-backed model credentials")
				}
				var body struct {
					Tools []struct {
						Function struct {
							Name string `json:"name"`
						} `json:"function"`
					} `json:"tools"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				found := false
				for _, tool := range body.Tools {
					if !strings.HasPrefix(tool.Function.Name, "mcp__lake__") {
						t.Error("foreign tool offered")
					}
					if tool.Function.Name == "mcp__lake__mcp_fixture_inspect" {
						found = true
					}
				}
				if !found {
					t.Error("Lake tool registry not exported")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				chunk := func(delta any, finish any) {
					data, _ := json.Marshal(map[string]any{"id": "fixture", "object": "chat.completion.chunk", "created": 1, "model": "fixture-model", "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
					fmt.Fprintf(w, "data: %s\n\n", data)
				}
				if requests.Add(1) == 1 {
					chunk(map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "call_fixture", "type": "function", "function": map[string]string{"name": "mcp__lake__mcp_fixture_inspect", "arguments": "{}"}}}}, nil)
					chunk(map[string]any{}, "tool_calls")
				} else {
					chunk(map[string]any{"role": "assistant", "content": "fixture result"}, nil)
					chunk(map[string]any{}, "stop")
				}
				fmt.Fprint(w, "data: [DONE]\n\n")
			}))
			defer modelServer.Close()
			if err := saveModelConfig(root, lakeModelConfig{Model: "fixture-model", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: modelServer.URL + "/v1", WireAPI: "openai_chat"}}}); err != nil {
				t.Fatal(err)
			}
			previous := modelKeys
			modelKeys = fakeModelKeys{}
			t.Cleanup(func() { modelKeys = previous })
			reader, input := io.Pipe()
			defer input.Close()
			sink := bridgeEventSink{events: make(chan bridgeEvent, 128)}
			done := make(chan error, 1)
			go func() { done <- runBridgeConversationRuntime(ctx, root, conversation.ID, reader, sink, "zcode") }()
			io.WriteString(input, "{\"type\":\"hello\",\"version\":1}\n{\"type\":\"ask\",\"id\":\"fixture-turn\",\"prompt\":\"检查一次\"}\n")
			var approved, started, finished, result bool
			for !result {
				select {
				case event := <-sink.events:
					switch event.Type {
					case "approval":
						if event.ID != "fixture-turn" || event.Kind != "mcp" {
							t.Fatal("existing approval contract changed")
						}
						approved = true
						fmt.Fprintf(input, "{\"type\":\"approve\",\"id\":\"fixture-turn\",\"approved\":%t}\n", approve)
					case "mcp_tool":
						if event.Status == "running" {
							started = true
						} else if event.Status == "completed" || event.Status == "failed" {
							finished = true
						}
					case "result":
						if event.ID != "fixture-turn" || event.Error != "" || !strings.Contains(event.Text, "fixture result") {
							t.Fatalf("unexpected result: %+v", event)
						}
						result = true
					case "fatal":
						t.Fatalf("ZCode bridge failed: %s", event.Error)
					}
				case err := <-done:
					t.Fatalf("bridge exited early: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
			want := int32(0)
			if approve {
				want = 1
			}
			if !approved || !started || !finished || executions.Load() != want || requests.Load() != 2 {
				t.Fatalf("approval=%t start=%t finish=%t executions=%d models=%d", approved, started, finished, executions.Load(), requests.Load())
			}
			input.Close()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			turns, err := db.ListConversationTurns(ctx, conversation.ID)
			if err != nil || len(turns) != 1 || !strings.Contains(turns[0].Answer, "fixture result") {
				t.Fatal("conversation result not persisted")
			}
			events, err := db.ListAgentEvents(ctx, conversation.ID, 0, 100)
			if err != nil {
				t.Fatal(err)
			}
			var decision, end bool
			for _, event := range events {
				if event.Kind == "tool_decision" {
					decision = true
				}
				if event.Kind == "tool_finished" {
					end = true
				}
			}
			if !decision || !end {
				t.Fatal("approval/tool history cannot be restored")
			}
		})
	}
}
