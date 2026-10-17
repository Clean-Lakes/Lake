package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestModelsDiscoveryPaginatesProviderCatalogs(t *testing.T) {
	for _, p := range []string{"claude", "gemini"} {
		t.Run(p, func(t *testing.T) {
			var requests atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				w.Header().Set("Content-Type", "application/json")
				if p == "claude" {
					if r.URL.Path != "/prefix/v1/models" || r.Header.Get("x-api-key") != "synthetic-discovery" || r.Header.Get("anthropic-version") == "" {
						t.Error("incorrect Claude discovery route/auth")
					}
					switch r.URL.Query().Get("after_id") {
					case "":
						fmt.Fprint(w, `{"data":[{"id":"claude-first","context_window":128000}],"has_more":true,"last_id":"claude-first"}`)
					case "claude-first":
						fmt.Fprint(w, `{"data":[{"id":"claude-first"},{"id":"claude-last","supports_image_input":true}],"has_more":false}`)
					default:
						t.Error("incorrect cursor")
					}
				} else {
					if r.URL.Path != "/v1beta/models" || r.Header.Get("x-goog-api-key") != "synthetic-discovery" {
						t.Error("incorrect Gemini discovery route/auth")
					}
					switch r.URL.Query().Get("pageToken") {
					case "":
						fmt.Fprint(w, `{"models":[{"name":"models/gemini-first","inputTokenLimit":128000}],"nextPageToken":"next-page"}`)
					case "next-page":
						fmt.Fprint(w, `{"models":[{"name":"models/gemini-first"},{"name":"models/gemini-last","supports_image_input":true}]}`)
					default:
						t.Error("incorrect page token")
					}
				}
			}))
			defer remote.Close()
			path := "/prefix/v1/messages"
			if p == "gemini" {
				path = "/v1beta/models/{model}:streamGenerateContent"
			}
			found, err := Models(context.Background(), Model{URL: remote.URL + path, Protocol: p, Key: "synthetic-discovery"})
			if err != nil {
				t.Fatal(err)
			}
			result := obj(found)
			names := result["models"].([]string)
			prefix := "claude"
			if p == "gemini" {
				prefix = "gemini"
			}
			if requests.Load() != 2 || len(names) != 2 || names[0] != prefix+"-first" || names[1] != prefix+"-last" {
				t.Fatal("pagination or deduplication failed", result, requests.Load())
			}
			if result["contextLimits"].(map[string]int)[prefix+"-first"] != 128000 || !result["imageInputCapabilities"].(map[string]bool)[prefix+"-last"] {
				t.Fatal("discovery metadata was lost")
			}
		})
	}
}

func TestModelsDiscoveryDoesNotStopAtTwoHundred(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rows := []map[string]any{}
		for i := 0; i < 300; i++ {
			rows = append(rows, map[string]any{"id": fmt.Sprintf("model-%03d", i)})
		}
		rows = append(rows, map[string]any{"id": "model-000"}, map[string]any{"id": "invalid\nmodel"})
		json.NewEncoder(w).Encode(map[string]any{"data": rows})
	}))
	defer remote.Close()
	found, err := Models(context.Background(), Model{URL: remote.URL + "/v1/chat/completions", Protocol: "openai"})
	if err != nil {
		t.Fatal(err)
	}
	names := obj(found)["models"].([]string)
	if len(names) != 300 || names[299] != "model-299" {
		t.Fatal("discovery truncated a long catalog")
	}
}

func TestModelsDiscoveryRejectsBrokenPaginationAndAuthWithoutLeakingResponse(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"auth", 401, `{"error":{"message":"synthetic-private-response"}}`},
		{"invalid-json", 200, `not-json`},
		{"repeated-page", 200, `{"models":[{"name":"models/first"}],"nextPageToken":"repeated"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var count atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				count.Add(1)
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer remote.Close()
			found, err := Models(context.Background(), Model{URL: remote.URL + "/v1beta/models/{model}:streamGenerateContent", Protocol: "gemini", Key: "synthetic-private-key"})
			if err != nil {
				t.Fatal(err)
			}
			result := obj(found)
			if len(result["models"].([]string)) != 0 || str(result["message"]) == "" || strings.Contains(js(result), "synthetic-private") || count.Load() > 2 {
				t.Fatal("invalid discovery result or unbounded pagination", result)
			}
		})
	}
}
