package ai

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func monitorOperationFixture(t *testing.T) (*gorm.DB, time.Time, nativeOperation, ExecutionOwner, security.TaskGrant) {
	t.Helper()
	db, now, descriptor, owner, grant := permitFixture(t)
	var permit *SecurityPermit
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		permit, err = AcquireSecurityPermitTx(tx, descriptor, owner, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var task securityTaskRow
	if err := db.First(&task, "id = ?", owner.TaskID).Error; err != nil {
		t.Fatal(err)
	}
	op := ownedOperationFixture(t, db, task.task(), owner, descriptor.ID, now)
	if err := db.Model(&nativeOperation{}).Where("id = ?", op.ID).Updates(map[string]any{"security_descriptor": js(permit.operation), "descriptor_digest": permit.digest, "tool": descriptor.Tool, "call_id": descriptor.CallID, "args_hash": descriptor.ArgumentsDigest, "resource_id": descriptor.Resources[0].ID, "resource_connection_revision": descriptor.Resources[0].ConnectionRevision}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&op, "id = ?", op.ID).Error; err != nil {
		t.Fatal(err)
	}
	return db, now, op, owner, grant
}

func TestExecutionMonitorRequiresConsentAndCannotDispatch(t *testing.T) {
	db, now, op, agent, grant := monitorOperationFixture(t)
	if _, err := AcquireExecutionMonitorTx(db, op.ID, agent, now); !errors.Is(err, errExecutionMonitor) {
		t.Fatal("model background flag implied monitor consent", err)
	}
	if err := db.Model(&securityTaskRow{}).Where("id = ?", agent.TaskID).Update("background_policy", "monitored_background").Error; err != nil {
		t.Fatal(err)
	}
	var monitor ExecutionOwner
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		monitor, err = AcquireExecutionMonitorTx(tx, op.ID, agent, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateExecutionOwner(db, monitor, now); !errors.Is(err, errExecutionOwner) {
		t.Fatal("monitor became agent execution authority", err)
	}
	var task securityTaskRow
	if err := db.First(&task, "id = ?", agent.TaskID).Error; err != nil {
		t.Fatal(err)
	}
	transitionTaskFixture(t, db, task.task(), security.TaskIdle, now.Add(time.Second))
	if err := ValidateExecutionOwner(db, agent, now.Add(time.Second)); err == nil {
		t.Fatal("old root binding survived turn end")
	}
	if ok, err := operationHasValidMonitor(db, op, now.Add(time.Second)); err != nil || !ok {
		t.Fatal("consented original job lost monitoring", ok, err)
	}
	if orphan, err := orphanedExecution(db, op, "store", "epoch", now.Add(time.Second)); err != nil || orphan {
		t.Fatal("valid monitor treated as orphan", orphan, err)
	}
	var renewed ExecutionOwner
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		renewed, err = RenewExecutionMonitorTx(tx, monitor, now.Add(5*time.Second))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if !renewed.LeaseUntil.Equal(now.Add(20 * time.Second)) {
		t.Fatal(renewed)
	}
	if err := db.Model(&securityTaskGrantRow{}).Where("id = ?", grant.ID).Updates(map[string]any{"revoked": true, "revision": grant.Revision + 1}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := RenewExecutionMonitorTx(db, renewed, now.Add(6*time.Second)); err == nil {
		t.Fatal("monitor renewed revoked usedauthority")
	}
	adapter := &orphanTestAdapter{db: db, cancelState: CancellationRequested}
	if err := ReconcileOrphanedExecutions(context.Background(), db, "store", "epoch", now.Add(6*time.Second), func(string, string) OrphanCleanupAdapter { return adapter }); err != nil {
		t.Fatal(err)
	}
	if adapter.cancelCount != 1 {
		t.Fatal("revoked monitor authority did not cancel original job", adapter.cancelCount)
	}
	if err := CheckResourceWriteBlock(db, op.ResourceID); err != ErrUnresolvedResourceEffect {
		t.Fatal("cancel request cleared unknown background effect", err)
	}
}

func TestExecutionMonitorRetainsProjectAllowBudgetSource(t *testing.T) {
	db, now, op, agent, grant := monitorOperationFixture(t)
	// Project permission and the independently consumed task budget are separate
	// authority sources. A zero balance is valid for this already-running job.
	sources := []security.AuthoritySource{{Kind: "project", ID: "project", Revision: 1}, {Kind: "task_budget", ID: grant.ID, Revision: grant.Revision}}
	if err := db.Model(&securityDecisionRow{}).Where("operation_id = ?", op.ID).Update("authorities", js(sources)).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&securityTaskGrantRow{}).Where("id = ?", grant.ID).Updates(map[string]any{"expires_at": now.Add(7 * time.Second), "remaining_uses": 0}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&securityTaskRow{}).Where("id = ?", agent.TaskID).Update("background_policy", "monitored_background").Error; err != nil {
		t.Fatal(err)
	}
	monitor, err := AcquireExecutionMonitorTx(db, op.ID, agent, now)
	if err != nil || !monitor.LeaseUntil.Equal(now.Add(7*time.Second)) {
		t.Fatal("monitor outlived actual task-budget expiry", monitor, err)
	}
	if _, err = RenewExecutionMonitorTx(db, monitor, now.Add(5*time.Second)); err != nil {
		t.Fatal("consumed final budget use revoked original job", err)
	}
	if ok, err := operationHasValidMonitor(db, op, now.Add(7*time.Second)); err != nil || ok {
		t.Fatal("project allow concealed expired task budget", ok, err)
	}
}

func TestExecutionMonitorClosesOnlyAfterOriginalTerminalResult(t *testing.T) {
	db, now, op, agent, _ := monitorOperationFixture(t)
	if err := db.Model(&securityTaskRow{}).Where("id = ?", agent.TaskID).Update("background_policy", "monitored_background").Error; err != nil {
		t.Fatal(err)
	}
	var monitor ExecutionOwner
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		monitor, err = AcquireExecutionMonitorTx(tx, op.ID, agent, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := CloseCompletedExecutionMonitorTx(db, monitor, now); !errors.Is(err, errExecutionMonitor) {
		t.Fatal("running monitor closed without original result", err)
	}
	if err := db.Model(&nativeOperation{}).Where("id = ?", op.ID).Update("status", "succeeded").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Transaction(func(tx *gorm.DB) error { return CloseCompletedExecutionMonitorTx(tx, monitor, now.Add(time.Second)) }); err != nil {
		t.Fatal(err)
	}
	var binding securityTaskBinding
	if err := db.First(&binding, "id = ?", monitor.BindingID).Error; err != nil || binding.State != "closed" {
		t.Fatal(binding, err)
	}
}
