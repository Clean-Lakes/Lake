package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestImageInputMetadata(t *testing.T) {
	for _, tc := range []struct {
		item map[string]any
		want *bool
	}{
		{map[string]any{"architecture": map[string]any{"input_modalities": []any{"text", "image"}}}, boolPointer(true)},
		{map[string]any{"architecture": map[string]any{"input_modalities": []any{"text"}}}, boolPointer(false)},
		{map[string]any{"supports_vision": true}, boolPointer(true)},
		{map[string]any{"id": "vision"}, nil},
	} {
		got := imageInputMetadata(tc.item)
		if got == nil && tc.want != nil || got != nil && tc.want == nil || got != nil && tc.want != nil && *got != *tc.want {
			t.Fatalf("metadata result %v, want %v", got, tc.want)
		}
	}
}

func boolPointer(value bool) *bool { return &value }

func TestProbeImageInputDoesNotSendUserImageAndCachesOnlyClearResults(t *testing.T) {
	for _, tc := range []struct {
		name, answer string
		status       int
		want         *bool
	}{
		{"accepted", "blue", 200, boolPointer(true)},
		{"ignored", "I cannot see images", 200, nil},
		{"rejected", `{"error":{"message":"Image input is not supported"}}`, 400, boolPointer(false)},
		{"transient", `{"error":{"message":"Service unavailable"}}`, 503, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if !strings.Contains(js(body), "data:image/png;base64,") {
					t.Error("generated probe image missing")
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				if tc.status == 200 {
					_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": tc.answer}}}})
				} else {
					_, _ = w.Write([]byte(tc.answer))
				}
			}))
			defer remote.Close()
			got, _ := ProbeImageInput(context.Background(), Model{URL: remote.URL, Name: "fixture", Protocol: "openai"})
			if got == nil && tc.want != nil || got != nil && tc.want == nil || got != nil && tc.want != nil && *got != *tc.want {
				t.Fatalf("probe result %v, want %v", got, tc.want)
			}
		})
	}
}
