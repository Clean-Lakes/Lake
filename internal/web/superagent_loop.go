package web

import "time"

// This loop admits durable invocations and reconciles delivery metadata. It
// never calls a model itself or schedules dependency graph nodes.
func (b *Server) runSuperagent() {
	defer b.workers.Done()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		b.reconcileSuperagent()
		select {
		case <-b.Context.Done():
			return
		case <-ticker.C:
		}
	}
}
func (b *Server) reconcileSuperagent() {
	domains, err := b.Engine.SuperProjects(b.Context)
	if err != nil {
		return
	}
	for _, domain := range domains {
		if b.Context.Err() != nil {
			return
		}
		visible := b.Store.read(func() any {
			return b.Store.row("SELECT id FROM projects WHERE id=? AND "+activeProjectsSQL, domain.ProjectID) != nil
		}).(bool)
		if !visible {
			continue
		}
		b.reconcileSuperSourceContexts(domain)
		b.startSuperRouter(domain)
		if _, err := b.Engine.RecoverSuperagent(b.Context, domain.ProjectID); err != nil {
			continue
		}
		if err := b.Engine.CheckSuperagentProgress(b.Context, domain.ProjectID); err != nil {
			continue
		}
		if b.Engine.ReconcileSuperInbox(b.Context, domain.ProjectID) != nil {
			continue
		}
		_ = b.Engine.ApplySuperStops(b.Context, domain.ProjectID)
		workers, err := b.Engine.SuperInputWorkers(b.Context, domain.ProjectID)
		if err != nil {
			continue
		}
		for _, worker := range workers {
			_ = b.Engine.DeliverSuperFollowups(b.Context, domain.ProjectID, worker)
			_ = b.Engine.QueueSuperFollowup(b.Context, domain.ProjectID, worker)
		}
		b.startSuperWorkers(domain)
		reports, err := b.Engine.PendingPilotReports(b.Context, domain.ProjectID)
		if err != nil {
			continue
		}
		for _, report := range reports {
			_ = b.DeliverPilotReport(b.Context, domain.ProjectID, domain.RouterSessionID, report.ID)
		}
	}
}
