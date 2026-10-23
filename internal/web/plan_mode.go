package web

import "github.com/Clean-Lakes/Lake/internal/ai"

func (b *Server) conversationMode(id string) string {
	if b.Store.Options(id)["conversationMode"] == ai.ModePlan {
		return ai.ModePlan
	}
	return ai.ModeDefault
}

func (b *Server) assertModeChangeIdleLocked(id string) {
	if b.messageBusyLocked(id) || b.Store.ActiveWorkflowRun(id) != "" {
		fail(409, "本轮运行中，请结束后再切换模式或执行计划")
	}
	view, err := b.Engine.Snapshot(id)
	aiFailure(err)
	if view.Question != nil || len(view.PendingApprovals) > 0 {
		fail(409, "请先处理当前问题或操作确认，再切换模式")
	}
	if len(objects(b.Store.MessageQueue(id)["items"])) > 0 {
		fail(409, "请先处理待发送消息，再切换模式或执行计划")
	}
}

func (b *Server) setConversationMode(id string, data Object) Object {
	mode, ok := data["mode"].(string)
	if !ok || mode != ai.ModeDefault && mode != ai.ModePlan {
		fail(400, "模式须为 default 或 plan")
	}
	b.messageMu.Lock()
	defer b.messageMu.Unlock()
	b.assertModeChangeIdleLocked(id)
	// Mode changes do not change messages, resources or terminals. Publish a
	// small presentation delta instead of making every client reload the page.
	var saved Object
	b.configureWithSave(id, Object{"conversationMode": mode}, func(id string, options Object) {
		saved = b.Store.update(func() any {
			b.Store.session(id)
			b.Store.exec("INSERT INTO aiOptions(sessionId,value) VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET value=excluded.value", id, jsonText(options))
			b.Store.event(id, "session")
			event := b.Store.events[len(b.Store.events)-1]
			event["conversationMode"] = mode
			return Object{"mode": mode, "cursor": event["seq"]}
		}).(Object)
	})
	return saved
}

func (b *Server) executeProposedPlan(id string, data Object) Object {
	b.messageMu.Lock()
	defer b.messageMu.Unlock()
	b.assertModeChangeIdleLocked(id)
	if b.conversationMode(id) != ai.ModePlan {
		fail(409, "当前会话已退出 Plan 模式，请刷新后重试")
	}
	view, err := b.Engine.Snapshot(id)
	aiFailure(err)
	if b.Store.Session(id)["status"] != "completed" || view.Status != "completed" || view.ProposedPlan == nil || view.ProposedPlan.ID != stringOf(data["planId"]) {
		fail(409, "计划已更新或尚未完成，请审阅最新计划")
	}
	if b.Models.Active() == nil {
		fail(400, "尚未配置模型")
	}
	// Use the authoritative persisted content. The client supplies an ID only;
	// neither stale text nor a double click can silently replace the plan.
	message := b.validateHumanMessage(id, Object{"text": "请执行以下已确认的计划，并按计划验证结果；现有资源范围和操作权限继续生效。\n\n" + view.ProposedPlan.Content})
	b.configure(id, Object{"conversationMode": ai.ModeDefault})
	launched := false
	defer func() {
		if !launched {
			b.configure(id, Object{"conversationMode": ai.ModePlan})
		}
	}()
	result := b.beginHumanMessageLocked(id, message)
	launched = true
	return result
}
