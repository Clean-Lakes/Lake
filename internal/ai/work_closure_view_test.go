package ai

import "testing"

func TestWorkClosureProjectionPreservesUnknownFailedEffectsAndCurrentRevisions(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	g := managedGoalFixture(t, e, "projection", true)
	g, attempt := managedAttemptFixture(t, e, g, "")
	op := managedProofFixture(t, e, g, attempt, "failed", "")
	store, _ := e.adkStore()
	if err := store.DB.Model(&nativeOperation{}).Where("id = ?", op.ID).Updates(map[string]any{"orphan_state": "effects_unknown", "closure_state": "effects_unknown"}).Error; err != nil {
		t.Fatal(err)
	}
	view, err := e.WorkClosureView(g.SessionID, g.ID)
	if err != nil || view.UnresolvedOperations != 1 || !view.AcceptanceRequired {
		t.Fatal("failed partial effects disappeared from projection", view, err)
	}
	if err = e.ResolveOperation(g.SessionID, op.ID, "failed", "人工核对原进程已停止及实际改动范围"); err != nil {
		t.Fatal(err)
	}
	view, err = e.WorkClosureView(g.SessionID, g.ID)
	if err != nil || view.UnresolvedOperations != 0 || !view.AcceptanceRequired {
		t.Fatal("reconciliation wrongly accepted business result", view, err)
	}
	var original nativeOperation
	if err = store.DB.First(&original, "id = ?", op.ID).Error; err != nil || original.Status != "failed" || original.RiskResolvedAt == nil {
		t.Fatal("failure or explicit resolution provenance lost", original, err)
	}
	var evidence []nativeEvidence
	if err = store.DB.Where("operation_id = ? AND status = ?", op.ID, "resolved_failed").Find(&evidence).Error; err != nil || len(evidence) != 1 {
		t.Fatal("resolution evidence missing", err)
	}
}
