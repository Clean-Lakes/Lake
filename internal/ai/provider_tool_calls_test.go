package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestResponsesFinalToolArguments(t *testing.T) {
	arguments := `{"questions":[{"id":"scope","title":"检查范围？","options":["全部库","指定库"]}]}`
	item := map[string]any{"type": "function_call", "id": "fc_question", "call_id": "call_question", "name": "ask_user_question", "arguments": arguments}
	for _, finalEvent := range []string{"arguments.done", "output_item.done", "completed"} {
		t.Run(finalEvent, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				send := func(frame any) { fmt.Fprintf(w, "data: %s\n\n", js(frame)) }
				added := map[string]any{"type": "function_call", "id": "fc_question", "arguments": ""}
				if finalEvent == "arguments.done" {
					added["call_id"], added["name"] = "call_question", "ask_user_question"
				}
				send(map[string]any{"type": "response.output_item.added", "output_index": 0, "item": added})
				send(map[string]any{"type": "response.function_call_arguments.delta", "output_index": 0, "delta": `{"questions":[`})
				switch finalEvent {
				case "arguments.done":
					send(map[string]any{"type": "response.function_call_arguments.done", "output_index": 0, "arguments": arguments})
				case "output_item.done":
					send(map[string]any{"type": "response.output_item.done", "output_index": 0, "item": item})
				}
				completed := map[string]any{"usage": map[string]any{"input_tokens": 10, "output_tokens": 4}}
				if finalEvent == "completed" {
					completed["output"] = []any{item}
				}
				send(map[string]any{"type": "response.completed", "response": completed})
			}))
			defer server.Close()
			result, err := Stream(context.Background(), Model{URL: server.URL, Name: "fixture", Protocol: "openai-response"}, nil, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			want := []Call{{ID: "call_question", Name: "ask_user_question", Arguments: arguments}}
			if !reflect.DeepEqual(result.Message.Calls, want) {
				t.Fatalf("final arguments not used: %+v", result.Message.Calls)
			}
			if len(result.Message.Native) != 1 || !strings.Contains(string(result.Message.Native[0]), `"name":"ask_user_question"`) {
				t.Fatal("native history lost final tool identity")
			}
			var native map[string]any
			if json.Unmarshal(result.Message.Native[0], &native) != nil || native["arguments"] != arguments {
				t.Fatal("native history disagrees with dispatched arguments")
			}
		})
	}
}

func TestInvalidToolBatchReturnsNoCallsAndKeepsUsage(t *testing.T) {
	for _, arguments := range []string{`{"unfinished":`, `[]`, `null`} {
		a := newAccumulator("openai", nil)
		if err := a.consume(obj(response("", Call{ID: "valid", Name: "read", Arguments: `{}`}, Call{ID: "invalid", Name: "ask_user_question", Arguments: arguments})), true); err != nil {
			t.Fatal(err)
		}
		result, err := a.finish()
		if !errors.Is(err, ErrInvalidModelToolCall) || len(result.Message.Calls) != 0 || result.Usage.Total != 14 {
			t.Fatalf("invalid batch escaped validation: %+v %v", result, err)
		}
		if strings.Contains(err.Error(), arguments) {
			t.Fatal("raw tool arguments exposed in error")
		}
	}
	a := newAccumulator("openai-response", nil)
	_ = a.consume(map[string]any{"type": "response.output_item.added", "output_index": 0, "item": map[string]any{"type": "function_call", "call_id": "one", "name": "read"}}, false)
	err := a.consume(map[string]any{"type": "response.output_item.done", "output_index": 0, "item": map[string]any{"type": "function_call", "call_id": "other", "name": "write", "arguments": `{}`}}, false)
	if !errors.Is(err, ErrInvalidModelToolCall) {
		t.Fatal("conflicting function identity was accepted")
	}
}
