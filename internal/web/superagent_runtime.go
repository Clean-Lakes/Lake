package web

import (
	"context"
	"errors"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func (b *Server) runSuperPilotTurn(ctx context.Context, domain ai.SuperProject, id, messageID string) {
	_, err := b.ReceiveUserEvent(ctx, id, messageID)
	if err == nil {
		err = b.Engine.RunPilotRouter(ctx, id, b.superUserSource(domain.ProjectID, id))
	}
	if err != nil {
		b.Store.AddMessage(id, "system", err.Error(), nil)
		b.Store.Status(id, "failed")
		return
	}
	view, err := b.Engine.Snapshot(id)
	if err != nil {
		b.Store.AddMessage(id, "system", err.Error(), nil)
		b.Store.Status(id, "failed")
		return
	}
	for i := len(view.Cards) - 1; i >= 0; i-- {
		if card := view.Cards[i]; card.Type == "message" && card.Content != "" {
			b.Store.AddMessage(id, "assistant", card.Content, nil)
			break
		}
	}
	_ = b.reconcileMemoryOutboxForSession(id)
	b.Store.Status(id, "completed")
	b.startSuperWorkers(domain)
}

func (b *Server) startSuperWorkers(domain ai.SuperProject) {
	queued, err := b.Engine.SuperQueuedWorkers(b.Context, domain.ProjectID)
	if err != nil {
		return
	}
	for _, task := range queued {
		if _, exists := b.superWorkers.LoadOrStore(task.WorkerID, true); exists {
			continue
		}
		b.gate.Lock()
		if b.closed {
			b.gate.Unlock()
			b.superWorkers.Delete(task.WorkerID)
			return
		}
		b.workers.Add(1)
		b.gate.Unlock()
		go func(task ai.SuperRouteResult) {
			defer b.workers.Done()
			defer b.superWorkers.Delete(task.WorkerID)
			defer func() {
				if recover() != nil {
					b.Store.AddMessage(domain.RouterSessionID, "system", "专员派发中断，原任务与操作记录已保留，需核对后继续。", nil)
				}
			}()
			b.Store.ensureSuperSession(domain.ProjectID, task.SessionID, "专员工作", "worker")
			b.configure(task.SessionID, nil)
			c, err := b.Engine.ConfigForSession(task.SessionID)
			if err == nil {
				err = b.Engine.ConfigureTaskWorker(b.Context, domain.ProjectID, task.WorkerID, c)
			}
			if err == nil {
				err = b.Engine.StartTaskWorker(b.Context, domain.ProjectID, task.WorkerID)
			}
			if errors.Is(err, ai.ErrSuperWorkerQueued) {
				return
			}
			if err != nil && b.Context.Err() == nil {
				b.Store.AddMessage(task.SessionID, "system", err.Error(), nil)
			}
			view, loadErr := b.Engine.SuperTask(task.SessionID, task.TaskID)
			if loadErr != nil {
				return
			}
			payload := "专员已保留当前工作进度。"
			if err != nil {
				payload = "专员本次执行中断，需核对原记录后继续。"
			}
			if snapshot, snapshotErr := b.Engine.Snapshot(task.SessionID); snapshotErr == nil {
				for i := len(snapshot.Cards) - 1; i >= 0; i-- {
					if card := snapshot.Cards[i]; card.Type == "message" && card.Content != "" {
						payload = card.Content
						break
					}
				}
			}
			report, reportErr := b.Engine.QueuePilotReport(b.Context, domain.ProjectID, task.SessionID, task.TaskID, domain.RouterSessionID, task.TaskID, "attention", payload, view.Revision)
			if reportErr == nil {
				_ = b.DeliverPilotReport(b.Context, domain.ProjectID, domain.RouterSessionID, report.ID)
			}
		}(task)
	}
}
