package web

import "time"

func (s *Store) FinishReplyTiming(id, status string) {
	s.update(func() any {
		row := s.row("SELECT messageId FROM replyTimings WHERE sessionId=? AND status='running' AND finishedAt='' ORDER BY startedAt DESC LIMIT 1", id)
		if row == nil {
			return nil
		}
		if !set("completed cancelled failed")[status] {
			status = "failed"
		}
		s.exec("UPDATE replyTimings SET finishedAt=?,status=? WHERE messageId=?", now(), status, row["messageId"])
		s.event(id, "session")
		return nil
	})
}
func (b *Server) finishReplyTiming(id string) {
	defer func() { recover() }()
	if b.Context.Err() != nil {
		return
	}
	status := "failed"
	if view, err := b.Engine.Snapshot(id); err == nil && set("completed cancelled failed")[view.Status] {
		status = view.Status
	}
	// Do not let historical successful SRE work overwrite a failed current reply.
	if status != "failed" {
		if tasks, err := b.Store.ListSRETasks(id, 1, ""); err == nil && len(tasks) > 0 {
			b.syncSRESessionStatus(id)
		}
	}
	if b.Store.Session(id)["status"] == "failed" && status != "cancelled" {
		independent := false
		if status == "completed" {
			if view, err := b.Engine.Snapshot(id); err == nil {
				if tasks, err := b.Store.ListSRETasks(id, 50, ""); err == nil {
					for _, row := range b.Store.ReplyTimingRows(id) {
						if row["status"] != "running" {
							continue
						}
						start, err := time.Parse(time.RFC3339Nano, stringOf(row["startedAt"]))
						if err == nil {
							independent = b.independentReplyCompleted(id, tasks, view, start, time.Now().UTC())
						}
					}
				}
			}
		}
		if !independent {
			status = "failed"
		}
	}
	b.Store.FinishReplyTiming(id, status)
}
