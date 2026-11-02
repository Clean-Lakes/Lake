package ai

import (
	"context"
	"testing"
)

func TestSuperMemoryPreservesWorkerExclusionAndOriginalSource(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	task := superCreateFixture(t, e, b, "memory-source", "Inspect orders without touching the database", "orders", "Inspect orders")
	view, err := e.MemoryForWorker(ctx, b.ProjectID, task.WorkerID)
	if err != nil || view.Available || view.Reason != "task_knowledge_view_unavailable" || view.Context.TaskID != task.TaskID || len(view.Context.SourceRefs) != 1 || view.Context.SourceRefs[0].SourceMessageID != "memory-source" {
		t.Fatal(view, err)
	}
	if _, err = e.MemoryForWorker(ctx, "foreign", task.WorkerID); err == nil {
		t.Fatal("cross-project task memory context")
	}
	c := Config{Model: Model{URL: "http://127.0.0.1:1", Name: "fixture"}, SecurityProjectID: b.ProjectID, MemoryProjectID: b.ProjectID, MemoryEnabled: true, MemoryExtractionEnabled: true, NaturalMemory: &NaturalMemoryConsent{GlobalEnabled: true, ProjectEnabled: true}}
	if err = e.ConfigureTaskWorker(ctx, b.ProjectID, task.WorkerID, c); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get(task.SessionID)
	s.mu.Lock()
	actual := s.state.Config
	s.mu.Unlock()
	if naturalRecallAllowed(actual) || actual.MemoryEnabled || actual.MemoryExtractionEnabled || actual.NaturalMemory != nil {
		t.Fatal("specialist inherited Router Memory")
	}
	for _, tool := range e.sessionCatalog(ctx, task.SessionID, actual) {
		if naturalRecallTool(tool.Name) || memoryTool(tool.Name) {
			t.Fatal("unqualified specialist memory tool", tool.Name)
		}
	}
}

func TestSuperRouterMemoryReadContextCannotAuthorizeMutationOrOtherSession(t *testing.T) {
	e, _ := superFixture(t)
	ctx := withSuperMemoryRead(context.Background(), "pilot", "project")
	// An unconfigured local project keeps existing owner consent semantics.
	if err := e.RequireSecurityBridgeContext(ctx, "project", "pilot", "read_project_memory"); err != nil {
		t.Fatal(err)
	}
	// A configured project cannot use the private read binding for writes.
	m := managedEngineFixture(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"})
	for _, test := range []struct{ project, session, name string }{{"project", "pilot", "save_project_memory"}, {"project", "other", "read_project_memory"}, {"project", "pilot", "shell"}} {
		if err := m.RequireSecurityBridgeContext(ctx, test.project, test.session, test.name); err == nil {
			t.Fatal("Memory read binding became execution permit", test)
		}
	}
}

func TestSuperMemoryReferencesRemainExactAndDoNotPromoteUnknown(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	task := superCreateFixture(t, e, b, "real-source", "Inspect orders without writes", "orders", "Inspect orders")
	db, _ := e.superStore()
	var worker superWorkerRow
	if err := db.First(&worker, "id = ?", task.WorkerID).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&superEventRow{}).Where("id = ?", worker.SourceEventID).Update("thread_ref", "pilot").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&nativeOperation{ID: "original-unknown", ProjectID: b.ProjectID, SessionID: task.SessionID, GoalID: task.TaskID, Status: "unknown"}).Error; err != nil {
		t.Fatal(err)
	}
	metadata, err := e.SuperMemorySourceContext(ctx, b.ProjectID, "pilot", "real-source")
	if err != nil || metadata == nil || metadata.TaskID != task.TaskID || len(metadata.Ledger) != 1 || metadata.Ledger[0].State != "unknown" {
		t.Fatal(metadata, err)
	}
	for _, source := range []struct{ project, session, message string }{{"other", "pilot", "real-source"}, {b.ProjectID, "foreign", "real-source"}, {b.ProjectID, "pilot", "ordinary-preference"}} {
		if metadata, err = e.SuperMemorySourceContext(ctx, source.project, source.session, source.message); err != nil || metadata != nil {
			t.Fatal("invented preference task or foreign source", metadata, err)
		}
	}
	// Two independent deliverables from one message have no unique task ID.
	if _, err = e.ApplySuperDecision(ctx, b, SuperDecision{EventID: worker.SourceEventID, PartKey: "other", Action: "create", Title: "Check changes", RoleKey: "other", Quote: "without writes", Reason: "second actual deliverable"}); err != nil {
		t.Fatal(err)
	}
	if metadata, err = e.SuperMemorySourceContext(ctx, b.ProjectID, "pilot", "real-source"); err != nil || metadata != nil {
		t.Fatal("ambiguous source assigned a task", metadata, err)
	}
}
