package model

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	einomodel "github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
)

func TestAnthropicToolRoundTrip(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/anthropic/v1/messages" || r.Header.Get("x-api-key") != "test-key" || r.Header.Get("anthropic-version") != "2023-06-01" {
			t.Errorf("unexpected request path or headers")
		}
		var req struct {
			Model    string            `json:"model"`
			Messages []json.RawMessage `json:"messages"`
			Tools    []json.RawMessage `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		if req.Model != "mimo-v2.6-pro" || len(req.Tools) != 1 {
			t.Errorf("request model/tools incorrect")
		}
		w.Header().Set("Content-Type", "application/json")
		if calls == 1 {
			_, _ = w.Write([]byte(`{"content":[{"type":"thinking","thinking":"reason","signature":"sig"},{"type":"tool_use","id":"toolu_1","name":"lake_ssh","input":{"resource":"host","check":"uptime"}}],"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}`))
			return
		}
		body, _ := json.Marshal(req.Messages)
		if !strings.Contains(string(body), "tool_result") || !strings.Contains(string(body), "signature") {
			t.Errorf("tool result or thinking signature missing in second request")
		}
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"主机正常"}],"usage":{"input_tokens":120,"output_tokens":30}}`))
	}))
	defer server.Close()
	meter := &UsageMeter{}
	adapter := &Anthropic{BaseURL: server.URL + "/anthropic", Model: "mimo-v2.6-pro", APIKey: []byte("test-key"), Usage: meter}
	tool := &schema.ToolInfo{Name: "lake_ssh", Desc: "Inspect a host"}
	first, err := adapter.Generate(context.Background(), []*schema.Message{schema.UserMessage("检查主机")}, einomodel.WithTools([]*schema.ToolInfo{tool}))
	if err != nil {
		t.Fatal(err)
	}
	if len(first.ToolCalls) != 1 || first.ToolCalls[0].Function.Name != "lake_ssh" {
		t.Fatalf("tool call = %+v", first.ToolCalls)
	}
	if first.ResponseMeta == nil || first.ResponseMeta.Usage == nil || first.ResponseMeta.Usage.TotalTokens != 135 {
		t.Fatalf("first response usage = %+v", first.ResponseMeta)
	}
	second, err := adapter.Generate(context.Background(), []*schema.Message{
		schema.UserMessage("检查主机"), first, schema.ToolMessage("uptime 1 day", "toolu_1"),
	}, einomodel.WithTools([]*schema.ToolInfo{tool}))
	if err != nil {
		t.Fatal(err)
	}
	if second.Content != "主机正常" || calls != 2 {
		t.Fatalf("second response = %+v, calls=%d", second, calls)
	}
	usage := meter.Snapshot()
	if usage.Calls != 2 || usage.ReportedCalls != 2 || usage.ModelDuration <= 0 || usage.TotalInputTokens() != 235 || usage.OutputTokens != 50 || usage.TotalTokens() != 285 {
		t.Fatalf("meter = %+v", usage)
	}
}

func TestAnthropicStreamsTextToolAndUsage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if string(body["stream"]) != "true" {
			t.Error("stream flag missing")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hel\"}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call-3\",\"name\":\"inspect\",\"input\":{}}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"host\\\":\\\"web\\\"}\"}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":5}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"message_stop\"}\n\n")
	}))
	defer server.Close()
	meter := &UsageMeter{}
	adapter := &Anthropic{BaseURL: server.URL, Model: "test", APIKey: []byte("test-key"), Usage: meter}
	stream, err := adapter.Stream(context.Background(), []*schema.Message{schema.UserMessage("check")})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	var text string
	var calls []schema.ToolCall
	var chunks []*schema.Message
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		text += chunk.Content
		calls = append(calls, chunk.ToolCalls...)
		chunks = append(chunks, chunk)
	}
	if text != "hello" || len(calls) != 1 || calls[0].Function.Arguments != `{"host":"web"}` {
		t.Fatalf("text=%q calls=%+v", text, calls)
	}
	if meter.Snapshot().TotalTokens() != 15 {
		t.Fatalf("usage=%+v", meter.Snapshot())
	}
	merged, err := schema.ConcatMessages(chunks)
	if err != nil || merged.Content != text || len(merged.ToolCalls) != 1 || merged.ResponseMeta == nil || merged.ResponseMeta.Usage.TotalTokens != 15 {
		t.Fatalf("merged=%+v err=%v", merged, err)
	}
}

func TestAnthropicEstimatesUsageWhenProviderOmitsIt(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"The requested answer has several words."}]}`))
	}))
	defer server.Close()
	meter := &UsageMeter{}
	adapter := &Anthropic{BaseURL: server.URL + "/anthropic", Model: "test-model", APIKey: []byte("test-key"), Usage: meter}
	if _, err := adapter.Generate(context.Background(), []*schema.Message{schema.UserMessage("Explain the server status")}); err != nil {
		t.Fatal(err)
	}
	usage := meter.Snapshot()
	if usage.Calls != 1 || usage.ReportedCalls != 0 || usage.EstimatedCalls != 1 || usage.EstimatedInputTokens == 0 || usage.EstimatedOutputTokens == 0 || usage.TotalTokens() == 0 {
		t.Fatalf("missing usage was not estimated: %+v", usage)
	}
}

func TestAnthropicEncodesImageAsBase64ContentBlock(t *testing.T) {
	data := "iVBORw0KGgo="
	message := schema.UserMessage("图里有什么")
	message.UserInputMultiContent = []schema.MessageInputPart{
		{Type: schema.ChatMessagePartTypeText, Text: "图里有什么"},
		{Type: schema.ChatMessagePartTypeImageURL, Image: &schema.MessageInputImage{MessagePartCommon: schema.MessagePartCommon{Base64Data: &data, MIMEType: "image/png"}}},
	}
	_, messages, err := encodeMessages([]*schema.Message{message})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(messages)
	if err != nil {
		t.Fatal(err)
	}
	var payload []struct {
		Role    string `json:"role"`
		Content []struct {
			Type   string `json:"type"`
			Source *struct {
				Type      string `json:"type"`
				MediaType string `json:"media_type"`
				Data      string `json:"data"`
			} `json:"source"`
		} `json:"content"`
	}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload) != 1 || len(payload[0].Content) != 2 || payload[0].Content[1].Type != "image" || payload[0].Content[1].Source == nil || payload[0].Content[1].Source.MediaType != "image/png" || payload[0].Content[1].Source.Data != data {
		t.Fatalf("unexpected image content block: %s", encoded)
	}
}
