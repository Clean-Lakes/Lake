package ai

import (
	"context"
	"testing"
	"time"
)

func TestSuperWorkerUsesOriginalGoalAndHostConfirmation(t *testing.T) {
	ctx := context.Background()
	m, closeModel := fakeModel(t, func(n int, input map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "plan", Name: "work_begin", Arguments: `{"title":"Investigate orders","items":[{"title":"Review order evidence"}]}`})
		}
		return response("Need actual evidence before acceptance.")
	})
	defer closeModel()
	e := managedEngineFixture(t, m)
	b := SuperSourceBinding{SourceID: "user", ProjectID: "project", Kind: "user", ActorRef: "owner", Revision: "1"}
	if err := e.RegisterSuperSource(ctx, b); err != nil {
		t.Fatal(err)
	}
	task := superCreateFixture(t, e, b, "original-message", "Investigate orders without changing data", "orders", "Investigate orders")
	db, _ := e.superStore()
	var w superWorkerRow
	if err := db.First(&w, "id = ?", task.WorkerID).Error; err != nil {
		t.Fatal(err)
	}
	if err := e.finishSuperRouting(ctx, b, w.SourceEventID); err != nil {
		t.Fatal(err)
	}
	if err := e.ConfigureTaskWorker(ctx, "project", w.ID, Config{Model: m, SecurityProjectID: "project", Profile: "core", MaxSteps: 12}); err != nil {
		t.Fatal(err)
	}
	questions := make(chan string, 4)
	e.Emit = func(event Event) {
		if event.Type == "question" {
			id := str(obj(event.Data)["id"])
			if q, ok := event.Data.(*QuestionRequest); ok && q != nil {
				id = q.ID
			}
			if id != "" {
				questions <- id
			}
		}
	}
	done := make(chan error, 1)
	go func() { done <- e.StartTaskWorker(ctx, "project", w.ID) }()
	select {
	case id := <-questions:
		if err := e.ReplyQuestion(w.SessionID, id, map[string][]string{"work_contract": {securityWorkConfirmLabel}}); err != nil {
			t.Fatal(err)
		}
	case err := <-done:
		t.Fatal("Worker skipped original host confirmation", err)
	case <-time.After(10 * time.Second):
		t.Fatal("Worker did not present confirmation")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("Worker did not finish bounded invocation")
	}
	_, goal, err := e.workRow(w.SessionID, w.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if goal.closure == nil || goal.OriginRootTurnID != w.OriginRootTurnID || goal.Status == "completed" {
		t.Fatal("goal identity or acceptance changed", goal)
	}
	var count int64
	if err = db.Model(&nativeWorkGoal{}).Where("session_id = ?", w.SessionID).Count(&count).Error; err != nil || count != 1 {
		t.Fatal("Worker created a second task authority", count, err)
	}
	if err = db.Model(&nativeOperation{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("text/confirmation created resource I/O", count, err)
	}
}
