package ai

import "testing"

func TestHumanAcceptanceRequiresConfirmedManualContractAndExactAction(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	g := managedGoalFixture(t, e, "manual", true)
	g, attempt := managedAttemptFixture(t, e, g, "")
	managedProofFixture(t, e, g, attempt, "succeeded", `{"exitCode":0}`)
	if _, err := e.VerifyWorkStep(g.SessionID, g.ID, g.Items[0].ID, g.Revision); err != nil {
		t.Fatal(err)
	}
	_, g, _ = e.workRow(g.SessionID, g.ID)
	ids := []string{"services", "tiles", "equal", "preserved"}
	if _, err := e.RecordHumanWorkAcceptance(g.SessionID, g.ID, g.Items[0].ID, "local-user", "wrong-criteria", "source", g.Revision, ids[:3], "checked"); err == nil {
		t.Fatal("partial verification accepted")
	}
	if _, err := e.RecordHumanWorkAcceptance(g.SessionID, g.ID, g.Items[0].ID, "local-user", "stale", "source", g.Revision-1, ids, "checked"); err == nil {
		t.Fatal("stale contract accepted")
	}
	before := g.Revision
	id, err := e.RecordHumanWorkAcceptance(g.SessionID, g.ID, g.Items[0].ID, "local-user", "verify", "source", before, ids, "人工检查实际数据库后确认")
	if err != nil {
		t.Fatal(err)
	}
	repeated, err := e.RecordHumanWorkAcceptance(g.SessionID, g.ID, g.Items[0].ID, "local-user", "verify", "source", before, ids, "人工检查实际数据库后确认")
	if err != nil || repeated != id {
		t.Fatal("human action replay was not idempotent", repeated, err)
	}
	if _, err = e.RecordHumanWorkAcceptance(g.SessionID, g.ID, g.Items[0].ID, "local-user", "verify", "source", before, ids, "different conclusion"); err == nil {
		t.Fatal("action ID reused for different verification")
	}
	_, g, _ = e.workRow(g.SessionID, g.ID)
	if g.Items[0].Status != "completed" || g.Status == "completed" {
		t.Fatal("human step acceptance bypassed goal verification")
	}
	store, _ := e.adkStore()
	var record workAcceptanceRecord
	if err = store.DB.First(&record, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	if record.Actor != "local-user" || record.SourceMessageID != "source" || record.VerifierVersion != "human/1" || record.AttemptID != attempt {
		t.Fatal("human provenance missing", record)
	}
	if _, err = e.VerifyWorkGoal(g.SessionID, g.ID, g.Revision); err != nil {
		t.Fatal(err)
	}
	_, g, _ = e.workRow(g.SessionID, g.ID)
	if g.Status != "completed" {
		t.Fatal("fully verified manual goal did not close", g.Status)
	}
}

func TestHumanAcceptanceCannotClearUnknownOrChangeAutomaticContract(t *testing.T) {
	for _, manual := range []bool{false, true} {
		e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
		g := managedGoalFixture(t, e, "blocked", manual)
		g, attempt := managedAttemptFixture(t, e, g, "")
		status := "succeeded"
		if manual {
			status = "unknown"
		}
		op := managedProofFixture(t, e, g, attempt, status, `{"service":2,"tiles":1442,"differences":0,"existingPreserved":true}`)
		if _, err := e.RecordHumanWorkAcceptance(g.SessionID, g.ID, g.Items[0].ID, "local-user", "verify", "source", g.Revision, []string{"services", "tiles", "equal", "preserved"}, "checked"); err == nil {
			t.Fatal("human action changed automatic contract or cleared unknown", manual)
		}
		store, _ := e.adkStore()
		var original nativeOperation
		if err := store.DB.First(&original, "id = ?", op.ID).Error; err != nil || original.Status != status {
			t.Fatal("original execution state overwritten", original.Status, err)
		}
	}
}
