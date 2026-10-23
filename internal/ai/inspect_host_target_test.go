package ai

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func TestInspectHostCarriesResolvedSSHRuntimeWithoutOverridingExplicitRuntime(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		t.Run(map[bool]string{false: "resolved_ssh", true: "explicit_runtime_retained"}[explicit], func(t *testing.T) {
			var executions atomic.Int32
			arguments := `{}`
			if explicit {
				arguments = `{"runtime":"local"}`
			}
			m, close := fakeModel(t, func(n int, _ map[string]any) any {
				if n == 1 {
					return response("", Call{ID: "inspect", Name: "inspect_host", Arguments: arguments})
				}
				return response("已返回实际检查结果。")
			})
			defer close()
			e := engineFor(t, m, func(_ context.Context, _, name string, a map[string]any, _ bool) (any, error) {
				if name == "policy" {
					return map[string]any{"asset_ref": "ssh-target", "runtime": "ssh", "target": "SSH fixture"}, nil
				}
				if name != "inspectHost" {
					t.Error("unexpected dispatch", name)
				}
				executions.Add(1)
				wantRuntime := "ssh"
				if explicit {
					wantRuntime = "local"
				}
				if a["asset_ref"] != "ssh-target" || a["runtime"] != wantRuntime {
					t.Error("execution did not preserve resolved target and runtime boundary", a)
				}
				return map[string]any{"runtime": "ssh", "checks": []any{"fixture observation"}}, nil
			})
			if err := e.Configure("case", Config{Model: m, Profile: "core", Runtime: "local", Assets: []Asset{{ID: "ssh-target", Kind: "ssh", Name: "SSH fixture"}}}); err != nil {
				t.Fatal(err)
			}
			if err := e.Chat(context.Background(), "case", "检查指定主机", nil); err != nil {
				t.Fatal(err)
			}
			if executions.Load() != 1 {
				t.Fatal("inspection replayed")
			}
			s, _ := e.get("case")
			s.mu.Lock()
			defer s.mu.Unlock()
			found := false
			for _, card := range s.state.View.Cards {
				if card.Title == "inspect_host" {
					found = true
					if str(obj(card.Data)["resource_id"]) != "ssh-target" {
						t.Fatal("operation did not record its resolved catalog identity")
					}
				}
			}
			if !found {
				t.Fatal("missing operation record")
			}
		})
	}
}

func TestOnlineDispatchedHostInspectionIsNotAutomaticallyReplayed(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, c := enableOnline(t, e)
	if onlineReadOnly("inspect_host", "readonly", nil, true) {
		t.Fatal("inspection can create a terminal and must not become replayable")
	}
	err := e.onlineObserve(s, c, Call{ID: "inspect", Name: "inspect_host"}, &onlinePolicyTrace{Dispatched: true, TargetHash: "target"}, nil, errors.New("inspection failed after dispatch"))
	var stopped *onlineStopped
	if !errors.As(err, &stopped) || stopped.Reason != strategy.AwaitingReconciliation {
		t.Fatal("unknown dispatched inspection must still await reconciliation", err)
	}
}
