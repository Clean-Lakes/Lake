package web

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// Opt-in diagnostic: sends synthetic text/tool definitions, never conversation
// history, resource inventory, or tool execution. Keys remain in Models/Stream.
func TestMiMoParameterProbe(t *testing.T) {
	if os.Getenv("LAKE_MIMO_PROBE") != "1" {
		t.Skip("live synthetic model diagnostic")
	}
	home, _ := os.UserHomeDir()
	home = filepath.Join(home, ".lake-dev")
	models := &Models{Home: home, Dir: filepath.Join(home, "web-agent")}
	m := models.Active()
	if m == nil {
		t.Fatal("model unavailable")
	}
	m.MaxOutput = 32
	var normalized []ai.Tool
	raw, _ := json.Marshal(ai.Catalog("core"))
	_ = json.Unmarshal(raw, &normalized)
	var clean func(any)
	clean = func(value any) {
		switch v := value.(type) {
		case map[string]any:
			for key, child := range v {
				if key == "required" && child == nil {
					delete(v, key)
				} else {
					clean(child)
				}
			}
		case []any:
			for _, child := range v {
				clean(child)
			}
		}
	}
	for _, tool := range normalized {
		clean(tool.Parameters)
	}
	cases := []struct {
		name  string
		tools []ai.Tool
	}{
		{"null_required", []ai.Tool{{Name: "probe_ping", Description: "Synthetic diagnostic. Do not call.", Parameters: map[string]any{"type": "object", "properties": map[string]any{}, "required": nil}}}},
		{"empty_required", []ai.Tool{{Name: "probe_ping", Description: "Synthetic diagnostic. Do not call.", Parameters: map[string]any{"type": "object", "properties": map[string]any{}, "required": []string{}}}}},
		{"core_without_null_required", normalized},
		{"fixed_core_tools", ai.Catalog("core")},
	}
	for _, c := range cases {
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		_, err := ai.Stream(ctx, *m, []ai.Message{{Role: "user", Content: "Reply only OK. Do not call any tool."}}, c.tools, nil)
		cancel()
		if err != nil {
			t.Logf("%s: %v", c.name, err)
		} else {
			t.Logf("%s: accepted", c.name)
		}
	}
}
