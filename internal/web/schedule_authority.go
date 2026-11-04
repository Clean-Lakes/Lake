package web

import (
	"context"
	"errors"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func normalizeScheduleRevisions(row *toolSchedule) {
	if row.ConfigRevision < 1 {
		row.ConfigRevision = int64(max(1, row.Revision))
	}
	if row.AuthorityRevision < 1 {
		row.AuthorityRevision = 1
	}
	if row.StatusRevision < 1 {
		row.StatusRevision = 1
	}
	if row.AnchorAt == "" {
		row.AnchorAt = row.At
	}
	row.Revision = max(row.Revision, int(row.ConfigRevision))
}
func scheduleStatusChanged(row *toolSchedule) { row.StatusRevision++ }

func (b *Server) scheduleDefinition(row toolSchedule) (ai.SecurityScheduleDefinition, error) {
	anchor, err := time.Parse(time.RFC3339, row.AnchorAt)
	if err != nil {
		return ai.SecurityScheduleDefinition{}, err
	}
	d := ai.SecurityScheduleDefinition{ID: row.ID, ProjectID: row.Project, SessionID: row.Session, Kind: row.Kind, AnchorAt: anchor, IntervalSeconds: int64(row.Interval), Enabled: row.Enabled, ConfigRevision: row.ConfigRevision, AuthorityRevision: row.AuthorityRevision, PayloadDigest: security.ContentDigest([]byte(jsonText(Object{"message": row.Message, "options": row.Options})))}
	if row.Kind == "workflow" {
		// Disabling a missing/changed template is always a narrowing action.
		// This disabled record cannot be granted or claimed; enabling still
		// requires the actual current template and its confirmed contract.
		if !row.Enabled {
			d.WorkflowID = row.WorkflowID
			d.WorkflowVersion = int64(row.Version)
			return d, nil
		}
		template := b.Store.Workflow(row.Project, row.WorkflowID)
		if template.Version != row.Version {
			return d, errors.New("workflow version conflict")
		}
		d.WorkflowID = row.WorkflowID
		d.WorkflowVersion = int64(row.Version)
		d.TemplateDigest = workflowSecurityDigest(template)
	}
	return d, nil
}

func recordScheduleClaimFailure(row *toolSchedule, current time.Time, cause error) {
	row.Status = "failed"
	row.Error = cause.Error()
	at, err := time.Parse(time.RFC3339, row.At)
	if err == nil {
		appendScheduleExecution(row, scheduleExecution{ID: ai.SecurityScheduleOccurrenceID(row.ID, row.ConfigRevision, at), ScheduledAt: row.At, FinishedAt: current.Format(time.RFC3339), Status: "failed", Error: row.Error, SessionID: row.Session})
	}
	scheduleStatusChanged(row)
	advanceSchedule(row, current)
}

func (b *Server) deliverScheduleReminder(row toolSchedule) {
	text := "提醒「" + row.Name + "」：" + row.Message
	if row.OccurrenceID == "" {
		b.Store.AddMessage(row.Session, "system", text, nil)
		return
	}
	messageID := security.ContentDigest([]byte("schedule-reminder\x00" + row.OccurrenceID))
	b.Store.update(func() any {
		b.Store.session(row.Session)
		if b.Store.row("SELECT id FROM messages WHERE id=? AND sessionId=?", messageID, row.Session) != nil {
			return nil
		}
		b.Store.exec("INSERT INTO messages(id,sessionId,role,text,images,createdAt) VALUES(?,?,'system',?,'[]',?)", messageID, row.Session, text, now())
		b.Store.event(row.Session, "message")
		return nil
	})
}

func (b *Server) persistScheduleConfiguration(ctx context.Context, row *toolSchedule, actor string, persist func() error) error {
	if b.Engine == nil {
		return errors.New("security: schedule coordinator unavailable")
	}
	normalizeScheduleRevisions(row)
	definition, err := b.scheduleDefinition(*row)
	if err != nil {
		return err
	}
	prior, _, err := b.Engine.SecurityScheduleDefinition(ctx, row.Project, row.ID)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		definition.ConfigRevision = max(definition.ConfigRevision, int64(row.Revision))
	}
	a := ai.SecurityScheduleAction{ActorID: "local-user", ActionID: ident(), ProjectID: row.Project, ScheduleID: row.ID, ExpectedConfigRevision: prior.ConfigRevision, ExpectedAuthorityRevision: prior.AuthorityRevision}
	if actor != "local-user" {
		a, err = b.Engine.SecurityScheduleToolAction(ctx, row.Project, row.Session, row.ID, prior.ConfigRevision, prior.AuthorityRevision)
		if err != nil {
			return err
		}
	}
	_, err = b.Engine.ChangeSecuritySchedule(ctx, a, definition, func(saved ai.SecurityScheduleDefinition) error {
		row.ConfigRevision, row.AuthorityRevision = saved.ConfigRevision, saved.AuthorityRevision
		row.Revision = max(row.Revision, int(saved.ConfigRevision))
		return persist()
	})
	return err
}

func (b *Server) persistScheduleAvailability(ctx context.Context, row *toolSchedule, anchorChanged bool, persist func() error) error {
	prior, state, err := b.Engine.SecurityScheduleDefinition(ctx, row.Project, row.ID)
	if errors.Is(err, gorm.ErrRecordNotFound) || state == "requires_reauthorization" || anchorChanged {
		return b.persistScheduleConfiguration(ctx, row, "local-user", persist)
	}
	if err != nil {
		return err
	}
	a := ai.SecurityScheduleAction{ActorID: "local-user", ActionID: ident(), ProjectID: row.Project, ScheduleID: row.ID, ExpectedConfigRevision: prior.ConfigRevision, ExpectedAuthorityRevision: prior.AuthorityRevision}
	return b.Engine.SetSecurityScheduleAvailability(ctx, a, row.Enabled, persist)
}

func (b *Server) ensureReminderScheduleConfiguration(row *toolSchedule) error {
	if b.Engine == nil {
		return errors.New("security: schedule coordinator unavailable")
	}
	if _, state, err := b.Engine.SecurityScheduleDefinition(b.Context, row.Project, row.ID); err == nil {
		if state != "ready" {
			return errors.New("security: schedule configuration is changing")
		}
		return nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	if row.Kind != "reminder" {
		return errors.New("security: workflow schedule needs explicit current authorization")
	}
	return b.persistScheduleConfiguration(b.Context, row, "legacy_reminder", func() error { return nil })
}
