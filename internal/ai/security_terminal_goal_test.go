package ai

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
)

// This fixture represents a goal already settled by the trusted verifier; the
// tests below exercise only association of the next real user message.
func setSecurityGoalTerminalFixture(t *testing.T, e *Engine, goal WorkGoal) {
	t.Helper()
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	goal.Status = "completed"
	if err = store.DB.Model(&nativeWorkGoal{}).Where("id = ? AND session_id = ?", goal.ID, goal.SessionID).Updates(map[string]any{"status": "completed", "data": js(goal)}).Error; err != nil {
		t.Fatal(err)
	}
}

func TestManagedCompletedGoalNewActualUserTurnStartsProposalWithoutOldAuthority(t *testing.T) {
	var e *Engine
	var newCalls atomic.Int32
	var initial SecurityExecutionContext
	var staleContextSeen atomic.Bool
	model, closeModel := fakeModel(t, func(_ int, _ map[string]any) any {
		s, _ := e.get("case")
		s.mu.Lock()
		source := s.state.SecuritySourceMessageID
		inherited := s.state.Config.securityExecution
		s.mu.Unlock()
		if source == "new-actual-user-message" {
			if inherited != nil {
				staleContextSeen.Store(true)
			}
			if _, err := e.CurrentSecurityExecution(context.Background(), "case"); err == nil {
				staleContextSeen.Store(true)
			}
			if newCalls.Add(1) == 1 {
				return response("", Call{ID: "cannot-borrow-old-permit", Name: "shell", Arguments: `{"command":"df -h"}`})
			}
			return response("请先确认新任务的步骤和验收条件。")
		}
		if initial.Task.ID == "" {
			initial, _ = e.CurrentSecurityExecution(context.Background(), "case")
		}
		return response("原目标保留，等待验收。")
	})
	defer closeModel()
	e = managedEngineFixture(t, model)
	goal := versionedGoalFixture(t, e, "original completed goal")
	if err := e.SelectSecurityGoal(t.Context(), SecurityGoalSelection{ActorID: "user", ActionID: "select-initial", ProjectID: "project", SessionID: "case", GoalID: goal.ID, SourceMessageID: "select-original", ExpectedGoalRevision: goal.closure.GoalRevision}); err != nil {
		t.Fatal(err)
	}
	if err := e.ExecuteTurn(t.Context(), "case", TurnInput{StrategyMessageID: "old-actual-user-message", UserText: "继续原任务"}); err != nil {
		t.Fatal(err)
	}
	if initial.Task.ID == "" {
		t.Fatal("old execution fixture missing")
	}
	store, _ := e.adkStore()
	grant := securityTaskGrantRow{ID: "old-grant", TaskID: initial.Task.ID, GoalID: goal.ID, ProjectID: "project", SessionID: "case", StoreID: initial.Task.StoreID, RecoveryEpoch: initial.Task.RecoveryEpoch, Revision: 4, RemainingUses: 7, ExpiresAt: time.Now().Add(time.Minute), Data: "{}"}
	if err := store.DB.Create(&grant).Error; err != nil {
		t.Fatal(err)
	}
	setSecurityGoalTerminalFixture(t, e, goal)
	// A late unresolved original result must survive the new proposal as well.
	if err := store.DB.Create(&nativeOperation{ID: "old-late-effect", GoalID: goal.ID, SessionID: "case", ResourceID: "resource", Risk: "write", Status: "unknown"}).Error; err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.Config.securityExecution = &initial
	s.mu.Unlock()
	if err := e.ExecuteTurn(t.Context(), "case", TurnInput{StrategyMessageID: "new-actual-user-message", UserText: "帮我检查另外一个新问题"}); err != nil {
		t.Fatal(err)
	}
	if newCalls.Load() == 0 || staleContextSeen.Load() {
		t.Fatal("new proposal retained old execution authority", newCalls.Load(), staleContextSeen.Load())
	}
	var selected securityGoalSelectionRow
	if err := store.DB.First(&selected, "session_id = ?", "case").Error; err != nil {
		t.Fatal(err)
	}
	if !selected.NewGoal || selected.GoalID != "" || selected.SourceMessageID != "new-actual-user-message" || selected.Revision != 2 {
		t.Fatal("new actual source lacks durable CAS association", selected)
	}
	var tasks []securityTaskRow
	if err := store.DB.Find(&tasks).Error; err != nil || len(tasks) != 1 || tasks[0].ID != initial.Task.ID || tasks[0].State != security.TaskCompleted || !tasks[0].ExpiresAt.Equal(initial.Task.ExpiresAt) {
		t.Fatal("new user request revived/copied original task or TTL", tasks, err)
	}
	var after securityTaskGrantRow
	if err := store.DB.First(&after, "id = ?", grant.ID).Error; err != nil || after.Revision != 4 || after.RemainingUses != 7 || !after.ExpiresAt.Equal(grant.ExpiresAt) {
		t.Fatal("proposal copied or consumed old grant", after, err)
	}
	var operations []nativeOperation
	if err := store.DB.Find(&operations).Error; err != nil || len(operations) != 1 || operations[0].ID != "old-late-effect" || operations[0].Status != "unknown" {
		t.Fatal("new task dispatched or erased old risk", operations, err)
	}
	var audit securityAuthorityEvent
	if err := store.DB.First(&audit, "kind = ?", "goal.new_after_terminal").Error; err != nil || audit.BeforeRevision != 1 || audit.AfterRevision != 2 || !strings.Contains(audit.Result, "source_root_turn_id") {
		t.Fatal("new association omitted source/root audit", audit, err)
	}
	stale := selected
	stale.GoalID = goal.ID
	stale.GoalRevision = goal.closure.GoalRevision
	stale.NewGoal = false
	stale.Revision = 1
	if _, _, err := e.advanceTerminalSecurityGoal(t.Context(), stale, "another-user-source", "another-root"); !errors.Is(err, security.ErrConflict) {
		t.Fatal("stale terminal selection bypassed CAS", err)
	}
	if _, old, err := e.workRow("case", goal.ID); err != nil || old.Status != "completed" {
		t.Fatal("historical goal rewritten", old, err)
	}
}

func TestManagedCompletedGoalWithOtherPendingGoalsClarifiesBeforeModel(t *testing.T) {
	var modelCalls atomic.Int32
	model, closeModel := fakeModel(t, func(_ int, _ map[string]any) any { modelCalls.Add(1); return response("must not run") })
	defer closeModel()
	e := managedEngineFixture(t, model)
	first := versionedGoalFixture(t, e, "completed original")
	second := versionedGoalFixture(t, e, "other pending goal")
	if err := e.SelectSecurityGoal(t.Context(), SecurityGoalSelection{ActorID: "user", ActionID: "select-first", ProjectID: "project", SessionID: "case", GoalID: first.ID, SourceMessageID: "original-selection", ExpectedGoalRevision: first.closure.GoalRevision}); err != nil {
		t.Fatal(err)
	}
	setSecurityGoalTerminalFixture(t, e, first)
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.Config.securityExecution = &SecurityExecutionContext{Managed: true, GoalID: first.ID}
	s.mu.Unlock()
	if err := e.ExecuteTurn(t.Context(), "case", TurnInput{StrategyMessageID: "new-human-source", UserText: "开始处理另一个问题"}); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	pending := s.state.PendingGoalQuestion
	stale := s.state.Config.securityExecution
	s.mu.Unlock()
	if modelCalls.Load() != 0 || pending == nil || stale != nil || pending.SourceMessageID != "new-human-source" {
		t.Fatal("terminal selection blocked clarification or called model", modelCalls.Load(), pending, stale)
	}
	found := false
	for _, choice := range pending.Choices {
		if choice.ID == first.ID {
			t.Fatal("terminal goal offered for revival")
		}
		if choice.ID == second.ID {
			found = true
		}
	}
	if !found {
		t.Fatal("other pending goal omitted")
	}
	store, _ := e.adkStore()
	var operations int64
	if err := store.DB.Model(&nativeOperation{}).Count(&operations).Error; err != nil || operations != 0 {
		t.Fatal("clarification performed resource I/O", operations, err)
	}
	var selected securityGoalSelectionRow
	if err := store.DB.First(&selected, "session_id = ?", "case").Error; err != nil || selected.Revision != 1 || selected.GoalID != first.ID {
		t.Fatal("clarification changed selection without answer", selected, err)
	}
}

func TestManagedCompletedGoalDoesNotTreatReplayedSourceAsNewHumanIntent(t *testing.T) {
	var calls atomic.Int32
	model, closeModel := fakeModel(t, func(_ int, _ map[string]any) any { calls.Add(1); return response("must not run") })
	defer closeModel()
	e := managedEngineFixture(t, model)
	goal := versionedGoalFixture(t, e, "old completed request")
	if err := e.SelectSecurityGoal(t.Context(), SecurityGoalSelection{ActorID: "user", ActionID: "select-original", ProjectID: "project", SessionID: "case", GoalID: goal.ID, SourceMessageID: "original-source", ExpectedGoalRevision: goal.closure.GoalRevision}); err != nil {
		t.Fatal(err)
	}
	setSecurityGoalTerminalFixture(t, e, goal)
	if err := e.ExecuteTurn(t.Context(), "case", TurnInput{StrategyMessageID: "original-source", UserText: "the old request was replayed"}); err == nil || calls.Load() != 0 {
		t.Fatal("old source became new task intent", err, calls.Load())
	}
	store, _ := e.adkStore()
	var selected securityGoalSelectionRow
	if err := store.DB.First(&selected, "session_id = ?", "case").Error; err != nil || selected.Revision != 1 || selected.NewGoal {
		t.Fatal("replay changed durable selection", selected, err)
	}
}
