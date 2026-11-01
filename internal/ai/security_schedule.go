package ai

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

type SecurityScheduleDefinition struct {
	ID, ProjectID, SessionID, Kind, WorkflowID, TemplateDigest, PayloadDigest string
	WorkflowVersion                                                           int64
	AnchorAt                                                                  time.Time
	IntervalSeconds                                                           int64
	Enabled                                                                   bool
	ConfigRevision, AuthorityRevision                                         int64
}
type SecurityScheduleAction struct {
	ActorID, ActionID, ProjectID, ScheduleID          string
	ExpectedConfigRevision, ExpectedAuthorityRevision int64
}
type securityScheduleConfigurationRow struct {
	ID                                                                string `gorm:"primaryKey"`
	ProjectID, SessionID, StoreID, RecoveryEpoch, State, Digest, Data string
	ConfigRevision, AuthorityRevision                                 int64
	Enabled                                                           bool
}

func (securityScheduleConfigurationRow) TableName() string { return "security_schedule_configurations" }

type securityScheduleGrantRow struct {
	ID                                                                   string `gorm:"primaryKey"`
	ScheduleID, ProjectID, StoreID, RecoveryEpoch, SourceMessageID, Data string `gorm:"index"`
	ConfigRevision, AuthorityRevision, Revision, RemainingRuns           int64
	ExpiresAt                                                            time.Time
	Revoked                                                              bool
}

func (securityScheduleGrantRow) TableName() string { return "security_schedule_grants" }

type securityScheduleOccurrenceRow struct {
	ID                                                                                      string    `gorm:"primaryKey"`
	ScheduleID                                                                              string    `gorm:"uniqueIndex:schedule_occurrence,priority:1"`
	ConfigRevision                                                                          int64     `gorm:"uniqueIndex:schedule_occurrence,priority:2"`
	DueAt                                                                                   time.Time `gorm:"uniqueIndex:schedule_occurrence,priority:3"`
	StoreID, RecoveryEpoch, ProjectID, GrantID, TaskID, RunID, SessionID, Kind, State, Data string
	AuthorityRevision                                                                       int64
}

func (securityScheduleOccurrenceRow) TableName() string { return "security_schedule_occurrences" }

type securityScheduleTaskSourceRow struct {
	TaskID                                                    string `gorm:"primaryKey"`
	ScheduleID, GrantID, OccurrenceID, StoreID, RecoveryEpoch string
	ConfigRevision, AuthorityRevision                         int64
}

func (securityScheduleTaskSourceRow) TableName() string { return "security_schedule_task_sources" }
func securityScheduleModels() []any {
	return []any{&securityScheduleConfigurationRow{}, &securityScheduleGrantRow{}, &securityScheduleOccurrenceRow{}, &securityScheduleTaskSourceRow{}}
}

type SecurityScheduleGrant struct {
	ID, ScheduleID, ProjectID, SourceMessageID                 string
	ConfigRevision, AuthorityRevision, Revision, RemainingRuns int64
	WorkflowDefinitionRevision                                 int64
	Revoked                                                    bool
	ExpiresAt                                                  time.Time
	TaskTTL                                                    time.Duration
	TaskGrant                                                  security.TaskGrant
}
type SecurityScheduleGrantAction struct {
	Action                SecurityScheduleAction
	ExpectedGrantRevision int64
	Grant                 SecurityScheduleGrant
}
type SecurityScheduleOccurrence struct {
	ID, ScheduleID, ProjectID, Kind, GrantID string
	ConfigRevision, AuthorityRevision        int64
	DueAt                                    time.Time
	Workflow                                 SecurityWorkflowRunBinding
	Replay                                   bool
}

func validScheduleAction(a SecurityScheduleAction) bool {
	return a.ActorID != "" && len(a.ActorID) <= 256 && a.ActionID != "" && len(a.ActionID) <= 256 && identifier.MatchString(a.ScheduleID) && a.ProjectID != "" && a.ExpectedConfigRevision >= 0 && a.ExpectedAuthorityRevision >= 0
}
func scheduleDefinitionDigest(d SecurityScheduleDefinition) string {
	d.ConfigRevision, d.AuthorityRevision = 0, 0
	d.Enabled = false // Availability does not change the frozen execution scope.
	return hash(js(d))
}
func validateScheduleDefinition(d SecurityScheduleDefinition) error {
	if !identifier.MatchString(d.ID) || d.ProjectID == "" || !identifier.MatchString(d.SessionID) || d.AnchorAt.IsZero() || d.IntervalSeconds != 0 && (d.IntervalSeconds < 60 || d.IntervalSeconds > 31536000) || d.Kind != "reminder" && d.Kind != "workflow" {
		return errSecurityAction
	}
	if d.Kind == "workflow" && d.Enabled && (!identifier.MatchString(d.WorkflowID) || d.WorkflowVersion < 1 || len(d.TemplateDigest) != 64) {
		return errSecurityAction
	}
	return nil
}

func beginSecurityScheduleConfiguration(tx *gorm.DB, storeID, epoch string, a SecurityScheduleAction, d SecurityScheduleDefinition, now time.Time) (SecurityScheduleDefinition, error) {
	if !validScheduleAction(a) || a.ScheduleID != d.ID || a.ProjectID != d.ProjectID || validateScheduleDefinition(d) != nil || now.IsZero() {
		return d, errSecurityAction
	}
	request := js(struct {
		Action     SecurityScheduleAction
		Definition SecurityScheduleDefinition
	}{a, d})
	var replay SecurityScheduleDefinition
	if repeated, err := securityActionReplay(tx, storeID, epoch, a.ActorID, a.ActionID, request, &replay); repeated || err != nil {
		return replay, err
	}
	var old securityScheduleConfigurationRow
	err := tx.First(&old, "id = ?", d.ID).Error
	create := errors.Is(err, gorm.ErrRecordNotFound)
	if err != nil && !create {
		return d, err
	}
	if !create && (old.ProjectID != d.ProjectID || old.SessionID != d.SessionID) {
		return d, security.ErrConflict
	}
	if create && (a.ExpectedConfigRevision != 0 || a.ExpectedAuthorityRevision != 0) || !create && ((old.StoreID != storeID || old.RecoveryEpoch != epoch) && a.ActorID != "local-user" || old.ConfigRevision != a.ExpectedConfigRevision || old.AuthorityRevision != a.ExpectedAuthorityRevision || old.State == "changing") {
		return d, security.ErrConflict
	}
	seedConfig, seedAuthority := d.ConfigRevision, d.AuthorityRevision
	d.ConfigRevision, d.AuthorityRevision = a.ExpectedConfigRevision+1, a.ExpectedAuthorityRevision+1
	if create {
		d.ConfigRevision = max(d.ConfigRevision, seedConfig)
		d.AuthorityRevision = max(d.AuthorityRevision, seedAuthority)
	}
	row := securityScheduleConfigurationRow{ID: d.ID, ProjectID: d.ProjectID, SessionID: d.SessionID, StoreID: storeID, RecoveryEpoch: epoch, State: "changing", Digest: scheduleDefinitionDigest(d), Data: js(d), ConfigRevision: d.ConfigRevision, AuthorityRevision: d.AuthorityRevision, Enabled: d.Enabled}
	if err = tx.Save(&row).Error; err != nil {
		return d, err
	}
	if err = tx.Model(&securityScheduleGrantRow{}).Where("schedule_id = ? AND revoked = ?", d.ID, false).Updates(map[string]any{"revoked": true, "revision": gorm.Expr("revision + 1")}).Error; err != nil {
		return d, err
	}
	if err = pauseScheduleDerivedTasks(tx, storeID, epoch, a, "", now); err != nil {
		return d, err
	}
	return d, securityActionRecord(tx, storeID, epoch, a.ActorID, a.ActionID, "schedule.configure", d.ID, request, a.ExpectedConfigRevision, d.ConfigRevision, d, now)
}
func readySecurityScheduleConfiguration(tx *gorm.DB, storeID, epoch string, d SecurityScheduleDefinition) error {
	changed := tx.Model(&securityScheduleConfigurationRow{}).Where("id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ? AND config_revision = ? AND authority_revision = ? AND digest = ? AND state = ?", d.ID, d.ProjectID, storeID, epoch, d.ConfigRevision, d.AuthorityRevision, scheduleDefinitionDigest(d), "changing").Update("state", "ready")
	if changed.Error != nil {
		return changed.Error
	}
	if changed.RowsAffected != 1 {
		return security.ErrConflict
	}
	return nil
}

// ChangeSecuritySchedule keeps a short Home barrier across changing -> atomic
// JSON replacement -> ready. The callback performs local persistence only.
func (e *Engine) ChangeSecuritySchedule(ctx context.Context, a SecurityScheduleAction, d SecurityScheduleDefinition, persist func(SecurityScheduleDefinition) error) (out SecurityScheduleDefinition, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	if persist == nil {
		return out, errSecurityAction
	}
	err = e.withSecurityDispatchBarrier(func() error {
		if err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			if d.Kind == "workflow" {
				if err := raiseSecurityPolicyReaderGuard(tx, storeID, epoch); err != nil {
					return err
				}
			}
			var err error
			out, err = beginSecurityScheduleConfiguration(tx, storeID, epoch, a, d, time.Now().UTC())
			return err
		}); err != nil {
			return err
		}
		if err := persist(out); err != nil {
			return err
		}
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error { return readySecurityScheduleConfiguration(tx, storeID, epoch, out) })
	})
	return out, err
}

func issueSecurityScheduleGrant(tx *gorm.DB, storeID, epoch string, in SecurityScheduleGrantAction, now time.Time) (SecurityScheduleGrant, error) {
	a, g := in.Action, in.Grant
	if !validScheduleAction(a) || a.ActorID != "local-user" || in.ExpectedGrantRevision != 0 || g.ID != "" || g.ScheduleID != a.ScheduleID || g.ProjectID != a.ProjectID || g.RemainingRuns < 1 || g.RemainingRuns > 10000 || !g.ExpiresAt.After(now) || g.TaskTTL <= 0 || g.TaskTTL > 4*time.Hour || g.TaskGrant.RemainingUses < 1 || g.TaskGrant.RemainingUses > 10000 || len(g.TaskGrant.Resources) == 0 || len(g.TaskGrant.Capabilities) == 0 || g.TaskGrant.ID != "" || g.TaskGrant.TaskID != "" || g.TaskGrant.ParentAuthorityID != "" {
		return g, errSecurityAction
	}
	request := js(in)
	var replay SecurityScheduleGrant
	if repeated, err := securityActionReplay(tx, storeID, epoch, a.ActorID, a.ActionID, request, &replay); repeated || err != nil {
		return replay, err
	}
	var config securityScheduleConfigurationRow
	if err := tx.First(&config, "id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ? AND state = ?", a.ScheduleID, a.ProjectID, storeID, epoch, "ready").Error; err != nil {
		return g, err
	}
	if config.ConfigRevision != a.ExpectedConfigRevision || config.AuthorityRevision != a.ExpectedAuthorityRevision || !config.Enabled {
		return g, security.ErrConflict
	}
	var definition SecurityScheduleDefinition
	if err := decodeSecurityJSON(config.Data, &definition); err != nil {
		return g, err
	}
	if definition.Kind != "workflow" {
		return g, errSecurityAction
	}
	var active int64
	if err := tx.Model(&securityScheduleGrantRow{}).Where("schedule_id = ? AND config_revision = ? AND authority_revision = ? AND store_id = ? AND recovery_epoch = ? AND revoked = ? AND remaining_runs > ? AND expires_at > ?", a.ScheduleID, config.ConfigRevision, config.AuthorityRevision, storeID, epoch, false, 0, now).Count(&active).Error; err != nil {
		return g, err
	}
	if active != 0 {
		return g, errors.New("security: revoke the existing unused schedule grant before replacing its scope or budget")
	}
	workflowDefinition, err := LoadSecurityWorkflowDefinitionTx(tx, storeID, epoch, definition.ProjectID, definition.WorkflowID, definition.WorkflowVersion, definition.TemplateDigest)
	if err != nil {
		return g, err
	}
	g.WorkflowDefinitionRevision = workflowDefinition.Revision
	proof := security.ProofStructured
	if len(g.TaskGrant.CommandProfiles) > 0 {
		proof = security.ProofCommandProfile
	}
	for _, capability := range g.TaskGrant.Capabilities {
		if !security.TaskGrantable(capability, proof) {
			return g, errSecurityAction
		}
		switch capability {
		case "resource.list", "resource.resolve", "file.read", "db.read", "cluster.read", "cluster.logs", "memory.read", "artifact.read", "network.fetch", "mcp.discover":
		case "command.diagnostics", "local.execute", "terminal.execute", "terminal.open":
			if len(g.TaskGrant.CommandProfiles) == 0 {
				return g, errors.New("security: scheduled commands require fixed read-only profiles")
			}
		default:
			return g, errors.New("security: v1 schedule grants permit read-only workflow effects only")
		}
	}
	for _, profile := range g.TaskGrant.CommandProfiles {
		if !security.ValidateCommandProfileScope(profile) {
			return g, errSecurityAction
		}
		switch profile.ID {
		case "disk_usage", "process_snapshot", "service_status", "service_logs":
		default:
			return g, errors.New("security: mutating command profiles cannot be scheduled in v1")
		}
	}
	policy, err := loadSecurityPolicy(tx, g.ProjectID, storeID, epoch)
	if err != nil {
		return g, err
	}
	for _, resource := range g.TaskGrant.Resources {
		if !slices.Contains(policy.ResourceIDs, resource.ID) || policy.DenyLocal && resource.Local {
			return g, errSecurityAction
		}
		var current securityResourceRevisionRow
		if err = tx.First(&current, "project_id = ? AND resource_id = ? AND store_id = ? AND recovery_epoch = ?", g.ProjectID, resource.ID, storeID, epoch).Error; err != nil {
			return g, err
		}
		if current.State != "ready" || resource.State != "ready" || current.ConnectionRevision != resource.ConnectionRevision || current.ConnectionDigest != resource.ConnectionDigest || current.Local != resource.Local || current.ConnectionIdentity != resource.ConnectionIdentity {
			return g, security.ErrConflict
		}
		for _, capability := range g.TaskGrant.Capabilities {
			rule, matched := security.ResolveCapabilityRule(policy.Rules, capability, resource.ID)
			if !matched || !(rule.Effect == security.EffectAllow || rule.Effect == security.EffectAsk && rule.Grantable && (rule.Confirmation == security.ConfirmTask || rule.Confirmation == security.ConfirmEither)) || !security.GrantLimitsFitRule(g.TaskGrant.Limits, rule, capability) {
				return g, errSecurityAction
			}
		}
	}
	// Freeze the service/OS registry now, at the original human schedule grant.
	// Occurrence task-grant issuance will reject a later target remapping.
	if err = freezeSecurityGrantCommandTargets(tx, storeID, epoch, g.ProjectID, &g.TaskGrant, false); err != nil {
		return g, err
	}
	g.ID, g.ConfigRevision, g.AuthorityRevision, g.Revision = uid(), config.ConfigRevision, config.AuthorityRevision, 1
	g.Revoked = false
	row := securityScheduleGrantRow{ID: g.ID, ScheduleID: g.ScheduleID, ProjectID: g.ProjectID, StoreID: storeID, RecoveryEpoch: epoch, SourceMessageID: g.SourceMessageID, Data: js(g), ConfigRevision: g.ConfigRevision, AuthorityRevision: g.AuthorityRevision, Revision: 1, RemainingRuns: g.RemainingRuns, ExpiresAt: g.ExpiresAt}
	if err := tx.Create(&row).Error; err != nil {
		return g, err
	}
	return g, securityActionRecord(tx, storeID, epoch, a.ActorID, a.ActionID, "schedule.grant", g.ID, request, 0, 1, g, now)
}

func pauseScheduleDerivedTasks(tx *gorm.DB, storeID, epoch string, a SecurityScheduleAction, grantID string, now time.Time) error {
	query := tx.Table("security_tasks AS task").Select("task.*").Joins("JOIN security_schedule_task_sources AS source ON source.task_id=task.id").Where("source.schedule_id = ? AND source.store_id = ? AND source.recovery_epoch = ? AND task.state NOT IN ?", a.ScheduleID, storeID, epoch, []string{"paused", "completed", "cancelled", "expired"})
	if grantID != "" {
		query = query.Where("source.grant_id = ?", grantID)
	}
	var tasks []securityTaskRow
	if err := query.Find(&tasks).Error; err != nil {
		return err
	}
	for _, task := range tasks {
		state := security.TaskPaused
		if !now.Before(task.ExpiresAt) {
			state = security.TaskExpired
		}
		_, err := transitionSecurityTask(tx, storeID, epoch, SecurityTaskAction{ActorID: a.ActorID, ActionID: hash(a.ActionID + "\x00" + task.ID), ProjectID: task.ProjectID, SessionID: task.SessionID, GoalID: task.GoalID, TaskID: task.ID, ExpectedRevision: task.StateRevision, Reason: "schedule authorization changed"}, state, now)
		if err != nil {
			return err
		}
	}
	return nil
}

func (e *Engine) RevokeSecurityScheduleGrant(ctx context.Context, a SecurityScheduleAction, grantID string, expectedGrantRevision int64) error {
	if !validScheduleAction(a) || a.ActorID != "local-user" || grantID == "" || expectedGrantRevision < 1 || a.ExpectedConfigRevision < 1 || a.ExpectedAuthorityRevision < 1 {
		return errSecurityAction
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			request := js(struct {
				Action   SecurityScheduleAction
				ID       string
				Revision int64
			}{a, grantID, expectedGrantRevision})
			var replay bool
			if repeated, err := securityActionReplay(tx, storeID, epoch, a.ActorID, a.ActionID, request, &replay); repeated || err != nil {
				return err
			}
			var configuration securityScheduleConfigurationRow
			if err := tx.First(&configuration, "id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ? AND config_revision = ? AND authority_revision = ?", a.ScheduleID, a.ProjectID, storeID, epoch, a.ExpectedConfigRevision, a.ExpectedAuthorityRevision).Error; err != nil {
				return err
			}
			changed := tx.Model(&securityScheduleGrantRow{}).Where("id = ? AND schedule_id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ? AND config_revision = ? AND authority_revision = ? AND revision = ?", grantID, a.ScheduleID, a.ProjectID, storeID, epoch, a.ExpectedConfigRevision, a.ExpectedAuthorityRevision, expectedGrantRevision).Updates(map[string]any{"revoked": true, "revision": expectedGrantRevision + 1})
			if changed.Error != nil {
				return changed.Error
			}
			if changed.RowsAffected != 1 {
				return security.ErrConflict
			}
			if err := pauseScheduleDerivedTasks(tx, storeID, epoch, a, grantID, time.Now().UTC()); err != nil {
				return err
			}
			return securityActionRecord(tx, storeID, epoch, a.ActorID, a.ActionID, "schedule.grant.revoke", grantID, request, expectedGrantRevision, expectedGrantRevision+1, true, time.Now().UTC())
		})
	})
}

func (e *Engine) SecurityScheduleGrants(ctx context.Context, projectID, scheduleID string) ([]SecurityScheduleGrant, error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return nil, err
	}
	var rows []securityScheduleGrantRow
	if err = db.WithContext(ctx).Where("schedule_id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ?", scheduleID, projectID, storeID, epoch).Order("id").Limit(1000).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]SecurityScheduleGrant, 0, len(rows))
	for _, row := range rows {
		var grant SecurityScheduleGrant
		if err = decodeSecurityJSON(row.Data, &grant); err != nil {
			return nil, err
		}
		grant.RemainingRuns, grant.Revision = row.RemainingRuns, row.Revision
		grant.Revoked, grant.ExpiresAt = row.Revoked, row.ExpiresAt
		out = append(out, grant)
	}
	return out, nil
}

func validOriginalScheduleDueAt(d SecurityScheduleDefinition, dueAt time.Time) bool {
	if dueAt.Before(d.AnchorAt) {
		return false
	}
	delta := dueAt.Sub(d.AnchorAt)
	if d.IntervalSeconds == 0 {
		return delta == 0
	}
	return delta%(time.Duration(d.IntervalSeconds)*time.Second) == 0
}

func SecurityScheduleOccurrenceID(scheduleID string, configRevision int64, dueAt time.Time) string {
	return hash(scheduleID + "\x00" + fmt.Sprint(configRevision) + "\x00" + dueAt.UTC().Format(time.RFC3339Nano))
}

func claimSecurityScheduleOccurrence(tx *gorm.DB, storeID, epoch, scheduleID string, configRevision, authorityRevision int64, dueAt, now time.Time) (SecurityScheduleOccurrence, error) {
	out := SecurityScheduleOccurrence{ID: SecurityScheduleOccurrenceID(scheduleID, configRevision, dueAt), ScheduleID: scheduleID, ConfigRevision: configRevision, AuthorityRevision: authorityRevision, DueAt: dueAt.UTC()}
	var prior securityScheduleOccurrenceRow
	if err := tx.First(&prior, "id = ?", out.ID).Error; err == nil {
		if prior.StoreID != storeID || prior.RecoveryEpoch != epoch || prior.ConfigRevision != configRevision || prior.AuthorityRevision != authorityRevision {
			return out, security.ErrConflict
		}
		if err = decodeSecurityJSON(prior.Data, &out); err != nil {
			return out, err
		}
		out.Replay = true
		return out, nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return out, err
	}
	var config securityScheduleConfigurationRow
	if err := tx.First(&config, "id = ? AND store_id = ? AND recovery_epoch = ? AND state = ? AND enabled = ? AND config_revision = ? AND authority_revision = ?", scheduleID, storeID, epoch, "ready", true, configRevision, authorityRevision).Error; err != nil {
		return out, err
	}
	var definition SecurityScheduleDefinition
	if err := decodeSecurityJSON(config.Data, &definition); err != nil {
		return out, err
	}
	if !validOriginalScheduleDueAt(definition, dueAt) || dueAt.After(now) || definition.Kind == "workflow" && now.Sub(dueAt) > time.Minute {
		return out, errors.New("security: invalid or missed original schedule occurrence")
	}
	out.ProjectID, out.Kind = config.ProjectID, definition.Kind
	if definition.Kind == "workflow" {
		var grants []securityScheduleGrantRow
		if err := tx.Where("schedule_id = ? AND config_revision = ? AND authority_revision = ? AND store_id = ? AND recovery_epoch = ? AND revoked = ? AND remaining_runs > ? AND expires_at > ?", scheduleID, configRevision, authorityRevision, storeID, epoch, false, 0, now).Order("id").Limit(2).Find(&grants).Error; err != nil {
			return out, err
		}
		if len(grants) != 1 {
			return out, errors.New("security: exactly one current explicit schedule grant is required")
		}
		grantRow := grants[0]
		var grant SecurityScheduleGrant
		if err := decodeSecurityJSON(grantRow.Data, &grant); err != nil {
			return out, err
		}
		if grant.ID != grantRow.ID || grant.ConfigRevision != configRevision || grant.AuthorityRevision != authorityRevision {
			return out, security.ErrConflict
		}
		workflowDefinition, err := LoadSecurityWorkflowDefinitionTx(tx, storeID, epoch, definition.ProjectID, definition.WorkflowID, definition.WorkflowVersion, definition.TemplateDigest)
		if err != nil || workflowDefinition.Revision != grant.WorkflowDefinitionRevision {
			return out, errors.New("security: workflow acceptance definition changed; schedule grant requires reconfirmation")
		}
		deadline := now.Add(grant.TaskTTL)
		if grantRow.ExpiresAt.Before(deadline) {
			deadline = grantRow.ExpiresAt
		}
		binding, err := CreateSecurityWorkflowRunTx(tx, storeID, epoch, SecurityWorkflowRunInput{RunID: hash("schedule-run\x00" + out.ID), WorkflowID: definition.WorkflowID, ProjectID: definition.ProjectID, SessionID: hash("schedule-session\x00" + out.ID), TemplateDigest: definition.TemplateDigest, TemplateVersion: definition.WorkflowVersion, ActorID: "schedule", ActionID: out.ID, SourceMessageID: grant.SourceMessageID, SourceKind: "schedule_occurrence", SourceEventID: out.ID, ExpiresAt: deadline}, now)
		if err != nil {
			return out, err
		}
		resources := sortedRecoveryResources(grant.TaskGrant.Resources)
		if !slices.Equal(resources, sortedStrings(binding.ResourceIDs)) {
			return out, errors.New("security: schedule grant does not cover the exact frozen workflow resources")
		}
		taskGrant := grant.TaskGrant
		taskGrant.AllowedChildScopes = nil
		for _, scopeID := range binding.ChildScopeIDs {
			taskGrant.AllowedChildScopes = append(taskGrant.AllowedChildScopes, scopeID)
		}
		slices.Sort(taskGrant.AllowedChildScopes)
		taskGrant.ExpiresAt = deadline
		taskGrant.ID = ""
		taskGrant.TaskID = ""
		taskGrant.GoalID = ""
		taskGrant.SessionID = ""
		taskGrant.ProjectID = ""
		taskGrant.StoreID = ""
		taskGrant.RecoveryEpoch = ""
		if _, err = issueSecurityTaskGrant(tx, storeID, epoch, SecurityTaskGrantAction{Action: SecurityTaskAction{ActorID: "schedule", ActionID: "grant-" + out.ID, ProjectID: binding.ProjectID, SessionID: binding.SessionID, GoalID: binding.GoalID, TaskID: binding.Task.ID, ExpectedRevision: binding.Task.StateRevision}, Grant: taskGrant}, now); err != nil {
			return out, err
		}
		changed := tx.Model(&securityScheduleGrantRow{}).Where("id = ? AND revision = ? AND revoked = ? AND remaining_runs > ? AND expires_at > ?", grantRow.ID, grantRow.Revision, false, 0, now).Update("remaining_runs", gorm.Expr("remaining_runs - 1"))
		if changed.Error != nil {
			return out, changed.Error
		}
		if changed.RowsAffected != 1 {
			return out, security.ErrConflict
		}
		out.GrantID, out.Workflow = grantRow.ID, binding
		source := securityScheduleTaskSourceRow{TaskID: binding.Task.ID, ScheduleID: scheduleID, GrantID: grantRow.ID, OccurrenceID: out.ID, StoreID: storeID, RecoveryEpoch: epoch, ConfigRevision: configRevision, AuthorityRevision: authorityRevision}
		if err = tx.Create(&source).Error; err != nil {
			return out, err
		}
	}
	row := securityScheduleOccurrenceRow{ID: out.ID, ScheduleID: scheduleID, ConfigRevision: configRevision, AuthorityRevision: authorityRevision, DueAt: out.DueAt, StoreID: storeID, RecoveryEpoch: epoch, ProjectID: out.ProjectID, Kind: out.Kind, GrantID: out.GrantID, TaskID: out.Workflow.Task.ID, RunID: out.Workflow.RunID, SessionID: out.Workflow.SessionID, State: "claimed", Data: js(out)}
	return out, tx.Create(&row).Error
}
func sortedStrings(in []string) []string {
	out := append([]string(nil), in...)
	slices.Sort(out)
	return out
}

// ValidateSecurityScheduleTaskSource runs at final dispatch, including project
// allow operations: a revoked/changed schedule cannot keep its derived task alive.
func ValidateSecurityScheduleTaskSource(tx *gorm.DB, taskID, storeID, epoch string, now time.Time) error {
	var source securityScheduleTaskSourceRow
	err := tx.First(&source, "task_id = ?", taskID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		var task securityTaskRow
		if taskErr := tx.First(&task, "id = ?", taskID).Error; taskErr == nil && (task.Kind == "schedule" || task.SourceKind == "schedule_occurrence") {
			return errors.New("security: scheduled task is missing its original occurrence authority")
		} else if taskErr != nil && !errors.Is(taskErr, gorm.ErrRecordNotFound) {
			return taskErr
		}
		return nil
	}
	if err != nil {
		return err
	}
	if source.StoreID != storeID || source.RecoveryEpoch != epoch {
		return security.ErrConflict
	}
	var task securityTaskRow
	if err = tx.First(&task, "id = ? AND store_id = ? AND recovery_epoch = ?", taskID, storeID, epoch).Error; err != nil {
		return err
	}
	if task.Kind != "schedule" || task.SourceKind != "schedule_occurrence" || task.SourceEventID != source.OccurrenceID {
		return security.ErrConflict
	}
	var occurrence securityScheduleOccurrenceRow
	if err = tx.First(&occurrence, "id = ? AND task_id = ? AND schedule_id = ? AND grant_id = ? AND store_id = ? AND recovery_epoch = ? AND config_revision = ? AND authority_revision = ? AND state IN ?", source.OccurrenceID, taskID, source.ScheduleID, source.GrantID, storeID, epoch, source.ConfigRevision, source.AuthorityRevision, []string{"claimed", "materialized"}).Error; err != nil {
		return err
	}
	if occurrence.ProjectID != task.ProjectID || occurrence.SessionID != task.SessionID {
		return security.ErrConflict
	}
	var config securityScheduleConfigurationRow
	if err = tx.First(&config, "id = ? AND store_id = ? AND recovery_epoch = ? AND config_revision = ? AND authority_revision = ? AND state IN ?", source.ScheduleID, storeID, epoch, source.ConfigRevision, source.AuthorityRevision, []string{"ready", "availability_changing"}).Error; err != nil {
		return err
	}
	if config.ProjectID != task.ProjectID {
		return security.ErrConflict
	}
	var grant securityScheduleGrantRow
	return tx.First(&grant, "id = ? AND schedule_id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ? AND config_revision = ? AND authority_revision = ? AND revoked = ? AND expires_at > ?", source.GrantID, source.ScheduleID, task.ProjectID, storeID, epoch, source.ConfigRevision, source.AuthorityRevision, false, now).Error
}

func (e *Engine) SetSecurityScheduleAvailability(ctx context.Context, a SecurityScheduleAction, enabled bool, persist func() error) error {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	if !validScheduleAction(a) || a.ActorID != "local-user" || persist == nil {
		return errSecurityAction
	}
	return e.withSecurityDispatchBarrier(func() error {
		var definition SecurityScheduleDefinition
		err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var err error
			definition, err = beginSecurityScheduleAvailability(tx, storeID, epoch, a, enabled)
			return err
		})
		if err != nil {
			return err
		}
		if err = persist(); err != nil {
			return err
		}
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			updated := tx.Model(&securityScheduleConfigurationRow{}).Where("id = ? AND store_id = ? AND recovery_epoch = ? AND config_revision = ? AND authority_revision = ? AND state = ?", a.ScheduleID, storeID, epoch, a.ExpectedConfigRevision, a.ExpectedAuthorityRevision, "availability_changing").Update("state", "ready")
			if updated.Error != nil {
				return updated.Error
			}
			if updated.RowsAffected != 1 {
				return security.ErrConflict
			}
			return securityActionRecord(tx, storeID, epoch, a.ActorID, a.ActionID, "schedule.availability", a.ScheduleID, js(struct {
				Action  SecurityScheduleAction
				Enabled bool
			}{a, enabled}), a.ExpectedConfigRevision, a.ExpectedConfigRevision, definition, time.Now().UTC())
		})
	})
}

func beginSecurityScheduleAvailability(tx *gorm.DB, storeID, epoch string, a SecurityScheduleAction, enabled bool) (definition SecurityScheduleDefinition, err error) {
	if !validScheduleAction(a) || a.ActorID != "local-user" {
		return definition, errSecurityAction
	}
	var row securityScheduleConfigurationRow
	if err = tx.First(&row, "id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ? AND config_revision = ? AND authority_revision = ? AND state IN ?", a.ScheduleID, a.ProjectID, storeID, epoch, a.ExpectedConfigRevision, a.ExpectedAuthorityRevision, []string{"ready", "availability_changing"}).Error; err != nil {
		return definition, err
	}
	if err = decodeSecurityJSON(row.Data, &definition); err != nil {
		return definition, err
	}
	definition.Enabled = enabled
	err = tx.Model(&securityScheduleConfigurationRow{}).Where("id = ?", row.ID).Updates(map[string]any{"state": "availability_changing", "enabled": enabled, "data": js(definition)}).Error
	return definition, err
}

func (e *Engine) IssueSecurityScheduleGrant(ctx context.Context, in SecurityScheduleGrantAction) (out SecurityScheduleGrant, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			if err := raiseSecurityPolicyReaderGuard(tx, storeID, epoch); err != nil {
				return err
			}
			out, err = issueSecurityScheduleGrant(tx, storeID, epoch, in, time.Now().UTC())
			return err
		})
	})
	return out, err
}
func (e *Engine) ClaimSecurityScheduleOccurrence(ctx context.Context, scheduleID string, configRevision, authorityRevision int64, dueAt time.Time) (out SecurityScheduleOccurrence, err error) {
	return e.ClaimSecurityScheduleOccurrenceAt(ctx, scheduleID, configRevision, authorityRevision, dueAt, time.Now().UTC())
}

func (e *Engine) ClaimSecurityScheduleOccurrenceAt(ctx context.Context, scheduleID string, configRevision, authorityRevision int64, dueAt, now time.Time) (out SecurityScheduleOccurrence, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			out, err = claimSecurityScheduleOccurrence(tx, storeID, epoch, scheduleID, configRevision, authorityRevision, dueAt, now)
			return err
		})
	})
	return out, err
}

func (e *Engine) SecurityScheduleToolAction(ctx context.Context, projectID, sessionID, scheduleID string, configRevision, authorityRevision int64) (SecurityScheduleAction, error) {
	a := SecurityScheduleAction{ActorID: "legacy_tool", ActionID: uid(), ProjectID: projectID, ScheduleID: scheduleID, ExpectedConfigRevision: configRevision, ExpectedAuthorityRevision: authorityRevision}
	configured, err := e.securityPolicyConfigured(projectID)
	if err != nil {
		return a, err
	}
	if !configured {
		return a, nil
	}
	p, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	if p == nil || p.operation.ProjectID != projectID || p.operation.SessionID != sessionID {
		return a, errors.New("security: schedule mutation requires original registered permit")
	}
	if err = e.ValidateSecurityPermitAtIO(ctx, projectID, sessionID); err != nil {
		return a, err
	}
	a.ActorID, a.ActionID = "agent", p.operation.ID
	return a, nil
}

func (e *Engine) SecurityScheduleDefinition(ctx context.Context, projectID, scheduleID string) (SecurityScheduleDefinition, string, error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return SecurityScheduleDefinition{}, "", err
	}
	var row securityScheduleConfigurationRow
	if err = db.WithContext(ctx).First(&row, "id = ? AND project_id = ?", scheduleID, projectID).Error; err != nil {
		return SecurityScheduleDefinition{}, "", err
	}
	var definition SecurityScheduleDefinition
	err = decodeSecurityJSON(row.Data, &definition)
	if row.StoreID != storeID || row.RecoveryEpoch != epoch {
		return definition, "requires_reauthorization", err
	}
	return definition, row.State, err
}

func (e *Engine) ValidateSecurityScheduleSnapshot(ctx context.Context, d SecurityScheduleDefinition) error {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	var row securityScheduleConfigurationRow
	return db.WithContext(ctx).First(&row, "id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ? AND config_revision = ? AND authority_revision = ? AND digest = ? AND state = ?", d.ID, d.ProjectID, storeID, epoch, d.ConfigRevision, d.AuthorityRevision, scheduleDefinitionDigest(d), "ready").Error
}

func (e *Engine) PendingSecurityScheduleOccurrences(ctx context.Context) ([]SecurityScheduleOccurrence, error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return nil, err
	}
	var rows []securityScheduleOccurrenceRow
	if err = db.WithContext(ctx).Where("store_id = ? AND recovery_epoch = ? AND state = ? AND kind = ?", storeID, epoch, "claimed", "workflow").Order("due_at,id").Limit(500).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]SecurityScheduleOccurrence, 0, len(rows))
	for _, row := range rows {
		var item SecurityScheduleOccurrence
		if err = decodeSecurityJSON(row.Data, &item); err != nil {
			return nil, err
		}
		item.Replay = true
		out = append(out, item)
	}
	return out, nil
}

func (e *Engine) MarkSecurityScheduleOccurrenceMaterialized(ctx context.Context, id, runID string) error {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var row securityScheduleOccurrenceRow
			if err := tx.First(&row, "id = ? AND store_id = ? AND recovery_epoch = ?", id, storeID, epoch).Error; err != nil {
				return err
			}
			if row.RunID != runID {
				return security.ErrConflict
			}
			if row.State == "materialized" {
				return nil
			}
			if row.State != "claimed" {
				return security.ErrConflict
			}
			return tx.Model(&securityScheduleOccurrenceRow{}).Where("id = ? AND state = ?", id, "claimed").Update("state", "materialized").Error
		})
	})
}
