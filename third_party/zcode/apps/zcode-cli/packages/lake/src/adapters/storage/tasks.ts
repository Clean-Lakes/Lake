import type { JsonValue } from "../../domain/json.js";
import { name, object, redact, text, type Params } from "../../domain/validation.js";
import { LakeDatabase, newID, timeView } from "./database.js";
import { CatalogRepository } from "./catalog.js";

const digest = (s: string) => /^[a-f0-9]{64}$/u.test(s);
export class TasksRepository {
  constructor(private readonly db: LakeDatabase, private readonly catalog: CatalogRepository) {}
  request(method: string, p: Params): JsonValue {
    const id = text(p, "id");
    if (method === "specialist.tasks") return this.db.all("SELECT * FROM specialist_task ORDER BY updated_at DESC,id LIMIT 100").map(timeView);
    if (method === "specialist.list") return this.db.all("SELECT * FROM specialist_task WHERE parent_run_id=? ORDER BY created_at,id", text(p, "parent_run_id")).map(timeView);
    if (method === "specialist.get") return timeView(this.db.one("SELECT * FROM specialist_task WHERE id=?", id));
    if (method === "specialist.create") {
      const scope = JSON.stringify(object(p.scope)), request = text(p, "request_sha256");
      if (!id || !text(p, "parent_run_id") || !text(p, "model") || scope.length > 16384 || !digest(request)) throw new Error("专员任务元数据无效");
      const now = Date.now();
      this.db.run("INSERT INTO specialist_task(id,conversation_id,parent_run_id,parent_task_id,name,model,scope_json,request_sha256,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'delegated',?,?)", id, text(p, "conversation_id") || null, text(p, "parent_run_id"), text(p, "parent_task_id") || null, name(text(p, "name")), text(p, "model"), scope, request, now, now);
      return this.request("specialist.get", { id });
    }
    if (method === "specialist.update") {
      const status = text(p, "status"), response = text(p, "response_sha256"), from = status === "running" ? "delegated" : "running";
      if (!["running", "completed", "failed", "unknown"].includes(status) || (response && !digest(response)) || (status === "completed" && !response)) throw new Error("专员任务状态或摘要无效");
      if (!this.db.run("UPDATE specialist_task SET status=?,response_sha256=?,updated_at=? WHERE id=? AND status=?", status, response, Date.now(), id, from)) throw new Error("专员任务状态已变化");
      return this.request("specialist.get", { id });
    }
    if (method === "specialist.interrupted") { this.db.run("UPDATE specialist_task SET status='unknown',updated_at=? WHERE parent_run_id=? AND status IN ('delegated','running')", Date.now(), text(p, "parent_run_id")); return null; }
    if (method === "specialist.resume") {
      // The application must hold the private checkpoint lock before this CAS.
      if (!this.db.run("UPDATE specialist_task SET status='running',response_sha256='',updated_at=? WHERE id=? AND status IN ('delegated','running','failed','unknown')", Date.now(), id)) throw new Error("专员任务已完成或不存在");
      return this.request("specialist.get", { id });
    }
    if (method === "patrol.get") return timeView(this.db.one("SELECT * FROM patrol WHERE run_id=?", id));
    if (method === "patrol.start") {
      const prompt = redact(text(p, "prompt"), 100000); if (!prompt.trim()) throw new Error("巡检请求为空");
      const run = newID(); this.db.run("INSERT INTO patrol(run_id,prompt,status,started_at) VALUES(?,?,'running',?)", run, prompt, Date.now());
      return this.request("patrol.get", { id: run });
    }
    if (method === "patrol.finish") {
      const status = text(p, "status"); if (!["completed", "failed", "unknown"].includes(status)) throw new Error("巡检状态无效");
      if (!this.db.run("UPDATE patrol SET status=?,finished_at=? WHERE run_id=? AND status='running'", status, Date.now(), id)) throw new Error("巡检状态已变化");
      return this.request("patrol.get", { id });
    }
    if (method.startsWith("link.")) {
      const resource = this.catalog.resource(text(p, "resource"));
      if (method === "link.list") return this.db.all("SELECT * FROM link WHERE from_id=? OR to_id=? ORDER BY type,from_id,to_id", String(resource.id), String(resource.id)).map(timeView);
      if (method === "link.add") {
        const to = this.catalog.resource(text(p, "to")), type = text(p, "type");
        if (resource.id === to.id || !["depends_on", "part_of", "connects_to"].includes(type)) throw new Error("资源关系无效");
        this.db.run("INSERT INTO link(from_id,to_id,type,created_at) VALUES(?,?,?,?)", String(resource.id), String(to.id), type, Date.now());
        return this.request("link.list", p);
      }
    }
    throw new Error("未知的任务数据命令");
  }
}
