package ai

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
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

func TestSuperFirstPlanBindsRealResourcesWithoutReplacingGoal(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	task := superCreateFixture(t, e, b, "target-source", "Read target A only", "read", "Read target A")
	c := Config{SecurityProjectID: b.ProjectID, Profile: "core", Model: Model{URL: "http://127.0.0.1:1", Name: "fixture"}, Assets: []Asset{{ID: "target-a", Name: "A", Kind: "ssh", SSH: &SSH{Host: "127.0.0.1", Port: 22, Username: "fixture"}}, {ID: "target-b", Name: "B", Kind: "ssh", SSH: &SSH{Host: "127.0.0.2", Port: 22, Username: "fixture"}}}}
	if err := e.ConfigureTaskWorker(ctx, b.ProjectID, task.WorkerID, c); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get(task.SessionID)
	s.mu.Lock()
	s.state.WorkGoalID = task.TaskID
	s.state.View.RootTurnID = "original-root"
	s.mu.Unlock()
	goal, err := e.beginWork(s, "Read A", []WorkItem{{ID: "read", Title: "Review A"}}, assetAlias("target-a"))
	if err != nil || goal.ID != task.TaskID || len(goal.ResourceBindings) != 1 || goal.ResourceBindings[0].AssetRef != "target-a" {
		t.Fatal(goal, err)
	}
	contract := WorkStepContract{Required: true, VerificationMode: "manual", Criteria: []security.AcceptanceCriterion{{ID: "review", Method: "human_verified", TargetKind: security.TargetSession, Target: task.SessionID, SourceDigest: hash("actual reviewed requirement"), Expected: json.RawMessage(`"Review A"`)}}}
	if err = e.ConfigureWorkAcceptance(task.SessionID, goal.ID, b.ProjectID, "user", "confirm-original-target", goal.Revision, map[string]WorkStepContract{goal.Items[0].ID: contract}); err != nil {
		t.Fatal(err)
	}
	if _, err = e.beginWork(s, "Read B", []WorkItem{{ID: "other", Title: "Different target"}}, assetAlias("target-b")); err == nil {
		t.Fatal("confirmed scope widened")
	}
	db, _ := e.superStore()
	var goals, tasks int64
	if err = db.Model(&nativeWorkGoal{}).Count(&goals).Error; err != nil || goals != 1 {
		t.Fatal(goals, err)
	}
	if err = db.Model(&securityTaskRow{}).Count(&tasks).Error; err != nil || tasks != 0 {
		t.Fatal("resource proposal granted execution", tasks, err)
	}
}

func TestSuperWorkerSourceRevocationStopsNextProviderOrTool(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	if _, err := e.ActivateSuperProject(ctx, b.ProjectID, "pilot", nil); err != nil {
		t.Fatal(err)
	}
	task := superCreateFixture(t, e, b, "source-message", "Inspect orders", "orders", "Inspect orders")
	db, _ := e.superStore()
	var worker superWorkerRow
	if err := db.First(&worker, "id = ?", task.WorkerID).Error; err != nil {
		t.Fatal(err)
	}
	if err := e.finishSuperRouting(ctx, b, worker.SourceEventID); err != nil {
		t.Fatal(err)
	}
	if err := e.ConfigureTaskWorker(ctx, b.ProjectID, task.WorkerID, Config{SecurityProjectID: b.ProjectID, Model: Model{URL: "http://127.0.0.1:1", Name: "fixture"}}); err != nil {
		t.Fatal(err)
	}
	c, err := e.ConfigForSession(task.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	token, err := e.AcquireWorkerSlot(ctx, b.ProjectID, task.WorkerID)
	if err != nil {
		t.Fatal(err)
	}
	run := context.WithValue(ctx, superAssignmentContextKey{}, token)
	if err = e.checkSuperModelDomain(run, task.SessionID, c); err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&superSourceRow{}).Where("id = ?", b.SourceID).Update("enabled", false).Error; err != nil {
		t.Fatal(err)
	}
	if err = e.checkSuperModelDomain(run, task.SessionID, c); err == nil {
		t.Fatal("revoked source still eligible for provider/tool dispatch")
	}
}
