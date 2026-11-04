package ai

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

var errSecurityAction = errors.New("security: trusted action binding required")

// SecurityTaskAction is supplied by an authenticated host action, never tool
// arguments. ActorID is the host's authenticated principal, not model text.
type SecurityTaskAction struct {
	ActorID, ActionID            string
	ProjectID, SessionID, GoalID string
	TaskID                       string
	ExpectedRevision             int64
	Reason                       string
}

type SecurityTaskStart struct {
	Action                    SecurityTaskAction
	Kind, ParentTaskID        string
	ExpiresAt                 time.Time
	SourceMessageID           string
	ExpectedGoalRevision      int64
	SourceKind, SourceEventID string
}

func validSecurityAction(a SecurityTaskAction) bool {
	return strings.TrimSpace(a.ActorID) != "" && len(a.ActorID) <= 256 && strings.TrimSpace(a.ActionID) != "" && len(a.ActionID) <= 256 && a.SessionID != "" && a.GoalID != "" && len(a.Reason) <= 2000
}

func taskActionKey(storeID, epoch string, a SecurityTaskAction) string {
	return hash(storeID + "\x00" + epoch + "\x00" + a.ActorID + "\x00" + a.ActionID)
}

func replayTaskAction(tx *gorm.DB, storeID, epoch string, a SecurityTaskAction, request string) (security.SecurityTask, bool, error) {
	var event securityAuthorityEvent
	err := tx.First(&event, "action_key = ?", taskActionKey(storeID, epoch, a)).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return security.SecurityTask{}, false, nil
	}
	if err != nil {
		return security.SecurityTask{}, false, err
	}
	if event.RequestHash != hash(request) {
		return security.SecurityTask{}, false, security.ErrConflict
	}
	var result security.SecurityTask
	if err = json.Unmarshal([]byte(event.Result), &result); err != nil {
		return result, false, err
	}
	return result, true, nil
}

func recordTaskAction(tx *gorm.DB, task security.SecurityTask, a SecurityTaskAction, kind, request string, before int64, now time.Time) error {
	return tx.Create(&securityAuthorityEvent{ProjectID: task.ProjectID, ID: uid(), ActionKey: taskActionKey(task.StoreID, task.RecoveryEpoch, a), RequestHash: hash(request), StoreID: task.StoreID, RecoveryEpoch: task.RecoveryEpoch, ActorID: a.ActorID, ActionID: a.ActionID, Kind: kind, ObjectID: task.ID, BeforeRevision: before, AfterRevision: task.StateRevision, Result: js(task), At: now}).Error
}

func beginSecurityTask(tx *gorm.DB, storeID, epoch string, in SecurityTaskStart, now time.Time) (security.SecurityTask, error) {
	a := in.Action
	if in.Kind == "" {
		in.Kind = "interactive"
	}
	if in.SourceKind == "" {
		in.SourceKind = "user_message"
	}
	validSource := in.SourceKind == "user_message" && in.SourceMessageID != "" || in.Kind == "workflow" && in.SourceKind == "workflow_run" && in.SourceEventID != "" || in.Kind == "schedule" && in.SourceKind == "schedule_occurrence" && in.SourceEventID != ""
	if !validSecurityAction(a) || a.TaskID != "" || a.ExpectedRevision != 0 || !validSource || len(in.SourceMessageID) > 256 || len(in.SourceEventID) > 256 || in.ExpectedGoalRevision < 1 || storeID == "" || epoch == "" || now.IsZero() {
		return security.SecurityTask{}, errSecurityAction
	}
	request := js(struct {
		Kind  string
		Input SecurityTaskStart
	}{"begin", in})
	if old, ok, err := replayTaskAction(tx, storeID, epoch, a, request); ok || err != nil {
		return old, err
	}
	var goal nativeWorkGoal
	if err := tx.First(&goal, "id = ? AND session_id = ?", a.GoalID, a.SessionID).Error; err != nil {
		return security.SecurityTask{}, err
	}
	if workTerminal(goal.Status) {
		return security.SecurityTask{}, errors.New("security: goal is closed")
	}
	if goal.GoalRevision != in.ExpectedGoalRevision {
		return security.SecurityTask{}, security.ErrConflict
	}
	var contract WorkClosureContract
	if goal.ClosureContract == "" || json.Unmarshal([]byte(goal.ClosureContract), &contract) != nil || contract.GoalRevision != in.ExpectedGoalRevision || contract.ProjectID != a.ProjectID {
		return security.SecurityTask{}, errors.New("security: confirmed goal contract required")
	}
	if in.Kind == "" {
		in.Kind = "interactive"
	}
	switch in.Kind {
	case "interactive", "child", "workflow", "schedule", "reconcile":
	default:
		return security.SecurityTask{}, errSecurityAction
	}
	expires := in.ExpiresAt
	if expires.IsZero() {
		expires = now.Add(security.MaxTaskLifetime)
	}
	if !expires.After(now) || expires.Sub(now) > security.MaxTaskLifetime {
		return security.SecurityTask{}, security.ErrTaskExpired
	}
	if in.ParentTaskID != "" {
		var parent securityTaskRow
		if err := tx.First(&parent, "id = ?", in.ParentTaskID).Error; err != nil {
			return security.SecurityTask{}, err
		}
		p := parent.task()
		if err := p.Validate(now); err != nil {
			return security.SecurityTask{}, err
		}
		if in.ExpiresAt.IsZero() && p.ExpiresAt.Before(expires) {
			expires = p.ExpiresAt
		}
		if p.State != security.TaskActive || p.GoalID != a.GoalID || p.ProjectID != a.ProjectID || p.SessionID != a.SessionID || p.StoreID != storeID || p.RecoveryEpoch != epoch || expires.After(p.ExpiresAt) {
			return security.SecurityTask{}, errSecurityAction
		}
	}
	result := security.SecurityTask{ID: uid(), GoalID: a.GoalID, ProjectID: a.ProjectID, SessionID: a.SessionID, ParentTaskID: in.ParentTaskID, Kind: in.Kind, StoreID: storeID, RecoveryEpoch: epoch, State: security.TaskActive, StateRevision: 1, ExecutionRevision: 1, CreatedAt: now, ExpiresAt: expires}
	row := securityTaskRecord(result)
	row.GoalRevision, row.SourceMessageID = in.ExpectedGoalRevision, in.SourceMessageID
	row.SourceKind, row.SourceEventID = in.SourceKind, in.SourceEventID
	row.BackgroundPolicy = "foreground_only"
	if err := tx.Create(&row).Error; err != nil {
		return result, err
	}
	return result, recordTaskAction(tx, result, a, "task.begin", request, 0, now)
}

func transitionSecurityTask(tx *gorm.DB, storeID, epoch string, a SecurityTaskAction, to security.TaskState, now time.Time) (security.SecurityTask, error) {
	if !validSecurityAction(a) || a.TaskID == "" || a.ExpectedRevision < 1 || now.IsZero() {
		return security.SecurityTask{}, errSecurityAction
	}
	request := js(struct {
		Kind   string
		Action SecurityTaskAction
		To     security.TaskState
	}{"transition", a, to})
	if old, ok, err := replayTaskAction(tx, storeID, epoch, a, request); ok || err != nil {
		return old, err
	}
	var row securityTaskRow
	if err := tx.First(&row, "id = ? AND session_id = ? AND goal_id = ? AND project_id = ?", a.TaskID, a.SessionID, a.GoalID, a.ProjectID).Error; err != nil {
		return security.SecurityTask{}, err
	}
	task := row.task()
	if task.StoreID != storeID || task.RecoveryEpoch != epoch {
		return task, errors.New("security: recovery epoch mismatch")
	}
	if to == security.TaskActive {
		if err := securityTaskGoalCurrent(tx, row); err != nil {
			return task, err
		}
	}
	before := task.StateRevision
	updated, err := task.Transition(to, a.ExpectedRevision, now, a.Reason)
	if err != nil {
		return task, err
	}
	changes := tx.Model(&securityTaskRow{}).Where("id = ? AND state_revision = ? AND recovery_epoch = ?", task.ID, before, epoch).Updates(map[string]any{"state": updated.State, "state_revision": updated.StateRevision, "execution_revision": updated.ExecutionRevision, "closed_reason": updated.ClosedReason})
	if changes.Error != nil {
		return task, changes.Error
	}
	if changes.RowsAffected != 1 {
		return task, security.ErrConflict
	}
	if updated.ExecutionRevision != task.ExecutionRevision || to == security.TaskIdle {
		closing := tx.Model(&securityTaskBinding{}).Where("task_id = ? AND state <> ?", task.ID, "closed")
		if to == security.TaskIdle {
			closing = closing.Where("kind = ?", "turn")
		}
		if err = closing.Updates(map[string]any{"state": "closed", "updated_at": now, "owner_generation": gorm.Expr("owner_generation + 1"), "lease_until": now}).Error; err != nil {
			return task, err
		}
	}
	return updated, recordTaskAction(tx, updated, a, "task.transition", request, before, now)
}

func bindSecurityTaskTurn(tx *gorm.DB, taskID, storeID, epoch, rootTurnID, scopeID string, executionRevision int64, now time.Time) (securityTaskBinding, error) {
	if taskID == "" || rootTurnID == "" || now.IsZero() {
		return securityTaskBinding{}, errSecurityAction
	}
	var row securityTaskRow
	if err := tx.First(&row, "id = ?", taskID).Error; err != nil {
		return securityTaskBinding{}, err
	}
	if err := securityTaskGoalCurrent(tx, row); err != nil {
		return securityTaskBinding{}, err
	}
	task := row.task()
	if err := task.Validate(now); err != nil {
		return securityTaskBinding{}, err
	}
	if task.State != security.TaskActive || task.StoreID != storeID || task.RecoveryEpoch != epoch || task.ExecutionRevision != executionRevision {
		return securityTaskBinding{}, errSecurityAction
	}
	if scopeID != "" {
		var parent securityTaskBinding
		if err := tx.Where("task_id = ? AND root_turn_id = ? AND scope_id = '' AND kind = ? AND state = ? AND execution_revision = ?", taskID, rootTurnID, "turn", "active", executionRevision).First(&parent).Error; err != nil {
			return securityTaskBinding{}, err
		}
	}
	// A new RootTurn closes only that scope's undispatched calls. Already
	// dispatched operation rows remain observable and retain their handles.
	var old securityTaskBinding
	err := tx.First(&old, "task_id = ? AND kind = ? AND execution_id = ?", taskID, "turn", rootTurnID+"\x00"+scopeID).Error
	if err == nil {
		if old.State == "closed" || old.ExecutionRevision != executionRevision {
			return old, security.ErrConflict
		}
		return old, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return old, err
	}
	closing := tx.Model(&securityTaskBinding{}).Where("task_id = ? AND kind = ? AND state <> ?", taskID, "turn", "closed")
	if scopeID == "" {
		closing = closing.Where("root_turn_id <> ?", rootTurnID)
	} else {
		closing = closing.Where("scope_id = ?", scopeID)
	}
	if err = closing.Updates(map[string]any{"state": "closed", "updated_at": now, "owner_generation": gorm.Expr("owner_generation + 1"), "lease_until": now}).Error; err != nil {
		return old, err
	}
	result := securityTaskBinding{ID: uid(), TaskID: task.ID, Kind: "turn", ExecutionID: rootTurnID + "\x00" + scopeID, SessionID: task.SessionID, GoalID: task.GoalID, RootTurnID: rootTurnID, ScopeID: scopeID, StoreID: storeID, RecoveryEpoch: epoch, ExecutionRevision: executionRevision, State: "active", CreatedAt: now, UpdatedAt: now}
	return result, tx.Create(&result).Error
}

func (e *Engine) securityTaskDB() (*gorm.DB, string, string, error) {
	if err := e.CheckSecurityRuntime(); err != nil {
		return nil, "", "", err
	}
	h := e.securityHome()
	if h == nil {
		return nil, "", "", errors.New("security: explicit Home owner required")
	}
	h.mu.Lock()
	storeID, epoch := h.control.StoreID, h.control.RecoveryEpoch
	h.mu.Unlock()
	store, err := e.adkStore()
	if err != nil {
		return nil, "", "", err
	}
	return store.DB, storeID, epoch, nil
}

func (e *Engine) BeginSecurityTask(ctx context.Context, in SecurityTaskStart) (out security.SecurityTask, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		out, err = beginSecurityTask(tx, storeID, epoch, in, time.Now().UTC())
		return err
	})
	return out, err
}

func (e *Engine) TransitionSecurityTask(ctx context.Context, a SecurityTaskAction, to security.TaskState) (out security.SecurityTask, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		out, err = transitionSecurityTask(tx, storeID, epoch, a, to, time.Now().UTC())
		return err
	})
	return out, err
}

func (e *Engine) BindSecurityTaskTurn(ctx context.Context, taskID, rootTurnID, scopeID string, executionRevision int64) error {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		_, err := bindSecurityTaskTurn(tx, taskID, storeID, epoch, rootTurnID, scopeID, executionRevision, time.Now().UTC())
		return err
	})
}

// verifySecurityTaskTx validates persistent goal and current turn membership.
// The caller still validates an ExecutionOwner before actual dispatch.
func verifySecurityTaskTx(tx *gorm.DB, taskID, sessionID, goalID, rootTurnID string, now time.Time) (security.SecurityTask, error) {
	var row securityTaskRow
	if taskID == "" || sessionID == "" || goalID == "" || rootTurnID == "" {
		return security.SecurityTask{}, errSecurityAction
	}
	if err := tx.First(&row, "id = ? AND session_id = ? AND goal_id = ?", taskID, sessionID, goalID).Error; err != nil {
		return security.SecurityTask{}, err
	}
	if err := securityTaskGoalCurrent(tx, row); err != nil {
		return row.task(), err
	}
	task := row.task()
	if err := task.Validate(now); err != nil {
		return task, err
	}
	if task.State != security.TaskActive {
		return task, security.ErrTaskBinding
	}
	if err := validateSecurityTaskAncestors(tx, task, now); err != nil {
		return task, err
	}
	var binding securityTaskBinding
	if err := tx.Where("task_id = ? AND root_turn_id = ? AND scope_id = '' AND state = ? AND execution_revision = ? AND recovery_epoch = ? AND store_id = ?", taskID, rootTurnID, "active", task.ExecutionRevision, task.RecoveryEpoch, task.StoreID).First(&binding).Error; err != nil {
		return task, err
	}
	return task, nil
}

func securityTaskGoalCurrent(tx *gorm.DB, task securityTaskRow) error {
	var goal nativeWorkGoal
	if err := tx.First(&goal, "id = ? AND session_id = ?", task.GoalID, task.SessionID).Error; err != nil {
		return err
	}
	var contract WorkClosureContract
	if task.GoalRevision < 1 || goal.GoalRevision != task.GoalRevision || json.Unmarshal([]byte(goal.ClosureContract), &contract) != nil || contract.GoalRevision != task.GoalRevision || contract.ProjectID != task.ProjectID {
		return errors.New("security: task goal revision changed; explicit reauthorization required")
	}
	return nil
}

// Called inside the authenticated contract mutation's dispatch barrier and DB
// transaction. It fences previous purpose bindings and revokes grants without
// creating a replacement task, extending deadlines or resetting budgets.
func fenceSecurityGoalRevisionTx(tx *gorm.DB, storeID, epoch, projectID, sessionID, goalID string, newRevision int64, actor, action string, now time.Time) error {
	if storeID == "" || epoch == "" || projectID == "" || sessionID == "" || goalID == "" || newRevision < 1 || actor == "" || action == "" || now.IsZero() {
		return errSecurityAction
	}
	var tasks []securityTaskRow
	if err := tx.Where("store_id = ? AND recovery_epoch = ? AND project_id = ? AND session_id = ? AND goal_id = ? AND goal_revision <> ?", storeID, epoch, projectID, sessionID, goalID, newRevision).Find(&tasks).Error; err != nil {
		return err
	}
	for _, row := range tasks {
		if !row.State.Terminal() && row.State != security.TaskPaused {
			to := security.TaskPaused
			if !row.ExpiresAt.After(now) {
				to = security.TaskExpired
			}
			if _, err := transitionSecurityTask(tx, storeID, epoch, SecurityTaskAction{ActorID: actor, ActionID: "goal-revision:" + action + ":" + row.ID, ProjectID: projectID, SessionID: sessionID, GoalID: goalID, TaskID: row.ID, ExpectedRevision: row.StateRevision, Reason: "goal revision changed; old authority revoked"}, to, now); err != nil {
				return err
			}
		}
		if err := tx.Model(&securityTaskGrantRow{}).Where("task_id = ? AND store_id = ? AND recovery_epoch = ? AND revoked = ?", row.ID, storeID, epoch, false).Updates(map[string]any{"revoked": true, "revision": gorm.Expr("revision + 1")}).Error; err != nil {
			return err
		}
	}
	return nil
}

func validateSecurityTaskAncestors(tx *gorm.DB, task security.SecurityTask, now time.Time) error {
	seen := map[string]bool{task.ID: true}
	for task.ParentTaskID != "" {
		if seen[task.ParentTaskID] || len(seen) > 32 {
			return security.ErrTaskBinding
		}
		seen[task.ParentTaskID] = true
		var row securityTaskRow
		if err := tx.First(&row, "id = ?", task.ParentTaskID).Error; err != nil {
			return err
		}
		parent := row.task()
		if err := parent.Validate(now); err != nil {
			return err
		}
		if parent.State != security.TaskActive || parent.StoreID != task.StoreID || parent.RecoveryEpoch != task.RecoveryEpoch || parent.GoalID != task.GoalID || parent.SessionID != task.SessionID || parent.ProjectID != task.ProjectID || task.ExpiresAt.After(parent.ExpiresAt) {
			return security.ErrTaskBinding
		}
		task = parent
	}
	return nil
}

// PauseSecurityTasksAfterRestart invalidates active RootTurn bindings without
// refreshing tasks or grants. It must run once during store startup, before
// any worker is admitted. Expired contexts are terminal rather than reopened.
func pauseSecurityTasksAfterRestart(tx *gorm.DB, storeID, epoch string, now time.Time) error {
	var rows []securityTaskRow
	if err := tx.Where("state NOT IN ?", []security.TaskState{security.TaskCompleted, security.TaskCancelled, security.TaskExpired}).Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		to := security.TaskPaused
		if !now.Before(row.ExpiresAt) {
			to = security.TaskExpired
		}
		if row.StoreID != storeID || row.RecoveryEpoch != epoch {
			to = security.TaskPaused
		}
		if row.State == to && to == security.TaskPaused {
			continue
		}
		if err := tx.Model(&securityTaskRow{}).Where("id = ? AND state_revision = ?", row.ID, row.StateRevision).Updates(map[string]any{"state": to, "state_revision": row.StateRevision + 1, "execution_revision": row.ExecutionRevision + 1, "closed_reason": "runtime restart"}).Error; err != nil {
			return err
		}
		key := hash(storeID + "\x00" + epoch + "\x00restart\x00" + row.ID + "\x00" + js(row.StateRevision))
		if err := tx.Create(&securityAuthorityEvent{ProjectID: row.ProjectID, ID: uid(), ActionKey: key, RequestHash: hash(js(map[string]any{"task_id": row.ID, "state_revision": row.StateRevision, "epoch": epoch})), StoreID: storeID, RecoveryEpoch: epoch, ActorID: "runtime-restart", ActionID: key, Kind: "task.restart_pause", ObjectID: row.ID, BeforeRevision: row.StateRevision, AfterRevision: row.StateRevision + 1, Result: js(map[string]any{"state": to, "execution_revision": row.ExecutionRevision + 1}), At: now}).Error; err != nil {
			return err
		}
	}
	return tx.Model(&securityTaskBinding{}).Where("state <> ?", "closed").Updates(map[string]any{"state": "closed", "owner_generation": gorm.Expr("owner_generation + 1"), "lease_until": now, "updated_at": now}).Error
}
