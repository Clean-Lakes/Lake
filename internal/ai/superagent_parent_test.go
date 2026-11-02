package ai

import (
	"context"
	"fmt"
	"testing"
)

func TestSuperChildrenShareGoalAndCannotRecurseOrResetInstanceLimit(t *testing.T) {
	e, _ := superFixture(t)
	goal, parentID, assignment := superWorkerFixture(t, e, "parent")
	row, goal, err := e.workRow(goal.SessionID, goal.ID)
	if err != nil {
		t.Fatal(err)
	}
	goal.RoundLimit = 20
	if err = e.writeWorkGoal(&row, &goal, false); err != nil {
		t.Fatal(err)
	}
	token := SuperAssignmentToken{AssignmentID: assignment, WorkerID: parentID, Generation: 1}
	ctx := context.WithValue(context.Background(), superAssignmentContextKey{}, token)
	children := []*agentWorker{}
	for i := 0; i < 7; i++ {
		children = append(children, &agentWorker{runID: fmt.Sprintf("child-%d", i), role: "host"})
	}
	if err := e.reserveSuperChildren(ctx, children); err != nil {
		t.Fatal(err)
	}
	if err := e.reserveSuperChildren(ctx, []*agentWorker{{runID: "ninth", role: "host"}}); err == nil {
		t.Fatal("lifetime count reset")
	}
	db, _ := e.superStore()
	var child superWorkerRow
	if err := db.First(&child, "id = ?", "child-0").Error; err != nil || child.goalSession() != goal.SessionID || child.TaskID != goal.ID || child.ParentWorkerID != parentID {
		t.Fatal(child, err)
	}
	resume, err := e.parkSuperInvocation(ctx, "waiting_children")
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&superAssignmentRow{}).Where("worker_id = ?", child.ID).Update("state", "queued").Error; err != nil {
		t.Fatal(err)
	}
	childToken, err := e.AcquireWorkerSlot(ctx, "project", child.ID)
	if err != nil {
		t.Fatal(err)
	}
	childCtx := context.WithValue(ctx, superAssignmentContextKey{}, childToken)
	if err = e.reserveSuperChildren(childCtx, []*agentWorker{{runID: "grandchild", role: "host"}}); err == nil {
		t.Fatal("recursive delegation")
	}
	if _, err := e.reserveSuperModel(childCtx, Model{MaxOutput: 20}, nil, nil); err != nil {
		t.Fatal("child cannot use canonical task budget", err)
	}
	if err = e.ReleaseWorkerSlot(context.Background(), childToken, "finished"); err != nil {
		t.Fatal(err)
	}
	if err = resume(); err != nil {
		t.Fatal(err)
	}
	var total int64
	if err = db.Model(&nativeWorkGoal{}).Count(&total).Error; err != nil || total != 1 {
		t.Fatal("delegation created another task authority", total, err)
	}
}
