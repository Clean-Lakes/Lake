import type { JsonValue } from "../../domain/json.js";
import { integer, object, redact, text, type Params, type View } from "../../domain/validation.js";
import { LakeDatabase, newID, timeView } from "./database.js";
import { CatalogRepository } from "./catalog.js";
import { checkedEvent } from "../../domain/events.js";
import { checkedImages } from "../../domain/images.js";

const CONVERSATION = `SELECT c.*,l.name lake,p.name project_name,p.path project_path,w.name remote_workspace_name,w.remote_root,r.spec remote_spec
FROM conversation c JOIN lake l ON l.id=c.lake_id LEFT JOIN code_project p ON p.id=c.project_id LEFT JOIN code_workspace w ON w.id=c.remote_workspace_id LEFT JOIN resource r ON r.id=w.resource_id`;

export class HistoryRepository {
  constructor(private readonly db: LakeDatabase, private readonly catalog: CatalogRepository) {}
  private conversation(row: View): View {
    const spec = row.remote_spec ? JSON.parse(String(row.remote_spec)) as { ssh?: View } : {};
    delete row.remote_spec; delete row.archived_at;
    if (spec.ssh) {
      row.remote_host = spec.ssh.host; row.remote_username = spec.ssh.username; row.remote_port = spec.ssh.port;
    }
    return timeView(row);
  }
  private events(id: string, after: number, limit: number): View[] {
    return this.db.all("SELECT conversation_id,seq sequence,kind,actor,tool_call_id,legacy_turn_id,payload,created_at FROM conversation_event WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?", id, after, limit)
      .map(row => timeView({ ...row, payload: JSON.parse(String(row.payload)) as JsonValue }));
  }
  private append(id: string, kind: string, actor: string, payload: JsonValue, tool = "", turn: string | null = null): View {
    this.db.one("SELECT id FROM conversation WHERE id=? AND archived_at IS NULL", id);
    if (tool.length > 128) throw new Error("事件工具 ID 过长");
    payload = checkedEvent(kind, payload);
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) > 65536 || !["user", "agent", "assistant", "system", "cli"].includes(actor)) throw new Error("无效的事件");
    return this.db.transaction(() => {
      const seq = Number(this.db.one("SELECT COALESCE(MAX(seq),0)+1 next FROM conversation_event WHERE conversation_id=?", id).next);
      const now = Date.now();
      this.db.run("INSERT INTO conversation_event(conversation_id,seq,kind,actor,tool_call_id,legacy_turn_id,payload,created_at) VALUES(?,?,?,?,?,?,?,?)", id, seq, kind, actor, tool, turn, encoded, now);
      this.db.run("UPDATE conversation SET updated_at=? WHERE id=?", now, id);
      return { conversation_id: id, sequence: seq, kind, actor, tool_call_id: tool, payload, created_at: new Date(now).toISOString() };
    });
  }
  request(method: string, p: Params): JsonValue {
    const id = text(p, "id");
    switch (method) {
      case "conversation.list": return this.db.all(CONVERSATION + ` WHERE c.archived_at IS ${p.archived === true ? "NOT " : ""}NULL ORDER BY c.updated_at DESC,c.id`).map(row => this.conversation(row));
      case "conversation.create": {
        const lake = this.catalog.lake(text(p, "lake")), created = newID(), now = Date.now();
        this.db.run("INSERT INTO conversation(id,lake_id,title,created_at,updated_at) VALUES(?,?,'新会话',?,?)", created, String(lake.id), now, now);
        return this.conversation(this.db.one(CONVERSATION + " WHERE c.id=?", created));
      }
      case "conversation.get": return this.conversation(this.db.one(CONVERSATION + " WHERE c.id=?", id));
      case "conversation.show": {
        const conversation = this.conversation(this.db.one(CONVERSATION + " WHERE c.id=?", id));
        const turns = this.db.all("SELECT t.*,COALESCE((SELECT seq FROM conversation_event WHERE legacy_turn_id=t.id AND kind='user' AND conversation_id=t.conversation_id),0) user_event_seq,COALESCE((SELECT seq FROM conversation_event WHERE legacy_turn_id=t.id AND kind='assistant' AND conversation_id=t.conversation_id),0) assistant_event_seq FROM conversation_turn t WHERE conversation_id=? ORDER BY t.rowid", id)
          .map(row => { delete row.conversation_id; return timeView({ ...row, images: JSON.parse(String(row.images)) as JsonValue, specialists: JSON.parse(String(row.specialists)) as JsonValue }); });
        const events: View[] = []; let page: View[];
        do { page = this.events(id, Number(events.at(-1)?.sequence ?? 0), 1000); events.push(...page); } while (page.length === 1000);
        return { conversation, turns, events };
      }
      case "conversation.rename": {
        const title = text(p, "title").trim();
        if (!title || title.length > 200) throw new Error("无效的会话标题");
        if (!this.db.run("UPDATE conversation SET title=?,updated_at=? WHERE id=?", title, Date.now(), id)) throw new Error("会话不存在");
        return this.request("conversation.get", p);
      }
      case "conversation.archive": case "conversation.restore": {
        if (!this.db.run("UPDATE conversation SET archived_at=?,updated_at=? WHERE id=?", method.endsWith("archive") ? Date.now() : null, Date.now(), id)) throw new Error("会话不存在");
        return null;
      }
      case "conversation.events": return this.events(id, integer(p, "after"), Math.min(1000, Math.max(1, integer(p, "limit", 500))));
      case "conversation.append_event": return this.append(id, text(p, "kind"), text(p, "actor", "agent"), p.payload ?? {}, text(p, "tool_call_id"));
      case "conversation.append_events": {
        if (!Array.isArray(p.events) || p.events.length > 16) throw new Error("事件批次数量无效");
        return this.db.transaction(() => (p.events as JsonValue[]).map(value => { const event = object(value); return this.append(id, text(event, "kind"), "agent", event.payload ?? {}); }));
      }
      case "conversation.begin_turn": {
        return this.db.transaction(() => {
          const turn = newID(), prompt = redact(text(p, "prompt"), 100000), images = checkedImages(p.images ?? []), now = Date.now();
          this.db.run("INSERT INTO conversation_turn(id,conversation_id,prompt,images,created_at) VALUES(?,?,?,?,?)", turn, id, prompt, JSON.stringify(images), now);
          const event = this.append(id, "user", "user", { preview: redact(prompt, 4000), truncated: prompt.length > 4000 }, "", turn);
          return { id: turn, event };
        });
      }
      case "conversation.finish_turn": {
        return this.db.transaction(() => {
          const turn = text(p, "turn_id"), answer = redact(text(p, "answer"), 2_000_000), error = redact(text(p, "error"));
          const display = text(p, "display"), specialists = p.specialists ?? [];
          if (!Array.isArray(specialists) || specialists.length > 32 || JSON.stringify(specialists).length > 16384) throw new Error("专员结果摘要无效");
          const safeDisplay = redact(display, 2_000_000);
          if (!this.db.run("UPDATE conversation_turn SET answer=?,display=?,error=?,specialists=? WHERE id=? AND conversation_id=?", answer, safeDisplay, error, redact(JSON.stringify(specialists), 16384), turn, id)) throw new Error("轮次不属于此会话");
          return this.append(id, "assistant", "agent", { preview: redact(answer, 4000), truncated: answer.length > 4000 }, "", turn);
        });
      }
      case "conversation.execution": {
        const sequence = integer(p, "sequence");
        const row = this.db.one("SELECT payload,actor FROM conversation_event WHERE conversation_id=? AND seq=? AND kind='execution_finished'", id, sequence);
        return { ...(JSON.parse(String(row.payload)) as View), sequence, actor: row.actor };
      }
      case "conversation.append_execution": {
        const record = { ...object(p.record) }, actor = text(record, "actor");
        if (!text(record, "id") || !text(record, "scope_id") || !text(record, "session_id") || !["user", "agent"].includes(actor) || !["running", "completed", "failed", "unknown"].includes(text(record, "status"))) throw new Error("执行记录标识或状态无效");
        delete record.sequence;
        for (const key of ["command", "stdout", "stderr", "error"]) { const value = text(record, key), limit = key === "command" ? 4000 : key === "error" ? 2048 : 16384; record[key] = redact(value, limit); if (value.length > limit) record.truncated = true; }
        const kind = record.status === "running" ? "execution_started" : "execution_finished", event = this.append(id, kind, actor, record, text(record, "id"));
        return { record: { ...object(event.payload), sequence: event.sequence, actor }, event };
      }
      case "journal.append": {
        const detail = redact(text(p, "detail"));
        this.db.run("INSERT INTO journal(ts,run_id,action_id,actor,target_path,tool,risk,event,detail,exit_code,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)", Date.now(), text(p, "run_id") || null, text(p, "action_id"), text(p, "actor", "agent"), text(p, "target_path"), text(p, "tool"), text(p, "risk", "read"), text(p, "event"), detail, typeof p.exit_code === "number" ? p.exit_code : null, typeof p.duration_ms === "number" ? p.duration_ms : null);
        return null;
      }
      case "journal.list": {
        const filters: string[] = [], values: string[] = [];
        for (const key of ["target_path", "run_id", "action_id"]) if (p[key]) { filters.push(`${key}=?`); values.push(text(p, key)); }
        return this.db.all(`SELECT id,ts timestamp,run_id,action_id,actor,target_path,tool,risk,event,detail,exit_code,duration_ms FROM journal ${filters.length ? "WHERE " + filters.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, ...values, Math.min(1000, Math.max(1, integer(p, "limit", 100)))).map(timeView);
      }
      default: throw new Error(`未知的历史命令 ${method}`);
    }
  }
}
