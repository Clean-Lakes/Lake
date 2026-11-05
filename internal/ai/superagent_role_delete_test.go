package ai

import (
	"errors"
	"testing"
	"time"
)

func TestDeleteSuperSpecialistPreservesHistoryAndFencesLateDispatch(t *testing.T) {
	e, b := superFixture(t)
	create := specialistChangeFixture(t, e, b, "建立", SuperSpecialistChange{Action: "create", RoleKey: "ops", Name: "运维专员", Duties: "核实证据"})
	role, err := e.ManageSuperSpecialist(t.Context(), b, create)
	if err != nil {
		t.Fatal(err)
	}
	other := specialistChangeFixture(t, e, b, "同名独立专员", SuperSpecialistChange{Action: "create", RoleKey: "other", Name: role.Name})
	otherRole, err := e.ManageSuperSpecialist(t.Context(), b, other)
	if err != nil {
		t.Fatal(err)
	}
	channels, _ := e.ListSpecialistChannels(t.Context(), b.ProjectID)
	var ch SpecialistChannel
	for _, row := range channels {
		if row.RoleID == role.ID {
			ch = row
		}
	}
	task := superCreateFixture(t, e, b, "task", "Check A", "task", "Check A")
	// Bind an actual task to the selected role through the public routing path.
	event, _, err := e.ReceiveSuperEvent(t.Context(), b, SuperEventInput{SourceEventID: "ops-task", Kind: "message", Payload: "Check ops"})
	if err != nil {
		t.Fatal(err)
	}
	ops, err := e.ApplySuperDecision(t.Context(), b, SuperDecision{EventID: event.ID, PartKey: "ops", Action: "create", RoleID: role.ID, Title: event.Payload, Quote: event.Payload, Reason: "actual assignment"})
	if err != nil {
		t.Fatal(err)
	}
	pending := channelEventFixture(t, e, b, ch, "pending-channel", "Inspect another target")
	before, err := e.SuperTask(ops.SessionID, ops.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	db, _ := e.superStore()
	var assignment superAssignmentRow
	if err := db.First(&assignment, "worker_id = ?", ops.WorkerID).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&assignment).Updates(map[string]any{"state": "active", "owner_id": "actual-owner", "generation": 1, "lease_until": time.Now().UTC().Add(time.Minute)}).Error; err != nil {
		t.Fatal(err)
	}
	token := SuperAssignmentToken{AssignmentID: assignment.ID, WorkerID: ops.WorkerID, OwnerID: "actual-owner", Generation: 1}
	if err := checkSuperAssignmentTx(db, token); err != nil {
		t.Fatal(err)
	}
	operation := nativeOperation{ID: "original-operation", SessionID: ops.SessionID, Status: "unknown", Handle: "original-handle"}
	if err := db.Create(&operation).Error; err != nil {
		t.Fatal(err)
	}
	if err := e.DeleteSuperSpecialist(t.Context(), "other-project", role.ID, 1); err == nil {
		t.Fatal("cross-project deletion succeeded")
	}
	if err := e.DeleteSuperSpecialist(t.Context(), b.ProjectID, role.ID, 2); !errors.Is(err, ErrSpecialistRevision) {
		t.Fatal("stale deletion succeeded", err)
	}
	for range 2 {
		if err := e.DeleteSuperSpecialist(t.Context(), b.ProjectID, role.ID, 1); err != nil {
			t.Fatal(err)
		}
	}
	if err := checkSuperAssignmentTx(db, token); err == nil {
		t.Fatal("retired owner retained dispatch eligibility")
	}
	after, err := e.SuperTask(ops.SessionID, ops.TaskID)
	if err != nil || after.State != "cancelled" || after.TaskID != before.TaskID || !after.DeadlineAt.Equal(before.DeadlineAt) {
		t.Fatal(after, err)
	}
	untouched, err := e.SuperTask(task.SessionID, task.TaskID)
	if err != nil || untouched.State == "cancelled" {
		t.Fatal("another role was stopped", untouched, err)
	}
	var saved nativeOperation
	if err := db.First(&saved, "id = ?", operation.ID).Error; err != nil || saved.Status != "unknown" || saved.Handle != operation.Handle {
		t.Fatal("operation history changed", saved, err)
	}
	if _, err := e.SpecialistChannelForSession(t.Context(), b.ProjectID, ch.SessionID); err != nil {
		t.Fatal("historical channel lost", err)
	}
	if _, err := e.ApplySuperDecision(t.Context(), b, SuperDecision{EventID: pending.ID, PartKey: "late", Action: "create", RoleID: role.ID, Title: pending.Payload, Quote: pending.Payload, Reason: "late provider response"}); err == nil {
		t.Fatal("late dispatch revived specialist")
	}
	newEvent, _, err := e.ReceiveSuperEvent(t.Context(), b, SuperEventInput{SourceEventID: "new-task", Kind: "message", Payload: "Check later"})
	if err != nil {
		t.Fatal(err)
	}
	for _, decision := range []SuperDecision{
		{EventID: newEvent.ID, PartKey: "id", Action: "create", RoleID: role.ID, Title: newEvent.Payload, Quote: newEvent.Payload, Reason: "stale exact id"},
		{EventID: newEvent.ID, PartKey: "key", Action: "create", RoleKey: role.RoleKey, Title: newEvent.Payload, Quote: newEvent.Payload, Reason: "stale legacy key"},
		{EventID: newEvent.ID, PartKey: "followup", Action: "followup", TaskID: ops.TaskID, Quote: newEvent.Payload, Reason: "stale task"},
	} {
		if _, err := e.ApplySuperDecision(t.Context(), b, decision); !errors.Is(err, ErrSpecialistDeleted) {
			t.Fatal("deleted role admitted work", decision, err)
		}
	}
	if _, err := e.AcquireWorkerSlot(t.Context(), b.ProjectID, ops.WorkerID); !errors.Is(err, ErrSpecialistDeleted) {
		t.Fatal("deleted role acquired slot", err)
	}
	if err := e.BindSpecialistSource(t.Context(), b.ProjectID, ch.SessionID, newEvent.ID, ""); !errors.Is(err, ErrSpecialistDeleted) {
		t.Fatal("deleted channel accepted input", err)
	}
	dir := e.Dir
	e.Shutdown()
	next, err := New(dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Shutdown()
	list, err := next.ListSuperSpecialists(t.Context(), b.ProjectID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	foundOther := false
	for _, r := range list.Items {
		if r.ID == role.ID {
			t.Fatal("restart resurrected deleted role")
		}
		if r.ID == otherRole.ID {
			foundOther = true
		}
	}
	if !foundOther {
		t.Fatal("same-name role deleted by name")
	}
	channels, err = next.ListSpecialistChannels(t.Context(), b.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range channels {
		if c.RoleID == role.ID {
			t.Fatal("deleted sidebar channel returned after restart")
		}
	}
}

func TestDeleteIdleSpecialistAndMigrateV5(t *testing.T) {
	e, b := superFixture(t)
	create := specialistChangeFixture(t, e, b, "先建不派单", SuperSpecialistChange{Action: "create", RoleKey: "idle", Name: "待命专员"})
	role, err := e.ManageSuperSpecialist(t.Context(), b, create)
	if err != nil {
		t.Fatal(err)
	}
	db, _ := e.superStore()
	if err := db.Migrator().DropColumn(&superRoleRow{}, "DeletedAt"); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&superSchemaRow{}).Where("id = ?", 1).Update("version", 5).Error; err != nil {
		t.Fatal(err)
	}
	dir := e.Dir
	e.Shutdown()
	next, err := New(dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Shutdown()
	list, err := next.ListSuperSpecialists(t.Context(), b.ProjectID, "", 50)
	if err != nil || len(list.Items) != 1 || list.Items[0] != role {
		t.Fatal("migration changed existing role", list, err)
	}
	if err := next.DeleteSuperSpecialist(t.Context(), b.ProjectID, role.ID, 1); err != nil {
		t.Fatal(err)
	}
	list, err = next.ListSuperSpecialists(t.Context(), b.ProjectID, "", 50)
	if err != nil || len(list.Items) != 0 {
		t.Fatal(list, err)
	}
	db, _ = next.superStore()
	var schema superSchemaRow
	if err := db.First(&schema, "id = ?", 1).Error; err != nil || schema.Version != 6 {
		t.Fatal(schema, err)
	}
}

func TestDeletedSpecialistRecoveryCompletesInterruptedStop(t *testing.T) {
	e, b := superFixture(t)
	task := superCreateFixture(t, e, b, "pending", "Inspect target", "pending", "Inspect target")
	channels, _ := e.ListSpecialistChannels(t.Context(), b.ProjectID)
	ch := channels[0]
	channelEventFixture(t, e, b, ch, "queued-channel", "Inspect next target")
	db, _ := e.superStore()
	// Simulate process loss between retirement and cancellation.
	if err := db.Model(&superRoleRow{}).Where("id = ?", ch.RoleID).Updates(map[string]any{"deleted_at": time.Now().UTC(), "revision": 2}).Error; err != nil {
		t.Fatal(err)
	}
	dir := e.Dir
	e.Shutdown()
	next, err := New(dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Shutdown()
	if _, err := next.RecoverSuperagent(t.Context(), b.ProjectID); err != nil {
		t.Fatal(err)
	}
	view, err := next.SuperTask(task.SessionID, task.TaskID)
	if err != nil || view.State != "cancelled" {
		t.Fatal("interrupted deletion was not completed", view, err)
	}
	channels, err = next.ListSpecialistChannels(t.Context(), b.ProjectID)
	if err != nil || len(channels) != 0 {
		t.Fatal("recovery revived sidebar role", channels, err)
	}
}

func TestDeleteLegacySpecialistRevisionZero(t *testing.T) {
	e, b := superFixture(t)
	create := specialistChangeFixture(t, e, b, "legacy", SuperSpecialistChange{Action: "create", RoleKey: "legacy", Name: "旧专员"})
	role, err := e.ManageSuperSpecialist(t.Context(), b, create)
	if err != nil {
		t.Fatal(err)
	}
	db, _ := e.superStore()
	if err := db.Model(&superRoleRow{}).Where("id = ?", role.ID).Update("revision", 0).Error; err != nil {
		t.Fatal(err)
	}
	if err := e.DeleteSuperSpecialist(t.Context(), b.ProjectID, role.ID, 0); err != nil {
		t.Fatal(err)
	}
}
