package ai

import (
	"context"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// SuperSourceBinding is supplied by an authenticated host adapter. It is not a
// tool argument and has no authority to dispatch resource operations.
type SuperSourceBinding struct{ SourceID, ProjectID, Kind, ActorRef, Revision string }
type SuperEventInput struct {
	SourceEventID, ThreadRef, Kind, Payload, NextCursor string
	HostStaged                                          bool // Host outbox confirms its committed context before routing.
}

func (e *Engine) ValidateSuperData(value string) error { return e.checkSuperPayload(value) }
func (e *Engine) resolveSuperInput(ctx context.Context, event SuperEvent) (TurnInput, error) {
	owner, err := securityRootEngine(e)
	if err != nil {
		return TurnInput{}, err
	}
	if owner.SuperInputResolver != nil {
		input, err := owner.SuperInputResolver(ctx, event)
		if err != nil {
			return input, err
		}
		if input.UserText != event.Payload || input.StrategyMessageID != event.SourceEventID {
			return TurnInput{}, errSuperBinding
		}
		return input, nil
	}
	return TurnInput{UserText: event.Payload, StrategyMessageID: event.SourceEventID}, nil
}

type SuperEvent struct {
	SourceKind    string    `json:"sourceKind"`
	ID            string    `json:"id"`
	SourceID      string    `json:"sourceId"`
	SourceEventID string    `json:"sourceEventId"`
	ProjectID     string    `json:"projectId"`
	ThreadRef     string    `json:"threadRef"`
	Kind          string    `json:"kind"`
	Payload       string    `json:"payload"`
	Disposition   string    `json:"disposition"`
	ReceivedAt    time.Time `json:"receivedAt"`
}

func (b SuperSourceBinding) valid() bool {
	for _, v := range []string{b.SourceID, b.ProjectID, b.Kind, b.ActorRef, b.Revision} {
		if v == "" || len(v) > 256 {
			return false
		}
	}
	switch b.Kind {
	case "user", "schedule", "workflow", "observer", "alert":
		return true
	}
	return false
}

func (e *Engine) RegisterSuperSource(ctx context.Context, b SuperSourceBinding) error {
	if !b.valid() {
		return errSuperBinding
	}
	db, err := e.superStore()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row := superSourceRow{ID: b.SourceID, ProjectID: b.ProjectID, Kind: b.Kind, ActorRef: b.ActorRef, Revision: b.Revision, Enabled: true}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; err != nil {
			return err
		}
		var existing superSourceRow
		if err := tx.First(&existing, "id = ?", b.SourceID).Error; err != nil {
			return err
		}
		if !superSourceMatches(existing, b) {
			return errSuperConflict
		}
		return nil
	})
}
func superSourceMatches(r superSourceRow, b SuperSourceBinding) bool {
	return r.Enabled && r.ID == b.SourceID && r.ProjectID == b.ProjectID && r.Kind == b.Kind && r.ActorRef == b.ActorRef && r.Revision == b.Revision
}
func (e *Engine) checkSuperPayload(payload string) error {
	if len(payload) > 128*1024 {
		return errors.New("superagent: event payload exceeds limit")
	}
	if strings.Contains(payload, "-----BEGIN") && strings.Contains(payload, "PRIVATE KEY-----") {
		return errors.New("superagent: credentials are not event data")
	}
	for _, secret := range e.securityHostSecretSnapshot() {
		if secret != "" && strings.Contains(payload, secret) {
			return errors.New("superagent: host credentials rejected")
		}
	}
	owner, err := securityRootEngine(e)
	if err != nil {
		return err
	}
	containsCredential := false
	owner.superSecrets.Range(func(key, value any) bool {
		if strings.Contains(payload, key.(string)) {
			containsCredential = true
			return false
		}
		return true
	})
	if containsCredential {
		return errors.New("superagent: credentials rejected")
	}
	return nil
}
func (r superEventRow) event() SuperEvent {
	return SuperEvent{ID: r.ID, SourceKind: r.SourceKind, SourceID: r.SourceID, SourceEventID: r.SourceEventID, ProjectID: r.ProjectID, ThreadRef: r.ThreadRef, Kind: r.Kind, Payload: r.Payload, Disposition: r.Disposition, ReceivedAt: r.ReceivedAt}
}

// ReceiveSuperEvent commits the immutable event before advancing the source
// cursor. A duplicate with different content is a conflict, never an overwrite.
func (e *Engine) ReceiveSuperEvent(ctx context.Context, b SuperSourceBinding, in SuperEventInput) (SuperEvent, bool, error) {
	var out SuperEvent
	if !b.valid() || in.SourceEventID == "" || len(in.SourceEventID) > 256 || len(in.ThreadRef) > 512 || in.Kind == "" || len(in.Kind) > 64 || len(in.NextCursor) > 1024 {
		return out, false, errSuperBinding
	}
	if err := e.checkSuperPayload(in.Payload); err != nil {
		return out, false, err
	}
	db, err := e.superStore()
	if err != nil {
		return out, false, err
	}
	created := false
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var source superSourceRow
		if err := tx.First(&source, "id = ?", b.SourceID).Error; err != nil {
			return err
		}
		if !superSourceMatches(source, b) {
			return errSuperBinding
		}
		row := superEventRow{ID: uid(), SourceID: b.SourceID, SourceEventID: in.SourceEventID, ProjectID: b.ProjectID, SourceRevision: b.Revision, ActorRef: b.ActorRef, ThreadRef: in.ThreadRef, Kind: in.Kind, Payload: in.Payload, PayloadHash: hash(in.Payload), Disposition: "pending", ReceivedAt: time.Now().UTC()}
		row.SourceKind = b.Kind
		if in.HostStaged {
			row.Disposition = "staged"
		}
		result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row)
		if result.Error != nil {
			return result.Error
		}
		created = result.RowsAffected == 1
		var original superEventRow
		if err := tx.First(&original, "source_id = ? AND source_event_id = ?", b.SourceID, in.SourceEventID).Error; err != nil {
			return err
		}
		if original.ProjectID != b.ProjectID || original.SourceRevision != b.Revision || original.ActorRef != b.ActorRef || original.PayloadHash != row.PayloadHash || original.ThreadRef != in.ThreadRef || original.Kind != in.Kind {
			return errSuperConflict
		}
		// Replayed events must not roll a source cursor back.
		if created && in.NextCursor != "" {
			result = tx.Model(&superSourceRow{}).Where("id = ? AND revision = ? AND enabled = ?", b.SourceID, b.Revision, true).Update("cursor", in.NextCursor)
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return errSuperConflict
			}
		}
		out = original.event()
		return nil
	})
	return out, created, err
}

func (e *Engine) PendingSuperEvents(ctx context.Context, b SuperSourceBinding, limit int) ([]SuperEvent, error) {
	if !b.valid() || limit < 1 || limit > 16 {
		return nil, errSuperBinding
	}
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	var source superSourceRow
	if err = db.WithContext(ctx).First(&source, "id = ?", b.SourceID).Error; err != nil {
		return nil, err
	}
	if !superSourceMatches(source, b) {
		return nil, errSuperBinding
	}
	var rows []superEventRow
	err = db.WithContext(ctx).Where("source_id = ? AND project_id = ? AND source_revision = ? AND disposition = ?", b.SourceID, b.ProjectID, b.Revision, "pending").Order("received_at, id").Limit(limit).Find(&rows).Error
	out := make([]SuperEvent, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.event())
	}
	return out, err
}

func (e *Engine) ConfirmSuperEventContext(ctx context.Context, b SuperSourceBinding, eventID, digest string) error {
	if !b.valid() || len(digest) != 64 {
		return errSuperBinding
	}
	db, err := e.superStore()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var source superSourceRow
		if err := tx.First(&source, "id = ?", b.SourceID).Error; err != nil {
			return err
		}
		if !superSourceMatches(source, b) {
			return errSuperBinding
		}
		var event superEventRow
		if err := tx.First(&event, "id = ? AND source_id = ? AND source_revision = ? AND project_id = ?", eventID, b.SourceID, b.Revision, b.ProjectID).Error; err != nil {
			return err
		}
		if event.HostInputHash != "" {
			if event.HostInputHash == digest {
				return nil
			}
			return errSuperConflict
		}
		if event.Disposition != "staged" {
			return errSuperConflict
		}
		return tx.Model(&superEventRow{}).Where("id = ? AND disposition = ? AND host_input_hash = ''", event.ID, "staged").Updates(map[string]any{"host_input_hash": digest, "disposition": "pending"}).Error
	})
}

// Stable project-wide intake: actual human controls/inputs precede scheduled
// work and observations. Disabled or revised sources cannot keep a queue alive.
func (e *Engine) PendingSuperProjectEvents(ctx context.Context, projectID string, limit int) ([]SuperEvent, error) {
	if projectID == "" || limit < 1 || limit > 16 {
		return nil, errSuperBinding
	}
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	var rows []superEventRow
	err = db.WithContext(ctx).Table("superagent_events AS event").Select("event.*").Joins("JOIN superagent_sources AS source ON source.id=event.source_id AND source.project_id=event.project_id AND source.revision=event.source_revision AND source.actor_ref=event.actor_ref AND source.enabled=1").Where("event.project_id = ? AND event.disposition = ? AND event.routing_attempts < ? AND event.retry_at <= ?", projectID, "pending", 3, time.Now().UTC()).Order("CASE WHEN source.kind='user' AND event.kind IN ('stop','approval') THEN 0 WHEN source.kind='user' THEN 1 WHEN source.kind='schedule' THEN 2 WHEN source.kind='observer' THEN 3 ELSE 4 END, event.received_at, event.id").Limit(limit).Scan(&rows).Error
	out := make([]SuperEvent, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.event())
	}
	return out, err
}

func superSourceForEvent(tx *gorm.DB, eventID, projectID string) (SuperSourceBinding, error) {
	var event superEventRow
	if err := tx.First(&event, "id = ? AND project_id = ?", eventID, projectID).Error; err != nil {
		return SuperSourceBinding{}, err
	}
	var row superSourceRow
	if err := tx.First(&row, "id = ? AND project_id = ? AND revision = ? AND actor_ref = ? AND enabled = ?", event.SourceID, projectID, event.SourceRevision, event.ActorRef, true).Error; err != nil {
		return SuperSourceBinding{}, err
	}
	return SuperSourceBinding{SourceID: row.ID, ProjectID: row.ProjectID, Kind: row.Kind, ActorRef: row.ActorRef, Revision: row.Revision}, nil
}
