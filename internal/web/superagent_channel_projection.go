package web

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

const superChannelSchema = `
CREATE TABLE IF NOT EXISTS superagentRoleChannels(channelId TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),roleId TEXT NOT NULL,sessionId TEXT NOT NULL UNIQUE REFERENCES sessions(id),UNIQUE(projectId,roleId));
CREATE TABLE IF NOT EXISTS superagentChannelTimeline(channelId TEXT NOT NULL REFERENCES superagentRoleChannels(channelId),kind TEXT NOT NULL,sourceSessionId TEXT NOT NULL,sourceId TEXT NOT NULL,taskId TEXT NOT NULL DEFAULT '',workerId TEXT NOT NULL DEFAULT '',createdAt TEXT NOT NULL,PRIMARY KEY(channelId,kind,sourceSessionId,sourceId));
CREATE INDEX IF NOT EXISTS superagentChannelTimelinePage ON superagentChannelTimeline(channelId,createdAt,kind,sourceSessionId,sourceId);
CREATE TABLE IF NOT EXISTS superagentChannelCursors(channelId TEXT NOT NULL,sessionId TEXT NOT NULL,cardsThrough INTEGER NOT NULL,eventThrough INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(channelId,sessionId));`

func (b *Server) reconcileSpecialistChannels(ctx context.Context, project string) []ai.SpecialistChannel {
	channels, err := b.Engine.ListSpecialistChannels(ctx, project)
	aiFailure(err)
	for _, channel := range channels {
		b.Store.ensureSuperSession(project, channel.SessionID, channel.RoleName, "role")
		b.Store.update(func() any {
			b.Store.exec("INSERT INTO superagentRoleChannels(channelId,projectId,roleId,sessionId) VALUES(?,?,?,?) ON CONFLICT(channelId) DO NOTHING", channel.ID, project, channel.RoleID, channel.SessionID)
			return nil
		})
	}
	return channels
}

// Resolve both the channel and a direct task link to the same project role.
func (b *Server) specialistTasks(ctx context.Context, session string) []ai.SuperWorkerView {
	project := stringOf(b.Store.Session(session)["projectId"])
	switch b.Store.superSessionKind(session) {
	case "worker":
		channel, err := b.Engine.SpecialistChannelForWorker(ctx, project, session)
		aiFailure(err)
		session = channel.SessionID
	case "role":
	default:
		fail(404, "Specialist session required")
	}
	workers := b.channelWorkers(ctx, project, session)
	sort.SliceStable(workers, func(i, j int) bool { return workers[i].CreatedAt.After(workers[j].CreatedAt) })
	return workers
}

func (b *Server) channelWorkers(ctx context.Context, project, session string) []ai.SuperWorkerView {
	out := []ai.SuperWorkerView{}
	after := ""
	for {
		page, err := b.Engine.SpecialistChannelWorkers(ctx, project, session, after, 100)
		aiFailure(err)
		out = append(out, page...)
		if len(page) < 100 {
			return out
		}
		after = page[len(page)-1].ID
	}
}

func (b *Server) reconcileRoleChannelTimeline(ctx context.Context, ch ai.SpecialistChannel, workers []ai.SuperWorkerView) {
	for _, worker := range workers {
		b.ensureSuperWorkerSession(ch.ProjectID, worker.SessionID, worker.Task.Title)
		cursorState := b.Store.read(func() any {
			return Object{"saved": b.Store.row("SELECT cardsThrough,eventThrough FROM superagentChannelCursors WHERE channelId=? AND sessionId=?", ch.ID, worker.SessionID), "event": b.Store.row("SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE sessionId=?", worker.SessionID)["n"]}
		}).(Object)
		saved := object(cursorState["saved"])
		if len(saved) > 0 && integer(saved["eventThrough"]) == integer(cursorState["event"]) {
			continue
		}
		ids, err := b.Engine.SuperWorkerEventIDs(ctx, ch.ProjectID, worker.SessionID)
		aiFailure(err)
		b.Store.update(func() any {
			for _, id := range ids {
				row := b.Store.row("SELECT m.id,m.sessionId,m.createdAt FROM superagentInputs i JOIN messages m ON m.id=i.messageId AND m.sessionId=i.sessionId JOIN sessions s ON s.id=m.sessionId WHERE i.eventId=? AND s.projectId=?", id, ch.ProjectID)
				if row != nil {
					b.Store.exec("INSERT OR IGNORE INTO superagentChannelTimeline(channelId,kind,sourceSessionId,sourceId,createdAt) VALUES(?,'message',?,?,?)", ch.ID, row["sessionId"], row["id"], channelEntryTime(stringOf(row["createdAt"])))
				}
			}
			for _, message := range b.Store.rows("SELECT id,createdAt FROM messages m WHERE sessionId=? AND NOT EXISTS(SELECT 1 FROM superagentChannelTimeline t WHERE t.channelId=? AND t.kind='message' AND t.sourceSessionId=m.sessionId AND t.sourceId=m.id)", worker.SessionID, ch.ID) {
				b.Store.exec("INSERT OR IGNORE INTO superagentChannelTimeline(channelId,kind,sourceSessionId,sourceId,taskId,workerId,createdAt) VALUES(?,'message',?,?,?,?,?)", ch.ID, worker.SessionID, message["id"], worker.Task.TaskID, worker.ID, channelEntryTime(stringOf(message["createdAt"])))
			}
			return nil
		})
		through := b.Store.read(func() any {
			return integer(b.Store.row("SELECT cardsThrough FROM superagentChannelCursors WHERE channelId=? AND sessionId=?", ch.ID, worker.SessionID)["cardsThrough"])
		}).(int)
		before, total := 0, 0
		for {
			view, err := b.Engine.SnapshotPage(worker.SessionID, before, 300)
			aiFailure(err)
			if total == 0 {
				total = view.TotalCards
			}
			b.Store.update(func() any {
				for _, card := range view.Cards {
					if (card.Type == "message" || card.Type == "text") && strings.TrimSpace(card.Content) != "" {
						b.Store.exec("INSERT OR IGNORE INTO superagentChannelTimeline(channelId,kind,sourceSessionId,sourceId,taskId,workerId,createdAt) VALUES(?,'card',?,?,?,?,?)", ch.ID, worker.SessionID, card.ID, worker.Task.TaskID, worker.ID, channelEntryTime(card.At))
					}
				}
				return nil
			})
			if view.CardsOffset <= through || view.CardsOffset == 0 {
				break
			}
			before = view.CardsOffset
		}
		b.Store.update(func() any {
			b.Store.exec("INSERT INTO superagentChannelCursors(channelId,sessionId,cardsThrough,eventThrough) VALUES(?,?,?,?) ON CONFLICT(channelId,sessionId) DO UPDATE SET cardsThrough=MAX(cardsThrough,excluded.cardsThrough),eventThrough=excluded.eventThrough", ch.ID, worker.SessionID, total, cursorState["event"])
			return nil
		})
	}
	b.Store.update(func() any {
		for _, message := range b.Store.rows("SELECT id,createdAt FROM messages m WHERE sessionId=? AND NOT EXISTS(SELECT 1 FROM superagentChannelTimeline t WHERE t.channelId=? AND t.kind='message' AND t.sourceSessionId=m.sessionId AND t.sourceId=m.id)", ch.SessionID, ch.ID) {
			b.Store.exec("INSERT OR IGNORE INTO superagentChannelTimeline(channelId,kind,sourceSessionId,sourceId,createdAt) VALUES(?,'message',?,?,?)", ch.ID, ch.SessionID, message["id"], channelEntryTime(stringOf(message["createdAt"])))
		}
		return nil
	})
}

type roleChannelEntry struct {
	ID              string   `json:"id"`
	SourceSessionID string   `json:"sourceSessionId"`
	TaskID          string   `json:"taskId,omitempty"`
	WorkerID        string   `json:"workerId,omitempty"`
	CreatedAt       string   `json:"createdAt"`
	Message         Object   `json:"message,omitempty"`
	Card            *ai.Card `json:"card,omitempty"`
}

func (b *Server) roleChannelPage(ctx context.Context, session, cursor string, limit int) Object {
	host := b.Store.Session(session)
	project := stringOf(host["projectId"])
	ch, err := b.Engine.SpecialistChannelForSession(ctx, project, session)
	aiFailure(err)
	workers := b.channelWorkers(ctx, project, session)
	b.reconcileRoleChannelTimeline(ctx, ch, workers)
	args := []any{ch.ID}
	condition := ""
	if cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil {
			fail(400, "无效的频道分页位置")
		}
		var values []string
		if json.Unmarshal(raw, &values) != nil || len(values) != 4 {
			fail(400, "无效的频道分页位置")
		}
		condition = " AND (createdAt,kind,sourceSessionId,sourceId)<(?,?,?,?)"
		for _, v := range values {
			args = append(args, v)
		}
	}
	args = append(args, limit+1)
	rows := b.Store.read(func() any {
		return b.Store.rows("SELECT * FROM superagentChannelTimeline WHERE channelId=?"+condition+" ORDER BY createdAt DESC,kind DESC,sourceSessionId DESC,sourceId DESC LIMIT ?", args...)
	}).([]Object)
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		next = base64.RawURLEncoding.EncodeToString([]byte(jsonText([]any{last["createdAt"], last["kind"], last["sourceSessionId"], last["sourceId"]})))
	}
	ids := []string{}
	for _, row := range rows {
		if row["kind"] == "message" && row["sourceSessionId"] == session {
			ids = append(ids, stringOf(row["sourceId"]))
		}
	}
	origins, err := b.Engine.SpecialistReportOrigins(ctx, project, session, ids)
	aiFailure(err)
	entries := []roleChannelEntry{}
	snapshots := map[string]Object{}
	cardPages := map[string]map[string]ai.Card{}
	cardBefore := map[string]int{}
	for i := len(rows) - 1; i >= 0; i-- {
		row := rows[i]
		if origin, ok := origins[stringOf(row["sourceId"])]; ok {
			exists := b.Store.read(func() any {
				return b.Store.row("SELECT sourceId FROM superagentChannelTimeline WHERE channelId=? AND kind='card' AND sourceSessionId=? AND sourceId=?", ch.ID, origin.SessionID, origin.CardID) != nil
			}).(bool)
			if exists {
				continue
			}
		}
		source := stringOf(row["sourceSessionId"])
		if snapshots[source] == nil {
			snapshots[source] = b.Store.Snapshot(source)
		}
		entry := roleChannelEntry{ID: jsonText([]any{row["kind"], source, row["sourceId"]}), SourceSessionID: source, TaskID: stringOf(row["taskId"]), WorkerID: stringOf(row["workerId"]), CreatedAt: stringOf(row["createdAt"])}
		if row["kind"] == "message" {
			for _, m := range objects(snapshots[source]["messages"]) {
				if m["id"] == row["sourceId"] {
					entry.Message = m
					break
				}
			}
		} else {
			// Exact card lookup can page arbitrarily old history without loading it all.
			if cardPages[source] == nil {
				cardPages[source] = map[string]ai.Card{}
			}
			for {
				if card, ok := cardPages[source][stringOf(row["sourceId"])]; ok {
					entry.Card = &card
					break
				}
				before, loaded := cardBefore[source]
				if loaded && before == 0 {
					break
				}
				view, err := b.Engine.SnapshotPage(source, before, 300)
				aiFailure(err)
				for _, card := range view.Cards {
					cardPages[source][card.ID] = card
				}
				cardBefore[source] = view.CardsOffset
			}
		}
		// Old projection rows may reference a streaming placeholder. Keep it
		// in the original task for live progress, never as an empty history row.
		if entry.Message != nil || (entry.Card != nil && strings.TrimSpace(entry.Card.Content) != "") {
			entries = append(entries, entry)
		}
	}
	active := []Object{}
	for _, w := range workers {
		hostStatus := b.Store.Session(w.SessionID)["status"]
		if hostStatus != "investigating" && hostStatus != "waiting_approval" && w.AssignmentState != "active" && w.AssignmentState != "waiting_user" && w.Task.State != "waiting_user" && !b.Engine.NeedsQuestionRecovery(w.SessionID) {
			continue
		}
		view, err := b.Engine.Snapshot(w.SessionID)
		aiFailure(err)
		if view.ReplyStatus != "" || view.Question != nil || view.Pending != nil || view.Status == "waiting_input" {
			snap := b.sessionSnapshot(w.SessionID)
			snap["ai"] = b.contextView(view)
			snap["hostKeyTrust"] = b.hostKeyPrompt(w.SessionID)
			active = append(active, snap)
		}
	}
	sort.Slice(active, func(i, j int) bool {
		return stringOf(object(active[i]["session"])["id"]) < stringOf(object(active[j]["session"])["id"])
	})
	// A streaming reply stays in its actual task component until it settles;
	// its durable source reference then takes over at the same timeline time.
	liveCards := map[string]bool{}
	for _, snap := range active {
		view := snap["ai"].(ai.View)
		for _, card := range view.Cards {
			if view.TurnStartedAt != "" && card.At >= view.TurnStartedAt {
				liveCards[view.Session+"\x00"+card.ID] = true
			}
		}
	}
	visible := entries[:0]
	for _, entry := range entries {
		if entry.Card == nil || !liveCards[entry.SourceSessionID+"\x00"+entry.Card.ID] {
			visible = append(visible, entry)
		}
	}
	entries = visible
	routing, err := b.Engine.SpecialistChannelRouting(ctx, project, session)
	aiFailure(err)
	queued := 0
	for _, worker := range workers {
		if worker.AssignmentState == "queued" && (worker.Task.State == "running" || worker.Task.State == "queued") {
			queued++
		}
	}
	return Object{"channel": ch, "entries": entries, "nextCursor": next, "workers": workers, "active": active, "routing": routing, "queued": queued}
}

func (b *Server) roleChannelRoute(w http.ResponseWriter, r *http.Request, session string) {
	if r.Method == "POST" {
		b.protect(r)
		if !b.authorized(r) {
			fail(401, "Authentication required")
		}
		data := body(w, r, 1024)
		if data["action"] != "stop" {
			fail(400, "Unknown channel action")
		}
		project := stringOf(b.Store.Session(session)["projectId"])
		aiFailure(b.Engine.StopSpecialistChannel(r.Context(), project, session))
		b.Store.AddMessage(session, "system", "已停止本专员当前处理与待派发工作；原任务和操作记录保留，远端执行状态以原记录为准。", nil)
		reply(w, 200, Object{"stopped": true})
		return
	}
	if r.Method != "GET" {
		fail(405, "Method not allowed")
	}
	reply(w, 200, b.roleChannelPage(r.Context(), session, r.URL.Query().Get("cursor"), 50))
}

func channelEntryTime(value string) string {
	if at, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return at.UTC().Format("2006-01-02T15:04:05.000000000Z")
	}
	return value
}
