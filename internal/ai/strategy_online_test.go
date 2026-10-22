package ai

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func enableOnline(t *testing.T, e *Engine) (*session, Config) {
	t.Helper()
	s, _ := e.get("case")
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	c.StrategyCorrectEnabled = true
	c.StrategyBudget = strategy.DefaultBudget()
	c.StrategyGlobalEpoch = 1
	c.StrategyProjectEpoch = 2
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	c = s.state.Config
	s.state.View.RootTurnID = "root"
	s.mu.Unlock()
	return s, c
}
func proposal(source, tool, arguments string) Call {
	return Call{ID: "proposal_" + source, Name: onlineRevisionTool, Arguments: js(map[string]any{"sourceId": source, "refutedHypothesis": "The original observation completed.", "changes": "Take one authorized sample and preserve unresolved gaps.", "expectedInformation": "The exact check returns an actual result.", "stopCondition": "Stop at denied permission, unknown effect or budget.", "tool": tool, "arguments": arguments})}
}
func onlineReport(t *testing.T, e *Engine, s *session, c Config) *strategy.OnlineReport {
	t.Helper()
	r, err := e.onlineCurrent(s, c)
	if err != nil || r == nil {
		t.Fatal("missing durable report", err)
	}
	return r
}

func TestOnlineOfficialADKReadonlyTimeoutProposalAndRecovery(t *testing.T) {
	var executions atomic.Int32
	var e *Engine
	m, close := fakeModel(t, func(n int, body map[string]any) any {
		if !strings.Contains(js(body), "Host-recorded correction state") && n == 2 {
			t.Error("correction context missing")
		}
		switch n {
		case 1:
			return response("", Call{ID: "failed_read", Name: "shell", Arguments: `{"command":"pwd"}`})
		case 2:
			return response("", proposal("failed_read", "shell", `{"command":"pwd"}`))
		case 3:
			return response("", Call{ID: "fresh_read", Name: "shell", Arguments: `{"command":"pwd"}`})
		case 4:
			return response("已取得该检查的结果；这不证明整个任务恢复。")
		default:
			t.Error("unbounded provider request", n)
			return response("Stop.")
		}
	})
	defer close()
	e = engineFor(t, m, func(_ context.Context, _, name string, _ map[string]any, _ bool) (any, error) {
		if name == "runtimeCommandExec" {
			if executions.Add(1) == 1 {
				return map[string]any{"output": "partial"}, context.DeadlineExceeded
			}
			return map[string]any{"output": "/test-host", "exitCode": 0}, nil
		}
		return map[string]any{"risk": "readonly", "runtime": "local"}, nil
	})
	s, c := enableOnline(t, e)
	if err := e.Chat(context.Background(), "case", "检查当前目录", nil); err != nil {
		t.Fatal(err)
	}
	r := onlineReport(t, e, s, c)
	if r.StopReason != strategy.Completed || !r.Recovered || len(r.Revisions) != 1 || !r.Revisions[0].Progress || r.Requests != 3 || r.TokensCharged != 42 || r.UsageUnknown || executions.Load() != 2 || len(r.OpenChecks) != 0 {
		t.Fatalf("wrong bounded outcome: %#v", r)
	}
	store, _ := e.adkStore()
	var ops []nativeOperation
	if err := store.DB.Where("tool = ?", "shell").Order("started_at").Find(&ops).Error; err != nil || len(ops) != 2 || ops[0].Status != "unknown" || ops[1].Status != "succeeded" || ops[0].ID == ops[1].ID {
		t.Fatal("old unknown was erased or replayed", ops, err)
	}
	manifest := readPromptManifest(t, e, "case")
	if !hasPromptSource(manifest, "online-readonly-correction-v1") || !hasPromptSource(manifest, "online-correction-state") {
		t.Fatal("actual dispatch manifest missing correction layers")
	}
	view, _ := e.Snapshot("case")
	found := false
	for _, card := range view.Cards {
		found = found || card.Type == "strategy_correction"
	}
	if !found {
		t.Fatal("task card missing")
	}
}

func TestOnlineSQLiteExitCodeCannotBecomeSuccess(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, func(_ context.Context, _, name string, _ map[string]any, _ bool) (any, error) {
		if name == "runtimeCommandExec" {
			return map[string]any{"exitCode": int64(52), "status": "completed", "output": "curl empty reply"}, nil
		}
		return map[string]any{"risk": "readonly", "runtime": "local"}, nil
	})
	s, c := enableOnline(t, e)
	ctx := context.WithValue(context.Background(), adkToolContextKey{}, true)
	if err := e.invokeCalls(ctx, s, &c, []Call{{ID: "sqlite_code", Name: "shell", Arguments: `{"command":"curl -sS http://127.0.0.1:12345/health"}`}}); err != nil {
		t.Fatal(err)
	}
	r := onlineReport(t, e, s, c)
	if len(r.Observations) != 1 || r.Observations[0].Success || r.Observations[0].Class != "transient" {
		t.Fatal("SQLite int64 was treated as exit zero", r)
	}
	store, _ := e.adkStore()
	var op nativeOperation
	if err := store.DB.Where("call_id = ?", "sqlite_code").First(&op).Error; err != nil || op.Status != "failed" {
		t.Fatal("real nonzero exit became ledger success", op.Status, err)
	}
	if num(json.Number("52"), 0) != 52 || num(int64(52), 0) != 52 {
		t.Fatal("numeric bridge conversion lost an exit code")
	}
}

func TestOnlineStopsBeforeOpaqueOrMutatingCorrection(t *testing.T) {
	for _, tool := range []string{"shell", "execute_sql", "call_mcp_tool", "write", "delegate_investigation", "open_ssh_terminal", "stage_attachment"} {
		t.Run(tool, func(t *testing.T) {
			var commands atomic.Int32
			e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, func(_ context.Context, _, name string, a map[string]any, _ bool) (any, error) {
				if name == "policy" {
					risk := "readonly"
					if str(obj(a["arguments"])["command"]) == "touch /tmp/forbidden" {
						risk = "write"
					}
					return map[string]any{"risk": risk, "runtime": "local"}, nil
				}
				commands.Add(1)
				return nil, errors.New("temporary connection reset")
			})
			s, c := enableOnline(t, e)
			trace := &onlinePolicyTrace{ReadOnly: true, TargetHash: onlineTarget(c, nil, map[string]any{"runtime": "local"})}
			failed := Call{ID: "source", Name: "shell", Arguments: `{"command":"pwd"}`}
			if err := e.onlineObserve(s, c, failed, trace, nil, context.DeadlineExceeded); err != nil {
				t.Fatal(err)
			}
			a := `{}`
			if tool == "shell" {
				a = `{"command":"touch /tmp/forbidden"}`
			}
			if _, err := e.onlinePropose(context.Background(), s, c, proposal("source", tool, a)); err != nil {
				t.Fatal(err)
			}
			_ = e.invokeCalls(context.Background(), s, &c, []Call{{ID: "forbidden", Name: tool, Arguments: a}})
			if onlineReport(t, e, s, c).StopReason == "" {
				t.Fatal("unsafe correction admitted")
			}
			if commands.Load() != 0 {
				t.Fatal("unsafe operation reached execution")
			}
		})
	}
}

func TestOnlineFailureCategoriesAndDisabledCompatibility(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		readonly bool
		want     strategy.StopReason
	}{
		{"permission", errors.New("permission denied"), true, strategy.PermissionBlocked},
		{"target", errors.New("ambiguous target"), true, strategy.TargetAmbiguous},
		{"capability", errors.New("tool unavailable"), true, strategy.CapabilityMissing},
		{"unknown_write", context.DeadlineExceeded, false, strategy.AwaitingReconciliation},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
			s, c := enableOnline(t, e)
			if err := e.onlineObserve(s, c, Call{ID: "failed", Name: "read", Arguments: `{"path":"/test"}`}, &onlinePolicyTrace{ReadOnly: tc.readonly, TargetHash: "target"}, nil, tc.err); err == nil {
				t.Fatal("hard failure did not stop")
			}
			if got := onlineReport(t, e, s, c).StopReason; got != tc.want {
				t.Fatal(got)
			}
		})
	}
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	if err := e.onlineObserve(s, c, Call{ID: "x", Name: "read"}, &onlinePolicyTrace{}, nil, errors.New("failure")); err != nil {
		t.Fatal(err)
	}
	store, _ := e.adkStore()
	var count int64
	store.DB.Model(&nativeCorrection{}).Count(&count)
	if count != 0 {
		t.Fatal("disabled feature created an optimization")
	}
	for _, tool := range e.sessionCatalog(context.Background(), "case", c) {
		if tool.Name == onlineRevisionTool {
			t.Fatal("disabled tool advertised")
		}
	}
}

func TestOnlineNoProgressAndUnresolvedOriginalGap(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, c := enableOnline(t, e)
	trace := &onlinePolicyTrace{ReadOnly: true, TargetHash: "same-target"}
	first := Call{ID: "first", Name: "read", Arguments: `{"path":"/missing-original"}`}
	if err := e.onlineObserve(s, c, first, trace, nil, errors.New("missing original")); err != nil {
		t.Fatal(err)
	}
	for i, path := range []string{"/another-log", "/yet-another-log"} {
		p := proposal("first", "read", js(map[string]any{"path": path}))
		if _, err := e.onlinePropose(context.Background(), s, c, p); err != nil {
			t.Fatal(err)
		}
		call := Call{ID: uid(), Name: "read", Arguments: js(map[string]any{"path": path})}
		_, err := e.onlineUpdate(s, c, false, func(r *strategy.OnlineReport) error {
			r.Revisions[len(r.Revisions)-1].CallID = call.ID
			r.InFlightCall = call.ID
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		err = e.onlineObserve(s, c, call, trace, map[string]any{"content": "different wording and timestamp", "at": timestamp()}, nil)
		if (i == 1) != (err != nil) {
			t.Fatal("no-progress bound incorrect", err)
		}
	}
	r := onlineReport(t, e, s, c)
	if r.Recovered || len(r.OpenChecks) != 1 || r.OpenChecks[0].CallID != "first" || r.StopReason != strategy.NoProgress || len(r.Revisions) != 2 {
		t.Fatal("unrelated success erased original failure", r)
	}
}

func TestOnlineSharedRoleBudgetConcurrentReservationAndRecovery(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, c := enableOnline(t, e)
	// Different role/plan IDs still resolve to one parent task record.
	child1, _ := New(t.TempDir(), nil, nil)
	defer child1.Shutdown()
	child1.worker = &agentWorker{parent: e, session: s, parentID: "case"}
	child2, _ := New(t.TempDir(), nil, nil)
	defer child2.Shutdown()
	child2.worker = &agentWorker{parent: e, session: s, parentID: "case"}
	c.sre = &sreRoleContext{TaskID: "task", Role: SREInvestigator, PlanRevisionID: "v1"}
	if err := child1.onlineObserve(s, c, Call{ID: "failed", Name: "read", Arguments: `{"path":"/test"}`}, &onlinePolicyTrace{ReadOnly: true, TargetHash: "target"}, nil, context.DeadlineExceeded); err != nil {
		t.Fatal(err)
	}
	c2 := c
	c2.sre = &sreRoleContext{TaskID: "task", Role: SREVerifier, PlanRevisionID: "v2"}
	var admitted atomic.Int32
	var wg sync.WaitGroup
	for _, item := range []struct {
		e *Engine
		c Config
	}{{child1, c}, {child2, c2}} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, _ := item.e.onlineReserve(context.Background(), s, item.c, 100)
			if ok {
				admitted.Add(1)
			}
		}()
	}
	wg.Wait()
	r := onlineReport(t, child1, s, c)
	if admitted.Load() != 1 || r.Requests != 1 || r.TokensCharged != 100 || !r.InFlightRequest {
		t.Fatal("role budget reset or duplicate dispatch", r)
	}
	store, _ := e.adkStore()
	if err := recoverOnlineCorrections(store.DB); err != nil {
		t.Fatal(err)
	}
	r = onlineReport(t, child2, s, c2)
	if r.StopReason != strategy.AwaitingReconciliation || r.Requests != 1 || r.TokensCharged != 100 || !r.InFlightRequest {
		t.Fatal("crash refunded unknown dispatch", r)
	}
	// Deliberately discard the cached card: the durable record remains visible.
	s.mu.Lock()
	s.state.View.Cards = nil
	s.mu.Unlock()
	view, err := e.Snapshot("case")
	if err != nil || len(view.Cards) != 1 {
		t.Fatal("durable report not projected", err)
	}
	var public strategy.OnlineReport
	raw, _ := json.Marshal(view.Cards[0].Data)
	_ = json.Unmarshal(raw, &public)
	if public.StopReason != strategy.AwaitingReconciliation {
		t.Fatal("stale UI overrode durable stop")
	}
}

func TestOnlineBudgetUnknownUsageRevocationAndStrictProposal(t *testing.T) {
	for _, budget := range []string{"requests", "tokens", "time", "revisions", "retry"} {
		t.Run(budget, func(t *testing.T) {
			e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
			s, c := enableOnline(t, e)
			if budget == "retry" {
				c.StrategyBudget.ExtraReadRetries = 0
			}
			if budget == "revisions" {
				c.StrategyBudget.MaxRevisions = 0
			}
			err := e.onlineObserve(s, c, Call{ID: "failed", Name: "read", Arguments: `{"path":"/test"}`}, &onlinePolicyTrace{ReadOnly: true, TargetHash: "target"}, nil, context.DeadlineExceeded)
			if budget == "revisions" {
				if err == nil {
					t.Fatal("zero revision budget ignored")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			_, _ = e.onlineUpdate(s, c, false, func(r *strategy.OnlineReport) error {
				switch budget {
				case "requests":
					r.Requests = r.Budget.MaxOptimizationRequests
				case "tokens":
					r.TokensCharged = r.Budget.MaxAdditionalTokens
				case "time":
					r.ActiveAt = time.Now().Add(-11 * time.Minute).Format(time.RFC3339Nano)
				}
				return nil
			})
			if budget == "retry" {
				_, err = e.onlinePropose(context.Background(), s, c, proposal("failed", "read", `{"path":"/test"}`))
			} else {
				_, err = e.onlineReserve(context.Background(), s, c, 1)
			}
			if err == nil || onlineReport(t, e, s, c).StopReason != strategy.BudgetExhausted {
				t.Fatal("budget not enforced", err)
			}
		})
	}
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, c := enableOnline(t, e)
	_ = e.onlineObserve(s, c, Call{ID: "source", Name: "read", Arguments: `{"path":"/test"}`}, &onlinePolicyTrace{ReadOnly: true, TargetHash: "target"}, nil, context.DeadlineExceeded)
	if ok, err := e.onlineReserve(context.Background(), s, c, 300); !ok || err != nil {
		t.Fatal(err)
	}
	if err := e.onlineSettle(s, c, 300, Usage{}, nil); err != nil {
		t.Fatal(err)
	}
	if ok, err := e.onlineReserve(context.Background(), s, c, 100); !ok || err != nil {
		t.Fatal(err)
	}
	if err := e.onlineSettle(s, c, 100, Usage{InputKnown: true, OutputKnown: true, Input: 10, Output: 5}, nil); err != nil {
		t.Fatal(err)
	}
	r := onlineReport(t, e, s, c)
	if r.TokensCharged != 315 || !r.UsageUnknown || r.UnknownRequests != 1 {
		t.Fatal("unknown usage refunded", r)
	}
	for _, input := range []string{`{"a":1,"a":2}`, `{"a":{"b":1,"b":2}}`, `{} {}`, `null trailing`} {
		var out any
		if decodeOnlineJSON(input, &out) == nil {
			t.Fatal("ambiguous JSON accepted", input)
		}
	}
	e.CorrectionGuard = func(context.Context, string, int64, int64) error { return errors.New("revoked") }
	if _, err := e.onlinePropose(context.Background(), s, c, proposal("source", "read", `{"path":"/test"}`)); err == nil {
		t.Fatal("revoked proposal admitted")
	}
}

func TestOnlineFinalTextCannotCloseFailedCheck(t *testing.T) {
	m, close := fakeModel(t, func(n int, _ map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "missing", Name: "shell", Arguments: `{"command":"pwd"}`})
		}
		return response("Everything recovered successfully.")
	})
	defer close()
	e := engineFor(t, m, func(_ context.Context, _, name string, _ map[string]any, _ bool) (any, error) {
		if name == "runtimeCommandExec" {
			return nil, context.DeadlineExceeded
		}
		return map[string]any{"risk": "readonly", "runtime": "local"}, nil
	})
	s, c := enableOnline(t, e)
	if err := e.Chat(context.Background(), "case", "Check.", nil); err == nil {
		t.Fatal("model prose became runtime success")
	}
	r := onlineReport(t, e, s, c)
	view, _ := e.Snapshot("case")
	if r.StopReason != strategy.AwaitingUser || r.Recovered || len(r.OpenChecks) != 1 || view.Status != "failed" {
		t.Fatal("unresolved check was hidden", r, view.Status)
	}
}

func TestOnlineSREExplicitContinuePreservesBudgetAndWaitTTL(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, c := enableOnline(t, e)
	c.sre = &sreRoleContext{TaskID: "task"}
	if err := e.onlineObserve(s, c, Call{ID: "failed", Name: "read", Arguments: `{"path":"/test"}`}, &onlinePolicyTrace{ReadOnly: true, TargetHash: "target"}, nil, context.DeadlineExceeded); err != nil {
		t.Fatal(err)
	}
	_, _ = e.onlineUpdate(s, c, false, func(r *strategy.OnlineReport) error {
		r.Requests = 2
		r.TokensCharged = 50
		r.ActiveMilliseconds = 900
		r.StopReason = strategy.AwaitingUser
		return nil
	})
	before := onlineReport(t, e, s, c)
	if err := e.prepareOnlineSREContinue(context.Background(), s, c, "task"); err != nil {
		t.Fatal(err)
	}
	r := onlineReport(t, e, s, c)
	if r.ID != before.ID || r.Requests != 2 || r.TokensCharged != 50 || r.ActiveMilliseconds < 900 || r.StopReason != "" || r.ActiveAt == "" {
		t.Fatal("continue reset the parent task budget", r)
	}
	_, _ = e.onlineUpdate(s, c, false, func(r *strategy.OnlineReport) error {
		r.StopReason = strategy.AwaitingUser
		return nil
	})
	_, _ = e.onlineUpdate(s, c, false, func(r *strategy.OnlineReport) error {
		r.WaitSince = time.Now().Add(-25 * time.Hour).Format(time.RFC3339Nano)
		return nil
	})
	if err := e.prepareOnlineSREContinue(context.Background(), s, c, "task"); err == nil {
		t.Fatal("expired wait resumed")
	}
	if onlineReport(t, e, s, c).Requests != 2 {
		t.Fatal("expired resume refunded budget")
	}
}

func TestOnlineClosingAnotherFailureDoesNotEraseOriginalGap(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, c := enableOnline(t, e)
	trace := &onlinePolicyTrace{ReadOnly: true, TargetHash: "target"}
	_ = e.onlineObserve(s, c, Call{ID: "original", Name: "read", Arguments: `{"path":"/original"}`}, trace, nil, context.DeadlineExceeded)
	for i := 0; i < 2; i++ {
		source := "original"
		if i == 1 {
			source = "alternate"
		}
		if _, err := e.onlinePropose(context.Background(), s, c, proposal(source, "read", `{"path":"/alternate"}`)); err != nil {
			t.Fatal(err)
		}
		id := "alternate"
		if i == 1 {
			id = "alternate_success"
		}
		_, _ = e.onlineUpdate(s, c, false, func(r *strategy.OnlineReport) error {
			r.Revisions[len(r.Revisions)-1].CallID = id
			r.InFlightCall = id
			return nil
		})
		call := Call{ID: id, Name: "read", Arguments: `{"path":"/alternate"}`}
		if i == 0 {
			_ = e.onlineObserve(s, c, call, trace, nil, context.DeadlineExceeded)
		} else {
			_ = e.onlineObserve(s, c, call, trace, map[string]any{"content": "actual alternate result"}, nil)
		}
	}
	r := onlineReport(t, e, s, c)
	if r.Recovered || r.StopReason != strategy.BudgetExhausted || len(r.OpenChecks) != 1 || r.OpenChecks[0].CallID != "original" || !r.Revisions[1].Progress {
		t.Fatal("closing a different gap invented original recovery", r)
	}
}
