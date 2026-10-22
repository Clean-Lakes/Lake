package ai

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestADKConfirmationStillSettlesWhenEarlierCallResolvesTarget(t *testing.T) {
	runTargetPolicyApproval(t, false, false)
}

func TestADKRelaxedPolicyStillHonorsRejectionAndChangedFingerprint(t *testing.T) {
	t.Run("reject", func(t *testing.T) { runTargetPolicyApproval(t, true, false) })
	t.Run("changed fingerprint", func(t *testing.T) { runTargetPolicyApproval(t, false, true) })
}

func runTargetPolicyApproval(t *testing.T, rejectSecond, changeFingerprint bool) {
	t.Helper()
	var executed atomic.Int32
	m, closeModel := fakeModel(t, func(n int, _ map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "first", Name: "shell", Arguments: js(map[string]any{"command": "printf fixture-first", "asset_ref": assetAlias("fixture-a")})}, Call{ID: "second", Name: "shell", Arguments: js(map[string]any{"command": "printf fixture-second", "asset_ref": assetAlias("fixture-b")})})
		}
		return response("fixture complete")
	})
	defer closeModel()
	e := engineFor(t, m, func(_ context.Context, _ string, name string, args map[string]any, _ bool) (any, error) {
		if name == "policy" {
			fingerprint := "same-fixture-target"
			if changeFingerprint && executed.Load() > 0 {
				fingerprint = "different-fixture-target"
			}
			ref := "fixture-a"
			if str(obj(args["arguments"])["asset_ref"]) == assetAlias("fixture-b") {
				ref = "fixture-b"
			}
			return map[string]any{"risk": "readonly", "needsTarget": executed.Load() == 0, "target": "fixture", "fingerprint": fingerprint + ref, "runtime": "local", "asset_ref": ref}, nil
		}
		if name == "runtimeCommandExec" {
			executed.Add(1) // No real command is executed by this fixture.
			return map[string]any{"exitCode": 0}, nil
		}
		return nil, fmt.Errorf("unexpected bridge %s", name)
	})
	s, _ := e.get("case")
	c := s.state.Config
	c.Assets = []Asset{{ID: "fixture-a", Name: "fixture A", Kind: "local"}, {ID: "fixture-b", Name: "fixture B", Kind: "local"}}
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- e.Chat(ctx, "case", "resolve two fixture targets", nil) }()
	seen := map[string]bool{}
	// Wait for the actual turn result within its existing bounded context.
	// A second, shorter wall clock can expire after all decisions/effects have
	// completed while Windows is still persisting the final ADK response.
	for {
		select {
		case <-ctx.Done():
			t.Fatalf("confirmation did not finish within turn context: decisions=%d, effects=%d: %v", len(seen), executed.Load(), ctx.Err())
		case err := <-result:
			wantEffects := int32(2)
			if rejectSecond || changeFingerprint {
				wantEffects = 1
			}
			if err != nil || len(seen) != 2 || executed.Load() != wantEffects {
				t.Fatal("confirmation did not settle exactly once", err, len(seen), executed.Load())
			}
			store, _ := e.adkStore()
			var unsettled int64
			if err := store.DB.Model(&nativeApproval{}).Where("status IN ?", []string{"pending", "decided", "authorized"}).Count(&unsettled).Error; err != nil || unsettled != 0 {
				t.Fatal("durable confirmation was left actionable", unsettled, err)
			}
			return
		default:
		}
		v, _ := e.Snapshot("case")
		if v.Pending != nil && !seen[v.Pending.ID] {
			accept := !rejectSecond || len(seen) == 0
			if err := e.Decision("case", v.Pending.ID, accept, v.Pending.Confirmation); err != nil {
				t.Fatal(err)
			}
			seen[v.Pending.ID] = true
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestADKParallelConfirmationsAdvanceWithoutRepeatingDecidedCard(t *testing.T) {
	dir := t.TempDir()
	paths := make([]string, 4)
	calls := make([]Call, 4)
	for i := range paths {
		paths[i] = filepath.Join(dir, fmt.Sprintf("fixture-%d.txt", i))
		calls[i] = Call{ID: fmt.Sprintf("parallel-write-%d", i), Name: "append", Arguments: js(map[string]any{"path": paths[i], "content": "once\n"})}
	}
	m, closeModel := fakeModel(t, func(n int, _ map[string]any) any {
		if n == 1 {
			return response("", calls...)
		}
		return response("fixture complete")
	})
	defer closeModel()
	e := engineFor(t, m, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- e.Chat(ctx, "case", "append to four fixture files", nil) }()
	seen := map[string]bool{}
	for len(seen) < 4 {
		select {
		case err := <-result:
			t.Fatalf("turn ended after %d/4 decisions: %v", len(seen), err)
		case <-ctx.Done():
			v, _ := e.Snapshot("case")
			t.Fatalf("approval queue stalled after %d/4 decisions; pending=%s", len(seen), js(v.Pending))
		default:
		}
		v, err := e.Snapshot("case")
		if err == nil && v.Pending != nil && !seen[v.Pending.ID] {
			if err = e.Decision("case", v.Pending.ID, true, v.Pending.Confirmation); err != nil {
				t.Fatal(err)
			}
			seen[v.Pending.ID] = true
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil || string(data) != "once\n" {
			t.Fatalf("fixture effect did not execute exactly once: %q %v", data, err)
		}
	}
}
