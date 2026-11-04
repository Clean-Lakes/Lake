package web

import (
	"context"
	"sort"
	"strings"
	"time"
)

// Derive both transcript copies from the same canonical routing identity.
// Never insert these presentation messages into model history or user sources.
func (b *Server) pilotDispatchMessages(ctx context.Context, project string, workerSessions ...string) []Object {
	rows, err := b.Engine.PilotDispatches(ctx, project, workerSessions...)
	aiFailure(err)
	out := []Object{}
	b.Store.read(func() any {
		for _, row := range rows {
			source := b.Store.row("SELECT m.id,m.files,m.images FROM superagentInputs i JOIN messages m ON m.id=i.messageId AND m.sessionId=i.sessionId JOIN sessions s ON s.id=m.sessionId WHERE i.eventId=? AND i.ready=1 AND m.id=? AND m.sessionId=? AND m.role='user' AND s.projectId=?", row.EventID, row.SourceMessageID, row.PilotSessionID, project)
			if source == nil || strings.TrimSpace(row.Instruction) == "" {
				continue
			}
			prefix := "，请去做一下："
			if row.Action == "followup" {
				prefix = "，请继续处理："
			}
			message := Object{"id": "pilot_dispatch_" + row.ID, "sessionId": row.PilotSessionID, "role": "assistant", "text": "@" + row.RoleName + prefix + row.Instruction, "createdAt": row.CreatedAt.UTC().Format(time.RFC3339Nano), "dispatch": Object{"id": row.ID, "sourceMessageId": row.SourceMessageID, "workerId": row.WorkerID, "sessionId": row.SessionID, "taskId": row.TaskID, "roleId": row.RoleID, "roleName": row.RoleName, "channelSessionId": row.ChannelSessionID, "instruction": row.Instruction, "action": row.Action}}
			message["files"] = objects(parsed(stringOf(source["files"])))
			images := objects(parsed(stringOf(source["images"])))
			for _, im := range images {
				im["base64"] = ""
				im["url"] = "/api/sessions/" + row.PilotSessionID + "/messages/" + row.SourceMessageID + "/images/" + stringOf(im["id"])
			}
			if len(images) > 0 {
				message["images"] = images
			}
			out = append(out, message)
		}
		return nil
	})
	return out
}

func appendPilotDispatchMessages(snap Object, messages []Object) {
	all := append(objects(snap["messages"]), messages...)
	sort.SliceStable(all, func(i, j int) bool {
		a, _ := time.Parse(time.RFC3339Nano, stringOf(all[i]["createdAt"]))
		b, _ := time.Parse(time.RFC3339Nano, stringOf(all[j]["createdAt"]))
		return a.Before(b)
	})
	snap["messages"] = all
}
