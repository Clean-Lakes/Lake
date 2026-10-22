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
		if _, err = r.invoke(context.Background(), call); err == nil {
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

func TestStrategyLiveFixtureKeepsExactBoundaryAndNeverFallsBack(t *testing.T) {
	f, _ := strategy.FindFixture("SL-005")
	calls := 0
	r := &strategyExperimentRuntime{input: StrategyVariantInput{Fixture: f, LiveRead: func(ctx context.Context) ([]byte, error) {
		calls++
		return []byte(`{"evidenceId":"observation-1","observation":"actual readonly connection"}`), nil
	}}}
	for _, call := range []Call{{Name: "shell", Arguments: `{"command":"pwd"}`}, {Name: "read", Arguments: `{"path":"/fixture/observations.json"}`}, {Name: "execute_sql", Arguments: `{"asset_ref":"fixture-db","schema":"fixture","sql":"DELETE FROM events"}`}} {
		if _, err := r.invoke(context.Background(), call); err == nil {
			t.Fatal("live adapter broadened tool boundary")
		}
	}
	if calls != 0 || r.result.Violations != 3 {
		t.Fatal("denied call reached live environment")
	}
	allowed := Call{Name: "execute_sql", Arguments: `{"asset_ref":"fixture-db","schema":"fixture","sql":"SELECT * FROM fixture_observations"}`}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.invoke(cancelled, allowed); err == nil || calls != 0 {
		t.Fatal("cancelled live observation dispatched")
	}
	if _, err := r.invoke(context.Background(), allowed); err != nil || calls != 1 || r.result.Observed != 1 {
		t.Fatal("valid live observation did not execute", err)
	}
	r.input.LiveRead = func(context.Context) ([]byte, error) { calls++; return nil, os.ErrPermission }
	r.path = filepath.Join(t.TempDir(), "observations.json")
	os.WriteFile(r.path, []byte(f.ActorMaterial()), 0600)
	r.hash = strategy.ContentHash(f.ActorMaterial())
	if _, err := r.invoke(context.Background(), allowed); err == nil || r.result.Observed != 1 {
		t.Fatal("live failure fell back to snapshot")
	}
	r.input.LiveRead = func(context.Context) ([]byte, error) {
		return []byte(`{"evidenceId":"forged","observation":"data"}`), nil
	}
	if _, err := r.invoke(context.Background(), allowed); err == nil {
		t.Fatal("unbound evidence accepted")
	}
	r.input.LiveRead = func(context.Context) ([]byte, error) {
		return []byte(`{"evidenceId":"observation-1","observation":"sensitive"}`), nil
	}
	r.input.Safe = func(string) bool { return false }
	if _, err := r.invoke(context.Background(), allowed); err == nil {
		t.Fatal("unsafe tool data reached actor")
	}
	e, err := New(t.TempDir(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown()
	result := e.RunStrategyVariant(context.Background(), StrategyVariantInput{RunID: "live-no-proof", Home: filepath.Join(t.TempDir(), "run"), Fixture: f, LiveRead: r.input.LiveRead, Model: Model{Protocol: "openai"}})
	if result.ErrorCode != "reset_failed" || result.Requests != 0 {
		t.Fatal("unproven reset dispatched provider")
	}
}
