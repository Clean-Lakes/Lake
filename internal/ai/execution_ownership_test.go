package ai

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func ownerFixture(t *testing.T, db *gorm.DB, task security.SecurityTask, now time.Time) ExecutionOwner {
	t.Helper()
	var owner ExecutionOwner
	if err := db.Transaction(func(tx *gorm.DB) error {
		binding, err := bindSecurityTaskTurn(tx, task.ID, "store", "epoch", "turn", "", task.ExecutionRevision, now)
		if err != nil {
			return err
		}
		owner, err = acquireExecutionOwner(tx, binding.ID, "owner", "agent", 0, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return owner
}

func TestExecutionOwnerStrictLeaseFenceAndHeartbeat(t *testing.T) {
	db, now := taskStoreFixture(t)
	task := startTaskFixture(t, db, now)
	owner := ownerFixture(t, db, task, now)
	if err := ValidateExecutionOwner(db, owner, now); err != nil {
		t.Fatal(err)
	}
	if _, err := acquireExecutionOwner(db, owner.BindingID, "other", "agent", owner.Generation, now); !errors.Is(err, errExecutionOwner) {
		t.Fatal("concurrent owner acquired lease", err)
	}
	if err := ValidateExecutionOwner(db, owner, owner.LeaseUntil); !errors.Is(err, errExecutionOwner) {
		t.Fatal("expiry gained sweep grace", err)
	}
	var renewed ExecutionOwner
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		renewed, err = renewExecutionOwner(tx, owner, now.Add(5*time.Second))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if !renewed.LeaseUntil.Equal(now.Add(20 * time.Second)) {
		t.Fatal(renewed.LeaseUntil)
	}
	var row securityTaskRow
	if err := db.First(&row, "id = ?", task.ID).Error; err != nil || !row.ExpiresAt.Equal(task.ExpiresAt) {
		t.Fatal("heartbeat refreshed absolute expiry", row, err)
	}
	if err := db.Transaction(func(tx *gorm.DB) error { return fenceExecutionOwner(tx, renewed, now.Add(6*time.Second)) }); err != nil {
		t.Fatal(err)
	}
	if err := ValidateExecutionOwner(db, renewed, now.Add(6*time.Second)); !errors.Is(err, errExecutionOwner) {
		t.Fatal("fenced owner retained authority", err)
	}
	if _, err := renewExecutionOwner(db, renewed, now.Add(7*time.Second)); err == nil {
		t.Fatal("late callback renewed owner")
	}
}

func TestExecutionOwnerPauseAndNewTurnRejectOldToken(t *testing.T) {
	db, now := taskStoreFixture(t)
	task := startTaskFixture(t, db, now)
	owner := ownerFixture(t, db, task, now)
	paused := transitionTaskFixture(t, db, task, security.TaskPaused, now.Add(time.Second))
	resumed := transitionTaskFixture(t, db, paused, security.TaskActive, now.Add(2*time.Second))
	if err := ValidateExecutionOwner(db, owner, now.Add(2*time.Second)); err == nil {
		t.Fatal("pause/resume revived owner")
	}
	var current ExecutionOwner
	if err := db.Transaction(func(tx *gorm.DB) error {
		binding, err := bindSecurityTaskTurn(tx, task.ID, "store", "epoch", "turn-2", "", resumed.ExecutionRevision, now.Add(2*time.Second))
		if err != nil {
			return err
		}
		current, err = acquireExecutionOwner(tx, binding.ID, "new-owner", "agent", 0, now.Add(2*time.Second))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateExecutionOwner(db, current, now.Add(3*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := bindSecurityTaskTurn(db, task.ID, "store", "epoch", "turn-3", "", resumed.ExecutionRevision, now.Add(4*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := ValidateExecutionOwner(db, current, now.Add(4*time.Second)); err == nil {
		t.Fatal("new RootTurn retained old owner")
	}
}

func TestExecutionOwnerDeadlineCapAndTransactionalRollback(t *testing.T) {
	db, now := taskStoreFixture(t)
	task := startTaskFixture(t, db, now)
	if err := db.Model(&securityTaskRow{}).Where("id = ?", task.ID).Update("expires_at", now.Add(8*time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	owner := ownerFixture(t, db, task, now)
	if !owner.LeaseUntil.Equal(now.Add(8 * time.Second)) {
		t.Fatal("lease exceeded task", owner)
	}
	aborted := errors.New("aborted")
	if err := db.Transaction(func(tx *gorm.DB) error {
		if _, err := renewExecutionOwner(tx, owner, now.Add(5*time.Second)); err != nil {
			return err
		}
		return aborted
	}); !errors.Is(err, aborted) {
		t.Fatal(err)
	}
	var b securityTaskBinding
	if err := db.First(&b, "id = ?", owner.BindingID).Error; err != nil || !b.LeaseUntil.Equal(owner.LeaseUntil) {
		t.Fatal("rolled back renewal persisted", b, err)
	}
	if _, err := renewExecutionOwner(db, owner, now.Add(8*time.Second)); err == nil {
		t.Fatal("expired task renewed lease")
	}
}

func TestExecutionOwnerHeartbeatAndFenceStayInOriginalChildScope(t *testing.T) {
	db, now := taskStoreFixture(t)
	task := startTaskFixture(t, db, now)
	owners := map[string]ExecutionOwner{}
	if _, err := bindSecurityTaskTurn(db, task.ID, "store", "epoch", "turn", "", 1, now); err != nil {
		t.Fatal(err)
	}
	for _, scope := range []string{"child-a", "child-b"} {
		if err := db.Transaction(func(tx *gorm.DB) error {
			binding, err := bindSecurityTaskTurn(tx, task.ID, "store", "epoch", "turn", scope, 1, now)
			if err != nil {
				return err
			}
			owners[scope], err = acquireExecutionOwner(tx, binding.ID, "same-process-owner", "agent", 0, now)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		ownedOperationFixture(t, db, task, owners[scope], scope+"-operation", now)
	}
	var renewed ExecutionOwner
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		renewed, err = renewExecutionOwner(tx, owners["child-a"], now.Add(5*time.Second))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var a, b nativeOperation
	if err := db.First(&a, "id = ?", "child-a-operation").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&b, "id = ?", "child-b-operation").Error; err != nil {
		t.Fatal(err)
	}
	if !a.OwnerLeaseUntil.Equal(now.Add(20*time.Second)) || !b.OwnerLeaseUntil.Equal(now.Add(15*time.Second)) {
		t.Fatal("one child renewed another child's lost lease", a.OwnerLeaseUntil, b.OwnerLeaseUntil)
	}
	if err := db.Transaction(func(tx *gorm.DB) error { return fenceExecutionOwner(tx, renewed, now.Add(6*time.Second)) }); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&b, "id = ?", "child-b-operation").Error; err != nil || b.OrphanState != "" {
		t.Fatal("fencing one child corrupted sibling operation", b, err)
	}
	if err := ValidateExecutionOwner(db, owners["child-b"], now.Add(7*time.Second)); err != nil {
		t.Fatal("fencing one child revoked its sibling", err)
	}
	if _, err := bindSecurityTaskTurn(db, task.ID, "store", "epoch", "new-turn", "", 1, now.Add(8*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := ValidateExecutionOwner(db, owners["child-b"], now.Add(8*time.Second)); err == nil {
		t.Fatal("new root turn resurrected old child dispatch")
	}
}

func TestExecutionOwnerConcurrentClaimHasSingleWinner(t *testing.T) {
	db, now := taskStoreFixture(t)
	task := startTaskFixture(t, db, now)
	binding, err := bindSecurityTaskTurn(db, task.ID, "store", "epoch", "turn", "", 1, now)
	if err != nil {
		t.Fatal(err)
	}
	var claimed atomic.Int32
	var group sync.WaitGroup
	start := make(chan struct{})
	for range 8 {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			if err := db.Transaction(func(tx *gorm.DB) error {
				_, err := acquireExecutionOwner(tx, binding.ID, uid(), "agent", 0, now)
				return err
			}); err == nil {
				claimed.Add(1)
			}
		}()
	}
	close(start)
	group.Wait()
	if claimed.Load() != 1 {
		t.Fatal("more than one owner claimed same execution", claimed.Load())
	}
}
