package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cloudwego/eino/lake/store"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type bridgeEventSink struct{ events chan bridgeEvent }

func (s bridgeEventSink) Write(data []byte) (int, error) {
	var event bridgeEvent
	if err := json.Unmarshal(data, &event); err != nil {
		return 0, err
	}
	s.events <- event
	return len(data), nil
}

func TestBridgeDisplaysMCPCallLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	mcpServer := mcp.NewServer(&mcp.Implementation{Name: "knowledge", Version: "1"}, nil)
	var calls atomic.Int32
	mcp.AddTool(mcpServer, &mcp.Tool{Name: "list_collections"}, func(_ context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, struct {
		Names []string `json:"names"`
	}, error) {
		calls.Add(1)
		return nil, struct {
			Names []string `json:"names"`
		}{Names: []string{"runbooks"}}, nil
	})
	httpMCP := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return mcpServer }, nil))
	defer httpMCP.Close()
	callSettings(t, root, settingsRequest{Action: "mcp_save", Server: mcpServerConfig{Name: "zmy", Transport: "http", URL: httpMCP.URL, Enabled: true}})
	var requests atomic.Int32
	modelServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if requests.Add(1) == 1 {
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"我来查知识库。"},{"type":"tool_use","id":"toolu-mcp","name":"mcp_zmy_list_collections","input":{}}]}`))
		} else {
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"找到了 runbooks。"}]}`))
		}
	}))
	defer modelServer.Close()
	if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: modelServer.URL + "/anthropic", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	previousKeys := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = previousKeys })
	reader, input := io.Pipe()
	defer input.Close()
	output := bridgeEventSink{events: make(chan bridgeEvent, 64)}
	done := make(chan error, 1)
	go func() { done <- runBridgeConversation(ctx, root, conversation.ID, reader, output) }()
	if _, err := io.WriteString(input, `{"type":"ask","id":"mcp-turn","prompt":"查看知识库"}`+"\n"); err != nil {
		t.Fatal(err)
	}
	var stepSeen, startSeen, endSeen, resultSeen bool
	for !resultSeen {
		select {
		case event := <-output.events:
			switch event.Type {
			case "assistant_step":
				stepSeen = strings.Contains(event.Text, "查知识库")
			case "mcp_tool":
				if event.ToolCallID != "toolu-mcp" || event.MCPServer != "zmy" || event.MCPTool != "list_collections" {
					t.Fatalf("MCP display metadata: %+v", event)
				}
				if event.Status == "running" {
					startSeen = true
				} else if event.Status == "completed" {
					endSeen = true
				}
			case "approval":
				if event.Kind != "mcp" {
					t.Fatalf("unexpected approval: %+v", event)
				}
				if _, err := io.WriteString(input, `{"type":"approve","id":"mcp-turn","approved":true}`+"\n"); err != nil {
					t.Fatal(err)
				}
			case "result":
				resultSeen = true
				if event.Error != "" || !strings.Contains(event.Text, "找到了 runbooks") {
					t.Fatalf("MCP answer: %+v", event)
				}
			case "fatal":
				t.Fatalf("bridge failed: %+v", event)
			}
		case err := <-done:
			t.Fatalf("bridge ended early: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if !stepSeen || !startSeen || !endSeen || calls.Load() != 1 || requests.Load() != 2 {
		t.Fatalf("incomplete MCP lifecycle: step=%t start=%t end=%t calls=%d requests=%d", stepSeen, startSeen, endSeen, calls.Load(), requests.Load())
	}
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	events, err := s.ListAgentEvents(ctx, conversation.ID, 0, 30)
	if err != nil {
		t.Fatal(err)
	}
	var proposed, finished, explanation bool
	for _, event := range events {
		if event.Kind == "assistant_progress" {
			explanation = true
		}
		if event.ToolCallID == "toolu-mcp" && event.Kind == "tool_proposed" && strings.Contains(string(event.Payload), `"mcp_server":"zmy"`) {
			proposed = true
		}
		if event.ToolCallID == "toolu-mcp" && event.Kind == "tool_finished" {
			finished = true
		}
	}
	if !explanation || !proposed || !finished {
		t.Fatalf("MCP timeline missing: explanation=%t proposed=%t finished=%t", explanation, proposed, finished)
	}
}
