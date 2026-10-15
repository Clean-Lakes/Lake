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

func TestModelConnectionHandlesReasoningAndOutputLimit(t *testing.T) {
	for _, tc := range []struct {
		name, protocol, model, response string
		status                          int
		ok                              bool
	}{
		{"reasoning budget", "claude", "mimo-v2.5-pro", "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n", 200, true},
		{"thinking reaches limit", "claude", "mimo-v2.5-pro", "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}\n\n", 200, true},
		{"chat completion reaches limit", "openai", "deepseek-pro", "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking\"},\"finish_reason\":\"length\"}]}\n\n", 200, true},
		{"invalid credential", "openai", "test", `{"error":{"message":"invalid key"}}`, 401, false},
		{"incomplete stream", "openai", "test", "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n", 200, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var payload map[string]any
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
				}
				if payload["max_tokens"] != float64(1024) || payload["tools"] != nil {
					t.Error("connection probe has insufficient budget or enabled tools")
				}
				if tc.model == "deepseek-pro" && obj(payload["thinking"])["type"] != "disabled" {
					t.Error("connection probe did not select lowest available thinking effort")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.response)
			}))
			defer remote.Close()
			input, _ := json.Marshal(Model{URL: remote.URL, Protocol: tc.protocol, Name: tc.model, SupportsImageOutput: true})
			result, err := (&Engine{}).Handle(context.Background(), "testModel", "", input)
			if err != nil {
				t.Fatal(err)
			}
			value := obj(result)
			if value["ok"] != tc.ok || strings.TrimSpace(str(value["message"])) == "" {
				t.Fatal("unexpected connection result", value)
			}
		})
	}
}
