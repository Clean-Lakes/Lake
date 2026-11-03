package ai

import (
	"context"
	"testing"
)

func TestSnapshotReplyActivityDoesNotChangeBlockedGoal(t *testing.T) {
	e, _ := superFixture(t)
	goal := managedGoalFixture(t, e, "reply-activity")
	row, goal, err := e.workRow(goal.SessionID, goal.ID)
	if err != nil {
		t.Fatal(err)
	}
	goal.Status = "blocked"
	if err = e.writeWorkGoal(&row, &goal, false); err != nil {
		t.Fatal(err)
	}
	s, err := e.get(goal.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	_, cancel := context.WithCancel(t.Context())
	defer cancel()
	s.mu.Lock()
	s.state.WorkGoalID = goal.ID
	s.state.View.RootTurnID = goal.OriginRootTurnID
	s.state.View.Status = "running"
	s.cancel = cancel
	s.mu.Unlock()
	view, err := e.Snapshot(goal.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if view.ReplyStatus != "running" || view.Status != "blocked" || view.WorkGoals[0].Status != "blocked" {
		t.Fatal("live reply and canonical blocked goal were conflated", view.ReplyStatus, view.Status)
	}
	s.mu.Lock()
	s.cancel = nil
	s.state.View.Status = "blocked"
	s.mu.Unlock()
	view, err = e.Snapshot(goal.SessionID)
	if err != nil || view.ReplyStatus != "" || view.Status != "blocked" {
		t.Fatal("inactive task retained a live reply", view.ReplyStatus, view.Status, err)
	}
}
