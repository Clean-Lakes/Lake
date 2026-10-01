import type { JsonValue } from "../../domain/json.js";
import { TASK_CREDENTIAL, validateTaskState } from "../../domain/checkpoint.js";
import { integer, object, text, type Params } from "../../domain/validation.js";
import { LakeDatabase, timeView } from "./database.js";

export class SummaryRepository {
  constructor(private readonly db: LakeDatabase) {}
  request(method: string, p: Params): JsonValue {
    const id = text(p, "id"); this.db.one("SELECT id FROM conversation WHERE id=?", id);
    if (method === "conversation.summary") {
      const row = this.db.all("SELECT conversation_id,through_seq,text,source_event_ids,token_estimate,created_at,task_state FROM conversation_summary WHERE conversation_id=? ORDER BY through_seq DESC LIMIT 1", id)[0];
      if (!row) return null;
      row.source_event_ids = JSON.parse(String(row.source_event_ids)) as number[];
      row.task_state = validateTaskState(JSON.parse(String(row.task_state)) as JsonValue, row.source_event_ids as number[]);
      return timeView(row);
    }
    if (method !== "conversation.save_summary") throw new Error("未知的摘要命令");
    const through = integer(p, "through_seq"), value = text(p, "text"), estimate = integer(p, "token_estimate"), sources = p.source_event_ids;
    if (through < 1 || !value.trim() || Buffer.byteLength(value) > 65536 || TASK_CREDENTIAL.test(value) || estimate < 0 || !Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length || sources.some(source => typeof source !== "number" || !Number.isSafeInteger(source) || source < 1 || source > through)) throw new Error("摘要来源、范围或内容无效");
    const state = validateTaskState(p.task_state ?? null, sources as number[]);
    return this.db.transaction(() => {
      const latest = Number(this.db.one("SELECT COALESCE(MAX(seq),0) latest FROM conversation_event WHERE conversation_id=?", id).latest);
      if (through > latest) throw new Error("摘要超出最新事件");
      const rows = this.db.all("SELECT e.seq,e.kind,CASE WHEN e.kind='question_answered' THEN json_extract(e.payload,'$.answers_json') ELSE COALESCE(t.prompt,json_extract(e.payload,'$.preview'),'') END original FROM conversation_event e LEFT JOIN conversation_turn t ON t.id=e.legacy_turn_id WHERE e.conversation_id=? AND e.seq<=?", id, through);
      const byID = new Map(rows.map(row => [Number(row.seq), row]));
      if ((sources as number[]).some(source => !byID.has(source))) throw new Error("摘要来源不属于此会话");
      for (const group of ["goals", "constraints"]) for (const value of state?.[group] as JsonValue[] | undefined ?? []) {
        const fact = object(value);
        for (const source of fact.source_event_ids as number[]) { const row = byID.get(source); if (!row || !["user", "question_answered"].includes(String(row.kind)) || !String(row.original).includes(text(fact, "text"))) throw new Error("任务目标或约束必须引用用户原话"); }
      }
      const changed = this.db.run(`INSERT INTO conversation_summary(conversation_id,through_seq,text,source_event_ids,token_estimate,created_at,task_state) VALUES(?,?,?,?,?,?,?)
ON CONFLICT(conversation_id,through_seq) DO UPDATE SET text=excluded.text,source_event_ids=excluded.source_event_ids,token_estimate=excluded.token_estimate,created_at=excluded.created_at,task_state=excluded.task_state
WHERE NOT EXISTS(SELECT 1 FROM json_each(conversation_summary.source_event_ids) old WHERE NOT EXISTS(SELECT 1 FROM json_each(excluded.source_event_ids) fresh WHERE fresh.value=old.value))`, id, through, value, JSON.stringify(sources), estimate, Date.now(), JSON.stringify(state));
      if (!changed) throw new Error("摘要修订不能丢失既有来源"); return null;
    });
  }
}
