package ai

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

type orphanTestAdapter struct {
	db                        *gorm.DB
	cancelCount, observeCount int
	cancelState               CancellationObservation
	observation               OrphanObservation
	last                      ExecutionCleanup
}

func (a *orphanTestAdapter) Cancel(ctx context.Context, c ExecutionCleanup) (CancellationObservation, error) {
	a.cancelCount++
	a.last = c
	// Store has a single connection: this query would block if the caller kept
	// its transaction/connection across cleanup I/O.
	var count int64
	if err := a.db.WithContext(ctx).Model(&nativeOperation{}).Count(&count).Error; err != nil {
		return CancellationUnknown, err
	}
	return a.cancelState, nil
}
func (a *orphanTestAdapter) Observe(ctx context.Context, c ExecutionCleanup) (OrphanObservation, error) {
	a.observeCount++
	a.last = c
	return a.observation, nil
}

func ownedOperationFixture(t *testing.T, db *gorm.DB, task security.SecurityTask, owner ExecutionOwner, id string, now time.Time) nativeOperation {
	t.Helper()
	op := nativeOperation{ID: id, ProjectID: task.ProjectID, SessionID: task.SessionID, RootTurnID: owner.RootTurnID, GoalID: task.GoalID, GoalRevision: 1, PlanRevision: 1, StepID: "step", StepRevision: 1, AttemptID: "attempt", SecurityTaskID: task.ID, StoreID: task.StoreID, RecoveryEpoch: task.RecoveryEpoch, ExecutionRevision: task.ExecutionRevision, OwnerID: owner.OwnerID, OwnerKind: "agent", OwnerGeneration: owner.Generation, OwnerLeaseUntil: owner.LeaseUntil, ResourceID: "resource", Tool: "trusted_job", Risk: "write", Status: "unknown", Handle: "original-handle", StartedAt: now}
	op.Identity = js(RunIdentity{SessionID: owner.SessionID, RootTurnID: owner.RootTurnID, ScopeID: owner.ScopeID})
	if err := db.Create(&op).Error; err != nil {
		t.Fatal(err)
	}
	return op
}

func TestOrphanCancellationDoesNotResolveUnknownEffects(t *testing.T) {
	db, now := taskStoreFixture(t)
	task := startTaskFixture(t, db, now)
	owner := ownerFixture(t, db, task, now)
	op := ownedOperationFixture(t, db, task, owner, "operation", now)
	adapter := &orphanTestAdapter{db: db, cancelState: CancellationConfirmed, observation: OrphanObservation{Stopped: true, EffectsKnown: false, Status: "unknown", Evidence: "connection closed"}}
	resolver := func(tool, resource string) OrphanCleanupAdapter {
		if tool != op.Tool || resource != op.ResourceID {
			t.Fatal("cleanup re-resolved target")
		}
		return adapter
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := ReconcileOrphanedExecutions(ctx, db, "store", "epoch", owner.LeaseUntil, resolver); err != nil {
		t.Fatal(err)
	}
	if adapter.cancelCount != 1 || adapter.observeCount != 1 || adapter.last.Handle != op.Handle {
		t.Fatal(adapter)
	}
	var after nativeOperation
	if err := db.First(&after, "id = ?", op.ID).Error; err != nil {
		t.Fatal(err)
	}
	if after.Status != "unknown" || after.OrphanState != "orphaned" || after.CancellationState != "confirmed" || after.ClosureState == "reconciled" || after.RiskResolvedAt != nil {
		t.Fatal("cancel request erased side effect uncertainty", after)
	}
	if err := CheckResourceWriteBlock(db, "resource"); err != ErrUnresolvedResourceEffect {
		t.Fatal("unknown write did not block resource", err)
	}
	if err := CheckResourceWriteBlock(db, "independent-resource"); err != nil {
		t.Fatal("known resource blocked independent write", err)
	}
	if err := ValidateExecutionOwner(db, owner, owner.LeaseUntil.Add(time.Millisecond)); err == nil {
		t.Fatal("late callback retained dispatch authority")
	}
	// A new goal's successful operation cannot clear the old goal's block.
	if err := db.Create(&nativeOperation{ID: "new-goal-success", GoalID: "goal2", ResourceID: "resource", Status: "succeeded", Risk: "write"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := CheckResourceWriteBlock(db, "resource"); err != ErrUnresolvedResourceEffect {
		t.Fatal("new success cleared old unknown", err)
	}
	adapter.observation = OrphanObservation{Stopped: true, EffectsKnown: true, Status: "failed", Evidence: "trusted final job state with secret-key-not-for-audit"}
	if err := ReconcileOrphanedExecutions(ctx, db, "store", "epoch", owner.LeaseUntil.Add(ExecutionOwnerHeartbeat), resolver); err != nil {
		t.Fatal(err)
	}
	if adapter.cancelCount != 1 {
		t.Fatal("confirmed cancellation repeated", adapter.cancelCount)
	}
	if err := db.First(&after, "id = ?", op.ID).Error; err != nil || after.Status != "unknown" || after.ClosureState != "reconciled" || after.RiskResolvedAt == nil {
		t.Fatal("original result lost or proof not applied", after, err)
	}
	if err := CheckResourceWriteBlock(db, "resource"); err != nil {
		t.Fatal(err)
	}
	var evidence []nativeEvidence
	if err := db.Where("operation_id = ?", op.ID).Find(&evidence).Error; err != nil {
		t.Fatal(err)
	}
	if len(evidence) != 2 {
		t.Fatal("orphan discovery or reconciliation audit duplicated/lost", len(evidence))
	}
	for _, entry := range evidence {
		if strings.Contains(entry.Data, "secret-key") {
			t.Fatal("raw adapter output leaked into audit")
		}
	}
}

func TestOrphanLegacyHumanAndUnknownResourceNeverAutoCancelled(t *testing.T) {
	db, now := taskStoreFixture(t)
	ops := []nativeOperation{
		{ID: "human", OwnerKind: "human", ResourceID: "human-resource", Status: "dispatched", Risk: "readonly", Handle: "human-terminal"},
		{ID: "legacy", Status: "unknown", Risk: "write", Handle: "legacy-unowned-terminal"},
		{ID: "old-read", Status: "unknown", Risk: "readonly", Handle: "legacy-read"},
	}
	if err := db.Create(&ops).Error; err != nil {
		t.Fatal(err)
	}
	adapter := &orphanTestAdapter{db: db, cancelState: CancellationConfirmed, observation: OrphanObservation{Stopped: true, EffectsKnown: true, Status: "succeeded", Evidence: "proof"}}
	if err := ReconcileOrphanedExecutions(context.Background(), db, "store", "epoch", now, func(string, string) OrphanCleanupAdapter { return adapter }); err != nil {
		t.Fatal(err)
	}
	if adapter.cancelCount != 0 || adapter.observeCount != 0 {
		t.Fatal("unowned/human process automatically controlled", adapter)
	}
	var human nativeOperation
	if err := db.First(&human, "id = ?", "human").Error; err != nil || human.OrphanState != "" {
		t.Fatal("human terminal fenced", human, err)
	}
	var legacy nativeOperation
	if err := db.First(&legacy, "id = ?", "legacy").Error; err != nil || legacy.OrphanState != "manual_review" || legacy.Status != "unknown" {
		t.Fatal(legacy, err)
	}
	if err := CheckResourceWriteBlock(db, "any-resource"); err != ErrUnresolvedResourceEffect {
		t.Fatal("unknown impact was treated as a scoped safe operation", err)
	}
}

func TestOrphanHealthyPageCannotHideLaterOrphan(t *testing.T) {
	db, now := taskStoreFixture(t)
	task := startTaskFixture(t, db, now)
	owner := ownerFixture(t, db, task, now)
	var healthy []nativeOperation
	for i := 0; i < 1000; i++ {
		healthy = append(healthy, nativeOperation{ID: fmt.Sprintf("a-%04d", i), OwnerKind: "human", Status: "dispatched", Risk: "readonly"})
	}
	if err := db.CreateInBatches(&healthy, 100).Error; err != nil {
		t.Fatal(err)
	}
	op := ownedOperationFixture(t, db, task, owner, "z-orphan", now)
	adapter := &orphanTestAdapter{db: db, cancelState: CancellationUnsupported}
	if err := ReconcileOrphanedExecutions(context.Background(), db, "store", "epoch", owner.LeaseUntil, func(string, string) OrphanCleanupAdapter { return adapter }); err != nil {
		t.Fatal(err)
	}
	if adapter.cancelCount != 1 || adapter.last.OperationID != op.ID {
		t.Fatal("later orphan starved behind healthy page", adapter.cancelCount, adapter.last)
	}
}

func TestOrphanMarkingRollsBackAndMissingTaskStopsOwner(t *testing.T) {
	db, now := taskStoreFixture(t)
	task := startTaskFixture(t, db, now)
	owner := ownerFixture(t, db, task, now)
	op := ownedOperationFixture(t, db, task, owner, "op", now)
	if err := db.Model(&securityTaskRow{}).Where("id = ?", task.ID).Update("state", security.TaskPaused).Error; err != nil {
		t.Fatal(err)
	}
	rollback := fmt.Errorf("rollback")
	if err := db.Transaction(func(tx *gorm.DB) error {
		ops, err := MarkOrphanedExecutions(tx, "store", "epoch", now, 100)
		if err != nil {
			return err
		}
		if len(ops) != 1 {
			t.Fatal(ops)
		}
		return rollback
	}); err != rollback {
		t.Fatal(err)
	}
	if err := db.First(&op, "id = ?", op.ID).Error; err != nil || op.OrphanState != "" {
		t.Fatal("rollback partially fenced ledger", op, err)
	}
	var count int64
	if err := db.Model(&nativeEvidence{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("rollback appended audit", count, err)
	}
	if err := ReconcileOrphanedExecutions(context.Background(), db, "store", "epoch", now, nil); err != nil {
		t.Fatal(err)
	}
	if err := ValidateExecutionOwner(db, owner, now); err == nil {
		t.Fatal("paused task had an effective owner")
	}
}

func TestResourceSetRiskBlocksEveryFrozenTargetAndLateCallbacksDoNotClearIt(t *testing.T) {
	db, now, descriptor, _, _ := permitFixture(t)
	descriptor.TargetKind = security.TargetResourceSet
	descriptor.Resources = append(descriptor.Resources, security.ResourceRevision{ID: "second-resource", ConnectionRevision: 1, ConnectionDigest: security.ContentDigest([]byte("second")), State: "ready"})
	digest, err := security.OperationDigest(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	op := nativeOperation{ID: descriptor.ID, SessionID: descriptor.SessionID, RootTurnID: descriptor.RootTurnID, GoalID: descriptor.GoalID, SecurityTaskID: descriptor.TaskID, StoreID: descriptor.StoreID, RecoveryEpoch: descriptor.RecoveryEpoch, ResourceID: descriptor.Resources[0].ID, Risk: "write", Status: "failed", OrphanState: "orphaned", SecurityDescriptor: js(descriptor), DescriptorDigest: digest, StartedAt: now}
	if err = db.Create(&op).Error; err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{descriptor.Resources[0].ID, "second-resource"} {
		if err = CheckResourceWriteBlock(db, id); err != ErrUnresolvedResourceEffect {
			t.Fatal("resource-set member lost unresolved risk", id, err)
		}
	}
	if err = CheckResourceWriteBlock(db, "independent-resource"); err != nil {
		t.Fatal("validated resource-set became global conflict", err)
	}
	if err = CheckResourceWriteBlock(db, ""); err != ErrUnresolvedResourceEffect {
		t.Fatal("resource-less mutation bypassed unresolved scoped writer", err)
	}
	if err = db.Model(&nativeOperation{}).Where("id = ?", op.ID).Update("descriptor_digest", "mismatched").Error; err != nil {
		t.Fatal(err)
	}
	if err = CheckResourceWriteBlock(db, "independent-resource"); err != ErrUnresolvedResourceEffect {
		t.Fatal("unverifiable resource-set identity allowed writes", err)
	}
	if err = db.Model(&nativeOperation{}).Where("id = ?", op.ID).Update("closure_state", "reconciled").Error; err != nil {
		t.Fatal(err)
	}
	if err = CheckResourceWriteBlock(db, "second-resource"); err != nil {
		t.Fatal("trusted reconciliation did not release risk", err)
	}
}

func TestRunningOperationUsesConsumedAuthorityAndStopsOnItsExpiry(t *testing.T) {
	db, now, descriptor, owner, grant := permitFixture(t)
	if err := db.Model(&securityTaskGrantRow{}).Where("id = ?", grant.ID).Update("expires_at", now.Add(7*time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	unused := grant
	unused.ID = "unused-candidate"
	unused.Revoked = true
	unused.RemainingUses = 0
	if err := db.Create(&securityTaskGrantRow{ID: unused.ID, TaskID: unused.TaskID, GoalID: unused.GoalID, ProjectID: unused.ProjectID, SessionID: unused.SessionID, StoreID: unused.StoreID, RecoveryEpoch: unused.RecoveryEpoch, Revision: 1, ExpiresAt: unused.ExpiresAt, Revoked: true, Data: js(unused)}).Error; err != nil {
		t.Fatal(err)
	}
	descriptor.GrantRevisions = append(descriptor.GrantRevisions, security.RevisionRef{ID: unused.ID, Revision: 1})
	var prepared *SecurityPermit
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		prepared, err = AcquireSecurityPermitTx(tx, descriptor, owner, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var task securityTaskRow
	if err := db.First(&task, "id = ?", owner.TaskID).Error; err != nil {
		t.Fatal(err)
	}
	op := ownedOperationFixture(t, db, task.task(), owner, descriptor.ID, now)
	if err := db.Model(&nativeOperation{}).Where("id = ?", op.ID).Updates(map[string]any{"security_descriptor": js(prepared.operation), "descriptor_digest": prepared.digest, "tool": descriptor.Tool, "call_id": descriptor.CallID, "args_hash": descriptor.ArgumentsDigest, "resource_id": descriptor.Resources[0].ID, "resource_connection_revision": descriptor.Resources[0].ConnectionRevision}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&op, "id = ?", op.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&securityTaskGrantRow{}).Where("id = ?", grant.ID).Update("remaining_uses", 0).Error; err != nil {
		t.Fatal(err)
	}
	valid, err := runningOperationAuthorityValid(db, op, now.Add(6*time.Second))
	if err != nil || !valid {
		t.Fatal("unused revoked candidate or consumedlastuse cancelled running operation", valid, err)
	}
	valid, err = runningOperationAuthorityValid(db, op, now.Add(7*time.Second))
	if err != nil || valid {
		t.Fatal("running operation outlived usedgrant expiry", valid, err)
	}
	adapter := &orphanTestAdapter{db: db, cancelState: CancellationRequested}
	if err = ReconcileOrphanedExecutions(context.Background(), db, "store", "epoch", now.Add(7*time.Second), func(string, string) OrphanCleanupAdapter { return adapter }); err != nil {
		t.Fatal(err)
	}
	if adapter.cancelCount != 1 {
		t.Fatal("expired usedauthority did not cancel known job whileownerlease remainedvalid", adapter.cancelCount)
	}
	if err = ValidateExecutionOwner(db, owner, now.Add(7*time.Second)); err == nil {
		t.Fatal("authorityloss did not freeze old owner")
	}
}
