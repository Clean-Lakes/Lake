package web

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func (b *Server) runSuperPilotTurn(ctx context.Context, domain ai.SuperProject, id, messageID string, refs, files []Object, ignoreMemory bool) {
	event, err := b.ReceiveUserEvent(ctx, id, messageID)
	if err == nil {
		err = b.recordSuperInput(event, refs, files, ignoreMemory)
	}
	if err == nil {
		err = b.Engine.RunPilotRouter(ctx, id, b.superUserSource(domain.ProjectID, id))
	}
	if err != nil {
		b.Store.AddMessage(id, "system", err.Error(), nil)
		b.Store.Status(id, "failed")
		return
	}
	b.deliverPendingSuperReports(domain)
	_ = b.reconcileMemoryOutboxForSession(id)
	b.Store.Status(id, "completed")
	b.startSuperWorkers(domain)
}

func (b *Server) deliverPendingSuperReports(domain ai.SuperProject) {
	if reports, err := b.Engine.PendingPilotReports(b.Context, domain.ProjectID); err == nil {
		for _, report := range reports {
			_ = b.DeliverPilotReport(b.Context, domain.ProjectID, domain.RouterSessionID, report.ID)
		}
	}
}

func (b *Server) startSuperWorkers(domain ai.SuperProject) {
	if b.Engine.ApplySuperStops(b.Context, domain.ProjectID) != nil {
		return
	}
	queued, err := b.Engine.SuperQueuedWorkers(b.Context, domain.ProjectID)
	if err != nil {
		return
	}
	for _, task := range queued {
		if _, exists := b.superWorkers.LoadOrStore(task.WorkerID, true); exists {
			continue
		}
		// Caller is already a registered turn/loop worker. Keep that parent
		// alive until every Add; Close can safely wait without a gate inversion.
		if b.Context.Err() != nil {
			b.superWorkers.Delete(task.WorkerID)
			return
		}
		b.workers.Add(1)
		go func(task ai.SuperRouteResult) {
			defer b.workers.Done()
			defer b.superWorkers.Delete(task.WorkerID)
			defer func() {
				if recover() != nil {
					b.Store.AddMessage(domain.RouterSessionID, "system", "专员派发中断，原任务与操作记录已保留，需核对后继续。", nil)
				}
			}()
			title := "专员工作"
			if goal, err := b.Engine.SuperTask(task.SessionID, task.TaskID); err == nil {
				title = goal.Title
			}
			b.ensureSuperWorkerSession(domain.ProjectID, task.SessionID, title)
			b.configure(task.SessionID, b.superWorkerTargetOptions(domain.ProjectID, task.WorkerID))
			c, err := b.Engine.ConfigForSession(task.SessionID)
			if err == nil {
				err = b.Engine.ConfigureTaskWorker(b.Context, domain.ProjectID, task.WorkerID, c)
			}
			if err == nil {
				err = b.Engine.ResumeTaskWorker(b.Context, domain.ProjectID, task.WorkerID)
			}
			if errors.Is(err, ai.ErrSuperWorkerQueued) {
				return
			}
			if err != nil && b.Context.Err() == nil {
				_ = b.Engine.RecordSuperDispatchFailure(b.Context, domain.ProjectID, task.WorkerID)
				b.Store.AddMessage(task.SessionID, "system", err.Error(), nil)
			}
			view, loadErr := b.Engine.SuperTask(task.SessionID, task.TaskID)
			if loadErr != nil {
				return
			}
			payload := "专员已保留当前工作进度。"
			if err == nil && (view.State == "waiting_external" || view.State == "running" || view.State == "queued") {
				return
			}
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

func (b *Server) runSuperTargetedInput(ctx context.Context, domain ai.SuperProject, id, messageID string, refs, files []Object, ignoreMemory bool) {
	task, err := b.Engine.SuperWorkerForSession(ctx, domain.ProjectID, id)
	var event ai.SuperEvent
	if err == nil {
		event, err = b.ReceiveUserEvent(ctx, id, messageID)
	}
	if err == nil {
		err = b.recordSuperInput(event, refs, files, ignoreMemory)
	}
	if err == nil && task.Protocol == "workflow" {
		b.startSuperRouter(domain)
		return
	}
	if err == nil {
		_, err = b.Engine.ApplySuperDecision(ctx, b.superUserSource(domain.ProjectID, domain.RouterSessionID), ai.SuperDecision{EventID: event.ID, PartKey: "targeted-followup", Action: "followup", TaskID: task.TaskID, Quote: event.Payload, Reason: "Authenticated user explicitly addressed this task's specialist"})
	}
	if err == nil {
		err = b.Engine.FinishSuperUserRouting(ctx, b.superUserSource(domain.ProjectID, domain.RouterSessionID), event.ID)
	}
	if err != nil {
		b.Store.AddMessage(id, "system", err.Error(), nil)
		b.Store.Status(id, "failed")
		return
	}
	_ = b.Engine.DeliverSuperFollowups(ctx, domain.ProjectID, task.WorkerID)
	_ = b.Engine.QueueSuperFollowup(ctx, domain.ProjectID, task.WorkerID)
	b.startSuperWorkers(domain)
}

func (b *Server) acceptSuperWorkerMessage(id string, message humanMessage, queuedID string) Object {
	project := stringOf(b.Store.Session(id)["projectId"])
	domain, active, err := b.Engine.SuperProject(b.Context, project)
	aiFailure(err)
	if !active {
		fail(409, "任务工作区尚未完成切换")
	}
	result := b.Store.update(func() any {
		var result Object
		if queuedID == "" {
			result = b.Store.message(id, "user", message.Text, message.Images)
		} else {
			row := b.Store.row("SELECT payload FROM queuedMessages WHERE id=? AND sessionId=?", queuedID, id)
			if row == nil {
				fail(409, "待发送消息已变化")
			}
			payload := object(parsed(stringOf(row["payload"])))
			if payload["text"] != message.Text {
				fail(409, "待发送消息内容已变化")
			}
			images := any(message.Images)
			if images == nil {
				images = []any{}
			}
			created := now()
			b.Store.exec("INSERT INTO messages(id,sessionId,role,text,images,createdAt) VALUES(?,?,?,?,?,?)", queuedID, id, "user", message.Text, jsonText(images), created)
			b.Store.exec("DELETE FROM queuedMessages WHERE id=? AND sessionId=?", queuedID, id)
			b.Store.queueChanged(id)
			b.Store.event(id, "message")
			result = Object{"id": queuedID, "sessionId": id, "role": "user", "text": message.Text, "createdAt": created}
		}
		b.Store.attachMessageFiles(id, result, publicMessageFiles(message.Files))
		b.Store.attachMessageMentions(id, result, message.Mentions)
		return result
	}).(Object)
	messageID := stringOf(result["id"])
	legacy := b.Store.superSessionKind(id) == "legacy"
	var task ai.SuperRouteResult
	if !legacy {
		task, err = b.Engine.SuperWorkerForSession(b.Context, project, id)
		aiFailure(err)
	}
	event, err := b.ReceiveUserEvent(b.Context, id, messageID)
	aiFailure(err)
	aiFailure(b.recordSuperInput(event, message.References, message.Files, message.IgnoreProjectMemory || legacy || task.Protocol == "workflow"))
	if legacy || task.Protocol == "workflow" {
		result["pilotSessionId"] = domain.RouterSessionID
		return result
	}
	_, err = b.Engine.ApplySuperDecision(b.Context, b.superUserSource(project, domain.RouterSessionID), ai.SuperDecision{EventID: event.ID, PartKey: "targeted-followup", Action: "followup", TaskID: task.TaskID, Quote: event.Payload, Reason: "Authenticated user explicitly addressed this specialist"})
	aiFailure(err)
	aiFailure(b.Engine.FinishSuperUserRouting(b.Context, b.superUserSource(project, domain.RouterSessionID), event.ID))
	_ = b.Engine.DeliverSuperFollowups(b.Context, project, task.WorkerID)
	_ = b.Engine.QueueSuperFollowup(b.Context, project, task.WorkerID)
	b.startSuperWorkers(domain)
	return result
}

func (b *Server) superWorkerTargetOptions(project, workerID string) Object {
	event, err := b.Engine.SuperWorkerOrigin(b.Context, project, workerID)
	aiFailure(err)
	_, err = b.resolveSuperInput(b.Context, event)
	aiFailure(err)
	var host superHostInput
	b.Store.read(func() any {
		row := b.Store.row("SELECT data FROM superagentInputs WHERE eventId=?", event.ID)
		if row == nil {
			fail(409, "原始任务目标上下文不可用")
		}
		must(json.Unmarshal([]byte(stringOf(row["data"])), &host))
		return nil
	})
	current := b.sessionOptions(event.ThreadRef)
	opts := Object{}
	for _, key := range []string{"runtime", "asset_ref", "terminal_id", "terminal_generation", "container_id"} {
		if value, ok := host.TargetOptions[key]; ok {
			opts[key] = value
		}
	}
	for _, key := range []string{"silentReadFiles", "silentWriteFiles", "silentReadSQL", "silentCommands", "silentTerminalCreation"} {
		opts[key] = host.TargetOptions[key] == true && current[key] == true
	}
	for _, key := range []string{"denyLocalExecution", "blockUnreferencedAssets"} {
		opts[key] = host.TargetOptions[key] == true || current[key] == true
	}
	return opts
}

func (b *Server) runSuperForwardedTurn(ctx context.Context, domain ai.SuperProject, id, messageID string, refs, files []Object) {
	event, err := b.ReceiveUserEvent(ctx, id, messageID)
	if err == nil {
		err = b.recordSuperInput(event, refs, files, true)
	}
	if err != nil {
		b.Store.AddMessage(id, "system", "原始输入尚未接纳，请核对来源记录。", nil)
		b.Store.Status(id, "failed")
		return
	}
	b.Store.Status(id, "completed")
	b.startSuperRouter(domain)
}
