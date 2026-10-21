package ai

// saveHumanInputState runs with s.mu held. Publish the durable wait/resume state
// explicitly: subscribers cannot call Snapshot synchronously from notify while
// the session lock is held. One answered input must not hide another pending one.
func (e *Engine) saveHumanInputState(s *session) error {
	s.state.View.Status = "running"
	if s.state.View.Question != nil || s.state.View.Pending != nil || len(s.state.View.PendingApprovals) > 0 {
		s.state.View.Status = "waiting_approval"
	}
	if err := e.save(s); err != nil {
		return err
	}
	e.notify(s, "inputState", map[string]any{"status": s.state.View.Status})
	return nil
}
