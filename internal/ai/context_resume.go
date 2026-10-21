package ai

import (
	"context"
	"errors"
	"strings"
	"time"
)

// Short conversations can resume directly. Substantial idle conversations get
// a fresh handoff before answering; elapsed time never expires their records.
func shouldCompactResumedConversation(st State, now time.Time) bool {
	if len(st.History) < 3 || historyCost(st.History) < 8192 {
		return false
	}
	var last time.Time
	consider := func(value string) {
		if at, err := time.Parse(time.RFC3339Nano, value); err == nil && at.After(last) {
			last = at
		}
	}
	consider(st.View.StartedAt)
	consider(st.View.TurnFinishedAt)
	consider(st.View.TurnStartedAt)
	consider(st.LastRequestAt)
	for _, card := range st.View.Cards {
		consider(card.At)
	}
	return !last.IsZero() && now.Sub(last) >= 30*time.Minute
}

func (e *Engine) compactForTurn(ctx context.Context, s *session, c Config, resume bool) error {
	if report, err := e.onlineCurrent(s, c); err != nil {
		return err
	} else if report != nil {
		// No unaccounted summarizer requests inside a correction budget.
		s.mu.Lock()
		cost := historyCost(s.state.History)
		s.mu.Unlock()
		if cost > (c.Model.ContextWindow-c.Model.MaxOutput)*2 {
			return &onlineStopped{Reason: "budget_exhausted"}
		}
		return nil
	}
	if e.experiment != nil {
		s.mu.Lock()
		cost := historyCost(s.state.History)
		s.mu.Unlock()
		if cost > (c.Model.ContextWindow-c.Model.MaxOutput)*2 {
			return errors.New("experiment context budget exhausted")
		}
		return nil
	}
	err := e.compact(ctx, s, c, resume)
	if err == nil || !resume || ctx.Err() != nil || !strings.HasPrefix(err.Error(), "context compaction:") {
		return err
	}
	// An idle-session handoff is optional while the original history still
	// fits. A required budget compaction must succeed; never truncate user
	// constraints or silently replay operations to recover from its failure.
	s.mu.Lock()
	id := s.state.View.Session
	s.mu.Unlock()
	toolCost := len(js(e.sessionCatalog(ctx, id, c)))
	if ctx.Err() != nil {
		return ctx.Err()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if historyCost(s.state.History)+toolCost >= (c.Model.ContextWindow-c.Model.MaxOutput)*2 {
		return err
	}
	s.state.View.Cards = append(s.state.View.Cards, Card{ID: uid(), Type: "notice", Content: "历史上下文整理未完成，已保留原上下文继续本轮对话。", Status: "completed", At: timestamp()})
	if err := e.save(s); err != nil {
		return err
	}
	e.notify(s, "compact", nil)
	return nil
}
