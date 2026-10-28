package web

import (
	"context"
	"errors"
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
func (b *Server) enqueueStrategyTurn(snapshot ai.StrategyTurnSnapshot) (err error) {
	if strategy.ExecutionRetired {
		return nil
	}
	defer func() {
		if recover() != nil {
			err = &StrategyError{500, "learning_internal_error"}
		}
	}()
	ctx := StrategyContext{ProjectID: snapshot.ProjectID}
	effective, err := b.Store.EffectiveStrategySettings(ctx)
	if err != nil {
		return err
	}
	// Outboxes survive a crash, but never authorization revocation/re-enable.
	if !effective.Settings.MasterEnabled || !effective.Settings.LearnEnabled || snapshot.GlobalEpoch != effective.GlobalEpoch || snapshot.ProjectEpoch != effective.ProjectEpoch || !b.strategySafeText(jsonText(snapshot)) {
		return nil
	}
	if snapshot.Deferred {
		text, readErr := strategyCall(b.Store, false, func() string {
			message := b.Store.row("SELECT m.text FROM messages m JOIN sessions s ON s.id=m.sessionId WHERE m.id=? AND m.sessionId=? AND s.projectId=? AND m.role='user'", snapshot.UserMessageID, snapshot.SessionID, snapshot.ProjectID)
			if message == nil {
				return ""
			}
			return stringOf(message["text"])
		})
		if readErr != nil {
			return readErr
		}
		materialized, eligible, materializeErr := b.Engine.MaterializeStrategySnapshot(snapshot, text)
		if materializeErr != nil {
			return materializeErr
		}
		if !eligible {
			return nil
		}
		snapshot = materialized
		if !b.strategySafeText(jsonText(snapshot)) {
			return nil
		}
	}
	source, err := b.Store.registerStrategyTurn(snapshot)
	if err != nil || source == "" {
		return err
	}
	_, err = b.Store.QueueStrategyProposal(ctx, "auto:"+strategyExtractorVersion+":"+snapshot.SnapshotHash, StrategyJobInput{Scope: strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}, Kind: "proposal", SourceIDs: []string{source}})
	return err
}
func strategyPermanentError(err error) bool {
	var e *StrategyError
	return errors.As(err, &e) && e.Status < 500 && e.Code != "strategy_learning_queue_full"
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
		if err = b.enqueueStrategyTurn(s); err != nil && !strategyPermanentError(err) {
			return err
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

// Called only while the background gate is owned. Startup inventory reads
// registered outboxes once; later ticks inspect only loaded pending sessions.
func (b *Server) processStrategyOutboxes(ctx context.Context) {
	if b.strategyOutboxPending == nil {
		b.strategyOutboxPending = map[string]bool{}
	}
	if !b.strategyRecoveryLoaded {
		items, err := b.Engine.PersistedStrategyOutboxes()
		if err != nil {
			b.strategyHandoffStatus.Store("handoff_pending_retry")
			return
		}
		for _, event := range items {
			b.strategyOutboxPending[event.SessionID] = true
		}
		b.strategyRecoveryLoaded = true
	}
	for _, id := range b.Engine.PendingStrategySessions() {
		b.strategyOutboxPending[id] = true
	}
	b.strategyHandoffStatus.Store("")
	processed := 0
	for id := range b.strategyOutboxPending {
		if ctx.Err() != nil || processed >= 8 {
			return
		}
		processed++
		if b.reconcileStrategyOutboxForSession(id) == nil {
			delete(b.strategyOutboxPending, id)
		} else {
			b.strategyHandoffStatus.Store("handoff_pending_retry")
		}
	}
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
