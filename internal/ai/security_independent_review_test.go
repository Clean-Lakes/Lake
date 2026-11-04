package ai

import (
	"context"
	"testing"
	"time"
)

// A process exit code can be known while its partial side effects still need
// reconciliation. Restoring an older backup must retain this newer risk.
func TestSecurityIndependentRecoveryRetainsFailedUnresolvedEffects(t *testing.T) {
	source := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	target := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	sourceStore, err := source.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	targetStore, err := target.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	op := nativeOperation{ID: "failed-partial-write", SessionID: "session", Tool: "shell", Status: "failed", Risk: "write", ResourceID: "asset", SecurityTaskID: "task", OrphanState: "effects_unknown", ClosureState: "effects_unknown", StartedAt: time.Now()}
	if err = sourceStore.DB.Create(&op).Error; err != nil {
		t.Fatal(err)
	}
	raw, err := sourceStore.DB.DB()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err = importRecoveryImpacts(ctx, targetStore.DB, raw, "recovery", "preserved", "source"); err != nil {
		t.Fatal(err)
	}
	var count int64
	if err = targetStore.DB.Model(&securityRecoveryImpactRow{}).Where("operation_id = ?", op.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	projection, err := inspectSecurityRiskStore(ctx, raw, "source", "preserved", 100)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 || projection.Unresolved != 1 || projection.EffectReview != 1 {
		t.Fatalf("failed unresolved writer lost on restore review: imported impacts=%d, unresolved=%d, effect review=%d", count, projection.Unresolved, projection.EffectReview)
	}
}
