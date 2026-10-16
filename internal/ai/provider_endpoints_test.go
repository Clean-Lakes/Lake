package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type mimoTransportFunc func(*http.Request) (*http.Response, error)

func (f mimoTransportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestMiMoProtocolEndpointNormalizationIsScoped(t *testing.T) {
	for _, host := range []string{"api.xiaomimimo.com", "token-plan-cn.xiaomimimo.com"} {
		for _, path := range []string{"", "/v1", "/v1/", "/v1/messages", "/v1/chat/completions", "/anthropic", "/anthropic/v1/messages"} {
			for p, suffix := range map[string]string{"claude": "/anthropic/v1/messages", "openai": "/v1/chat/completions", "openai-response": "/v1/responses"} {
				if got := NormalizeProviderEndpoint("https://"+host+path, p); got != "https://"+host+suffix {
					t.Fatalf("wrong official route for %s %s", p, path)
				}
			}
		}
	}
	for _, raw := range []string{"https://api.xiaomimimo.com.attacker.test/v1", "http://127.0.0.1:1234/v1", "https://api.xiaomimimo.com/proxy/v1", "https://api.xiaomimimo.com:9443/v1", "https://example.test/anthropic/v1"} {
		if NormalizeProviderEndpoint(raw, "claude") != raw {
			t.Fatal("custom host, port or path was rewritten")
		}
	}
}

func TestMiMoCompactionAndDiscoveryUseDocumentedRouteAndAuth(t *testing.T) {
	previous := HTTPClient
	t.Cleanup(func() { HTTPClient = previous })
	summaries, discoveries := 0, 0
	HTTPClient = &http.Client{Transport: mimoTransportFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Hostname() != "api.xiaomimimo.com" || r.Header.Get("Authorization") != "Bearer synthetic-mimo-fixture" || r.Header.Get("x-api-key") != "" {
			t.Error("MiMo request used the wrong host or authentication format")
		}
		body := ""
		if r.Method == "GET" {
			discoveries++
			if r.URL.Path != "/v1/models" {
				t.Error("model discovery used the Anthropic messages prefix")
			}
			body = `{"data":[{"id":"mimo-v2.6-pro"}]}`
		} else {
			summaries++
			var payload map[string]any
			json.NewDecoder(r.Body).Decode(&payload)
			if r.URL.Path != "/anthropic/v1/messages" || payload["model"] != "mimo-v2.6-pro" || payload["tools"] != nil || !strings.Contains(str(payload["system"]), "handoff summary") {
				t.Error("compaction did not use the selected model's Anthropic endpoint and summary-only payload")
			}
			body = `{"type":"message","role":"assistant","content":[{"type":"text","text":"Earlier observations are recorded. Keep the target and continue without replaying commands."}],"stop_reason":"end_turn","usage":{"input_tokens":100,"output_tokens":20}}`
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	model := Model{URL: "https://api.xiaomimimo.com/v1/messages", Name: "mimo-v2.6-pro", Protocol: "claude", Key: "synthetic-mimo-fixture", ContextWindow: 64000, MaxOutput: 8192}
	e := engineFor(t, model, nil)
	s, _ := e.get("case")
	s.state.History = longFirstTurn()
	// Force a model summary: automatic maintenance can now fit older tool
	// previews locally, which would not exercise the MiMo request at all.
	if err := e.compact(context.Background(), s, s.state.Config, true); err != nil {
		t.Fatal(err)
	}
	if _, err := Models(context.Background(), model); err != nil {
		t.Fatal(err)
	}
	if summaries != 1 || discoveries != 1 || validHistory(s.state.History) != nil {
		t.Fatal("unexpected requests or invalid compacted history")
	}
}
