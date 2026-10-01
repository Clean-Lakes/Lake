import type { JsonValue } from "../../domain/json.js";
import { integer, text, type Params } from "../../domain/validation.js";
import { LakeDatabase, newID, timeView } from "./database.js";
import { CatalogRepository } from "./catalog.js";

export class MemoryRepository {
  constructor(private readonly db: LakeDatabase, private readonly catalog: CatalogRepository) {}
  request(method: string, p: Params): JsonValue {
    const lake = this.catalog.lake(text(p, "lake")), lakeID = String(lake.id);
    const enabled = this.db.all("SELECT enabled FROM memory_policy WHERE lake_id=?", lakeID)[0]?.enabled === 1;
    switch (method) {
      case "memory.show": return { lake_id: lakeID, lake: String(lake.name), enabled, facts: this.db.all("SELECT * FROM memory_fact WHERE lake_id=? AND deleted_at IS NULL ORDER BY updated_at DESC", lakeID).map(timeView) };
      case "memory.set": {
        this.db.run("INSERT INTO memory_policy(lake_id,enabled,updated_at) VALUES(?,?,?) ON CONFLICT(lake_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at", lakeID, p.enabled === true ? 1 : 0, Date.now());
        return this.request("memory.show", p);
      }
      case "memory.delete": {
        if (!this.db.run("UPDATE memory_fact SET deleted_at=?,updated_at=? WHERE id=? AND lake_id=?", Date.now(), Date.now(), text(p, "id"), lakeID)) throw new Error("记忆不存在");
        return null;
      }
      case "memory.edit": {
        const value = text(p, "text").trim();
        if (!value || value.length > 1024 || /(?:private key|api[_ -]?key|password|passwd|access[_ -]?token|secret|密码|私钥|密钥|访问令牌|口令)/iu.test(value)) throw new Error("无效或含敏感内容的记忆");
        if (!this.db.run("UPDATE memory_fact SET text=?,updated_at=? WHERE id=? AND lake_id=? AND deleted_at IS NULL", value, Date.now(), text(p, "id"), lakeID)) throw new Error("记忆不存在");
        return this.request("memory.show", p);
      }
      case "memory.add": {
        if (!enabled) throw new Error("跨会话记忆未启用");
        const value = text(p, "text").trim();
        if (!value || value.length > 1024 || /(?:private key|api[_ -]?key|password|passwd|access[_ -]?token|secret|密码|私钥|密钥|访问令牌|口令)/iu.test(value)) throw new Error("无效或含敏感内容的记忆");
        const conversation = text(p, "conversation_id"), sequence = integer(p, "source_event_seq");
        const source = this.db.one("SELECT c.lake_id,e.kind,e.payload FROM conversation_event e JOIN conversation c ON c.id=e.conversation_id WHERE e.conversation_id=? AND e.seq=?", conversation, sequence);
        if (source.lake_id !== lakeID || source.kind !== "user") throw new Error("记忆来源必须是同一湖的用户事件");
        const project = text(p, "project_id");
        if (project && this.db.one("SELECT lake_id FROM code_project WHERE id=?", project).lake_id !== lakeID) throw new Error("记忆项目不属于同一湖");
        const id = newID(), now = Date.now();
        this.db.run("INSERT INTO memory_fact(id,lake_id,project_id,source_conversation_id,source_event_seq,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", id, lakeID, project || null, conversation, sequence, value, now, now);
        return timeView(this.db.one("SELECT * FROM memory_fact WHERE id=?", id));
      }
      default: throw new Error(`未知的记忆命令 ${method}`);
    }
  }
}
