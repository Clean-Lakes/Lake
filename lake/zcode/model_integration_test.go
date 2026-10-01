package zcode

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/schema"
)

func TestSourceModelProtocolsSettingsAndUsage(t *testing.T) {
	for _, api := range []string{"anthropic", "openai_chat", "openai_responses"} {
		t.Run(api, func(t *testing.T) {
			opts := sourceOptions(t, t.TempDir())
			opts.APIType, opts.ReasoningEffort = api, "high"
			opts.ContextWindow, opts.MaxOutputTokens = 42000, 384
			var calls, tokens atomic.Int64
			opts.OnUsage = func(input, output, _, _ int64) { tokens.Add(input + output) }
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				limitKey := map[string]string{"anthropic": "max_tokens", "openai_chat": "max_completion_tokens", "openai_responses": "max_output_tokens"}[api]
				if body[limitKey] != float64(384) || body["model"] != opts.Model {
					t.Error("Lake model/output limit was not preserved")
				}
				switch api {
				case "anthropic":
					thinking, _ := body["thinking"].(map[string]any)
					if thinking["type"] != "enabled" {
						t.Error("Anthropic reasoning setting lost")
					}
				case "openai_chat":
					if body["reasoning_effort"] != "high" {
						t.Error("Chat reasoning setting lost")
					}
				case "openai_responses":
					reasoning, _ := body["reasoning"].(map[string]any)
					if reasoning["effort"] != "high" {
						t.Error("Responses reasoning setting lost")
					}
				}
				fixtureAnswer(w, api)
			}))
			defer server.Close()
			opts.BaseURL = server.URL + "/v1"
			agent, err := New(opts)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			iter := agent.Run(ctx, &adk.AgentInput{Messages: []*schema.Message{schema.UserMessage("settings fixture")}})
			var answer string
			for {
				event, ok := iter.Next()
				if !ok {
					break
				}
				if event.Err != nil {
					t.Fatal(event.Err)
				}
				answer = event.Output.MessageOutput.Message.Content
			}
			if answer != "fixture settings" || calls.Load() != 1 {
				t.Fatal("source model response or request count changed")
			}
			if tokens.Load() != 10 {
				t.Fatalf("reported usage not preserved: %d", tokens.Load())
			}
		})
	}
}

func fixtureAnswer(w http.ResponseWriter, api string) {
	w.Header().Set("Content-Type", "text/event-stream")
	send := func(kind string, value any) {
		data, _ := json.Marshal(value)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", kind, data)
	}
	switch api {
	case "anthropic":
		send("message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": "fixture", "type": "message", "role": "assistant", "model": "fixture-model", "content": []any{}, "stop_reason": nil, "usage": map[string]int{"input_tokens": 7, "output_tokens": 0}}})
		send("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]string{"type": "text", "text": ""}})
		send("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]string{"type": "text_delta", "text": "fixture settings"}})
		send("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
		send("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn", "stop_sequence": nil}, "usage": map[string]int{"output_tokens": 3}})
		send("message_stop", map[string]string{"type": "message_stop"})
	case "openai_chat":
		fixtureChunk(w, map[string]any{"role": "assistant", "content": "fixture settings"}, nil)
		fixtureChunk(w, map[string]any{}, "stop")
		fmt.Fprint(w, "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"model\":\"fixture-model\",\"created\":1,\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"total_tokens\":10}}\n\ndata: [DONE]\n\n")
	case "openai_responses":
		response := map[string]any{"id": "fixture", "object": "response", "created_at": 1, "status": "in_progress", "model": "fixture-model", "output": []any{}, "usage": nil}
		part := map[string]any{"type": "output_text", "text": "fixture settings", "annotations": []any{}}
		item := map[string]any{"type": "message", "id": "msg_fixture", "role": "assistant", "status": "in_progress", "content": []any{}}
		send("response.created", map[string]any{"type": "response.created", "sequence_number": 0, "response": response})
		send("response.output_item.added", map[string]any{"type": "response.output_item.added", "sequence_number": 1, "output_index": 0, "item": item})
		send("response.content_part.added", map[string]any{"type": "response.content_part.added", "sequence_number": 2, "output_index": 0, "item_id": "msg_fixture", "content_index": 0, "part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}})
		send("response.output_text.delta", map[string]any{"type": "response.output_text.delta", "sequence_number": 3, "output_index": 0, "item_id": "msg_fixture", "content_index": 0, "delta": "fixture settings"})
		send("response.output_text.done", map[string]any{"type": "response.output_text.done", "sequence_number": 4, "output_index": 0, "item_id": "msg_fixture", "content_index": 0, "text": "fixture settings"})
		send("response.content_part.done", map[string]any{"type": "response.content_part.done", "sequence_number": 5, "output_index": 0, "item_id": "msg_fixture", "content_index": 0, "part": part})
		item["status"], item["content"] = "completed", []any{part}
		send("response.output_item.done", map[string]any{"type": "response.output_item.done", "sequence_number": 6, "output_index": 0, "item": item})
		response["status"], response["output"] = "completed", []any{item}
		response["usage"] = map[string]any{"input_tokens": 7, "output_tokens": 3, "total_tokens": 10, "input_tokens_details": map[string]int{"cached_tokens": 0}, "output_tokens_details": map[string]int{"reasoning_tokens": 0}}
		send("response.completed", map[string]any{"type": "response.completed", "sequence_number": 7, "response": response})
	}
}
