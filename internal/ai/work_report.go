package ai

import (
	"context"
	"errors"
)

// The foreground transcript receives a named background result, without
// replacing its RootTurnID, task status or user draft. The card ID is stable
// across outbox retries and crashes.
func (e *Engine) publishWorkReport(ctx context.Context, g WorkGoal) error {
	if (!workTerminal(g.Status) && g.Status != "waiting_user") || g.Summary == "" || !g.BackgroundSummary {
		return nil
	}
	s, err := e.get(g.SessionID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.cancel != nil || s.finalizing {
		s.mu.Unlock()
		return errors.New("foreground reserved")
	}
	_, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	defer func() { cancel(); s.mu.Lock(); s.cancel = nil; s.mu.Unlock() }()
	cardID := "work-report-" + g.ID
	if g.Status == "waiting_user" {
		cardID += "-waiting"
	}
	exists := false
	for _, card := range s.state.View.Cards {
		if card.ID == cardID {
			exists = true
			break
		}
	}
	if !exists {
		text := "后台任务「" + g.Title + "」结果：\n\n" + g.Summary
		s.state.View.Cards = append(s.state.View.Cards, Card{ID: cardID, Type: "work_result", Title: g.Title, Status: "completed", Content: text, At: timestamp(), Data: map[string]any{"workGoalId": g.ID, "originRootTurnId": g.OriginRootTurnID}})
		s.state.History = append(s.state.History, Message{Role: "assistant", HostTurnID: g.OriginRootTurnID, Content: text})
		err = e.save(s)
	}
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return e.persistNativeProjection(ctx, s)
}
