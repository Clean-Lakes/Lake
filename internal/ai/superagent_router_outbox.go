package ai

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

// A direct Pilot answer is committed with its source dispositions. Restarting
// between the canonical commit and the host message cannot lose/duplicate it.
func (e *Engine) finalizeSuperRouter(ctx context.Context, sessionID string, run *superRouterRun, events []SuperEvent) error {
	view, err := e.Snapshot(sessionID)
	if err != nil {
		return err
	}
	text := ""
	for i := len(view.Cards) - 1; i >= 0; i-- {
		if view.CardsOffset+i >= run.firstCard && view.Cards[i].Type == "message" {
			text = view.Cards[i].Content
			break
		}
	}
	if err = e.checkSuperPayload(text); err != nil {
		return err
	}
	db, err := e.superStore()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		ids := []string{}
		admitted := []SuperEvent{}
		for _, event := range events {
			var current superEventRow
			if err := tx.First(&current, "id = ? AND project_id = ?", event.ID, run.projectID).Error; err != nil {
				return err
			}
			if current.Disposition == "cancelled" {
				continue
			}
			if err := finishSuperRoutingTx(tx, run.bindings[event.ID], event.ID); err != nil {
				return err
			}
			ids = append(ids, event.ID)
			admitted = append(admitted, event)
		}
		if len(ids) == 0 {
			return nil
		}
		var domain superProjectRow
		err := tx.First(&domain, "project_id = ? AND router_session_id = ?", run.projectID, sessionID).Error
		if errors.Is(err, gorm.ErrRecordNotFound) || text == "" {
			return nil
		}
		if err != nil {
			return err
		}
		id := hash(js([]any{"router-reply", ids}))
		destination := sessionID
		var origin superEventRow
		if err := tx.First(&origin, "id = ? AND project_id = ?", admitted[0].ID, run.projectID).Error; err != nil {
			return err
		}
		channel, err := superChannelForEventTx(tx, origin)
		if err != nil {
			return err
		}
		if channel != nil {
			destination = channel.HostSessionID
		}
		payload := js(map[string]any{"text": text})
		var prior superOutputRow
		if err := tx.First(&prior, "id = ?", id).Error; err == nil {
			return nil
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		return tx.Create(&superOutputRow{ID: id, ProjectID: run.projectID, ChannelRef: destination, SourceMessageID: admitted[len(admitted)-1].SourceEventID, Kind: "router_reply", Payload: payload, RequestHash: hash(payload), ReportRevision: 1, State: "pending", CreatedAt: time.Now().UTC()}).Error
	})
}

func (e *Engine) beginSuperRoutingAttempt(ctx context.Context, project string, events []SuperEvent) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, event := range events {
			if _, err := superSourceForEvent(tx, event.ID, project); err != nil {
				return err
			}
			r := tx.Model(&superEventRow{}).Where("id = ? AND disposition = ? AND routing_attempts < ? AND retry_at <= ?", event.ID, "pending", 3, time.Now().UTC()).Updates(map[string]any{"routing_attempts": gorm.Expr("routing_attempts + 1"), "retry_at": time.Now().UTC().Add(2 * time.Minute)})
			if r.Error != nil {
				return r.Error
			}
			if r.RowsAffected != 1 {
				return errSuperConflict
			}
		}
		return nil
	})
}

func (e *Engine) failSuperRouting(ctx context.Context, project string, events []SuperEvent) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, event := range events {
			var row superEventRow
			if err := tx.First(&row, "id = ? AND project_id = ?", event.ID, project).Error; err != nil {
				return err
			}
			if row.Disposition != "pending" {
				continue
			}
			updates := map[string]any{"retry_at": time.Now().UTC().Add(time.Duration(max(1, row.RoutingAttempts)) * 5 * time.Second)}
			if row.RoutingAttempts >= 3 {
				updates["disposition"] = "blocked"
			}
			if err := tx.Model(&superEventRow{}).Where("id = ? AND disposition = ?", row.ID, "pending").Updates(updates).Error; err != nil {
				return err
			}
		}
		return nil
	})
}
