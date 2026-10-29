package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func (b *Server) strategySafeText(text string) bool {
	model := b.Models.Active()
	if model == nil {
		model = &ai.Model{}
	}
	return ai.SafeMemoryContent(text, *model) && !b.Models.strategyContainsProviderSecret(text) && !b.Terminals.containsCredential(text)
}
func (b *Server) reconcileStrategyOutboxForSession(id string) error {
	items, err := b.Engine.StrategyOutbox(id)
	if err != nil {
		return err
	}
	for _, s := range items {
		acknowledged, ackErr := b.Store.strategyHandoffAcknowledged(s)
		if ackErr != nil {
			return ackErr
		}
		if acknowledged {
			if err = b.Engine.AckStrategyOutbox(id, s.TurnID, s.SnapshotHash); err != nil {
				return err
			}
			continue
		}
		if err = b.Store.ackStrategyHandoff(s); err != nil {
			return err
		}
		if err = b.Engine.AckStrategyOutbox(id, s.TurnID, s.SnapshotHash); err != nil {
			return err
		}
	}
	return nil
}

func strategyHandoffKey(event ai.StrategyTurnSnapshot) string {
	return strategy.ContentHash("handoff-v2:" + event.SessionID + ":" + event.TurnID)
}
func (s *Store) strategyHandoffAcknowledged(event ai.StrategyTurnSnapshot) (bool, error) {
	return strategyCall(s, false, func() bool {
		row := s.row("SELECT requestHash FROM strategyReceipts WHERE scopeKey='user' AND keyHash=?", strategyHandoffKey(event))
		if row == nil {
			return false
		}
		if row["requestHash"] != event.SnapshotHash {
			strategyFail(409, "handoff_conflict")
		}
		return true
	})
}
func (s *Store) ackStrategyHandoff(event ai.StrategyTurnSnapshot) error {
	_, err := strategyCall(s, true, func() bool {
		if !ai.ValidStrategySnapshot(event) {
			strategyFail(400, "invalid_snapshot")
		}
		key := strategyHandoffKey(event)
		if old := s.row("SELECT requestHash FROM strategyReceipts WHERE scopeKey='user' AND keyHash=?", key); old != nil {
			if old["requestHash"] != event.SnapshotHash {
				strategyFail(409, "handoff_conflict")
			}
			return true
		}
		// Host-owned hash-only receipts contain no project text or source payload.
		s.exec("INSERT INTO strategyReceipts(scopeKey,keyHash,requestHash,result) VALUES('user',?,?,'{}')", key, event.SnapshotHash)
		return true
	})
	return err
}
