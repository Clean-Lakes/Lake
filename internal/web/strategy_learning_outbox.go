package web

import (
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
	source, err := b.Store.registerStrategyTurn(snapshot)
	if err != nil || source == "" {
		return err
	}
	_, err = b.Store.QueueStrategyProposal(ctx, "auto:"+strategyExtractorVersion+":"+snapshot.SnapshotHash, StrategyJobInput{Scope: strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}, Kind: "proposal", SourceIDs: []string{source}})
	return err
}
func strategyPermanentError(err error) bool {
	var e *StrategyError
	return errors.As(err, &e) && e.Status < 500
}
func (b *Server) reconcileStrategyOutboxForSession(id string) error {
	items, err := b.Engine.StrategyOutbox(id)
	if err != nil {
		return err
	}
	for _, s := range items {
		if err = b.enqueueStrategyTurn(s); err != nil && !strategyPermanentError(err) {
			return err
		}
		if err = b.Engine.AckStrategyOutbox(id, s.TurnID, s.SnapshotHash); err != nil {
			return err
		}
	}
	return nil
}
func (b *Server) reconcilePersistedStrategyOutboxes() error {
	items, err := b.Engine.PersistedStrategyOutboxes()
	if err != nil {
		return err
	}
	for _, s := range items {
		if err = b.enqueueStrategyTurn(s); err != nil && !strategyPermanentError(err) {
			continue
		}
		_ = b.Engine.AckStrategyOutbox(s.SessionID, s.TurnID, s.SnapshotHash)
	}
	return nil
}
