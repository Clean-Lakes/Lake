package web

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
	if tasks, err := b.Store.ListSRETasks(id, 1, ""); err == nil && len(tasks) > 0 {
		b.syncSRESessionStatus(id)
	}
	status := "failed"
	if view, err := b.Engine.Snapshot(id); err == nil && set("completed cancelled failed")[view.Status] {
		status = view.Status
	}
	if b.Store.Session(id)["status"] == "failed" && status != "cancelled" {
		status = "failed"
	}
	b.Store.FinishReplyTiming(id, status)
}
