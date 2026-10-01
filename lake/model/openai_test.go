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

func TestOpenAIChatToolRoundTripAndUsage(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("request path or auth incorrect")
		}
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if calls == 1 {
			if !strings.Contains(string(body["tools"]), "inspect") {
				t.Error("tool schema missing")
			}
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"call-1","type":"function","function":{"name":"inspect","arguments":"{\"host\":\"web\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`)
			return
		}
		if !strings.Contains(string(body["messages"]), `"tool_call_id":"call-1"`) {
			t.Error("tool result missing")
		}
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"healthy"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}`)
	}))
	defer server.Close()
	meter := &UsageMeter{}
	adapter, err := New(Config{WireAPI: "openai_chat", BaseURL: server.URL, Model: "test", APIKey: []byte("test-key"), Usage: meter})
	if err != nil {
		t.Fatal(err)
	}
	tool := &schema.ToolInfo{Name: "inspect", Desc: "inspect host"}
	first, err := adapter.Generate(context.Background(), []*schema.Message{schema.UserMessage("check")}, einomodel.WithTools([]*schema.ToolInfo{tool}))
	if err != nil || len(first.ToolCalls) != 1 || first.ToolCalls[0].ID != "call-1" {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	second, err := adapter.Generate(context.Background(), []*schema.Message{schema.UserMessage("check"), first, schema.ToolMessage("up", "call-1")}, einomodel.WithTools([]*schema.ToolInfo{tool}))
	if err != nil || second.Content != "healthy" || calls != 2 {
		t.Fatalf("second=%+v err=%v calls=%d", second, err, calls)
	}
	if meter.Snapshot().TotalTokens() != 30 {
		t.Fatalf("usage=%+v", meter.Snapshot())
	}
}

func TestOpenAIResponsesToolRoundTrip(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/responses" {
			t.Errorf("path=%s", r.URL.Path)
		}
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if calls == 1 {
			if !strings.Contains(string(body["tools"]), `"type":"function"`) {
				t.Error("function tool missing")
			}
			_, _ = io.WriteString(w, `{"output":[{"type":"function_call","call_id":"call-2","name":"inspect","arguments":"{\"host\":\"web\"}"}],"usage":{"input_tokens":8,"output_tokens":4,"total_tokens":12}}`)
			return
		}
		if !strings.Contains(string(body["input"]), `"type":"function_call_output"`) {
			t.Error("function output missing")
		}
		_, _ = io.WriteString(w, `{"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"healthy"}]}],"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11}}`)
	}))
	defer server.Close()
	adapter, err := New(Config{WireAPI: "openai_responses", BaseURL: server.URL, Model: "test", APIKey: []byte("test-key")})
	if err != nil {
		t.Fatal(err)
	}
	tool := &schema.ToolInfo{Name: "inspect"}
	first, err := adapter.Generate(context.Background(), []*schema.Message{schema.UserMessage("check")}, einomodel.WithTools([]*schema.ToolInfo{tool}))
	if err != nil || len(first.ToolCalls) != 1 || first.ToolCalls[0].ID != "call-2" {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	second, err := adapter.Generate(context.Background(), []*schema.Message{schema.UserMessage("check"), first, schema.ToolMessage("up", "call-2")}, einomodel.WithTools([]*schema.ToolInfo{tool}))
	if err != nil || second.Content != "healthy" || calls != 2 {
		t.Fatalf("second=%+v err=%v calls=%d", second, err, calls)
	}
}

func TestOpenAIChatStreamsTextAndToolCall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if string(body["stream"]) != "true" {
			t.Error("stream flag missing")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"lo\",\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"inspect\",\"arguments\":\"{\\\"host\\\":\"}}]}}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"web\\\"}\"}}]}}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3}}\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer server.Close()
	meter := &UsageMeter{}
	adapter, err := New(Config{WireAPI: "openai_chat", BaseURL: server.URL, Model: "test", APIKey: []byte("test-key"), Usage: meter})
	if err != nil {
		t.Fatal(err)
	}
	stream, err := adapter.Stream(context.Background(), []*schema.Message{schema.UserMessage("check")})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	var content string
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
		content += chunk.Content
		calls = append(calls, chunk.ToolCalls...)
		chunks = append(chunks, chunk)
	}
	if content != "hello" || len(calls) != 1 || calls[0].Function.Arguments != `{"host":"web"}` {
		t.Fatalf("content=%q calls=%+v", content, calls)
	}
	if meter.Snapshot().TotalTokens() != 13 {
		t.Fatalf("usage=%+v", meter.Snapshot())
	}
	merged, err := schema.ConcatMessages(chunks)
	if err != nil || merged.Content != content || len(merged.ToolCalls) != 1 || merged.ResponseMeta == nil || merged.ResponseMeta.Usage.TotalTokens != 13 {
		t.Fatalf("merged=%+v err=%v", merged, err)
	}
}

func TestOpenAIResponsesStreamsTextAndToolCall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hel\"}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"call_id\":\"call-2\",\"name\":\"inspect\"}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.function_call_arguments.done\",\"output_index\":1,\"arguments\":\"{\\\"host\\\":\\\"web\\\"}\"}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":8,\"output_tokens\":4}}}\n\n")
	}))
	defer server.Close()
	meter := &UsageMeter{}
	adapter, err := New(Config{WireAPI: "openai_responses", BaseURL: server.URL, Model: "test", APIKey: []byte("test-key"), Usage: meter})
	if err != nil {
		t.Fatal(err)
	}
	stream, err := adapter.Stream(context.Background(), []*schema.Message{schema.UserMessage("check")})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	var content string
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
		content += chunk.Content
		calls = append(calls, chunk.ToolCalls...)
		chunks = append(chunks, chunk)
	}
	if content != "hello" || len(calls) != 1 || calls[0].ID != "call-2" || calls[0].Function.Arguments != `{"host":"web"}` {
		t.Fatalf("content=%q calls=%+v", content, calls)
	}
	merged, err := schema.ConcatMessages(chunks)
	if err != nil || merged.Content != content || len(merged.ToolCalls) != 1 || merged.ResponseMeta == nil || merged.ResponseMeta.Usage.TotalTokens != 12 || meter.Snapshot().TotalTokens() != 12 {
		t.Fatalf("merged=%+v usage=%+v err=%v", merged, meter.Snapshot(), err)
	}
}
