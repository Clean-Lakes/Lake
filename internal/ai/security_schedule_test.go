package ai

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func archivedScheduleFixture(t *testing.T) (*gorm.DB, time.Time, security.PreparedOperation, ExecutionOwner) {
	t.Helper()
	db, now, op, owner, _ := permitFixture(t)
	if err := db.AutoMigrate(securityScheduleModels()...); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&securityTaskRow{}).Where("id = ?", op.TaskID).Updates(map[string]any{
		"kind": "schedule", "source_kind": "schedule_occurrence", "source_event_id": "occurrence",
	}).Error; err != nil {
		t.Fatal(err)
	}
	rows := []any{
		&securityScheduleConfigurationRow{
			ID: "schedule", ProjectID: op.ProjectID, SessionID: op.SessionID, StoreID: op.StoreID, RecoveryEpoch: op.RecoveryEpoch,
			State: "ready", ConfigRevision: 1, AuthorityRevision: 1, Enabled: true,
		},
		&securityScheduleGrantRow{
			ID: "grant", ScheduleID: "schedule", ProjectID: op.ProjectID, StoreID: op.StoreID, RecoveryEpoch: op.RecoveryEpoch,
			ConfigRevision: 1, AuthorityRevision: 1, Revision: 1, ExpiresAt: now.Add(time.Hour),
		},
		&securityScheduleOccurrenceRow{
			ID: "occurrence", ScheduleID: "schedule", ProjectID: op.ProjectID, SessionID: op.SessionID, StoreID: op.StoreID,
			RecoveryEpoch: op.RecoveryEpoch, GrantID: "grant", TaskID: op.TaskID, ConfigRevision: 1, AuthorityRevision: 1,
			DueAt: now, Kind: "workflow", State: "materialized",
		},
		&securityScheduleTaskSourceRow{
			TaskID: op.TaskID, ScheduleID: "schedule", GrantID: "grant", OccurrenceID: "occurrence",
			StoreID: op.StoreID, RecoveryEpoch: op.RecoveryEpoch, ConfigRevision: 1, AuthorityRevision: 1,
		},
	}
	for _, row := range rows {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	return db, now, op, owner
}

func TestSecurityRetiredScheduleAuthorityOnlyReconcilesExistingOperation(t *testing.T) {
	db, now, op, owner := archivedScheduleFixture(t)
	if err := ValidateSecurityScheduleTaskSource(db, op.TaskID, op.StoreID, op.RecoveryEpoch, now); err != nil {
		t.Fatal("original authority no longer readable", err)
	}
	if _, err := AcquireSecurityPermitTx(db, op, owner, now); !errors.Is(err, errScheduleRetired) {
		t.Fatal("old schedule received a new operation permit", err)
	}
}

func TestSecurityRetiredScheduleRejectsDamagedHistoricalAuthority(t *testing.T) {
	for _, damage := range []string{"missing_source", "missing_occurrence", "wrong_project", "wrong_original_due_source", "revoked_grant"} {
		t.Run(damage, func(t *testing.T) {
			db, now, op, _ := archivedScheduleFixture(t)
			var err error
			switch damage {
			case "missing_source":
				err = db.Delete(&securityScheduleTaskSourceRow{}, "task_id = ?", op.TaskID).Error
			case "missing_occurrence":
				err = db.Delete(&securityScheduleOccurrenceRow{}, "id = ?", "occurrence").Error
			case "wrong_project":
				err = db.Model(&securityScheduleOccurrenceRow{}).Where("id = ?", "occurrence").Update("project_id", "other-project").Error
			case "wrong_original_due_source":
				err = db.Model(&securityTaskRow{}).Where("id = ?", op.TaskID).Update("source_event_id", "another-occurrence").Error
			case "revoked_grant":
				err = db.Model(&securityScheduleGrantRow{}).Where("id = ?", "grant").Update("revoked", true).Error
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := ValidateSecurityScheduleTaskSource(db, op.TaskID, op.StoreID, op.RecoveryEpoch, now); err == nil {
				t.Fatal("damaged schedule relationship validated")
			}
		})
	}
}

func TestSecurityRetiredScheduleCannotCreateOrActivateWorkflow(t *testing.T) {
	e, _, in := managedWorkflowFixture(t)
	ctx := context.Background()
	old := in
	old.SourceKind = "schedule_occurrence"
	if _, err := e.BeginSecurityWorkflowRun(ctx, old); !errors.Is(err, errScheduleRetired) {
		t.Fatal("scheduled occurrence created new run", err)
	}

	binding, err := e.BeginSecurityWorkflowRun(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	binding.SourceKind, binding.SourceEventID = old.SourceKind, "occurrence"
	binding.Task.Kind = "schedule"
	if _, err = e.RegisterSuperWorkflow(ctx, binding); !errors.Is(err, errScheduleRetired) {
		t.Fatal("Pilot registered a retired schedule", err)
	}
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&securityTaskRow{}).Where("id = ?", binding.Task.ID).Updates(map[string]any{
		"kind": binding.Task.Kind, "source_kind": binding.SourceKind, "source_event_id": binding.SourceEventID,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&securityWorkflowRunRow{}).Where("run_id = ?", in.RunID).Update("data", js(binding)).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := e.ActivateSecurityWorkflowRun(ctx, in.RunID); !errors.Is(err, errScheduleRetired) {
		t.Fatal("historical schedule run was admitted", err)
	}
	worker := superWorkerRow{TaskID: binding.GoalID, ProjectID: binding.ProjectID, SessionID: binding.SessionID, Protocol: "workflow"}
	if err := checkSuperWorkflowTx(db, worker, time.Now().UTC()); !errors.Is(err, errScheduleRetired) {
		t.Fatal("historical schedule worker qualified for a new dispatch", err)
	}
}
