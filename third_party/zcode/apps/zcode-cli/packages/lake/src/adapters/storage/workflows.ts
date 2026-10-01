import type { JsonValue } from "../../domain/json.js";
import { integer, name, object, redact, text, type Params, type View } from "../../domain/validation.js";
import { validateWorkflow, V2_TRANSITIONS } from "../../domain/workflow.js";
import { LakeDatabase, newID, timeView } from "./database.js";
import { CatalogRepository } from "./catalog.js";

export class WorkflowRepository {
  constructor(private readonly db: LakeDatabase, private readonly catalog: CatalogRepository) {}
  private definition(id: string, v2: boolean): View {
    const row = this.db.one(`SELECT w.*,l.name lake FROM ${v2 ? "workflow_v2_definition" : "ops_workflow"} w JOIN lake l ON w.lake_id=l.id WHERE w.id=?`, id);
    const spec = JSON.parse(String(row[v2 ? "spec_json" : "spec"])) as JsonValue;
    delete row.spec_json; return timeView({ ...row, spec, enabled: row.enabled === 1 });
  }
  private run(id: string, v2: boolean): View {
    const row = this.db.one(`SELECT * FROM ${v2 ? "workflow_v2_run" : "ops_workflow_run"} WHERE id=?`, id);
    const spec = JSON.parse(String(row[v2 ? "spec_json" : "spec"])) as JsonValue;
    delete row.spec_json;
    if (v2) {
      const nodes = this.db.all("SELECT * FROM workflow_v2_node WHERE run_id=? ORDER BY rowid", id).map(node => {
        for (const field of ["input", "approval", "result"]) { node[field] = node[field + "_json"] ? JSON.parse(String(node[field + "_json"])) as JsonValue : null; delete node[field + "_json"]; }
        return timeView(node);
      });
      return timeView({ ...row, spec, nodes });
    }
    row.trigger = row.trigger_kind; delete row.trigger_kind;
    return timeView({ ...row, spec, steps: this.db.all("SELECT step_id,status,stdout,stderr,error,exit_code,started_at,finished_at FROM ops_workflow_step_run WHERE run_id=? ORDER BY rowid", id).map(timeView) });
  }
  private event(run: string, node: string, kind: string, payload: JsonValue, v2: boolean): void {
    if (v2) {
      const seq = Number(this.db.one("SELECT COALESCE(MAX(seq),0)+1 next FROM workflow_v2_event WHERE run_id=?", run).next);
      this.db.run("INSERT INTO workflow_v2_event(run_id,seq,node_id,kind,payload_json,created_at) VALUES(?,?,?,?,?,?)", run, seq, node, kind, JSON.stringify(payload), Date.now());
    } else this.db.run("INSERT INTO ops_workflow_event(run_id,step_id,status,message,ts) VALUES(?,?,?,?,?)", run, node, kind, typeof payload === "string" ? payload : JSON.stringify(payload), Date.now());
  }
  request(method: string, p: Params): JsonValue {
    const v2 = method.startsWith("workflow.v2."), action = method.slice(v2 ? "workflow.v2.".length : "workflow.".length);
    const table = v2 ? "workflow_v2_definition" : "ops_workflow", runTable = v2 ? "workflow_v2_run" : "ops_workflow_run", id = text(p, "id"), lake = text(p, "lake");
    const lakeID = lake ? String(this.catalog.lake(lake).id) : "";
    switch (action) {
      case "list": return this.db.all(`SELECT id FROM ${table} ${lakeID ? "WHERE lake_id=?" : ""} ORDER BY name,id`, ...(lakeID ? [lakeID] : [])).map(row => this.definition(String(row.id), v2));
      case "get": return this.definition(id, v2);
      case "save": case "amend": {
        const spec = object(p.spec), nodes = validateWorkflow(spec, v2 ? 2 : 1), encoded = JSON.stringify(spec);
        if (encoded.length > (v2 ? 256 : 64) * 1024 || !nodes.length) throw new Error("工作流定义过长");
        const target = action === "save" ? newID() : id, now = Date.now();
        if (action === "save") this.db.run(`INSERT INTO ${table}(id,lake_id,name,description,${v2 ? "spec_json" : "spec"},created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, target, lakeID, name(text(spec, "name")), text(spec, "description"), encoded, now, now);
        else {
          const current = this.definition(id, v2);
          if (lakeID && current.lake_id !== lakeID) throw new Error("工作流不属于选定湖");
          const changed = this.db.run(`UPDATE ${table} SET name=?,description=?,${v2 ? "spec_json" : "spec"}=?,updated_at=?${v2 ? ",revision=revision+1" : ""} WHERE id=?${v2 ? " AND revision=?" : ""}`, name(text(spec, "name")), text(spec, "description"), encoded, now, id, ...(v2 ? [integer(p, "expected_revision")] : []));
          if (!changed) throw new Error("工作流已被其他编辑更新，请刷新");
        }
        return this.definition(target, v2);
      }
      case "enable": {
        const current = this.definition(id, v2);
        if (lakeID && current.lake_id !== lakeID) throw new Error("工作流不属于选定湖");
        this.db.run(`UPDATE ${table} SET enabled=?,updated_at=? WHERE id=?`, p.enabled === true ? 1 : 0, Date.now(), id); return this.definition(id, v2);
      }
      case "runs": return this.db.all(`SELECT id FROM ${runTable} ${lakeID ? "WHERE lake_id=?" : ""} ORDER BY created_at DESC,rowid DESC LIMIT ?`, ...(lakeID ? [lakeID] : []), Math.min(100, Math.max(1, integer(p, "limit", 50)))).map(row => this.run(String(row.id), v2));
      case "status": return this.run(id, v2);
      case "events": return v2 ? this.db.all("SELECT run_id,seq sequence,node_id,kind,payload_json,created_at FROM workflow_v2_event WHERE run_id=? ORDER BY seq", id).map(row => { const payload = JSON.parse(String(row.payload_json)) as JsonValue; delete row.payload_json; return timeView({ ...row, payload }); }) : this.db.all("SELECT id,run_id,step_id,status,message,ts timestamp FROM ops_workflow_event WHERE run_id=? ORDER BY id", id).map(timeView);
      case "create_run": {
        const definition = this.definition(text(p, "definition_id"), v2);
        if (!definition.enabled) throw new Error("工作流已停用");
        const spec = object(p.spec ?? definition.spec), nodes = validateWorkflow(spec, v2 ? 2 : 1), run = newID(), now = Date.now(), trigger = text(p, "trigger", "desktop");
        if (!["agent", "cli", "desktop", "schedule"].includes(trigger)) throw new Error("无效的触发来源");
        this.db.transaction(() => {
          if (v2) this.db.run("INSERT INTO workflow_v2_run(id,definition_id,lake_id,name,revision,trigger,spec_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)", run, String(definition.id), String(definition.lake_id), String(definition.name), Number(definition.revision), trigger, JSON.stringify(spec), now, now);
          else this.db.run("INSERT INTO ops_workflow_run(id,workflow_id,lake_id,name,spec,trigger_kind,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)", run, String(definition.id), String(definition.lake_id), String(definition.name), JSON.stringify(spec), trigger, now);
          for (const node of nodes) {
            if (v2) this.db.run("INSERT INTO workflow_v2_node(run_id,node_id,status,updated_at) VALUES(?,?,'pending',?)", run, String(node.id), now);
            else this.db.run("INSERT INTO ops_workflow_step_run(run_id,step_id,status) VALUES(?,?,'pending')", run, String(node.id));
          }
          this.event(run, "", v2 ? "created" : "pending", v2 ? { status: "pending" } : "created", v2);
        });
        return this.run(run, v2);
      }
      case "run_status": {
        const status = text(p, "status"), message = redact(text(p, "message"), 4000);
        if (!(v2 ? ["pending", "running", "waiting_approval", "completed", "failed", "interrupted"] : ["running", "completed", "failed", "cancelled", "interrupted"]).includes(status)) throw new Error("运行状态无效");
        this.db.transaction(() => {
          let changed: number;
          if (v2) changed = this.db.run("UPDATE workflow_v2_run SET status=?,updated_at=? WHERE id=?", status, Date.now(), id);
          else if (status === "running") changed = this.db.run("UPDATE ops_workflow_run SET status='running',started_at=COALESCE(started_at,?),finished_at=NULL,error='' WHERE id=? AND status IN ('pending','interrupted','failed')", Date.now(), id);
          else changed = this.db.run("UPDATE ops_workflow_run SET status=?,finished_at=?,error=? WHERE id=? AND status='running'", status, Date.now(), message, id);
          if (!changed) throw new Error("工作流状态已变化");
          this.event(id, "", v2 ? "run_status" : status, v2 ? { status } : message, v2);
        }); return this.run(id, v2);
      }
      case "node_status": {
        const node = text(p, "node_id"), from = text(p, "from"), to = text(p, "to");
        this.db.transaction(() => {
          if (v2) {
            if (!V2_TRANSITIONS[from]?.includes(to)) throw new Error("工作流节点转换无效");
            const current = this.db.one("SELECT * FROM workflow_v2_node WHERE run_id=? AND node_id=?", id, node);
            const error = text(p, "error_code"); if (!/^[a-z0-9_]{0,64}$/u.test(error)) throw new Error("错误码无效");
            const encoded = (field: string) => p[field] !== undefined ? JSON.stringify(p[field]) : String(current[field + "_json"]);
            const snapshots = [encoded("input"), encoded("approval"), encoded("result")];
            if (snapshots.some(value => value.length > 65536)) throw new Error("节点快照过长");
            if (!this.db.run("UPDATE workflow_v2_node SET status=?,input_json=?,approval_json=?,result_json=?,error_code=?,updated_at=? WHERE run_id=? AND node_id=? AND status=?", to, ...snapshots, error, Date.now(), id, node, from)) throw new Error("节点状态已变化");
            this.event(id, node, "node_status", { from, to }, true);
          } else {
            if (!["pending", "running", "completed", "failed", "skipped", "unknown", "cancelled"].includes(to)) throw new Error("步骤状态无效");
            let changed: number;
            if (to === "running") changed = this.db.run("UPDATE ops_workflow_step_run SET status='running',started_at=?,finished_at=NULL,stdout='',stderr='',error='',exit_code=NULL WHERE run_id=? AND step_id=? AND status IN ('pending','failed','cancelled')", Date.now(), id, node);
            else if (to === "pending") changed = this.db.run("UPDATE ops_workflow_step_run SET status='pending',started_at=NULL,finished_at=NULL,stdout='',stderr='',error='',exit_code=NULL WHERE run_id=? AND step_id=? AND status IN ('unknown','failed','cancelled','completed','skipped')", id, node);
            else changed = this.db.run("UPDATE ops_workflow_step_run SET status=?,stdout=?,stderr=?,error=?,exit_code=?,finished_at=? WHERE run_id=? AND step_id=? AND status IN ('pending','running')", to, redact(text(p, "stdout")), redact(text(p, "stderr")), redact(text(p, "message"), 4000), typeof p.exit_code === "number" ? p.exit_code : null, Date.now(), id, node);
            if (!changed) throw new Error("步骤状态已变化");
            this.event(id, node, to, redact(text(p, "message"), 4000), false);
          }
        }); return this.run(id, v2);
      }
      default: throw new Error(`未知的工作流数据命令 ${action}`);
    }
  }
}
