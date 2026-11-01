package ai

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func scheduleAuthorityFixture(t *testing.T, kind string) (*gorm.DB, time.Time, SecurityScheduleDefinition, SecurityScheduleGrant) {
	t.Helper()
	db, now, op, _, _ := permitFixture(t)
	models := append(securityScheduleModels(), securityWorkflowModels()...)
	models = append(models, &nativeWorkOutbox{}, &nativeWorkObservation{})
	if err := db.AutoMigrate(models...); err != nil {
		t.Fatal(err)
	}
	definition := SecurityScheduleDefinition{ID: "schedule", ProjectID: "project", SessionID: "session", Kind: kind, AnchorAt: now.Add(10 * time.Second), IntervalSeconds: 60, Enabled: true}
	if kind == "workflow" {
		definition.WorkflowID = "workflow"
		definition.WorkflowVersion = 1
		definition.TemplateDigest = security.ContentDigest([]byte("fixed-workflow"))
		workflow := SecurityWorkflowDefinition{ProjectID: "project", WorkflowID: "workflow", TemplateVersion: 1, TemplateDigest: definition.TemplateDigest, Revision: 1, Goal: "Inspect fixed resource", Steps: []SecurityWorkflowStep{{ID: "check", Title: "Inspect real health", Role: "observer", ResourceIDs: []string{"r1"}}}, Acceptance: map[string]WorkStepContract{"check": {Revision: 1, Required: true, Criteria: []security.AcceptanceCriterion{{ID: "healthy", Method: "json_equal", Target: "r1", ConnectionRevision: 1, SourceDigest: security.ObservationSourceDigest("read", security.ContentDigest([]byte("health-query")), "r1", 1), Pointer: "/healthy", Expected: json.RawMessage(`true`)}}}}}
		if err := db.Create(&securityWorkflowDefinitionRow{ProjectID: "project", WorkflowID: "workflow", StoreID: "store", RecoveryEpoch: "epoch", TemplateVersion: 1, TemplateDigest: workflow.TemplateDigest, Revision: 1, Data: js(workflow)}).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		definition, err = beginSecurityScheduleConfiguration(tx, "store", "epoch", SecurityScheduleAction{ActorID: "local-user", ActionID: "configure", ProjectID: "project", ScheduleID: "schedule"}, definition, now)
		if err != nil {
			return err
		}
		return readySecurityScheduleConfiguration(tx, "store", "epoch", definition)
	}); err != nil {
		t.Fatal(err)
	}
	var grant SecurityScheduleGrant
	if kind == "workflow" {
		if err := db.Transaction(func(tx *gorm.DB) error {
			var err error
			grant, err = issueSecurityScheduleGrant(tx, "store", "epoch", SecurityScheduleGrantAction{Action: SecurityScheduleAction{ActorID: "local-user", ActionID: "grant-schedule", ProjectID: "project", ScheduleID: "schedule", ExpectedConfigRevision: 1, ExpectedAuthorityRevision: 1}, Grant: SecurityScheduleGrant{ScheduleID: "schedule", ProjectID: "project", ExpiresAt: now.Add(2 * time.Hour), RemainingRuns: 1, TaskTTL: 30 * time.Minute, TaskGrant: security.TaskGrant{Resources: op.Resources, Capabilities: []string{"file.read"}, RemainingUses: 5, Limits: security.ScopeLimits{FileRoots: []string{"/var/log"}}}}}, now)
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	return db, now, definition, grant
}

func TestSecurityScheduleOccurrenceConsumesOnceAndStatusDoesNotInvalidate(t *testing.T) {
	db, now, definition, grant := scheduleAuthorityFixture(t, "workflow")
	var first, again SecurityScheduleOccurrence
	claim := func(out *SecurityScheduleOccurrence) error {
		return db.Transaction(func(tx *gorm.DB) error {
			var err error
			*out, err = claimSecurityScheduleOccurrence(tx, "store", "epoch", definition.ID, 1, 1, definition.AnchorAt, now.Add(11*time.Second))
			return err
		})
	}
	if err := claim(&first); err != nil {
		t.Fatal(err)
	}
	if err := claim(&again); err != nil {
		t.Fatal(err)
	}
	if first.Replay || !again.Replay || first.ID != again.ID || first.Workflow.Task.ID == "" || first.Workflow.Task.ID != again.Workflow.Task.ID {
		t.Fatal("same occurrence created a second execution")
	}
	var row securityScheduleGrantRow
	if err := db.First(&row, "id = ?", grant.ID).Error; err != nil || row.RemainingRuns != 0 {
		t.Fatal("schedule budget not consumed exactly once", err)
	}
	if err := ValidateSecurityScheduleTaskSource(db, first.Workflow.Task.ID, "store", "epoch", now.Add(12*time.Second)); err != nil {
		t.Fatal("remaining_runs=0 incorrectly revoked the already admitted run", err)
	}
	var count int64
	if err := db.Model(&securityScheduleOccurrenceRow{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatal("duplicate occurrence record", err)
	}
	if err := db.Model(&nativeOperation{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("claim performed actual tool I/O registration", err)
	}
	if err := db.Transaction(func(tx *gorm.DB) error {
		_, err := claimSecurityScheduleOccurrence(tx, "store", "epoch", definition.ID, 1, 1, definition.AnchorAt.Add(time.Minute), now.Add(71*time.Second))
		return err
	}); err == nil {
		t.Fatal("exhausted schedule budget allowed another occurrence")
	}
}

func TestSecurityScheduleAtomicRollbackAndConfigurationRevokesDerivedSource(t *testing.T) {
	db, now, definition, grant := scheduleAuthorityFixture(t, "workflow")
	rollback := errors.New("injected after claim")
	if err := db.Transaction(func(tx *gorm.DB) error {
		if _, err := claimSecurityScheduleOccurrence(tx, "store", "epoch", definition.ID, 1, 1, definition.AnchorAt, now.Add(11*time.Second)); err != nil {
			return err
		}
		return rollback
	}); !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	var row securityScheduleGrantRow
	if err := db.First(&row, "id = ?", grant.ID).Error; err != nil || row.RemainingRuns != 1 {
		t.Fatal("rolled back claim consumed grant", err)
	}
	var occurrence SecurityScheduleOccurrence
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		occurrence, err = claimSecurityScheduleOccurrence(tx, "store", "epoch", definition.ID, 1, 1, definition.AnchorAt, now.Add(11*time.Second))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	definition.Enabled = false
	if err := db.Transaction(func(tx *gorm.DB) error {
		_, err := beginSecurityScheduleConfiguration(tx, "store", "epoch", SecurityScheduleAction{ActorID: "local-user", ActionID: "disable", ProjectID: "project", ScheduleID: "schedule", ExpectedConfigRevision: 1, ExpectedAuthorityRevision: 1}, definition, now.Add(12*time.Second))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateSecurityScheduleTaskSource(db, occurrence.Workflow.Task.ID, "store", "epoch", now.Add(13*time.Second)); err == nil {
		t.Fatal("changing/revoked schedule source kept derived authority alive")
	}
}

func TestSecurityScheduleRejectsMissingGrantChangedDefinitionAndLateDueAt(t *testing.T) {
	db, now, definition, _ := scheduleAuthorityFixture(t, "workflow")
	if err := db.Model(&securityWorkflowDefinitionRow{}).Where("project_id = ?", "project").Update("revision", 2).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Transaction(func(tx *gorm.DB) error {
		_, err := claimSecurityScheduleOccurrence(tx, "store", "epoch", definition.ID, 1, 1, definition.AnchorAt, now.Add(11*time.Second))
		return err
	}); err == nil {
		t.Fatal("changed workflow acceptance silently inherited schedule authority")
	}
	for _, due := range []time.Time{definition.AnchorAt.Add(time.Second), definition.AnchorAt.Add(-time.Minute)} {
		if validOriginalScheduleDueAt(definition, due) {
			t.Fatal("forged dueAt accepted")
		}
	}
	late, clock, workflow, _ := scheduleAuthorityFixture(t, "workflow")
	if err := late.Transaction(func(tx *gorm.DB) error {
		_, err := claimSecurityScheduleOccurrence(tx, "store", "epoch", workflow.ID, 1, 1, workflow.AnchorAt, clock.Add(2*time.Minute))
		return err
	}); err == nil {
		t.Fatal("missed occurrence replayed")
	}
	reminders, clock, reminder, _ := scheduleAuthorityFixture(t, "reminder")
	var out SecurityScheduleOccurrence
	if err := reminders.Transaction(func(tx *gorm.DB) error {
		var err error
		out, err = claimSecurityScheduleOccurrence(tx, "store", "epoch", reminder.ID, 1, 1, reminder.AnchorAt, clock.Add(11*time.Second))
		return err
	}); err != nil || out.Kind != "reminder" || out.Workflow.Task.ID != "" {
		t.Fatal("local reminder unexpectedly created agent execution authority", err)
	}
}

func TestSecurityScheduleAvailabilityPausesFutureOnlyAndNeverRenewsBudget(t *testing.T) {
	db, now, definition, grant := scheduleAuthorityFixture(t, "workflow")
	var occurrence SecurityScheduleOccurrence
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		occurrence, err = claimSecurityScheduleOccurrence(tx, "store", "epoch", definition.ID, 1, 1, definition.AnchorAt, now.Add(11*time.Second))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	a := SecurityScheduleAction{ActorID: "local-user", ActionID: "pause", ProjectID: "project", ScheduleID: definition.ID, ExpectedConfigRevision: 1, ExpectedAuthorityRevision: 1}
	if err := db.Transaction(func(tx *gorm.DB) error {
		_, err := beginSecurityScheduleAvailability(tx, "store", "epoch", a, false)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateSecurityScheduleTaskSource(db, occurrence.Workflow.Task.ID, "store", "epoch", now.Add(12*time.Second)); err != nil {
		t.Fatal("availability pause revoked admitted workflow", err)
	}
	if err := db.Transaction(func(tx *gorm.DB) error {
		_, err := claimSecurityScheduleOccurrence(tx, "store", "epoch", definition.ID, 1, 1, definition.AnchorAt.Add(time.Minute), now.Add(71*time.Second))
		return err
	}); err == nil {
		t.Fatal("paused availability admitted new occurrence")
	}
	var row securityScheduleGrantRow
	if err := db.First(&row, "id = ?", grant.ID).Error; err != nil || row.Revoked || row.RemainingRuns != 0 || !row.ExpiresAt.Equal(grant.ExpiresAt) {
		t.Fatal("availability change mutated authorization budget or TTL", err)
	}
	var task securityTaskRow
	if err := db.First(&task, "id = ?", occurrence.Workflow.Task.ID).Error; err != nil || task.State != security.TaskActive || !task.ExpiresAt.Equal(occurrence.Workflow.Task.ExpiresAt) {
		t.Fatal("active occurrence lifecycle changed", err)
	}
}

func TestSecurityScheduleConcurrentClaimHasOneBudgetCharge(t *testing.T) {
	db, now, definition, grant := scheduleAuthorityFixture(t, "workflow")
	var workers sync.WaitGroup
	results := make(chan SecurityScheduleOccurrence, 8)
	failures := make(chan error, 8)
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			var result SecurityScheduleOccurrence
			err := db.Transaction(func(tx *gorm.DB) error {
				var err error
				result, err = claimSecurityScheduleOccurrence(tx, "store", "epoch", definition.ID, 1, 1, definition.AnchorAt, now.Add(11*time.Second))
				return err
			})
			if err != nil {
				failures <- err
			} else {
				results <- result
			}
		}()
	}
	workers.Wait()
	close(results)
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	newClaims := 0
	taskID := ""
	for result := range results {
		if !result.Replay {
			newClaims++
		}
		if taskID != "" && taskID != result.Workflow.Task.ID {
			t.Fatal("concurrent claim created multiple tasks")
		}
		taskID = result.Workflow.Task.ID
	}
	var row securityScheduleGrantRow
	if err := db.First(&row, "id = ?", grant.ID).Error; err != nil || row.RemainingRuns != 0 || newClaims != 1 {
		t.Fatal("concurrent claim was not exactly once", err, newClaims)
	}
}

func TestSecurityScheduleMissingOrMismatchedSourceCannotBecomeInteractiveAuthority(t *testing.T) {
	for _, damage := range []string{"missing_source", "missing_occurrence", "wrong_project", "wrong_original_due_source"} {
		t.Run(damage, func(t *testing.T) {
			db, now, definition, _ := scheduleAuthorityFixture(t, "workflow")
			var occurrence SecurityScheduleOccurrence
			if err := db.Transaction(func(tx *gorm.DB) error {
				var err error
				occurrence, err = claimSecurityScheduleOccurrence(tx, "store", "epoch", definition.ID, 1, 1, definition.AnchorAt, now.Add(11*time.Second))
				return err
			}); err != nil {
				t.Fatal(err)
			}
			var err error
			switch damage {
			case "missing_source":
				err = db.Delete(&securityScheduleTaskSourceRow{}, "task_id = ?", occurrence.Workflow.Task.ID).Error
			case "missing_occurrence":
				err = db.Delete(&securityScheduleOccurrenceRow{}, "id = ?", occurrence.ID).Error
			case "wrong_project":
				err = db.Model(&securityScheduleOccurrenceRow{}).Where("id = ?", occurrence.ID).Update("project_id", "other-project").Error
			case "wrong_original_due_source":
				err = db.Model(&securityTaskRow{}).Where("id = ?", occurrence.Workflow.Task.ID).Update("source_event_id", "another-occurrence").Error
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := ValidateSecurityScheduleTaskSource(db, occurrence.Workflow.Task.ID, "store", "epoch", now.Add(12*time.Second)); err == nil {
				t.Fatal("damaged schedule relationship accepted current authority")
			}
		})
	}
}
