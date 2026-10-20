package ai

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestUnknownMutationAllowsIndependentReadonlyButBlocksAnotherWrite(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	store, _ := e.adkStore()
	unknown := nativeOperation{ID: "original-change", SessionID: "case", Tool: "shell", Risk: "write", Status: "unknown", Target: "fixture-host", Handle: "terminal:entry", StartedAt: time.Now()}
	if err := store.DB.Create(&unknown).Error; err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), adkToolContextKey{}, true)
	op, err := e.dispatchNativeOperation(ctx, s, c, Call{ID: "health", Name: "shell", Arguments: "{}"}, "readonly", "fixture-host", "fixture")
	if err != nil || op == nil {
		t.Fatal("independent read was blocked", err)
	}
	if err := e.finishNativeOperation(op, c, map[string]any{"exitCode": 0}, nil); err != nil {
		t.Fatal(err)
	}
	_, err = e.dispatchNativeOperation(ctx, s, c, Call{ID: "new-change", Name: "write", Arguments: "{}"}, "write", "fixture-host", "fixture")
	if err == nil || !strings.Contains(err.Error(), "original-change") || !strings.Contains(err.Error(), "fixture-host") {
		t.Fatal("write guard lost the exact original operation", err)
	}
	if !strings.Contains(err.Error(), "shell_output") || !strings.Contains(err.Error(), "shell_id=original-change") || strings.Contains(err.Error(), "terminal_command_status") {
		t.Fatal("write guard must offer a model-visible recovery tool", err)
	}
	var preserved nativeOperation
	store.DB.First(&preserved, "id = ?", unknown.ID)
	if preserved.Status != "unknown" {
		t.Fatal("a fresh read invented an outcome for an old change")
	}
}

func TestSnapshotReconcilesOnlyExactCompletedTerminalHandle(t *testing.T) {
	for _, tc := range []struct {
		name   string
		result map[string]any
		want   string
	}{
		{"completed", map[string]any{"status": "completed", "exitCode": 0}, "succeeded"},
		{"failed", map[string]any{"status": "failed", "exitCode": 7}, "failed"},
		{"running", map[string]any{"status": "running", "exitCode": 0}, "unknown"},
		{"disconnected", map[string]any{"status": "unknown"}, "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			e, err := New(t.TempDir(), func(_ context.Context, session, tool string, args map[string]any, _ bool) (any, error) {
				calls++
				if session != "case" || tool != "terminal_command_status" || args["terminal_id"] != "terminal" || args["entry_id"] != "original" {
					t.Fatal("recovery replayed a command or read the wrong handle")
				}
				return tc.result, nil
			}, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer e.Shutdown()
			store, _ := e.adkStore()
			row := nativeOperation{ID: "old", SessionID: "case", Tool: "shell", Risk: "write", Status: "unknown", Handle: "terminal:original", StartedAt: time.Now()}
			if err := store.DB.Create(&row).Error; err != nil {
				t.Fatal(err)
			}
			if _, err := e.OperationOutcomes("case"); err != nil {
				t.Fatal(err)
			}
			store.DB.First(&row, "id = ?", row.ID)
			if calls != 1 || row.Status != tc.want {
				t.Fatalf("incorrect reconciliation: calls=%d, status=%s", calls, row.Status)
			}
		})
	}
}

func TestBlockedOperationReportsNoDispatchAndCallableRecovery(t *testing.T) {
	executions := 0
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, func(_ context.Context, _, tool string, _ map[string]any, _ bool) (any, error) {
		switch tool {
		case "policy":
			return map[string]any{"risk": "write", "runtime": "local", "target": "another-host"}, nil
		case "terminal_command_status":
			return map[string]any{"status": "unknown", "exitCode": nil}, nil
		default:
			executions++
			return map[string]any{"exitCode": 0}, nil
		}
	})
	s, _ := e.get("case")
	c := s.state.Config
	c.Permissions = &Permissions{SilentCommands: true}
	store, _ := e.adkStore()
	row := nativeOperation{ID: "original-change", SessionID: "case", Tool: "shell", Risk: "write", Status: "unknown", Target: "original-host", Handle: "terminal:entry", Result: `{"shell_id":"original-shell"}`, StartedAt: time.Now()}
	if err := store.DB.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), adkToolContextKey{}, true)
	if err := e.invokeCalls(ctx, s, &c, []Call{{ID: "blocked-call", Name: "shell", Arguments: `{"command":"rpm -qa"}`}}); err != nil {
		t.Fatal(err)
	}
	if executions != 0 {
		t.Fatal("blocked command reached execution")
	}
	if len(s.state.View.Cards) != 1 || s.state.View.Cards[0].Status != "not_executed" {
		t.Fatalf("blocked call mislabeled: %#v", s.state.View.Cards)
	}
	var failure map[string]any
	if err := json.Unmarshal([]byte(s.state.History[len(s.state.History)-1].Content), &failure); err != nil {
		t.Fatal(err)
	}
	if failure["outcome"] != "not_executed" || failure["code"] != "unresolved_operation" || failure["retryable"] != false {
		t.Fatalf("missing actionable refusal: %#v", failure)
	}
	recovery := obj(failure["recovery"])
	if recovery["tool"] != "shell_output" || obj(recovery["arguments"])["shell_id"] != row.ID {
		t.Fatalf("unavailable or wrong recovery: %#v", recovery)
	}
	value, err := e.shellJob(ctx, "case", str(recovery["tool"]), obj(recovery["arguments"]))
	if err != nil || obj(value)["status"] != "unknown" {
		t.Fatal("suggested recovery cannot read exact record", err)
	}
	if err := store.DB.First(&row, "id = ?", row.ID).Error; err != nil || row.Status != "unknown" {
		t.Fatal("refusal/read changed original unknown outcome", err)
	}
}
