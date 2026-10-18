package lakeadk

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"

	lakeai "github.com/Clean-Lakes/Lake/internal/ai"
)

const testSSE = `data: {"choices":[{"index":0,"delta":{"content":"hello "}}]}

data: {"choices":[{"index":0,"delta":{"content":"world","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"shell","arguments":"{\"command\":\"uptime\"}"}}]}}]}

data: {"choices":[{"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}

data: [DONE]

`

func testRequest() *model.LLMRequest {
	return &model.LLMRequest{
		Contents: []*genai.Content{
			genai.NewContentFromText("check the host", genai.RoleUser),
		},
		Config: &genai.GenerateContentConfig{
			SystemInstruction: genai.NewContentFromText("You are Lake.", genai.RoleUser),
			Tools: []*genai.Tool{{
				FunctionDeclarations: []*genai.FunctionDeclaration{{
					Name:        "shell",
					Description: "Run a shell command",
					ParametersJsonSchema: map[string]any{
						"type": "object",
						"properties": map[string]any{
							"command": map[string]any{"type": "string"},
						},
						"required": []string{"command"},
					},
				}},
			}},
		},
	}
}

func TestLakeLLMNonStreaming(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("unexpected Authorization header %q", got)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, testSSE)
	}))
	defer server.Close()

	llm := NewLakeLLM(lakeai.Model{
		URL:           server.URL + "/v1/chat/completions",
		Name:          "test-model",
		Protocol:      "openai",
		ContextWindow: 64000,
		MaxOutput:     8192,
	})
	var responses []*model.LLMResponse
	for resp, err := range llm.GenerateContent(context.Background(), testRequest(), false) {
		if err != nil {
			t.Fatalf("GenerateContent: %v", err)
		}
		responses = append(responses, resp)
	}
	if len(responses) != 1 {
		t.Fatalf("responses = %d, want 1", len(responses))
	}
	resp := responses[0]
	if !resp.TurnComplete {
		t.Fatal("final response is not complete")
	}
	if got := contentText(resp.Content); got != "hello world" {
		t.Fatalf("content = %q", got)
	}
	if resp.Content == nil || len(resp.Content.Parts) != 2 || resp.Content.Parts[1].FunctionCall == nil {
		t.Fatalf("function call missing: %#v", resp.Content)
	}
	call := resp.Content.Parts[1].FunctionCall
	if call.Name != "shell" || call.ID != "call-1" || call.Args["command"] != "uptime" {
		t.Fatalf("function call = %#v", call)
	}
	if resp.UsageMetadata == nil || resp.UsageMetadata.PromptTokenCount != 10 || resp.UsageMetadata.CandidatesTokenCount != 3 || resp.UsageMetadata.TotalTokenCount != 13 {
		t.Fatalf("usage = %#v", resp.UsageMetadata)
	}
	if !strings.Contains(string(mustJSON(t, body)), `"name":"shell"`) {
		t.Fatalf("tool declaration was not sent: %s", mustJSON(t, body))
	}
}

func TestLakeLLMStreamingYieldsPartialsAndFinal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, testSSE)
	}))
	defer server.Close()

	llm := NewLakeLLM(lakeai.Model{
		URL:           server.URL + "/v1/chat/completions",
		Name:          "test-model",
		Protocol:      "openai",
		ContextWindow: 64000,
		MaxOutput:     8192,
	})
	partials := []string{}
	final := 0
	for resp, err := range llm.GenerateContent(context.Background(), testRequest(), true) {
		if err != nil {
			t.Fatalf("GenerateContent: %v", err)
		}
		if resp.Partial {
			if resp.Content != nil && len(resp.Content.Parts) > 0 {
				partials = append(partials, resp.Content.Parts[0].Text)
			}
			continue
		}
		final++
		if !resp.TurnComplete {
			t.Fatal("final response is not complete")
		}
		if got := contentText(resp.Content); got != "hello world" {
			t.Fatalf("final content = %q", got)
		}
		if len(resp.Content.Parts) < 2 || resp.Content.Parts[len(resp.Content.Parts)-1].FunctionCall == nil {
			t.Fatalf("final function call missing: %#v", resp.Content)
		}
	}
	if len(partials) == 0 || !strings.Contains(strings.Join(partials, ""), "hello") {
		t.Fatalf("partials = %v", partials)
	}
	if final != 1 {
		t.Fatalf("final responses = %d, want 1", final)
	}
}

func TestLakeRequestConvertsToolHistory(t *testing.T) {
	req := &model.LLMRequest{
		Contents: []*genai.Content{
			genai.NewContentFromText("check", genai.RoleUser),
			{
				Role: "model",
				Parts: []*genai.Part{{
					FunctionCall: &genai.FunctionCall{ID: "call-1", Name: "shell", Args: map[string]any{"command": "uptime"}},
				}},
			},
			{
				Role: "user",
				Parts: []*genai.Part{{
					FunctionResponse: &genai.FunctionResponse{ID: "call-1", Name: "shell", Response: map[string]any{"output": "ok"}},
				}},
			},
		},
	}
	history, _, err := lakeRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 3 {
		t.Fatalf("history = %#v", history)
	}
	if history[1].Role != "assistant" || len(history[1].Calls) != 1 || history[1].Calls[0].Name != "shell" {
		t.Fatalf("assistant history = %#v", history[1])
	}
	if history[2].Role != "tool" || history[2].CallID != "call-1" || !strings.Contains(history[2].Content, "ok") {
		t.Fatalf("tool history = %#v", history[2])
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
