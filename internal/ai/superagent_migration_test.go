package ai

import (
	"context"
	"testing"
)

func TestSuperLegacyImportKeepsOriginalGoalAndNeverReplays(t *testing.T) {
	e, _ := superFixture(t)
	ctx := context.Background()
	goal, _, _ := superWorkerFixture(t, e, "old-goal")
	// Remove only this fixture's artificial Super metadata, retaining its actual
	// original canonical goal/evidence as the legacy import input.
	db, _ := e.superStore()
	if err := db.Where("worker_id = ?", "worker-old-goal").Delete(&superAssignmentRow{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Where("id = ?", "worker-old-goal").Delete(&superWorkerRow{}).Error; err != nil {
		t.Fatal(err)
	}
	first, err := e.ApplyLegacyWorkImport(ctx, "project", goal.SessionID, "work", goal.ID)
	if err != nil || !first.ReadOnly || first.CanAdopt || first.Alias.CanonicalID != goal.ID {
		t.Fatal(first, err)
	}
	second, err := e.ApplyLegacyWorkImport(ctx, "project", goal.SessionID, "work", goal.ID)
	if err != nil || second.Alias != first.Alias {
		t.Fatal(second, err)
	}
	_, after, err := e.workRow(goal.SessionID, goal.ID)
	if err != nil || after.Status != "paused" || after.OriginRootTurnID != goal.OriginRootTurnID || !after.DeadlineAt.Equal(goal.DeadlineAt) || after.ModelRounds != goal.ModelRounds {
		t.Fatal(after, err)
	}
	if _, err = e.VerifyWorkGoal(goal.SessionID, goal.ID, after.Revision); err == nil {
		t.Fatal("read-only history became mutable acceptance")
	}
}

func TestSuperLegacySREArchivePreservesUnknownOperationsAndIDs(t *testing.T) {
	e, _ := superFixture(t)
	ctx := context.Background()
	legacy := SRETask{ID: "old-sre", SessionID: "old-session", ProjectID: "project", RequestID: "old-request", Goal: "Old investigation", Status: "completed", Attempts: []SREStepAttempt{{ID: "old-attempt", Operations: []SREOperation{{ID: "old-operation", ApprovalID: "old-approval", Status: "unknown", EvidenceIDs: []string{"old-evidence"}}}}}}
	e.sreRepository = &srePolicyRepository{task: legacy}
	db, _ := e.superStore()
	if err := db.Create(&nativeOperation{ID: "old-operation", SessionID: legacy.SessionID, Status: "unknown", Handle: "original-handle"}).Error; err != nil {
		t.Fatal(err)
	}
	first, err := e.ApplyLegacyWorkImport(ctx, "project", legacy.SessionID, "sre", legacy.ID)
	if err != nil || !first.ReadOnly || first.CanAdopt || !isSuperArchiveGoal(first.Alias.CanonicalID) || len(first.OperationIDs) != 1 || first.OperationIDs[0] != "old-operation" || len(first.ApprovalIDs) != 1 || first.ApprovalIDs[0] != "old-approval" {
		t.Fatal(first, err)
	}
	second, err := e.ApplyLegacyWorkImport(ctx, "project", legacy.SessionID, "sre", legacy.ID)
	if err != nil || second.Alias != first.Alias {
		t.Fatal(second, err)
	}
	view, err := e.SuperTask(legacy.SessionID, first.Alias.CanonicalID)
	if err != nil || view.State != "paused" || view.AcceptanceState == "pass" || view.ProjectID != "project" {
		t.Fatal(view, err)
	}
	var operation nativeOperation
	if err = db.First(&operation, "id = ?", "old-operation").Error; err != nil || operation.Status != "unknown" || operation.Handle != "original-handle" {
		t.Fatal(operation, err)
	}
	if err = e.WorkControl(ctx, legacy.SessionID, first.Alias.CanonicalID, "resume", view.Revision); err == nil {
		t.Fatal("archive resumed")
	}
	var goals int64
	if err = db.Model(&nativeWorkGoal{}).Count(&goals).Error; err != nil || goals != 1 {
		t.Fatal("duplicate archival goal", goals, err)
	}
}
