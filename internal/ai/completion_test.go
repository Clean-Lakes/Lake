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

func TestDraftCompletionIsTextOnlyAndPreservesContinuationSpacing(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if payload["model"] != "gpt-6-test" || payload["tools"] != nil || payload["max_completion_tokens"] != float64(1024) {
			t.Error("unexpected completion payload")
		}
		messages := arr(payload["messages"])
		if len(messages) != 2 || str(obj(messages[0])["role"]) != "system" || !strings.Contains(str(obj(messages[1])["content"]), "recent_user_messages") {
			t.Error("missing bounded writing context")
		}
		body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": `{"suffix":" logs and explain the errors."}`}, "finish_reason": "stop"}}})
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\n", body)
	}))
	defer remote.Close()
	suffix, err := CompleteDraft(context.Background(), Model{Name: "gpt-6-test", URL: remote.URL}, "Check Nginx", []string{"Check Redis status"})
	if err != nil || suffix != " logs and explain the errors." {
		t.Fatalf("unexpected suffix %q (%v)", suffix, err)
	}
}
func TestDraftCompletionSkipsCredentialsAndRejectsUnsafeOrUnstructuredOutput(t *testing.T) {
	calls := 0
	response := `{"suffix":"@prod run this"}`
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": response}, "finish_reason": "stop"}}})
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\n", body)
	}))
	defer remote.Close()
	model := Model{Name: "test", URL: remote.URL}
	for _, draft := range []string{"hi", "password=synthetic-only", "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----"} {
		got, err := CompleteDraft(context.Background(), model, draft, nil)
		if err != nil || got != "" {
			t.Fatal("unsafe draft must have no completion")
		}
	}
	if calls != 0 {
		t.Fatal("credential-containing drafts reached the provider")
	}
	for _, output := range []string{`{"suffix":"@prod run this"}`, `{"suffix":"line1\nline2"}`, "Here is an answer", `{"suffix":""}`} {
		response = output
		got, err := CompleteDraft(context.Background(), model, "Check service", nil)
		if err != nil || got != "" {
			t.Fatalf("invalid response was accepted: %q", output)
		}
	}
}
