package web

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

type pilotReportPayload struct {
	Task ai.SuperTaskView `json:"task"`
	Text string           `json:"text"`
}

// Compatibility only: match the exact old host rendering for this outbox row.
// Never strip status-like text from user input or from the report's own prose.
func legacyPilotReportText(report ai.SuperReport, payload pilotReportPayload) string {
	if report.Kind == "router_reply" && report.TaskID == "" {
		return payload.Text
	}
	states := map[string]string{"queued": "排队中", "running": "执行中", "waiting_external": "等待外部结果", "waiting_user": "需要你回答", "paused": "已暂停", "blocked": "待核实", "completed": "已验收", "failed": "执行失败", "cancelled": "已停止后续跟进"}
	acceptance := map[string]string{"pass": "通过", "fail": "未通过", "insufficient": "条件尚不充分", "not_evaluated": "未验收"}
	return fmt.Sprintf("%s\n\n任务「%s」· %s · 验收：%s", payload.Text, payload.Task.Title, states[payload.Task.State], acceptance[payload.Task.AcceptanceState])
}

func (b *Server) projectPilotReportMessages(ctx context.Context, project, channel string, messages []Object) {
	ids := []string{}
	for _, message := range messages {
		if message["role"] == "assistant" {
			ids = append(ids, stringOf(message["id"]))
		}
	}
	reports, err := b.Engine.SuperHostReports(ctx, project, channel, ids)
	aiFailure(err)
	for _, message := range messages {
		report, ok := reports[stringOf(message["id"])]
		if !ok || message["role"] != "assistant" {
			continue
		}
		var payload pilotReportPayload
		if json.Unmarshal([]byte(report.Payload), &payload) == nil && message["text"] == legacyPilotReportText(report, payload) {
			message["text"] = payload.Text
		}
	}
}
