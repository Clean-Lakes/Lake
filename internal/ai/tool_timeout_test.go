package ai

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestToolChildContextFailureIsPairedAndReportedWithoutReplay(t *testing.T) {
	for _, childErr := range []error{context.DeadlineExceeded, context.Canceled} {
		t.Run(childErr.Error(), func(t *testing.T) {
			var executions atomic.Int32
			m, closeModel := fakeModel(t, func(n int, body map[string]any) any {
				if n == 1 {
					return response("", Call{ID: "slow", Name: "shell", Arguments: `{"command":"pwd"}`})
				}
				messages := arr(body["messages"])
				last := obj(messages[len(messages)-1])
				if n != 2 || str(last["tool_call_id"]) != "slow" || !strings.Contains(str(last["content"]), childErr.Error()) || !strings.Contains(str(last["content"]), "partial-evidence") || !strings.Contains(str(last["content"]), `"outcome":"unknown"`) {
					t.Error("interrupted tool lost its paired error/evidence", js(last))
				}
				return response("操作等待中断，需核查结果。")
			})
			defer closeModel()
			bridge := func(_ context.Context, _, name string, _ map[string]any, _ bool) (any, error) {
				if name == "runtimeCommandExec" {
					executions.Add(1)
					return map[string]any{"output": "partial-evidence"}, childErr
				}
				return map[string]any{"risk": "readonly", "runtime": "local"}, nil
			}
			e := engineFor(t, m, bridge)
			if err := e.Chat(context.Background(), "case", "检查测试命令", nil); err != nil {
				t.Fatal("tool-local cancellation aborted the whole turn", err)
			}
			if executions.Load() != 1 {
				t.Fatal("command was replayed", executions.Load())
			}
		})
	}
}

func TestParentContextFailureStillStopsToolTurn(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "deadline"}[deadline], func(t *testing.T) {
			var requests atomic.Int32
			m, closeModel := fakeModel(t, func(_ int, _ map[string]any) any {
				requests.Add(1)
				return response("", Call{ID: "stopped", Name: "shell", Arguments: `{"command":"pwd"}`})
			})
			defer closeModel()
			// The assertion concerns cancellation inside an executing tool. Keep
			// the first durable SDK store initialization outside that deadline.
			var turnCtx context.Context
			var cancel context.CancelFunc
			bridge := func(ctx context.Context, _, name string, _ map[string]any, _ bool) (any, error) {
				if name == "runtimeCommandExec" {
					if !deadline {
						cancel()
					}
					<-ctx.Done()
					return nil, ctx.Err()
				}
				return map[string]any{"risk": "readonly", "runtime": "local"}, nil
			}
			e := engineFor(t, m, bridge)
			if _, err := e.adkStore(); err != nil {
				t.Fatal(err)
			}
			if deadline {
				turnCtx, cancel = context.WithTimeout(context.Background(), 2*time.Second)
			} else {
				turnCtx, cancel = context.WithCancel(context.Background())
			}
			defer cancel()
			err := e.Chat(turnCtx, "case", "检查测试命令", nil)
			if !errors.Is(err, turnCtx.Err()) || turnCtx.Err() == nil || requests.Load() != 1 {
				t.Fatal("turn cancellation allowed another model request", err, requests.Load())
			}
		})
	}
}
