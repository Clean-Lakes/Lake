package ai

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/agent/storage"
	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func taskStoreFixture(t *testing.T) (*gorm.DB, time.Time) {
	t.Helper()
	store, err := storage.Open(filepath.Join(t.TempDir(), "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	if err = store.DB.AutoMigrate(&nativeWorkGoal{}, &nativeOperation{}, &nativeEvidence{}); err != nil {
		t.Fatal(err)
	}
	if err = migrateSecurityStore(store.DB); err != nil {
		t.Fatal(err)
	}
	if err = store.DB.Create(&nativeWorkGoal{ID: "goal", SessionID: "session", Status: "running", Revision: 1, GoalRevision: 1, PlanRevision: 1, ClosureContract: js(WorkClosureContract{ProjectID: "project", GoalRevision: 1, PlanRevision: 1})}).Error; err != nil {
		t.Fatal(err)
	}
	return store.DB, time.Date(2026, 11, 1, 1, 0, 0, 0, time.UTC)
}

func startTaskFixture(t *testing.T, db *gorm.DB, now time.Time) security.SecurityTask {
	t.Helper()
	var task security.SecurityTask
	err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		task, err = beginSecurityTask(tx, "store", "epoch", SecurityTaskStart{SourceMessageID: "source", ExpectedGoalRevision: 1, Action: SecurityTaskAction{ActorID: "user", ActionID: uid(), SessionID: "session", GoalID: "goal", ProjectID: "project"}, ExpiresAt: now.Add(time.Hour)}, now)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func transitionTaskFixture(t *testing.T, db *gorm.DB, task security.SecurityTask, to security.TaskState, now time.Time) security.SecurityTask {
	t.Helper()
	var result security.SecurityTask
	err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		result, err = transitionSecurityTask(tx, "store", "epoch", SecurityTaskAction{ActorID: "user", ActionID: uid(), TaskID: task.ID, ProjectID: task.ProjectID, SessionID: task.SessionID, GoalID: task.GoalID, ExpectedRevision: task.StateRevision}, to, now)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestSecurityTaskActionIdempotencyCASAndDeadline(t *testing.T) {
	db, now := taskStoreFixture(t)
	in := SecurityTaskStart{SourceMessageID: "source", ExpectedGoalRevision: 1, Action: SecurityTaskAction{ActorID: "user", ActionID: "start", SessionID: "session", GoalID: "goal", ProjectID: "project"}, ExpiresAt: now.Add(time.Hour)}
	var first, again security.SecurityTask
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		first, err = beginSecurityTask(tx, "store", "epoch", in, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		again, err = beginSecurityTask(tx, "store", "epoch", in, now.Add(time.Minute))
		return err
	}); err != nil || again.ID != first.ID || !again.ExpiresAt.Equal(first.ExpiresAt) {
		t.Fatal("replay changed task", again, err)
	}
	changed := in
	changed.ExpiresAt = now.Add(2 * time.Hour)
	if err := db.Transaction(func(tx *gorm.DB) error { _, err := beginSecurityTask(tx, "store", "epoch", changed, now); return err }); !errors.Is(err, security.ErrConflict) {
		t.Fatal("action collision accepted", err)
	}
	waiting := transitionTaskFixture(t, db, first, security.TaskWaiting, now.Add(time.Second))
	active := transitionTaskFixture(t, db, waiting, security.TaskActive, now.Add(2*time.Second))
	if active.ExecutionRevision != first.ExecutionRevision || active.StateRevision != 3 {
		t.Fatal("approval wait invalidated execution", active)
	}
	paused := transitionTaskFixture(t, db, active, security.TaskPaused, now.Add(3*time.Second))
	resumed := transitionTaskFixture(t, db, paused, security.TaskActive, now.Add(4*time.Second))
	if resumed.ExecutionRevision != first.ExecutionRevision+1 || !resumed.ExpiresAt.Equal(first.ExpiresAt) {
		t.Fatal("pause did not fence or refreshed deadline", resumed)
	}
	a := SecurityTaskAction{ActorID: "user", ActionID: "stale", TaskID: first.ID, ProjectID: "project", SessionID: "session", GoalID: "goal", ExpectedRevision: first.StateRevision}
	if err := db.Transaction(func(tx *gorm.DB) error {
		_, err := transitionSecurityTask(tx, "store", "epoch", a, security.TaskCancelled, now.Add(5*time.Second))
		return err
	}); !errors.Is(err, security.ErrConflict) {
		t.Fatal("stale CAS allowed", err)
	}
	cancelled := transitionTaskFixture(t, db, resumed, security.TaskCancelled, now.Add(6*time.Second))
	a.ExpectedRevision, a.ActionID = cancelled.StateRevision, "reopen"
	if err := db.Transaction(func(tx *gorm.DB) error {
		_, err := transitionSecurityTask(tx, "store", "epoch", a, security.TaskActive, now.Add(7*time.Second))
		return err
	}); !errors.Is(err, security.ErrTaskEnded) {
		t.Fatal("terminal task reopened", err)
	}
}

func TestSecurityTaskTurnBindingsEpochAndRestart(t *testing.T) {
	db, now := taskStoreFixture(t)
	task := startTaskFixture(t, db, now)
	var old securityTaskBinding
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		old, err = bindSecurityTaskTurn(tx, task.ID, "store", "epoch", "turn-1", "", 1, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := verifySecurityTaskTx(db, task.ID, "session", "goal", "turn-1", now); err != nil {
		t.Fatal(err)
	}
	if err := db.Transaction(func(tx *gorm.DB) error {
		_, err := bindSecurityTaskTurn(tx, task.ID, "store", "epoch", "turn-2", "", 1, now.Add(time.Second))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := verifySecurityTaskTx(db, task.ID, "session", "goal", "turn-1", now.Add(time.Second)); err == nil {
		t.Fatal("old turn resurrected")
	}
	if err := db.Transaction(func(tx *gorm.DB) error {
		_, err := bindSecurityTaskTurn(tx, task.ID, "store", "epoch", "turn-1", "", 1, now.Add(2*time.Second))
		return err
	}); err == nil {
		t.Fatal("closed binding reopened")
	}
	if err := db.Transaction(func(tx *gorm.DB) error {
		_, err := bindSecurityTaskTurn(tx, task.ID, "store", "next-epoch", "turn-3", "", 1, now.Add(2*time.Second))
		return err
	}); err == nil {
		t.Fatal("cross epoch continuation")
	}
	if err := db.Transaction(func(tx *gorm.DB) error {
		return pauseSecurityTasksAfterRestart(tx, "store", "epoch", now.Add(3*time.Second))
	}); err != nil {
		t.Fatal(err)
	}
	var row securityTaskRow
	if err := db.First(&row, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if row.State != security.TaskPaused || row.ExecutionRevision != 2 || !row.ExpiresAt.Equal(task.ExpiresAt) {
		t.Fatal(row)
	}
	if err := db.First(&old, "id = ?", old.ID).Error; err != nil || old.State != "closed" {
		t.Fatal("restart left binding open", old, err)
	}
	if err := db.Transaction(func(tx *gorm.DB) error { return pauseSecurityTasksAfterRestart(tx, "store", "epoch", task.ExpiresAt) }); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&row, "id = ?", task.ID).Error; err != nil || row.State != security.TaskExpired {
		t.Fatal("deadline was not terminal", row, err)
	}
}

func TestSecurityTaskParentConstraintsAndRollback(t *testing.T) {
	db, now := taskStoreFixture(t)
	parent := startTaskFixture(t, db, now)
	childIn := SecurityTaskStart{SourceMessageID: "source", ExpectedGoalRevision: 1, Action: SecurityTaskAction{ActorID: "user", ActionID: "child", SessionID: "session", GoalID: "goal", ProjectID: "project"}, Kind: "child", ParentTaskID: parent.ID, ExpiresAt: parent.ExpiresAt}
	var child security.SecurityTask
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		child, err = beginSecurityTask(tx, "store", "epoch", childIn, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	bad := childIn
	bad.Action.ActionID = "bad"
	bad.ExpiresAt = parent.ExpiresAt.Add(time.Second)
	if err := db.Transaction(func(tx *gorm.DB) error { _, err := beginSecurityTask(tx, "store", "epoch", bad, now); return err }); err == nil {
		t.Fatal("child exceeded parent deadline")
	}
	transitionTaskFixture(t, db, parent, security.TaskPaused, now.Add(time.Second))
	if err := validateSecurityTaskAncestors(db, child, now.Add(2*time.Second)); err == nil {
		t.Fatal("paused ancestor allowed child")
	}
	rollback := SecurityTaskStart{SourceMessageID: "source", ExpectedGoalRevision: 1, Action: SecurityTaskAction{ActorID: "user", ActionID: "rollback", SessionID: "session", GoalID: "goal", ProjectID: "project"}, ExpiresAt: now.Add(time.Hour)}
	errRollback := errors.New("rollback")
	if err := db.Transaction(func(tx *gorm.DB) error {
		if _, err := beginSecurityTask(tx, "store", "epoch", rollback, now); err != nil {
			return err
		}
		return errRollback
	}); !errors.Is(err, errRollback) {
		t.Fatal(err)
	}
	var count int64
	if err := db.Model(&securityAuthorityEvent{}).Where("action_id = ?", "rollback").Count(&count).Error; err != nil || count != 0 {
		t.Fatal("rollback consumed action", count, err)
	}
}

func TestSecurityGoalRevisionFencesOwnerAndOldGrantWithoutNewTaskOrTTL(t *testing.T) {
	db, now := taskStoreFixture(t)
	if err := db.AutoMigrate(&securityTaskGrantRow{}); err != nil {
		t.Fatal(err)
	}
	task := startTaskFixture(t, db, now)
	owner := ownerFixture(t, db, task, now)
	grant := securityTaskGrantRow{ID: "original-grant", TaskID: task.ID, GoalID: task.GoalID, ProjectID: task.ProjectID, SessionID: task.SessionID, StoreID: "store", RecoveryEpoch: "epoch", Revision: 3, RemainingUses: 2, ExpiresAt: now.Add(30 * time.Minute), Data: "{}"}
	if err := db.Create(&grant).Error; err != nil {
		t.Fatal(err)
	}
	err := db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&nativeWorkGoal{}).Where("id = ?", task.GoalID).Updates(map[string]any{"goal_revision": 2, "closure_contract": js(WorkClosureContract{ProjectID: "project", GoalRevision: 2, PlanRevision: 1})}).Error; err != nil {
			return err
		}
		return fenceSecurityGoalRevisionTx(tx, "store", "epoch", "project", "session", "goal", 2, "user", "new-contract", now.Add(time.Second))
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = ValidateExecutionOwner(db, owner, now.Add(2*time.Second)); err == nil {
		t.Fatal("old purpose owner survived contract change")
	}
	var original securityTaskRow
	if err = db.First(&original, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if original.State != security.TaskPaused || !original.ExpiresAt.Equal(task.ExpiresAt) || original.ExecutionRevision != task.ExecutionRevision+1 {
		t.Fatal("contract change did not preserve expiry and fence execution", original)
	}
	if _, err = transitionSecurityTask(db, "store", "epoch", SecurityTaskAction{ActorID: "user", ActionID: "stale-resume", TaskID: task.ID, ProjectID: "project", SessionID: "session", GoalID: "goal", ExpectedRevision: original.StateRevision}, security.TaskActive, now.Add(2*time.Second)); err == nil {
		t.Fatal("stale task purpose reactivated")
	}
	if err = db.First(&grant, "id = ?", grant.ID).Error; err != nil {
		t.Fatal(err)
	}
	if !grant.Revoked || grant.Revision != 4 || grant.RemainingUses != 2 || !grant.ExpiresAt.Equal(now.Add(30*time.Minute)) {
		t.Fatal("grant was copied or budget/TTL refreshed", grant)
	}
	if err = fenceSecurityGoalRevisionTx(db, "store", "epoch", "project", "session", "goal", 2, "user", "new-contract", now.Add(3*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err = db.First(&grant, "id = ?", grant.ID).Error; err != nil || grant.Revision != 4 {
		t.Fatal("replay revoked grant twice", grant, err)
	}
	var count int64
	if err = db.Model(&securityTaskRow{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatal("contract update created replacement task", count, err)
	}
}
