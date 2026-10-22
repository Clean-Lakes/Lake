package ai

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestADKConcurrentApprovalExecutesActualAppendOnce(t *testing.T) {
	target := filepath.Join(t.TempDir(), "effect")
	m, close := fakeModel(t, func(n int, _ map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "concurrent", Name: "append", Arguments: js(map[string]any{"path": target, "content": "once\n"})})
		}
		return response("complete")
	})
	defer close()
	e := engineFor(t, m, nil)
	// This test races approval decisions, not first-use schema/ACL setup.
	if _, err := e.adkStore(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- e.Chat(context.Background(), "case", "append fixture", nil) }()
	p := waitApproval(t, e)
	var accepted atomic.Int32
	var wg sync.WaitGroup
	for range 24 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e.Decision("case", p.ID, true, p.Confirmation) == nil {
				accepted.Add(1)
			}
		}()
	}
	wg.Wait()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(target)
	if accepted.Load() != 1 || err != nil || string(data) != "once\n" {
		t.Fatal("concurrent decision replayed effect", accepted.Load(), err)
	}
	store, _ := e.adkStore()
	var approvals []nativeApproval
	_ = store.DB.Find(&approvals).Error
	if len(approvals) != 1 || approvals[0].Status != "consumed" {
		t.Fatal("dispatch did not atomically consume authorization")
	}
}

func TestADKUnknownOutcomeRequiresHumanEvidenceAndCannotCrossSessions(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	store, _ := e.adkStore()
	row := nativeOperation{ID: "original", SessionID: "case", Status: "unknown", Risk: "write", Tool: "append", StartedAt: time.Now()}
	if err := store.DB.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	if err := e.ResolveOperation("other", row.ID, "succeeded", "checked fixture"); err == nil {
		t.Fatal("cross-session resolution allowed")
	}
	if err := e.ResolveOperation("case", row.ID, "succeeded", ""); err == nil {
		t.Fatal("unverified outcome accepted")
	}
	if err := e.ResolveOperation("case", row.ID, "succeeded", "read the original fixture file and confirmed contents"); err != nil {
		t.Fatal(err)
	}
	if err := e.ResolveOperation("case", row.ID, "not_executed", "replacement verdict"); err == nil {
		t.Fatal("settled operation overwritten")
	}
	outcomes, err := e.OperationOutcomes("case")
	if err != nil || len(outcomes) != 0 {
		t.Fatal("resolved operation still blocks writes", err)
	}
}

func TestHumanResolutionUnblocksNewWriteWithoutReplayingOriginal(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	ctx := context.WithValue(context.Background(), adkToolContextKey{}, true)
	original := Call{ID: "original", Name: "append", Arguments: `{}`}
	op, err := e.dispatchNativeOperation(ctx, s, c, original, "write", "fixture", "fixture")
	if err != nil {
		t.Fatal(err)
	}
	store, _ := e.adkStore()
	if err = store.DB.Model(&nativeOperation{}).Where("id = ?", op.ID).Update("status", "unknown").Error; err != nil {
		t.Fatal(err)
	}
	if _, err = e.Handle(ctx, "resolveOperation", "case", []byte(js(map[string]any{"id": op.ID, "status": "not_executed", "note": "checked the original fixture; no effect occurred"}))); err != nil {
		t.Fatal(err)
	}
	if _, err = e.dispatchNativeOperation(ctx, s, c, original, "write", "fixture", "fixture"); err == nil {
		t.Fatal("human resolution enabled replay of the original call")
	}
	if _, err = e.dispatchNativeOperation(ctx, s, c, Call{ID: "new", Name: "append", Arguments: `{}`}, "write", "fixture", "fixture"); err != nil {
		t.Fatal("verified outcome still blocks a new write", err)
	}
	var evidence int64
	store.DB.Model(&nativeEvidence{}).Where("operation_id = ? AND status = ?", op.ID, "resolved_not_executed").Count(&evidence)
	if evidence != 1 {
		t.Fatal("human verification did not retain exactly one audit record")
	}
}

func TestADKOperationOutcomesOnlyRequireVerificationWhenUnknown(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"dispatched", "succeeded", "failed", "not_executed", "unknown"} {
		row := nativeOperation{ID: status, SessionID: "case", Status: status, Risk: "write", Tool: "shell", StartedAt: time.Now()}
		if err := store.DB.Create(&row).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []nativeOperation{
		{ID: "other-session", SessionID: "other", Status: "unknown", Risk: "write"},
		{ID: "readonly", SessionID: "case", Status: "unknown", Risk: "readonly"},
	} {
		if err := store.DB.Create(&row).Error; err != nil {
			t.Fatal(err)
		}
	}
	view, err := e.Snapshot("case")
	if err != nil {
		t.Fatal(err)
	}
	if len(view.OperationOutcomes) != 1 || view.OperationOutcomes[0].ID != "unknown" {
		t.Fatalf("only unknown effects should request verification: %+v", view.OperationOutcomes)
	}
	var running nativeOperation
	if err := store.DB.First(&running, "id = ?", "dispatched").Error; err != nil || running.Status != "dispatched" {
		t.Fatalf("view must preserve the running operation ledger: %+v, %v", running, err)
	}
	if err := e.ResolveOperation("case", "dispatched", "succeeded", "still running"); err == nil {
		t.Fatal("running operation accepted a manual verdict")
	}
}

func TestADKInterruptedOperationStillRequestsVerificationAfterRestart(t *testing.T) {
	dir := t.TempDir()
	e, err := New(dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	row := nativeOperation{ID: "interrupted", SessionID: "case", Status: "dispatched", Risk: "write", Tool: "shell", StartedAt: time.Now()}
	if err := store.DB.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	e.Shutdown()
	restarted, err := New(dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Shutdown()
	view, err := restarted.Snapshot("case")
	if err != nil || len(view.OperationOutcomes) != 1 || view.OperationOutcomes[0].ID != row.ID || view.OperationOutcomes[0].Status != "unknown" {
		t.Fatalf("interrupted effect must still require verification: %+v, %v", view.OperationOutcomes, err)
	}
}

func TestADKMissingPolicyFingerprintFailsClosed(t *testing.T) {
	e, err := New(t.TempDir(), func(context.Context, string, string, map[string]any, bool) (any, error) { return nil, nil }, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown()
	if _, _, err = e.policy(context.Background(), "case", Config{}, "shell", map[string]any{"command": "printf forbidden"}); err == nil {
		t.Fatal("missing policy target allowed")
	}
}
