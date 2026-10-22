package ai

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func TestStrategyExperimentResetFailureAndNoHostFallback(t *testing.T) {
	e, err := New(t.TempDir(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown()
	f, _ := strategy.FindFixture("SL-001")
	home := filepath.Join(t.TempDir(), "owned-run")
	if os.Mkdir(home, 0700) != nil {
		t.Fatal("fixture setup")
	}
	result := e.RunStrategyVariant(context.Background(), StrategyVariantInput{RunID: "reset-run", Home: home, Fixture: f, Model: Model{Protocol: "openai"}})
	if result.Status != "failed" || result.ErrorCode != "reset_failed" || result.Requests != 0 {
		t.Fatal("reset failure ran provider", result)
	}
	outside := filepath.Join(t.TempDir(), "private")
	if os.WriteFile(outside, []byte("synthetic-private-file"), 0600) != nil {
		t.Fatal("fixture setup")
	}
	r := &strategyExperimentRuntime{input: StrategyVariantInput{Fixture: f}}
	for _, call := range []Call{{Name: "read", Arguments: js(map[string]any{"path": outside})}, {Name: "shell", Arguments: js(map[string]any{"command": "touch /tmp/lake-p5-forbidden"})}, {Name: "read", Arguments: js(map[string]any{"path": "/fixture/observations.json", "runtime": "ssh"})}} {
		if _, err = r.invoke(call); err == nil {
			t.Fatal("host escape allowed")
		}
	}
	if r.result.Violations != 3 || r.result.Observed != 0 {
		t.Fatal("lost denial metrics")
	}
	raw, _ := os.ReadFile(outside)
	if string(raw) != "synthetic-private-file" {
		t.Fatal("host file changed")
	}
}
