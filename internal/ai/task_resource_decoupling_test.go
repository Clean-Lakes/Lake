package ai

import (
	"context"
	"strings"
	"testing"
)

func TestTaskResourceProjectionIncludesActualOperationsWithoutGrantingScope(t *testing.T) {
	e, b := superFixture(t)
	task := superCreateFixture(t, e, b, "compare", "Compare database with cluster", "compare", "Compare database with cluster")
	db, _ := e.superStore()
	for _, op := range []nativeOperation{
		{ID: "actual-cluster", ProjectID: b.ProjectID, SessionID: task.SessionID, GoalID: task.TaskID, ResourceID: "cluster", Status: "succeeded"},
		{ID: "actual-db", ProjectID: b.ProjectID, SessionID: task.SessionID, GoalID: task.TaskID, ResourceID: "db", Status: "unknown"},
		{ID: "repeated-cluster", ProjectID: b.ProjectID, SessionID: task.SessionID, GoalID: task.TaskID, ResourceID: "cluster", Status: "succeeded"},
		{ID: "foreign", ProjectID: "foreign-project", SessionID: task.SessionID, GoalID: task.TaskID, ResourceID: "foreign", Status: "succeeded"},
		{ID: "different-session", ProjectID: b.ProjectID, SessionID: "different", GoalID: task.TaskID, ResourceID: "unrelated", Status: "succeeded"},
	} {
		if err := db.Create(&op).Error; err != nil {
			t.Fatal(err)
		}
	}
	before, goal, _ := e.workRow(task.SessionID, task.TaskID)
	view, err := e.SuperTask(task.SessionID, task.TaskID)
	if err != nil || len(view.Resources) != 2 || view.Resources[0].AssetRef != "cluster" || view.Resources[1].AssetRef != "db" || view.State == "completed" {
		t.Fatal(view, err)
	}
	after, unchanged, _ := e.workRow(task.SessionID, task.TaskID)
	if after.Revision != before.Revision || js(unchanged) != js(goal) {
		t.Fatal("resource projection wrote task state")
	}
	var count int64
	if err := db.Model(&securityTaskRow{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("resource projection granted execution", count, err)
	}
}

func TestOrdinarySREPlanUsesProjectCatalogInsteadOfFirstGoalReference(t *testing.T) {
	var e *Engine
	var task SRETask
	var result, foreign error
	model, closeModel := fakeModel(t, func(_ int, _ map[string]any) any {
		repo := &srePolicyRepository{task: task}
		e.SetSRERepository(repo)
		result = e.BindSecuritySREPlan(t.Context(), "case", task.ID)
		repo.task.ID = "foreign-plan-task"
		repo.task.Plans = append([]SREPlanRevision(nil), task.Plans...)
		repo.task.Plans[0].Steps = append([]SREPlanStep(nil), task.Plans[0].Steps...)
		repo.task.Plans[0].Steps[0].ResourceIDs = []string{"foreign"}
		foreign = e.BindSecuritySREPlan(t.Context(), "case", repo.task.ID)
		return response("Preserve task and operation history")
	})
	defer closeModel()
	e = managedEngineFixture(t, model)
	goal := versionedGoalFixture(t, e, "Compare current database and cluster")
	task = SRETask{ID: "same-goal-sre", SessionID: "case", ProjectID: "project", Status: "active", Plans: []SREPlanRevision{{ID: "actual-plan", Goal: goal.Title, Steps: []SREPlanStep{{ID: goal.Items[0].ID, Description: goal.Items[0].Title, Role: SREInvestigator, ResourceIDs: []string{"new-cluster"}}}}}}
	if err := e.SetSecurityCatalogResolver(func(context.Context, SecurityCatalogQuery) (SecurityCatalogView, error) {
		return SecurityCatalogView{Resources: []SecurityCatalogResource{{ID: "new-cluster", ProjectID: "project", Kind: "kubernetes", MetadataDigest: hash("current-project-cluster")}}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := e.SelectSecurityGoal(t.Context(), SecurityGoalSelection{ActorID: "user", ActionID: "select-original", ProjectID: "project", SessionID: "case", GoalID: goal.ID, SourceMessageID: "actual-source", ExpectedGoalRevision: goal.closure.GoalRevision}); err != nil {
		t.Fatal(err)
	}
	if err := e.ExecuteTurn(t.Context(), "case", TurnInput{StrategyMessageID: "actual-continue", UserText: "Continue comparing database and cluster"}); err != nil {
		t.Fatal(err)
	}
	if result != nil {
		t.Fatal("later project resource rejected by task references", result)
	}
	if foreign == nil || !strings.Contains(foreign.Error(), "current project catalog") {
		t.Fatal("foreign candidate accepted", foreign)
	}
}
