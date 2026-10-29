package ai

import (
	"context"
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"os"
	"path/filepath"
	"testing"
)

func TestStrategyExperimentRetiredBeforeCallbacksAndIO(t *testing.T) {
	e, err := New(t.TempDir(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown()
	home := filepath.Join(t.TempDir(), "must-not-create")
	callbacks := 0
	f, _ := strategy.FindFixture("SL-001")
	in := StrategyVariantInput{Home: home, RunID: "legacy-run", Fixture: f, LiveRead: func(context.Context) ([]byte, error) { callbacks++; return nil, nil }, Guard: func() error { callbacks++; return nil }, Reserve: func(int64) error { callbacks++; return nil }, Settle: func(int64, Usage) error { callbacks++; return nil }, Safe: func(string) bool { callbacks++; return true }}
	for _, ctx := range []context.Context{context.Background(), func() context.Context { ctx, cancel := context.WithCancel(context.Background()); cancel(); return ctx }()} {
		r := e.RunStrategyVariant(ctx, in)
		if r.Status != "retired" || r.ErrorCode != "strategy_execution_retired" || r.Requests != 0 || callbacks != 0 {
			t.Fatal("retired actor performed work", r, callbacks)
		}
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatal("retired actor created environment")
	}
}
