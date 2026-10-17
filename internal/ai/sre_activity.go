package ai

// Phase changes are runtime facts. Tool arguments and output never enter this
// compact shared activity state.
func (e *Engine) setSREActivity(phase, tool string) {
	if e.worker == nil || e.worker.sreTaskID == "" {
		return
	}
	_ = e.worker.parent.updateAgent(e.worker, func(r *AgentRun) {
		if r.Status != "running" && r.Status != "waiting_approval" {
			return
		}
		if r.ActivityPhase != phase || r.ActivityTool != tool {
			r.ActivityPhase, r.ActivityTool, r.ActivityUpdatedAt = phase, tool, timestamp()
		}
	})
}
