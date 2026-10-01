import type { JsonValue } from "../../domain/json.js";
import { nextSchedule } from "../../domain/schedule.js";
import { integer, object, text, type Params, type View } from "../../domain/validation.js";
import { LakeDatabase, newID, timeView } from "./database.js";
import { CatalogRepository } from "./catalog.js";

const digest = (s: string) => /^[a-f0-9]{64}$/u.test(s);
function view(row: View): View {
  const result = timeView(row);
  for (const key of ["next_at", "lease_until", "due_at", "expires_at"]) if (typeof result[key] === "number") result[key] = new Date(Number(result[key])).toISOString();
  if ("enabled" in result) result.enabled = row.enabled === 1;
  return result;
}
export class SchedulesRepository {
  constructor(private readonly db: LakeDatabase, private readonly catalog: CatalogRepository) {}
  request(method: string, p: Params): JsonValue {
    const id = text(p, "id"), now = integer(p, "now_ms", Date.now()), owner = text(p, "owner"), lease = integer(p, "lease_ms", 60000);
    if (method === "schedule.get") return view(this.db.one("SELECT * FROM schedule WHERE id=?", id));
    if (method === "schedule.list") {
      const lake = text(p, "lake"), scope = lake ? String(this.catalog.lake(lake).id) : "";
      return this.db.all(`SELECT * FROM schedule ${scope ? "WHERE lake_id=?" : ""} ORDER BY created_at DESC,id`, ...(scope ? [scope] : [])).map(view);
    }
    if (method === "schedule.create") {
      const definition = this.db.one("SELECT * FROM workflow_v2_definition WHERE id=?", text(p, "workflow_id"));
      if (!definition.enabled) throw new Error("工作流已停用");
      const kind = text(p, "kind"), expression = text(p, "expression"), zone = text(p, "timezone", "Local"), next = nextSchedule(kind, expression, zone, now), schedule = newID();
      this.db.run("INSERT INTO schedule(id,lake_id,workflow_id,workflow_revision,kind,expression,timezone,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", schedule, String(definition.lake_id), String(definition.id), Number(definition.revision), kind, expression, zone, next, now, now);
      return this.request("schedule.get", { id: schedule });
    }
    if (method === "schedule.enable") {
      if (!this.db.run("UPDATE schedule SET enabled=?,updated_at=? WHERE id=?", p.enabled === true ? 1 : 0, now, id)) throw new Error("计划不存在");
      return this.request("schedule.get", { id });
    }
    if (method === "schedule.runs") return this.db.all("SELECT * FROM schedule_run WHERE schedule_id=? ORDER BY created_at DESC,id LIMIT 100", id).map(view);
    if (method === "schedule.run") return view(this.db.one("SELECT * FROM schedule_run WHERE id=?", id));
    if (method === "schedule.expire") return this.db.transaction(() => {
      const changed = this.db.run("UPDATE schedule_run SET status='unknown',reason='lease_expired',updated_at=? WHERE status IN ('claimed','running') AND schedule_id IN (SELECT id FROM schedule WHERE lease_until>0 AND lease_until<=?)", now, now);
      this.db.run("UPDATE schedule SET enabled=0,lease_owner='',lease_until=0,updated_at=? WHERE lease_until>0 AND lease_until<=?", now, now); return changed;
    });
    if (method === "schedule.claim") {
      if (!owner || lease < 1 || lease > 600000) throw new Error("计划认领参数无效");
      return this.db.transaction(() => {
        const schedule = this.db.all("SELECT * FROM schedule WHERE enabled=1 AND next_at<=? AND lease_until<=? ORDER BY next_at,id LIMIT 1", now, now)[0];
        if (!schedule) return null;
        const due = Number(schedule.next_at), next = schedule.kind === "once" ? null : nextSchedule(String(schedule.kind), String(schedule.expression), String(schedule.timezone), due);
        if (!this.db.run("UPDATE schedule SET next_at=?,lease_owner=?,lease_until=?,updated_at=? WHERE id=? AND next_at=? AND lease_until<=?", next, owner, now + lease, now, String(schedule.id), due, now)) throw new Error("计划已被其他进程认领");
        const run = newID(); this.db.run("INSERT INTO schedule_run(id,schedule_id,due_at,status,lease_owner,created_at,updated_at) VALUES(?,?,?,'claimed',?,?,?)", run, String(schedule.id), due, owner, now, now);
        return { schedule: this.request("schedule.get", { id: String(schedule.id) }), run: this.request("schedule.run", { id: run }) };
      });
    }
    if (method === "schedule.renew") {
      if (!owner || lease < 1 || lease > 600000 || !this.db.run("UPDATE schedule SET lease_until=?,updated_at=? WHERE id=? AND lease_owner=? AND lease_until>?", now + lease, now, id, owner, now)) throw new Error("计划租约已失效"); return null;
    }
    if (method === "schedule.update_run") return this.db.transaction(() => {
      const run = this.db.one("SELECT * FROM schedule_run WHERE id=?", id), schedule = this.db.one("SELECT * FROM schedule WHERE id=?", String(run.schedule_id)), status = text(p, "status"), reason = text(p, "reason");
      if (!["running", "waiting_approval", "completed", "failed", "missed", "unknown"].includes(status) || reason.length > 200 || !owner || run.lease_owner !== owner || !["claimed", "running"].includes(String(run.status)) || schedule.lease_owner !== owner || Number(schedule.lease_until) <= now) throw new Error("计划状态或认领租约无效");
      this.db.run("UPDATE schedule_run SET workflow_run_id=COALESCE(?,workflow_run_id),status=?,reason=?,updated_at=? WHERE id=? AND lease_owner=?", text(p, "workflow_run_id") || null, status, reason, now, id, owner);
      if (status !== "running") {
        const fail = status === "failed" || status === "unknown" ? 1 : 0, backoff = now + (fail ? 60000 * 2 ** Math.min(5, Number(schedule.fail_count)) : 0);
        this.db.run("UPDATE schedule SET lease_owner='',lease_until=0,fail_count=CASE WHEN ?=1 THEN fail_count+1 ELSE 0 END,enabled=CASE WHEN ?='unknown' THEN 0 ELSE enabled END,next_at=CASE WHEN ?=1 AND next_at IS NOT NULL AND next_at<? THEN ? ELSE next_at END,updated_at=? WHERE id=? AND lease_owner=?", fail, status, fail, backoff, backoff, now, String(schedule.id), owner);
      }
      return this.request("schedule.run", { id });
    });
    if (method === "schedule.grant") {
      const schedule = this.db.one("SELECT * FROM schedule WHERE id=?", id), definition = this.db.one("SELECT * FROM workflow_v2_definition WHERE id=?", String(schedule.workflow_id)), resource = this.catalog.resource(text(p, "resource")), node = text(p, "node_id"), hash = text(p, "command_sha256"), expiry = integer(p, "expires_ms"), maximum = integer(p, "max_runs");
      if (!schedule.enabled || definition.revision !== schedule.workflow_revision || !node || !digest(hash) || expiry <= now || maximum < 1 || maximum > 10000 || resource.lake_id !== schedule.lake_id || resource.kind !== "host" || !resource.execute_authz) throw new Error("计划授权参数或范围无效");
      const grant = newID(); this.db.run("INSERT INTO schedule_grant(id,schedule_id,workflow_revision,node_id,resource_id,command_sha256,expires_at,max_runs,created_at) VALUES(?,?,?,?,?,?,?,?,?)", grant, id, Number(schedule.workflow_revision), node, String(resource.id), hash, expiry, maximum, now);
      return view(this.db.one("SELECT * FROM schedule_grant WHERE id=?", grant));
    }
    if (method === "schedule.consume") return this.db.transaction(() => {
      const revision = integer(p, "revision"), schedule = this.db.one("SELECT d.revision,d.enabled,p.enabled schedule_enabled FROM schedule p JOIN workflow_v2_definition d ON d.id=p.workflow_id WHERE p.id=? AND p.workflow_revision=?", id, revision);
      if (schedule.revision !== revision || !schedule.enabled || !schedule.schedule_enabled || !Array.isArray(p.calls) || !p.calls.length) throw new Error("计划工作流版本已变化或停用");
      for (const value of p.calls) {
        const call = object(value), hash = text(call, "command_sha256");
        if (!digest(hash) || !this.db.run("UPDATE schedule_grant SET used_runs=used_runs+1 WHERE schedule_id=? AND workflow_revision=? AND node_id=? AND resource_id=? AND command_sha256=? AND expires_at>? AND used_runs<max_runs AND EXISTS(SELECT 1 FROM resource r JOIN schedule p ON p.id=schedule_grant.schedule_id WHERE r.id=schedule_grant.resource_id AND r.lake_id=p.lake_id AND r.kind='host' AND r.execute_authz=1)", id, revision, text(call, "node_id"), text(call, "resource_id"), hash, now)) throw new Error("节点缺少有效计划授权");
      }
      return null;
    });
    throw new Error("未知的计划数据命令");
  }
}
