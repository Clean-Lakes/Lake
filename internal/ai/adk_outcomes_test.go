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
