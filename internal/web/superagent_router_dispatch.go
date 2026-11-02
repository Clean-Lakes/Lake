package web

import "github.com/Clean-Lakes/Lake/internal/ai"

// Backlog/handbacks have the same serialized Router and host message outbox as
// a fresh user turn. This is invocation admission; ADK still owns the loop.
func (b *Server) startSuperRouter(domain ai.SuperProject) {
	if b.Context.Err() != nil || b.Models.Active() == nil {
		return
	}
	pending, err := b.Engine.PendingSuperProjectEvents(b.Context, domain.ProjectID, 16)
	if err != nil || len(pending) == 0 {
		return
	}
	b.messageMu.Lock()
	if b.messageBusyLocked(domain.RouterSessionID) {
		b.messageMu.Unlock()
		return
	}
	if b.runningMessages == nil {
		b.runningMessages = map[string]bool{}
	}
	b.runningMessages[domain.RouterSessionID] = true
	b.workers.Add(1)
	b.messageMu.Unlock()
	go func() {
		defer b.workers.Done()
		defer b.finishMessageQueue(domain.RouterSessionID)
		defer func() {
			if recover() != nil {
				b.Store.Status(domain.RouterSessionID, "failed")
			}
		}()
		b.configure(domain.RouterSessionID, nil)
		err := b.Engine.RunPilotRouter(b.Context, domain.RouterSessionID, b.superUserSource(domain.ProjectID, domain.RouterSessionID))
		if err != nil {
			b.Store.Status(domain.RouterSessionID, "failed")
			return
		}
		b.deliverPendingSuperReports(domain)
		_ = b.reconcileMemoryOutboxForSession(domain.RouterSessionID)
		b.Store.Status(domain.RouterSessionID, "completed")
		b.startSuperWorkers(domain)
	}()
}
