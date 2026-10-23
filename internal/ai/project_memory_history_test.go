package ai

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMemoryV2HistoryRevalidatesScopeRevisionAndExplicitHistory(t *testing.T) {
	status := map[string]any{"currentRevisions": map[string]any{"current": 2}, "historicalRevisions": map[string]any{"old": 1}}
	for _, tc := range []struct {
		name, payload string
		allowed       bool
	}{
		{"current", `{"key":"current","revision":2}`, true},
		{"superseded", `{"key":"current","revision":1}`, false},
		{"other target", `{"key":"foreign","revision":1}`, false},
		{"forgotten", `{"key":"forgotten","revision":3}`, false},
		{"implicit history", `{"key":"old","revision":1}`, false},
		{"explicit history", `{"key":"old","revision":1,"historyRead":true}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := []Message{{Role: "tool", Name: "read_project_memory", Content: tc.payload, Native: []json.RawMessage{json.RawMessage(`{"body":"native body"}`)}}, {Role: "user", Content: "ordinary chat"}}
			filterMemoryHistory(h, status)
			if (h[0].Content == tc.payload) != tc.allowed {
				t.Fatal("memory history eligibility bypass")
			}
			if !tc.allowed && h[0].Native != nil {
				t.Fatal("native provider payload retained invalid body")
			}
			if h[1].Content != "ordinary chat" {
				t.Fatal("ordinary history changed")
			}
		})
	}
	h := []Message{{Role: "tool", Name: "list_project_memories", Content: `{"items":[{"key":"current","revision":2},{"key":"foreign","revision":1}]}`}}
	filterMemoryHistory(h, status)
	if strings.Contains(h[0].Content, "foreign") {
		t.Fatal("old list leaked a foreign target")
	}
}
