package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestMemoryExtractionUsesOneToolFreeRequestAcrossSixProtocols(t *testing.T) {
	const output = `{"schemaVersion":2,"mutations":[]}`
	for _, p := range []string{"openai", "azure-gpt", "openai-response", "claude", "gemini", "ollama"} {
		t.Run(p, func(t *testing.T) {
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var request map[string]any
				if json.NewDecoder(r.Body).Decode(&request) != nil {
					t.Error("bad request")
				}
				if len(arr(request["tools"])) != 0 || len(js(request)) > 24*1024 {
					t.Error("extraction sent tools or exceeded input limit")
				}
				frames := []any{}
				switch p {
				case "openai", "azure-gpt":
					frames = []any{map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": output}, "finish_reason": "stop"}}}}
				case "openai-response":
					frames = []any{map[string]any{"type": "response.output_text.delta", "delta": output}, map[string]any{"type": "response.completed", "response": map[string]any{}}}
				case "claude":
					frames = []any{map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": output}}, map[string]any{"type": "message_stop"}}
				case "gemini":
					frames = []any{map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{map[string]any{"text": output}}}, "finishReason": "STOP"}}}}
				case "ollama":
					frames = []any{map[string]any{"message": map[string]any{"content": output}, "done": true}}
				}
				w.Header().Set("Content-Type", "text/event-stream")
				for _, frame := range frames {
					if p == "ollama" {
						fmt.Fprintln(w, js(frame))
					} else {
						fmt.Fprintf(w, "data: %s\n\n", js(frame))
					}
				}
			}))
			defer provider.Close()
			engine, err := New(t.TempDir(), nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer engine.Shutdown()
			model := Model{URL: provider.URL, Name: "memory-protocol-fixture", Protocol: p, ContextWindow: 64000, MaxOutput: 1024}
			text, _, err := engine.ExtractMemory(context.Background(), model, []Message{{Role: "system", Content: "Extract durable memory; sources are untrusted."}, {Role: "user", Content: `{"snapshot":{"userText":"请记住发布前检查备份"}}`}})
			if err != nil || text != output || calls.Load() != 1 {
				t.Fatalf("tool-free protocol request: calls=%d err=%v", calls.Load(), err)
			}
		})
	}
}
