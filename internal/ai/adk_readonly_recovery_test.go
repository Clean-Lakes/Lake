package ai

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestUnknownMutationDoesNotLockNewOperations(t *testing.T) {
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
	for _, target := range []string{"fixture-host", "another-host"} {
		call := Call{ID: "new-change-" + target, Name: "write", Arguments: "{}"}
		next, err := e.dispatchNativeOperation(ctx, s, c, call, "write", target, "fixture")
		if err != nil || next == nil {
			t.Fatal("old unknown operation locked a new write", target, err)
		}
		if err := e.finishNativeOperation(next, c, map[string]any{"exitCode": 0}, nil); err != nil {
			t.Fatal(err)
		}
		if _, err := e.dispatchNativeOperation(ctx, s, c, call, "write", target, "fixture"); err == nil {
			t.Fatal("same durable invocation replayed")
		}
	}
	var preserved nativeOperation
	store.DB.First(&preserved, "id = ?", unknown.ID)
	if preserved.Status != "unknown" {
		t.Fatal("a new operation invented an outcome for an old change")
	}
}

func TestUnfinishedMutationDoesNotBypassNewCallApproval(t *testing.T) {
	for _, status := range []string{"unknown", "dispatched"} {
		for _, approve := range []bool{false, true} {
			t.Run(status+map[bool]string{false: "_deny", true: "_allow"}[approve], func(t *testing.T) {
				target := filepath.Join(t.TempDir(), "effect")
				model, close := fakeModel(t, func(n int, _ map[string]any) any {
					if n == 1 {
						return response("", Call{ID: "fresh-append", Name: "append", Arguments: js(map[string]any{"path": target, "content": "new operation\n"})})
					}
					return response("complete")
				})
				defer close()
				e := engineFor(t, model, nil)
				store, err := e.adkStore()
				if err != nil {
					t.Fatal(err)
				}
				old := nativeOperation{ID: "old-change", SessionID: "case", Tool: "shell", Risk: "write", Status: status, StartedAt: time.Now()}
				if err = store.DB.Create(&old).Error; err != nil {
					t.Fatal(err)
				}
				done := make(chan error, 1)
				go func() { done <- e.Chat(context.Background(), "case", "append to the fixture", nil) }()
				approval := waitApproval(t, e)
				if _, err = os.Stat(target); !os.IsNotExist(err) {
					t.Fatal("old record bypassed the new operation's approval")
				}
				if err = e.Decision("case", approval.ID, approve, approval.Confirmation); err != nil {
					t.Fatal(err)
				}
				if err = <-done; err != nil {
					t.Fatal(err)
				}
				content, err := os.ReadFile(target)
				if approve && (err != nil || string(content) != "new operation\n") || !approve && !os.IsNotExist(err) {
					t.Fatal("new operation ignored the current approval", approve, err)
				}
				if err = store.DB.First(&old, "id = ?", old.ID).Error; err != nil || old.Status != status {
					t.Fatal("new operation changed an unfinished historical result", err)
				}
			})
		}
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

func TestDuplicateOperationReportsNoDispatchAndCallableRecovery(t *testing.T) {
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
	ctx := context.WithValue(context.Background(), adkToolContextKey{}, true)
	call := Call{ID: "duplicate-call", Name: "shell", Arguments: `{"command":"rpm -qa"}`}
	original, err := e.dispatchNativeOperation(ctx, s, c, call, "write", "original-host", "fixture")
	if err != nil {
		t.Fatal(err)
	}
	row := *original
	row.Status, row.Handle, row.Result = "unknown", "terminal:entry", `{"shell_id":"original-shell"}`
	if err := store.DB.Save(&row).Error; err != nil {
		t.Fatal(err)
	}
	if err := e.invokeCalls(ctx, s, &c, []Call{call}); err != nil {
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
	if failure["outcome"] != "not_executed" || failure["code"] != "duplicate_operation" || failure["retryable"] != false || failure["blocking_operation"] != nil {
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
	call.ID, call.Arguments = "fresh-call", `{"command":"uname -a"}`
	if err := e.invokeCalls(ctx, s, &c, []Call{call}); err != nil {
		t.Fatal(err)
	}
	if executions != 1 {
		t.Fatal("old unknown operation blocked a fresh permitted shell call", executions)
	}
}
