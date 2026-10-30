package ai

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"gorm.io/gorm"
	"time"
)

// Historical data compatibility only. No controller, budgets or dispatch hooks.
const onlineRevisionTool = "revise_readonly_strategy"

// This host-owned record is authoritative even when an older ADK UI projection
// is recovered. A role, plan change or process restart cannot refund counters.
type nativeCorrection struct {
	ID        string `gorm:"primaryKey"`
	SessionID string `gorm:"index"`
	Body      string
	UpdatedAt time.Time
}

func (e *Engine) refreshHistoricalCorrectionCards(s *session) error {
	s.mu.Lock()
	id := s.state.View.Session
	s.mu.Unlock()
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	owner := e
	if e.worker != nil {
		owner = e.worker.parent
	}
	if _, ok := owner.historicalCorrectionSessions.Load(id); !ok {
		return nil
	}
	owner.correctionMu.Lock()
	defer owner.correctionMu.Unlock()
	var rows []nativeCorrection
	if err := store.DB.Where("session_id = ?", id).Order("updated_at DESC").Limit(100).Find(&rows).Error; err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, row := range rows {
		var r strategy.OnlineReport
		if json.Unmarshal([]byte(row.Body), &r) != nil {
			return errors.New("invalid correction report")
		}
		card := Card{ID: "correction_" + row.ID, Type: "strategy_correction", Title: "只读纠错", Status: "running", At: r.StartedAt, Data: r}
		if r.StopReason != "" {
			card.Status = "completed"
		}
		found := false
		for i := range s.state.View.Cards {
			if s.state.View.Cards[i].ID == card.ID {
				s.state.View.Cards[i] = card
				found = true
				break
			}
		}
		if !found {
			s.state.View.Cards = append(s.state.View.Cards, card)
		}
	}
	return nil
}

func recoverOnlineCorrections(db *gorm.DB) error {
	var rows []nativeCorrection
	if err := db.Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		var r strategy.OnlineReport
		if json.Unmarshal([]byte(row.Body), &r) != nil {
			return fmt.Errorf("invalid durable correction %s", row.ID)
		}
		if r.Retired {
			continue
		}
		r.Retired = true
		if r.StopReason == "" || r.StopReason == strategy.AwaitingUser {
			r.StopReason = strategy.Cancelled
		}
		if r.InFlightRequest || r.InFlightCall != "" {
			r.StopReason = strategy.AwaitingReconciliation
		}
		if r.ActiveAt != "" {
			if at, err := time.Parse(time.RFC3339Nano, r.ActiveAt); err == nil {
				r.ActiveMilliseconds += min(max(int64(0), time.Since(at).Milliseconds()), max(int64(0), r.Budget.MaxActiveSeconds*1000-r.ActiveMilliseconds))
			}
			r.ActiveAt = ""
		}
		if r.WaitSince == "" {
			r.WaitSince = timestamp()
		}
		// Keep dispatch identities and conservative reservations. Recovery never
		// dispatches, marks an old read successful or creates an automatic resume.
		if err := db.Model(&nativeCorrection{}).Where("id = ?", row.ID).Update("body", js(r)).Error; err != nil {
			return err
		}
	}
	return nil
}
