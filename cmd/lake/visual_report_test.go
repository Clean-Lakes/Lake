package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/store"
)

func TestBridgePresentationUsesA2UIAndRetainsFactsInContext(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "reports", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	messages := uiCreate("health", []map[string]any{
		{"id": "root", "component": "Card", "title": "健康覆盖", "children": []string{"metric", "source"}},
		{"id": "metric", "component": "Metric", "label": "未检查健康", "value": uiBinding("/count")},
		{"id": "source", "component": "Text", "text": uiBinding("/source")},
	}, map[string]any{"count": "8", "source": "token=fixture-secret"})
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid model request")
		}
		w.Header().Set("Content-Type", "application/json")
		call := calls.Add(1)
		if call == 1 {
			tools, _ := json.Marshal(body["tools"])
			if !bytes.Contains(tools, []byte("lake_ui")) || bytes.Contains(tools, []byte("lake_visual_report")) {
				t.Error("A2UI and legacy report catalogs were not separated")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"content": []any{map[string]any{"type": "tool_use", "id": "missing-fields", "name": "lake_ui", "input": map[string]any{"root": "root", "elements": map[string]any{}}}}, "stop_reason": "tool_use"})
			return
		}
		if call == 2 {
			context, _ := json.Marshal(body["messages"])
			if !bytes.Contains(context, []byte("invalid_ui")) || !bytes.Contains(context, []byte("不重新执行命令")) {
				t.Error("invalid UI did not return correction feedback")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"content": []any{map[string]any{"type": "tool_use", "id": fmt.Sprintf("ui-tool-%d", call), "name": "lake_ui", "input": uiToolInput{Messages: messages}}}, "stop_reason": "tool_use"})
			return
		}
		if call == 4 {
			messages, _ := json.Marshal(body["messages"])
			if !bytes.Contains(messages, []byte("未检查健康")) || bytes.Contains(messages, []byte("fixture-secret")) {
				t.Error("follow-up lost report facts or retained sensitive input")
			}
		}
		if call == 5 {
			tools, _ := body["tools"].([]any)
			if len(tools) != 4 {
				t.Errorf("review mode exposed %d tools, want 4", len(tools))
			}
			for _, candidate := range tools {
				info, _ := candidate.(map[string]any)
				name, _ := info["name"].(string)
				switch name {
				case "lake_ui", "lake_workflow_status", "lake_workflow_v2_status", "lake_conversation_history":
				default:
					t.Errorf("review mode exposed tool %q", name)
				}
			}
		}
		if call == 6 {
			tools, _ := json.Marshal(body["tools"])
			if !bytes.Contains(tools, []byte("lake_workflow_run")) {
				t.Error("review mode changed subsequent normal turn tools")
			}
		}
		_, _ = io.WriteString(w, `{"content":[{"type":"text","text":"请优先补齐健康检查。"}],"stop_reason":"end_turn"}`)
	}))
	defer server.Close()
	if err = saveModelConfig(root, lakeModelConfig{Model: "report-model", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL, WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	input, send := io.Pipe()
	output, write := io.Pipe()
	defer output.Close()
	defer send.Close()
	events := make(chan bridgeEvent, 64)
	go func() {
		decoder := json.NewDecoder(output)
		for {
			var event bridgeEvent
			if decoder.Decode(&event) != nil {
				return
			}
			events <- event
		}
	}()
	done := make(chan error, 1)
	go func() { done <- runBridgeConversation(ctx, root, conversation.ID, input, write); write.Close() }()
	next := func() bridgeEvent {
		select {
		case e := <-events:
			return e
		case <-ctx.Done():
			t.Fatal(ctx.Err())
			return bridgeEvent{}
		}
	}
	if next().Type != "ready" {
		t.Fatal("bridge not ready")
	}
	encoder := json.NewEncoder(send)
	if err = encoder.Encode(bridgeRequest{Type: "ask", ID: "turn", Prompt: "图形化显示检查结果"}); err != nil {
		t.Fatal(err)
	}
	seen := false
	for {
		event := next()
		if event.Type == "a2ui" {
			seen = true
			if event.ID != "turn" || event.UI == nil || event.UI.Data["count"] != "8" || event.UI.Data["source"] != "[redacted]" || event.UI.Components[0]["title"] != "健康覆盖" {
				t.Fatal("invalid displayed report")
			}
		}
		if event.Type == "result" {
			if !seen || event.Error != "" {
				t.Fatal("report missing or turn failed", event.Error)
			}
			break
		}
	}
	if err = encoder.Encode(bridgeRequest{Type: "ask", ID: "follow-up", Prompt: "刚才有多少个尚未确认健康？"}); err != nil {
		t.Fatal(err)
	}
	for {
		event := next()
		if event.Type == "result" {
			if event.ID != "follow-up" || event.Error != "" {
				t.Fatal("follow-up failed")
			}
			break
		}
	}
	for _, request := range []bridgeRequest{
		{Type: "ask", ID: "review", Prompt: "重新整理已有检查结果", ReviewOnly: true},
		{Type: "ask", ID: "normal", Prompt: "还有哪些工作流？"},
	} {
		if err = encoder.Encode(request); err != nil {
			t.Fatal(err)
		}
		for {
			event := next()
			if event.Type == "result" {
				if event.ID != request.ID || event.Error != "" {
					t.Fatal("review or subsequent turn failed", event.Error)
				}
				break
			}
		}
	}
	if err = encoder.Encode(bridgeRequest{Type: "close"}); err != nil {
		t.Fatal(err)
	}
	send.Close()
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	persisted, err := s.ListAgentEvents(ctx, conversation.ID, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	count, rejected := 0, 0
	for _, e := range persisted {
		if e.Kind == "tool_finished" && e.ToolCallID == "missing-fields" {
			var payload map[string]any
			_ = json.Unmarshal(e.Payload, &payload)
			if payload["status"] != "failed" || payload["error_code"] != "invalid_ui" || len(payload) != 3 {
				t.Fatal("format failure category missing or raw arguments persisted")
			}
			rejected++
		}
		if e.Kind == "a2ui" {
			count++
			if bytes.Contains(e.Payload, []byte("fixture-secret")) {
				t.Fatal("secret stored")
			}
		}
	}
	if count != 1 || rejected != 1 || calls.Load() != 6 {
		t.Fatal("report not durable")
	}
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 4 {
		t.Fatal("turn lost", err)
	}
	if !strings.Contains(turns[0].Answer, "未检查健康") || strings.Contains(turns[0].Display, "metrics") {
		t.Fatal("model facts lost or UI contains JSON")
	}
}

func TestReportCorrectionKeepsValidationAndOperationalErrors(t *testing.T) {
	ctx := context.Background()
	presented := 0
	operational := errors.New("fixture persistence failure")
	base, err := newVisualReportTool(func(context.Context, agent.VisualReport) error { presented++; return operational })
	if err != nil {
		t.Fatal(err)
	}
	registered, err := registerChatTools(ctx, []tool.BaseTool{base}, "fixture-lake")
	if err != nil {
		t.Fatal(err)
	}
	reportTool := registered[0].(tool.InvokableTool)
	for _, arguments := range []string{`{}`, `{"root":"root","elements":{}}`, `not json`, `{"title":"结果","summary":"待确认","tone":"info","metrics":[{"label":"指标","value":"","tone":"info"}]}`, `{"title":"结果","summary":"待确认","tone":"info","metrics":[{"label":"指标","value":"1","tone":"info"}],"ui":{"root":"card","elements":{"card":{"type":"HTML","props":{}}}}}`} {
		output, err := reportTool.InvokableRun(ctx, arguments)
		if err != nil {
			t.Fatalf("presentation error interrupted the agent: %v", err)
		}
		var result visualReportResult
		if json.Unmarshal([]byte(output), &result) != nil || result.Displayed || result.Error != "invalid_report" || !strings.Contains(result.Message, "不重新运行工作流") {
			t.Fatal("missing correction feedback", output)
		}
	}
	if presented != 0 {
		t.Fatal("invalid data reached presentation")
	}
	valid := `{"title":"结果","summary":"一项待确认","tone":"unknown","metrics":[{"label":"待确认","value":"1","tone":"unknown"}]}`
	if _, err := reportTool.InvokableRun(ctx, valid); !errors.Is(err, operational) {
		t.Fatal("persistence failure swallowed", err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := reportTool.InvokableRun(canceled, `{}`); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation swallowed", err)
	}
}
