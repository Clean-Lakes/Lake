package zcode

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/schema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type hostFixture struct {
	calls  atomic.Int32
	callID atomic.Value
}

func (*hostFixture) Info(context.Context) (*schema.ToolInfo, error) {
	return &schema.ToolInfo{Name: "fixture", ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{})}, nil
}
func (f *hostFixture) InvokableRun(ctx context.Context, _ string, _ ...tool.Option) (string, error) {
	f.calls.Add(1)
	f.callID.Store(compose.GetToolCallID(ctx))
	data, _ := json.Marshal(map[string]any{"status": "failed", "error": "fixture failure", "stdout": strings.Repeat("x", 300*1024)})
	return string(data), nil
}

type hostAuthTransport struct{ token string }

func (tr hostAuthTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	request.Header.Set("Authorization", "Bearer "+tr.token)
	return http.DefaultTransport.RoundTrip(request)
}

func TestHostPreservesFailureWhenClippingAndStopsExecution(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fixture := &hostFixture{}
	var stopped atomic.Bool
	h, err := startHost(ctx, Options{APIType: "openai_chat", BaseURL: "http://127.0.0.1", APIKey: []byte("fixture-key"), Tools: []tool.BaseTool{fixture}, ToolStopReason: func(context.Context) string {
		if stopped.Load() {
			return "fixture tool execution stopped"
		}
		return ""
	}}, func(*schema.Message) {})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "fixture", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: h.URL + "/mcp", HTTPClient: &http.Client{Transport: hostAuthTransport{h.Token}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "fixture", Arguments: map[string]any{}})
	if err != nil || !result.IsError {
		t.Fatalf("clipped failure lost its error flag: %v", err)
	}
	if fixture.callID.Load() == "" {
		t.Fatal("original Lake tool-call context was lost")
	}
	var value struct {
		Status    string `json:"status"`
		Truncated bool   `json:"truncated"`
	}
	if err := json.Unmarshal([]byte(result.Content[0].(*mcp.TextContent).Text), &value); err != nil || value.Status != "failed" || !value.Truncated {
		t.Fatal("clipped result is not valid failure JSON")
	}
	stopped.Store(true)
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "fixture", Arguments: map[string]any{}})
	if err != nil || !result.IsError || fixture.calls.Load() != 1 {
		t.Fatal("stopped tool reached executor")
	}
}
