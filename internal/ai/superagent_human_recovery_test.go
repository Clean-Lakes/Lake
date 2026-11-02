package ai

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestSuperHumanRecoveryUsesOriginalRunnerAndActualAnswer(t *testing.T) {
	model, closeModel := fakeModel(t, func(n int, input map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "original-question", Name: "work_begin", Arguments: `{"title":"Inspect test target","items":[{"title":"Review test evidence"}]}`})
		}
		if !strings.Contains(js(input["messages"]), securityWorkConfirmLabel) {
			t.Error("actual answer missing")
		}
		return response("Actual answer recovered; no resource operations requested.")
	})
	defer closeModel()
	e := managedEngineFixture(t, model)
	ctx := context.Background()
	if _, err := e.ActivateSuperProject(ctx, "project", "pilot", nil); err != nil {
		t.Fatal(err)
	}
	b := SuperSourceBinding{SourceID: "human", ProjectID: "project", Kind: "user", ActorRef: "owner", Revision: "1"}
	if err := e.RegisterSuperSource(ctx, b); err != nil {
		t.Fatal(err)
	}
	task := superCreateFixture(t, e, b, "real-message", "Ask which target to inspect; no changes", "inspect", "Ask which target to inspect")
	db, _ := e.superStore()
	var w superWorkerRow
	if err := db.First(&w, "id = ?", task.WorkerID).Error; err != nil {
		t.Fatal(err)
	}
	if err := e.finishSuperRouting(ctx, b, w.SourceEventID); err != nil {
		t.Fatal(err)
	}
	if err := e.ConfigureTaskWorker(ctx, "project", w.ID, Config{Model: model, SecurityProjectID: "project", Profile: "core", MaxSteps: 12}); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get(w.SessionID)
	run, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- e.StartTaskWorker(run, "project", w.ID) }()
	var saved State
	for deadline := time.Now().Add(10 * time.Second); ; {
		select {
		case err := <-done:
			s.mu.Lock()
			state := js(s.state.View)
			s.mu.Unlock()
			t.Fatalf("original invocation ended before question: %v %s", err, state)
		default:
		}
		s.mu.Lock()
		ready := nativeQuestionReady(s.state.View.Question)
		if ready {
			_ = json.Unmarshal([]byte(js(s.state)), &saved)
		}
		s.mu.Unlock()
		if ready {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("original ADK question not created")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	// Restore the last committed wait as a crashed host would, after the old
	// invocation has drained. Its official SDK call and root remain unchanged.
	s.mu.Lock()
	c := s.state.Config
	s.state = saved
	s.state.Config = c
	s.cancel, s.questionReply = nil, nil
	s.mu.Unlock()
	if err := e.ReplyQuestion(w.SessionID, saved.View.Question.ID, map[string][]string{"work_contract": {securityWorkConfirmLabel}}); err != nil {
		t.Fatal(err)
	}
	if err := e.ResumeTaskWorker(ctx, "project", w.ID); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	if s.state.View.RootTurnID != saved.View.RootTurnID || s.state.Runtime.SessionID != saved.Runtime.SessionID {
		t.Error("recovery replaced original execution")
	}
	s.mu.Unlock()
	var operations int64
	if err := db.Model(&nativeOperation{}).Count(&operations).Error; err != nil || operations != 0 {
		t.Fatal("human recovery dispatched resource operations", operations, err)
	}
	if err := e.ReplyQuestion(w.SessionID, saved.View.Question.ID, map[string][]string{"work_contract": {securityWorkConfirmLabel}}); err == nil {
		t.Fatal("answered question accepted twice")
	}
}

func TestSuperHumanReceiptBatchesOnlyExactApprovalRuntime(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	task := superCreateFixture(t, e, b, "approval-source", "Inspect orders", "orders", "Inspect orders")
	s, _ := e.get(task.SessionID)
	s.mu.Lock()
	s.state.View.RootTurnID = "actual-root"
	s.state.Runtime = &RuntimeCheckpoint{SessionID: "actual-sdk"}
	for _, id := range []string{"approval-a", "approval-b"} {
		if handled, err := e.queueSuperHumanRecoveryLocked(s, nil, nil, id); !handled || err != nil {
			s.mu.Unlock()
			t.Fatal(handled, err)
		}
	}
	s.state.Runtime.SessionID = "foreign-sdk"
	if _, err := e.queueSuperHumanRecoveryLocked(s, nil, nil, "approval-c"); err == nil {
		s.mu.Unlock()
		t.Fatal("foreign approval runtime replaced receipt")
	}
	s.mu.Unlock()
	db, _ := e.superStore()
	var assignment superAssignmentRow
	if err := db.First(&assignment, "worker_id = ?", task.WorkerID).Error; err != nil || assignment.InvocationKind != "human_recovery" {
		t.Fatal(assignment, err)
	}
	var cp superHumanCheckpoint
	if err := json.Unmarshal([]byte(assignment.Checkpoint), &cp); err != nil || cp.RuntimeID != "actual-sdk" || cp.ApprovalID != "approval-a" {
		t.Fatal(cp, err)
	}
	if _, err := e.AcquireWorkerSlot(ctx, b.ProjectID, task.WorkerID); err == nil {
		t.Fatal("unrouted source became runnable")
	}
}
