package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSixProviderStreams(t *testing.T) {
	cases := []struct {
		protocol string
		frames   []any
		header   string
	}{
		{"openai", []any{map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"reasoning_content": "thought", "content": "ok", "tool_calls": []any{map[string]any{"index": 0, "id": "c1", "function": map[string]any{"name": "list_assets", "arguments": "{\"pattern\":"}}}}}}}, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "function": map[string]any{"arguments": "\"\"}"}}}}, "finish_reason": "tool_calls"}}, "usage": map[string]any{"prompt_tokens": 3, "completion_tokens": 2}}}, "Authorization"},
		{"azure-gpt", []any{map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": "ok"}, "finish_reason": "stop"}}}}, "api-key"},
		{"openai-response", []any{map[string]any{"type": "response.output_text.delta", "delta": "ok"}, map[string]any{"type": "response.output_item.added", "output_index": 0, "item": map[string]any{"type": "function_call", "id": "fc1", "call_id": "c1", "name": "list_assets", "arguments": ""}}, map[string]any{"type": "response.function_call_arguments.delta", "output_index": 0, "delta": "{\"pattern\":\"\"}"}, map[string]any{"type": "response.output_item.done", "output_index": 0, "item": map[string]any{"type": "function_call", "id": "fc1", "call_id": "c1", "name": "list_assets", "arguments": "{\"pattern\":\"\"}"}}, map[string]any{"type": "response.completed", "response": map[string]any{"usage": map[string]any{"input_tokens": 3, "output_tokens": 2}}}}, "Authorization"},
		{"claude", []any{map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}}, map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "ok"}}, map[string]any{"type": "content_block_start", "index": 1, "content_block": map[string]any{"type": "tool_use", "id": "c1", "name": "list_assets", "input": map[string]any{}}}, map[string]any{"type": "content_block_delta", "index": 1, "delta": map[string]any{"type": "input_json_delta", "partial_json": "{\"pattern\":\"\"}"}}, map[string]any{"type": "message_stop"}}, "x-api-key"},
		{"gemini", []any{map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{map[string]any{"text": "ok"}, map[string]any{"functionCall": map[string]any{"id": "c1", "name": "list_assets", "args": map[string]any{"pattern": ""}}, "thoughtSignature": "signature"}}}, "finishReason": "STOP"}}}}, "x-goog-api-key"},
		{"ollama", []any{map[string]any{"message": map[string]any{"content": "ok", "tool_calls": []any{map[string]any{"function": map[string]any{"name": "list_assets", "arguments": map[string]any{"pattern": ""}}}}}, "done": true, "prompt_eval_count": 3, "eval_count": 2}}, "Authorization"},
	}
	for _, tc := range cases {
		t.Run(tc.protocol, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get(tc.header) == "" {
					t.Error("credential header missing")
				}
				var request map[string]any
				_ = json.NewDecoder(r.Body).Decode(&request)
				if tc.protocol == "gemini" && r.URL.Query().Get("alt") != "sse" {
					t.Error("missing Gemini SSE query")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				for _, frame := range tc.frames {
					if tc.protocol == "ollama" {
						fmt.Fprintln(w, js(frame))
					} else {
						fmt.Fprintf(w, "data: %s\n\n", js(frame))
					}
				}
			}))
			defer s.Close()
			m := Model{URL: s.URL, Name: "test", Key: "synthetic-fixture", Protocol: tc.protocol}
			result, err := Stream(context.Background(), m, []Message{{Role: "system", Content: "policy"}, {Role: "user", Content: "question"}}, Catalog("core"), nil)
			if err != nil || result.Message.Content != "ok" {
				t.Fatal(result, err)
			}
			if tc.protocol != "azure-gpt" {
				if len(result.Message.Calls) != 1 || result.Message.Calls[0].Arguments != `{"pattern":""}` {
					t.Fatal(result)
				}
			}
			h := []Message{{Role: "system", Content: "policy"}, {Role: "user", Content: "question"}, result.Message}
			for _, call := range result.Message.Calls {
				h = append(h, Message{Role: "tool", CallID: call.ID, Name: call.Name, Content: `[]`})
			}
			_, payload, err := modelPayload(m, h, nil)
			if err != nil {
				t.Fatal(err)
			}
			encoded := js(payload)
			if len(result.Message.Calls) > 0 && !strings.Contains(encoded, "list_assets") {
				t.Fatal("native tool history lost")
			}
			if tc.protocol == "gemini" && !strings.Contains(encoded, "signature") {
				t.Fatal("thought signature lost")
			}
		})
	}
}
func TestTruncatedStreamsAndToolIDs(t *testing.T) {
	for _, line := range []string{`{"choices":[{"delta":{"content":"partial"}}]}`, `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"same","function":{"name":"list_assets","arguments":"{}"}},{"index":1,"id":"same","function":{"name":"list_assets","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`, `{"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}`} {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "data: %s\n\n", line)
		}))
		_, err := Stream(context.Background(), Model{URL: s.URL, Name: "fixture"}, nil, nil, nil)
		s.Close()
		if err == nil {
			t.Fatal("incomplete or duplicate response accepted")
		}
	}
}

func TestDeepSeekToolPreludeAndReasoningHistory(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		json.NewDecoder(r.Body).Decode(&req)
		for _, v := range arr(req["messages"]) {
			message := obj(v)
			if message["role"] != "assistant" {
				continue
			}
			if _, exists := message["reasoning_content"]; !exists {
				w.WriteHeader(400)
				fmt.Fprint(w, `{"error":{"message":"Missing reasoning_content field in assistant history"}}`)
				return
			}
			if message["content"] == "earlier answer" && message["reasoning_content"] != "original provider reasoning" {
				t.Error("original model reasoning was changed")
			}
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"fresh host evidence analyzed"},"finish_reason":"stop"}]}`)
	}))
	defer provider.Close()
	history := []Message{
		{Role: "user", Content: "earlier question"},
		{Role: "assistant", Content: "earlier answer", Reasoning: "original provider reasoning"},
		{Role: "user", Content: "memory now"},
		{Role: "assistant", Calls: []Call{{ID: "preflight", Name: "inspect_host", Arguments: `{}`}}},
		{Role: "tool", CallID: "preflight", Name: "inspect_host", Content: `{"memory":"fresh"}`},
	}
	result, err := Stream(context.Background(), Model{URL: provider.URL, Name: "deepseek/deepseek-flash", Protocol: "openai"}, history, Catalog("core"), nil)
	if err != nil || result.Message.Content != "fresh host evidence analyzed" {
		t.Fatal("thinking-mode tool history rejected", err)
	}
	// Other OpenAI-compatible providers must not receive unsupported empty
	// reasoning extensions in application-generated assistant messages.
	_, payload, err := modelPayload(Model{URL: provider.URL, Name: "other-model"}, history[2:], Catalog("core"))
	if err != nil || strings.Contains(js(payload), "reasoning_content") {
		t.Fatal("empty reasoning extension leaked into another provider")
	}
}

func TestProviderErrorDetailsRedactCredentials(t *testing.T) {
	const key = "synthetic-provider-test-key"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		fmt.Fprintf(w, `{"error":{"message":"Missing reasoning_content; credential %s"}}`, key)
	}))
	defer provider.Close()
	_, err := Stream(context.Background(), Model{URL: provider.URL, Name: "fixture", Key: key}, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "Missing reasoning_content") || strings.Contains(err.Error(), key) {
		t.Fatal("provider error was hidden or credentials were not redacted")
	}
}
func TestStreamErrorDetailsRedactCredentials(t *testing.T) {
	const key = "synthetic-stream-test-key"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
		fmt.Fprintf(w, "data: {\"error\":{\"message\":\"DeepSeek: connection lost mid-response; credential %s\"}}\n\n", key)
	}))
	defer provider.Close()
	_, err := Stream(context.Background(), Model{URL: provider.URL, Name: "deepseek/deepseek-flash", Protocol: "openai", Key: key}, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "connection lost mid-response") || strings.Contains(err.Error(), key) {
		t.Fatal("stream error detail was hidden or credentials were not redacted")
	}
}
func TestRestoreRejectsOrphanBatches(t *testing.T) {
	for _, history := range [][]Message{{{Role: "tool", CallID: "orphan"}}, {{Role: "assistant", Calls: []Call{{ID: "id", Name: "read", Arguments: "{}"}}}, {Role: "user", Content: "skip tool"}}, {{Role: "assistant", Calls: []Call{{ID: "id"}, {ID: "id"}}}}} {
		if validHistory(history) == nil {
			t.Fatal(history)
		}
	}
}

func TestProtocolSwitchAndReusedCallIDs(t *testing.T) {
	message := Message{Role: "assistant", Calls: []Call{{ID: "same", Name: "read", Arguments: `{"path":"/tmp/file"}`}}, NativeProtocol: "claude", NativeModel: "old", Native: []json.RawMessage{json.RawMessage(`{"type":"tool_use","id":"same","name":"read","input":{"business_id":"same"}}`)}}
	resolveCallIDs(&message, []Message{{Role: "assistant", Calls: []Call{{ID: "same"}}}})
	if message.Calls[0].ID == "same" || !strings.Contains(string(message.Native[0]), `"business_id":"same"`) {
		t.Fatal(message)
	}
	for _, protocol := range []string{"openai-response", "gemini"} {
		_, body, err := modelPayload(Model{URL: "http://localhost/test", Name: "new", Protocol: protocol}, []Message{message, {Role: "tool", CallID: message.Calls[0].ID, Name: "read", Content: "result"}}, nil)
		if err != nil || strings.Contains(js(body), "tool_use") {
			t.Fatal(body, err)
		}
	}
}
