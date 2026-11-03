//go:build darwin || linux

package ai

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestSecuritySavedLocalDenyStopsAlreadyOwnedLocalProcess(t *testing.T) {
	e, c, ctx, cancel, operation, _, a := managedShellFixture(t, true, "sleep 30")
	defer cancel()
	owner, err := securityRootEngine(e)
	if err != nil {
		t.Fatal(err)
	}
	owner.adkMu.Lock()
	services := owner.adk
	owner.adkMu.Unlock()
	services.catalogMu.Lock()
	original := services.catalogResolver
	services.catalogMu.Unlock()
	var denied atomic.Bool
	if err = e.SetSecurityCatalogResolver(func(ctx context.Context, q SecurityCatalogQuery) (SecurityCatalogView, error) {
		view, err := original(ctx, q)
		view.HardLocalDeny = denied.Load()
		return view, err
	}); err != nil {
		t.Fatal(err)
	}
	value, err := e.startManagedShell(ctx, c, a, str(a["command"]))
	if err != nil {
		t.Fatal(err)
	}
	if err = e.finishNativeOperation(operation, c, value, nil); err != nil {
		t.Fatal(err)
	}
	job := e.managedShellByOperation(operation.ID)
	if job == nil {
		t.Fatal("owned original process missing")
	}
	denied.Store(true)
	select {
	case <-job.done:
	case <-time.After(8 * time.Second):
		t.Fatal("saved hard deny did not stop the owned local process")
	}
	job.mu.Lock()
	cancelled := job.cancellationRequested
	job.mu.Unlock()
	if !cancelled {
		t.Fatal("process ended without recording cancellation source")
	}
	store, _ := e.adkStore()
	var row nativeOperation
	if err = store.DB.First(&row, "id = ?", operation.ID).Error; err != nil {
		t.Fatal(err)
	}
	if row.Status == "succeeded" || row.RiskResolvedAt != nil {
		t.Fatal("stop was confused with known business effects", row.Status)
	}
}
