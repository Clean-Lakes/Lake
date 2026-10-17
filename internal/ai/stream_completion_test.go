package ai

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func heldModelStream(t *testing.T, frames string, ndjson bool) *httptest.Server {
	t.Helper()
	release := make(chan struct{})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ndjson {
			w.Header().Set("Content-Type", "application/x-ndjson")
		} else {
			w.Header().Set("Content-Type", "text/event-stream")
		}
		fmt.Fprint(w, frames)
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	t.Cleanup(func() { close(release); s.Close() })
	return s
}

func TestStreamCompletionDoesNotWaitForConnectionEOF(t *testing.T) {
	for _, tc := range []struct{ protocol, frames string }{
		{"openai", "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n"},
		{"openai", "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n"},
		{"azure-gpt", "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}],\"usage\":{\"total_tokens\":5}}\n\n"},
		{"openai-response", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}}\n\n"},
		{"claude", "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"ok\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n"},
		{"gemini", "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ok\"}]},\"finishReason\":\"STOP\"}]}\n\n"},
		{"ollama", "{\"message\":{\"content\":\"ok\"},\"done\":true}\n"},
	} {
		t.Run(tc.protocol, func(t *testing.T) {
			s := heldModelStream(t, tc.frames, tc.protocol == "ollama")
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			result, err := Stream(ctx, Model{URL: s.URL, Name: "fixture", Protocol: tc.protocol}, nil, nil, nil)
			if err != nil || result.Message.Content != "ok" {
				t.Fatalf("ended stream remained busy: content=%q err=%v", result.Message.Content, err)
			}
		})
	}
}

func TestStreamCompletionWaitsBrieflyForUsageTrailer(t *testing.T) {
	release := make(chan struct{})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n")
		w.(http.Flusher).Flush()
		time.Sleep(20 * time.Millisecond)
		fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":7,\"total_tokens\":17}}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer s.Close()
	defer close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	result, err := Stream(ctx, Model{URL: s.URL, Name: "fixture"}, nil, nil, nil)
	if err != nil || result.Usage.Total != 17 || !result.Usage.InputKnown || !result.Usage.OutputKnown {
		t.Fatal("usage trailer lost", result.Usage, err)
	}
}

func TestStreamCompletionBoundsMissingDoneTrailerAndKeepsToolCalls(t *testing.T) {
	s := heldModelStream(t, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"read\",\"function\":{\"name\":\"list_assets\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n", false)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	result, err := streamWithTimeouts(ctx, Model{URL: s.URL, Name: "fixture"}, nil, nil, nil, time.Second, 50*time.Millisecond)
	if err != nil || len(result.Message.Calls) != 1 || result.Message.Calls[0].ID != "read" || result.Message.Calls[0].Arguments != "{}" {
		t.Fatal("tool completion stalled or lost its arguments", err)
	}
	if result.Usage.Known {
		t.Fatal("missing usage was invented")
	}
	if ctx.Err() != nil {
		t.Fatal("completion cancelled the caller")
	}
}

func TestStreamIdleHeartbeatDoesNotInventCompletion(t *testing.T) {
	for _, reason := range []string{"null", `""`} {
		t.Run(reason, func(t *testing.T) {
			release := make(chan struct{})
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial [DONE] in prose\"},\"finish_reason\":%s}]}\n\n", reason)
				w.(http.Flusher).Flush()
				ticker := time.NewTicker(5 * time.Millisecond)
				defer ticker.Stop()
				for {
					select {
					case <-ticker.C:
						fmt.Fprint(w, ": keepalive\n\ndata: {\"type\":\"ping\"}\n\n")
						w.(http.Flusher).Flush()
					case <-r.Context().Done():
						return
					case <-release:
						return
					}
				}
			}))
			defer s.Close()
			defer close(release)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			text := ""
			_, err := streamWithTimeouts(ctx, Model{URL: s.URL, Name: "fixture"}, nil, nil, func(_ string, value string) { text += value }, 50*time.Millisecond, 20*time.Millisecond)
			if !errors.Is(err, ErrModelStreamIdle) || text != "partial [DONE] in prose" {
				t.Fatal("stalled reply was accepted as complete or lost", err)
			}
		})
	}
}

func TestStreamCompletionDoesNotHideParentCancellation(t *testing.T) {
	s := heldModelStream(t, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n", false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, err := Stream(ctx, Model{URL: s.URL, Name: "fixture"}, nil, nil, func(_, _ string) { cancel() })
	if !errors.Is(err, context.Canceled) {
		t.Fatal("parent cancellation was treated as success", err)
	}
}
