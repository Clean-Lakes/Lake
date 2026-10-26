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
// The pass is deliberately narrow: only the latest persisted engine outcome
// can prove completion. Outstanding historical operations keep their session
// warning; correcting reply metadata never resolves or retries an operation.
func (b *Server) reconcileStaleSREStatuses() {
	defer func() { recover() }()
	for _, session := range b.Store.SRESessionIDs() {
		if stringOf(b.Store.Session(session)["status"]) != "failed" {
			continue
		}
		tasks, err := b.Store.ListSRETasks(session, 50, "")
		if err != nil {
			continue
		}
		view, err := b.Engine.Snapshot(session)
		if err != nil || view.Status != "completed" {
			continue
		}
		if b.repairStaleReplyTimings(session, tasks, view) && b.sreSessionStatus(session, tasks) == "completed" {
			b.Store.RepairSessionStatus(session, "completed")
		}
	}
}

// Only the latest persisted engine outcome can prove a stale timing wrong.
// Earlier failures, task/operation history and outstanding session warnings stay intact.
func (b *Server) repairStaleReplyTimings(session string, tasks []ai.SRETask, view ai.View) bool {
	for _, timing := range b.Store.ReplyTimingRows(session) {
		if !set("failed completed")[stringOf(timing["status"])] {
			continue
		}
		start, se := time.Parse(time.RFC3339Nano, stringOf(timing["startedAt"]))
		end, ee := time.Parse(time.RFC3339Nano, stringOf(timing["finishedAt"]))
		if se != nil || ee != nil || !b.independentReplyCompleted(session, tasks, view, start, end) {
			continue
		}
		if timing["status"] == "failed" {
			b.Store.SetReplyTimingStatus(session, stringOf(timing["messageId"]), "completed")
		}
		return true
	}
	return false
}

// A legacy paused task can still own an outstanding operation and the session
// warning without turning a later, independently completed reply into a failure.
func (b *Server) independentReplyCompleted(session string, tasks []ai.SRETask, view ai.View, start, end time.Time) bool {
	if view.Status != "completed" || view.Pending != nil || len(view.PendingApprovals) > 0 || view.Question != nil {
		return false
	}
	modelStart, se := time.Parse(time.RFC3339Nano, view.TurnStartedAt)
	modelEnd, ee := time.Parse(time.RFC3339Nano, view.TurnFinishedAt)
	if se != nil || ee != nil || end.Before(start) || modelEnd.Before(modelStart) || modelStart.Before(start) || modelEnd.After(end) {
		return false
	}
	historicalPause := false
	for _, task := range tasks {
		updated, err := time.Parse(time.RFC3339Nano, task.UpdatedAt)
		if err != nil {
			return false
		}
		if updated.Before(start) && set("paused waiting_input draft")[task.Status] {
			historicalPause = true
		}
	}
	if !historicalPause || sreTaskTouched(tasks, start, end) {
		return false
	}
	for _, op := range view.OperationOutcomes {
		if (op.Status == "unknown" || op.Status == "dispatched") && (op.StartedAt.IsZero() || !op.StartedAt.Before(start)) {
			return false
		}
	}
	if len(view.Cards) == 0 {
		return false
	}
	coveredFrom, err := time.Parse(time.RFC3339Nano, view.Cards[0].At)
	if err != nil || view.CardsOffset > 0 && start.Before(coveredFrom) {
		return false
	}
	assistant, system := b.Store.ReplyMessageWindow(session, start, end)
	return assistant && !system && !errorCardBetween(view.Cards, start, end)
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
