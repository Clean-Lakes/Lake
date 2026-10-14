package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestReasoningRequestAdapters(t *testing.T) {
	for _, tc := range []struct{ name, protocol, effort, expected string }{
		{"magpie/deepseek/deepseek-flash", "openai", "max", `"reasoning_effort":"max"`},
		{"deepseek-flash", "openai", "none", `"type":"disabled"`},
		{"deepseek-flash", "openai-response", "max", `"reasoning":{"effort":"max"}`},
		{"deepseek-flash", "claude", "max", `"output_config":{"effort":"max"}`},
		{"gpt-5.2", "openai", "xhigh", `"reasoning_effort":"xhigh"`},
		{"gpt-5.2", "openai-response", "low", `"reasoning":{"effort":"low"}`},
		{"gpt-6.1-sol", "openai-response", "ultra", `"reasoning":{"effort":"ultra"}`},
		{"claude-opus-4-6", "claude", "max", `"output_config":{"effort":"max"}`},
		{"gemini-3-pro-preview", "gemini", "low", `"thinkingLevel":"low"`},
	} {
		t.Run(tc.name+"/"+tc.protocol+"/"+tc.effort, func(t *testing.T) {
			m := Model{URL: "http://localhost/v1/test", Name: tc.name, Protocol: tc.protocol, ReasoningEffort: tc.effort}
			_, body, err := modelPayload(m, nil, nil)
			if err != nil || !strings.Contains(js(body), tc.expected) {
				t.Fatal(body, err)
			}
			if tc.protocol == "openai" && strings.Contains(tc.name, "deepseek") {
				if tc.effort == "none" {
					if _, exists := body["reasoning_effort"]; exists {
						t.Fatal("disabled thinking sent unsupported effort")
					}
				} else if obj(body["thinking"])["type"] != "enabled" {
					t.Fatal("effort did not enable thinking")
				}
			}
			if tc.protocol == "openai" && tc.name == "gpt-5.2" {
				if body["max_tokens"] != nil || body["max_completion_tokens"] != 8192 {
					t.Fatal("wrong output token parameter", body)
				}
			}
		})
	}
	for _, m := range []Model{{Name: "deepseek-flash", ReasoningEffort: "medium"}, {Name: "gpt-5.2", ReasoningEffort: "max"}, {Name: "gpt-4.1", ReasoningEffort: "high"}, {Name: "gemini-3-pro-preview", Protocol: "gemini", ReasoningEffort: "medium"}} {
		m.URL = "http://localhost/test"
		if _, _, err := modelPayload(m, nil, nil); err == nil {
			t.Fatal("unsupported effort accepted", m.Name, m.ReasoningEffort)
		}
	}
	for _, name := range []string{"deepseek-flash", "gpt-5.2", "unknown"} {
		_, body, err := modelPayload(Model{URL: "http://localhost/test", Name: name}, nil, nil)
		if err != nil || body["reasoning_effort"] != nil || body["thinking"] != nil || body["reasoning"] != nil {
			t.Fatal("default changed provider behavior", body, err)
		}
	}
}

func TestProviderReasoningMetadataOverridesModelFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"data": []any{
			map[string]any{"id": "deepseek-flash", "effort": map[string]any{"supported_levels": []string{"low", "high", "high", "invalid"}, "default_level": "high"}},
			map[string]any{"id": "custom-model", "supported_reasoning_efforts": []string{"medium", "high"}},
			map[string]any{"id": "gpt-5.2", "effort": map[string]any{"supported_levels": []string{}}},
			map[string]any{"id": "codex/gpt-6.1-sol", "supported_reasoning_levels": []any{map[string]any{"effort": "low"}, map[string]any{"effort": "ultra"}}},
		}})
	}))
	defer server.Close()
	data, err := Models(context.Background(), Model{URL: server.URL + "/v1/chat/completions"})
	if err != nil {
		t.Fatal(err)
	}
	caps := obj(data)["reasoningCapabilities"].(map[string]ReasoningCapability)
	c := caps["deepseek-flash"]
	if !reflect.DeepEqual(c.Levels, []string{"low", "high"}) || c.Default != "high" {
		t.Fatal(c)
	}
	m := Model{URL: server.URL, Name: "deepseek-flash", Reasoning: &c, ReasoningEffort: "max"}
	if _, _, err := modelPayload(m, nil, nil); err == nil {
		t.Fatal("metadata restriction ignored")
	}
	u := caps["custom-model"]
	m.Name, m.Reasoning, m.ReasoningEffort = "custom-model", &u, "medium"
	if _, _, err := modelPayload(m, nil, nil); err != nil {
		t.Fatal("custom model metadata ignored", err)
	}
	disabled := caps["gpt-5.2"]
	if len(ReasoningSupport(Model{Name: "gpt-5.2", Reasoning: &disabled}).Levels) != 0 {
		t.Fatal("explicit absence borrowed fallback")
	}
	actual := caps["codex/gpt-6.1-sol"]
	if !reflect.DeepEqual(actual.Levels, []string{"low", "ultra"}) || actual.Source != "provider" {
		t.Fatal("gateway reasoning levels were not parsed", actual)
	}
	m.Name, m.Reasoning, m.ReasoningEffort = "codex/gpt-6.1-sol", &actual, "ultra"
	if _, _, err := modelPayload(m, nil, nil); err != nil {
		t.Fatal("gateway ultra effort was rejected", err)
	}
}
