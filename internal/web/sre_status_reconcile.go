package web

import (
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// reconcileStaleSREStatuses repairs reply metadata written by builds that let
// a paused SRE task from an earlier turn fail later ordinary replies. The task
// itself stays paused and resumable; only a session status and reply timing
// that were derived from that stale state are corrected.
//
// The pass is deliberately narrow: it runs once per process start, touches
// only sessions whose current SRE state no longer labels the latest turn, and
// requires the engine's persisted latest turn to have completed. Task history,
// operations, messages and evidence are never rewritten.
func (b *Server) reconcileStaleSREStatuses() {
	defer func() { recover() }()
	for _, session := range b.Store.SRESessionIDs() {
		if stringOf(b.Store.Session(session)["status"]) != "failed" {
			continue
		}
		tasks, err := b.Store.ListSRETasks(session, 50, "")
		if err != nil || b.sreSessionStatus(session, tasks) != "completed" {
			continue
		}
		view, err := b.Engine.Snapshot(session)
		if err != nil || view.Status != "completed" || view.TurnStartedAt == "" || view.TurnFinishedAt == "" {
			continue
		}
		stalePause := false
		for _, task := range tasks {
			if set("paused waiting_input draft")[task.Status] && !ai.SRETaskOwnsTurn(task, view.TurnStartedAt) {
				stalePause = true
			}
		}
		if stalePause && b.repairStaleReplyTimings(session, tasks, view) {
			b.Store.RepairSessionStatus(session, "completed")
		}
	}
}

// repairStaleReplyTimings restores the recorded outcome of turns that ended
// normally but were marked failed from a stale pause. Only the latest engine
// turn has a provable model outcome; earlier failed timings stay unchanged.
// A failed timing is left untouched when the turn shows its own failure: task activity
// inside the turn, a system message, or an error card. Timings older than the
// retained card window are skipped because a pruned error card could otherwise
// look like a stale pause.
func (b *Server) repairStaleReplyTimings(session string, tasks []ai.SRETask, view ai.View) bool {
	if view.Pending != nil || len(view.PendingApprovals) > 0 || view.Question != nil {
		return false
	}
	for _, op := range view.OperationOutcomes {
		if op.Status == "unknown" || op.Status == "dispatched" {
			return false
		}
	}
	modelStart, startErr := time.Parse(time.RFC3339Nano, view.TurnStartedAt)
	modelEnd, endErr := time.Parse(time.RFC3339Nano, view.TurnFinishedAt)
	if startErr != nil || endErr != nil || modelEnd.Before(modelStart) {
		return false
	}
	if len(view.Cards) == 0 {
		return false
	}
	coveredFrom, err := time.Parse(time.RFC3339Nano, view.Cards[0].At)
	if err != nil {
		return false
	}
	if view.CardsOffset == 0 {
		// The view retains every card of this session; nothing hinted at a
		// failure before the first retained card.
		coveredFrom = time.Time{}
	}
	for _, timing := range b.Store.ReplyTimingRows(session) {
		if !set("failed completed")[stringOf(timing["status"])] || stringOf(timing["finishedAt"]) == "" {
			continue
		}
		start, startErr := time.Parse(time.RFC3339Nano, stringOf(timing["startedAt"]))
		end, endErr := time.Parse(time.RFC3339Nano, stringOf(timing["finishedAt"]))
		if startErr != nil || endErr != nil || end.Before(start) || start.Before(coveredFrom) || modelStart.Before(start) || modelEnd.After(end) {
			continue
		}
		if sreTaskTouched(tasks, start, end) {
			continue
		}
		assistant, system := b.Store.ReplyMessageWindow(session, start, end)
		if !assistant || system || errorCardBetween(view.Cards, start, end) {
			continue
		}
		if stringOf(timing["status"]) == "failed" {
			b.Store.SetReplyTimingStatus(session, stringOf(timing["messageId"]), "completed")
		}
		return true
	}
	return false
}

func sreTaskTouched(tasks []ai.SRETask, start, end time.Time) bool {
	for _, task := range tasks {
		at, err := time.Parse(time.RFC3339Nano, task.UpdatedAt)
		if err == nil && !at.Before(start) && !at.After(end) {
			return true
		}
	}
	return false
}

func errorCardBetween(cards []ai.Card, start, end time.Time) bool {
	for _, card := range cards {
		at, err := time.Parse(time.RFC3339Nano, card.At)
		if err == nil && !at.Before(start) && !at.After(end) && card.Type == "error" {
			return true
		}
	}
	return false
}

func (s *Store) SRESessionIDs() []string {
	return s.read(func() any {
		out := []string{}
		for _, row := range s.rows("SELECT DISTINCT tasks.sessionId FROM sreTasks tasks JOIN sessions ON sessions.id=tasks.sessionId ORDER BY tasks.sessionId") {
			out = append(out, stringOf(row["sessionId"]))
		}
		return out
	}).([]string)
}

func (s *Store) ReplyTimingRows(session string) []Object {
	return s.read(func() any {
		return s.rows("SELECT messageId,startedAt,finishedAt,status FROM replyTimings WHERE sessionId=? ORDER BY startedAt,rowid", session)
	}).([]Object)
}

// ReplyMessageWindow reports whether the turn recorded an assistant reply and
// whether it recorded a system-level failure message.
func (s *Store) ReplyMessageWindow(session string, start, end time.Time) (assistant, system bool) {
	s.read(func() any {
		for _, row := range s.rows("SELECT role,createdAt FROM messages WHERE sessionId=?", session) {
			at, err := time.Parse(time.RFC3339Nano, stringOf(row["createdAt"]))
			if err != nil || at.Before(start) || at.After(end) {
				continue
			}
			switch stringOf(row["role"]) {
			case "assistant":
				assistant = true
			case "system":
				system = true
			}
		}
		return nil
	})
	return
}

func (s *Store) SetReplyTimingStatus(session, messageID, status string) {
	s.update(func() any {
		s.exec("UPDATE replyTimings SET status=? WHERE sessionId=? AND messageId=?", status, session, messageID)
		s.event(session, "session")
		return nil
	})
}

// RepairSessionStatus corrects a status derived from stale SRE state without
// reordering the session's last-activity time.
func (s *Store) RepairSessionStatus(id, status string) {
	s.update(func() any {
		s.session(id)
		s.exec("UPDATE sessions SET status=? WHERE id=? AND status='failed'", status, id)
		s.event(id, "session")
		return nil
	})
}
