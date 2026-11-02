package ai

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type SuperReport struct {
	ID              string `json:"id"`
	TaskID          string `json:"taskId"`
	ProjectID       string `json:"projectId"`
	ChannelRef      string `json:"channelRef"`
	SourceMessageID string `json:"sourceMessageId"`
	Kind            string `json:"kind"`
	Payload         string `json:"payload"`
	Revision        int64  `json:"revision"`
	State           string `json:"state"`
	Receipt         string `json:"receipt,omitempty"`
}

func (r superOutputRow) report() SuperReport {
	return SuperReport{ID: r.ID, TaskID: r.TaskID, ProjectID: r.ProjectID, ChannelRef: r.ChannelRef, SourceMessageID: r.SourceMessageID, Kind: r.Kind, Payload: r.Payload, Revision: r.ReportRevision, State: r.State, Receipt: r.Receipt}
}

// QueuePilotReport binds the report to the canonical goal revision in the same
// transaction. Repeated submissions retain one delivery key and exact content.
func (e *Engine) QueuePilotReport(ctx context.Context, projectID, sessionID, taskID, channelRef, sourceMessageID, kind, payload string, expected int64) (SuperReport, error) {
	var out SuperReport
	switch kind {
	case "ack", "result", "question", "attention":
	default:
		return out, errSuperBinding
	}
	if projectID == "" || channelRef == "" || len(channelRef) > 256 || sourceMessageID == "" || expected < 1 {
		return out, errSuperBinding
	}
	if err := e.checkSuperPayload(payload); err != nil {
		return out, err
	}
	db, err := e.superStore()
	if err != nil {
		return out, err
	}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		id := hash(js([]any{"pilot-report", taskID, expected, channelRef, kind}))
		requestHash := hash(js([]any{projectID, sessionID, sourceMessageID, payload}))
		var prior superOutputRow
		if lookup := tx.First(&prior, "id = ?", id).Error; lookup == nil {
			if prior.RequestHash != requestHash {
				return errSuperConflict
			}
			out = prior.report()
			return nil
		} else if !errors.Is(lookup, gorm.ErrRecordNotFound) {
			return lookup
		}
		view, err := projectSuperTaskTx(tx, sessionID, taskID)
		if err != nil {
			return err
		}
		if view.ProjectID != projectID || view.Revision != expected {
			return errSuperConflict
		}
		// A result is not necessarily success; the canonical state travels with it.
		// Consumers must display it and cannot derive completion from prose.
		data := js(map[string]any{"task": view, "text": payload})
		row := superOutputRow{ID: id, TaskID: taskID, ProjectID: projectID, ChannelRef: channelRef, SourceMessageID: sourceMessageID, Kind: kind, Payload: data, RequestHash: requestHash, ReportRevision: expected, State: "pending", CreatedAt: time.Now().UTC()}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; err != nil {
			return err
		}
		var original superOutputRow
		if err := tx.First(&original, "id = ?", id).Error; err != nil {
			return err
		}
		if original.RequestHash != requestHash {
			return errSuperConflict
		}
		out = original.report()
		return nil
	})
	return out, err
}

// BeginPilotDelivery serializes channel writes. On process loss a sending row
// becomes unknown; only an idempotent channel or receipt reconciliation may retry.
func (e *Engine) BeginPilotDelivery(ctx context.Context, projectID, id string) (SuperReport, error) {
	db, err := e.superStore()
	if err != nil {
		return SuperReport{}, err
	}
	var out SuperReport
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row superOutputRow
		if err := tx.First(&row, "id = ? AND project_id = ?", id, projectID).Error; err != nil {
			return err
		}
		if row.State == "delivered" {
			out = row.report()
			return nil
		}
		if row.State != "pending" {
			return errors.New("superagent: delivery requires receipt reconciliation")
		}
		r := tx.Model(&superOutputRow{}).Where("id = ? AND state = ?", id, "pending").Update("state", "sending")
		if r.Error != nil {
			return r.Error
		}
		if r.RowsAffected != 1 {
			return errSuperConflict
		}
		row.State = "sending"
		out = row.report()
		return nil
	})
	return out, err
}

// The built-in host message store guarantees a unique message ID. This adapter
// may retry the same key after an uncertain send; arbitrary channels cannot.
func (e *Engine) BeginPilotHostDelivery(ctx context.Context, projectID, id string) (SuperReport, error) {
	db, err := e.superStore()
	if err != nil {
		return SuperReport{}, err
	}
	var out SuperReport
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row superOutputRow
		if err := tx.First(&row, "id = ? AND project_id = ?", id, projectID).Error; err != nil {
			return err
		}
		var domain superProjectRow
		if err := tx.First(&domain, "project_id = ? AND router_session_id = ?", projectID, row.ChannelRef).Error; err != nil {
			return err
		}
		switch row.State {
		case "delivered":
			out = row.report()
			return nil
		case "pending", "sending", "unknown":
		default:
			return errSuperBinding
		}
		if err := tx.Model(&superOutputRow{}).Where("id = ?", id).Update("state", "sending").Error; err != nil {
			return err
		}
		row.State = "sending"
		out = row.report()
		return nil
	})
	return out, err
}

func (e *Engine) PendingPilotReports(ctx context.Context, projectID string) ([]SuperReport, error) {
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	var rows []superOutputRow
	err = db.WithContext(ctx).Where("project_id = ? AND state IN ?", projectID, []string{"pending", "sending", "unknown"}).Order("created_at, id").Limit(100).Find(&rows).Error
	out := make([]SuperReport, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.report())
	}
	return out, err
}
func (e *Engine) AcknowledgePilotDelivery(ctx context.Context, projectID, id, receipt string) error {
	if receipt == "" || len(receipt) > 1024 {
		return errSuperBinding
	}
	if err := e.checkSuperPayload(receipt); err != nil {
		return err
	}
	db, err := e.superStore()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row superOutputRow
		if err := tx.First(&row, "id = ? AND project_id = ?", id, projectID).Error; err != nil {
			return err
		}
		if row.State == "delivered" {
			if row.Receipt == receipt {
				return nil
			}
			return errSuperConflict
		}
		if row.State != "sending" && row.State != "unknown" {
			return errSuperBinding
		}
		return tx.Model(&superOutputRow{}).Where("id = ?", id).Updates(map[string]any{"state": "delivered", "receipt": receipt}).Error
	})
}
func (e *Engine) MarkPilotDeliveryUnknown(ctx context.Context, projectID, id string) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	r := db.WithContext(ctx).Model(&superOutputRow{}).Where("id = ? AND project_id = ? AND state = ?", id, projectID, "sending").Update("state", "unknown")
	if r.Error != nil {
		return r.Error
	}
	if r.RowsAffected != 1 {
		return errSuperConflict
	}
	return nil
}
