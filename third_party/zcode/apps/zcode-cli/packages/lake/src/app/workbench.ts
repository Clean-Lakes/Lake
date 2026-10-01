import type { JsonValue } from "../domain/json.js";
import { object, text, type Params } from "../domain/validation.js";
import { terminalCommand } from "../domain/workspace.js";
import type { RuntimePorts } from "./ports.js";
import { ApprovalGate } from "./approval.js";

interface TerminalLease { project: Params; running: boolean; owner: "desktop" | "task" }
export class WorkbenchService {
  private readonly leases = new Map<string, TerminalLease>();
  private opening = false;
  constructor(private readonly ports: RuntimePorts, private readonly approvals: ApprovalGate) {}
  async request(method: string, p: Params, actionID: string, signal: AbortSignal): Promise<JsonValue> {
    if (method === "workbench.terminal.close") {
      const id = text(p, "id"), lease = this.leases.get(id);
      if (lease?.running) throw new Error("终端命令正在执行，请等待结果后关闭");
      this.leases.delete(id); return this.ports.execution.request(lease?.project.remote_root ? "remote.terminal.close" : "workspace.terminal.close", { id }, signal);
    }
    if (method === "workbench.terminal.status") {
      const id = text(p, "id"), lease = this.leases.get(id); if (!lease) return null;
      return this.ports.execution.request(lease.project.remote_root ? "remote.terminal.status" : "workspace.terminal.status", { id }, signal);
    }
    if (method === "workbench.terminal.run") return this.run(p, actionID, signal);
    const project = object(await this.ports.data.request("code.get", { id: text(p, "project_id") }));
    if (!project.lake_id) throw new Error("代码项目缺少湖范围");
    await this.ports.execution.request("workspace.validate", { root: project.path }, signal);
    if (method === "workbench.terminal.open") {
      if (this.opening || [...this.leases.values()].some(lease => lease.running)) throw new Error("终端已有操作正在执行");
      this.opening = true;
      try {
        const audit = await this.authorize(project, actionID, "lake_code_terminal_open", "每条命令仍须单独批准；命令从项目根目录启动", signal);
        for (const [id, lease] of this.leases) if (lease.owner === "desktop") await this.request("workbench.terminal.close", { id }, actionID, signal);
        await audit("started");
        const terminal = object(await this.ports.execution.request("workspace.terminal.open", { root: project.path }, signal));
        this.leases.set(text(terminal, "id"), { project, running: false, owner: "desktop" }); await audit("completed"); return terminal;
      } finally { this.opening = false; }
    }
    const actions: Record<string, string> = { "workbench.files": "workspace.files", "workbench.read": "workspace.read", "workbench.git": "workspace.git", "workbench.diff": "workspace.diff" };
    const action = actions[method]; if (!action) throw new Error("未知的代码工作台操作");
    return this.ports.execution.request(action, { ...p, root: project.path }, signal);
  }
  private async authorize(project: Params, id: string, tool: string, body: string, signal: AbortSignal, consent?: () => Promise<boolean>) {
    if (!this.ports.digest) throw new Error("工作区摘要适配器未配置");
    const detail = "arguments_sha256=" + this.ports.digest(body);
    const root = project.path ?? project.remote_root;
    if (project.remote_root && !project.authorized) throw new Error("远程任务工作区未授权");
    const audit = (event: string, result: Params = {}) => this.ports.data.request("journal.append", { action_id: id, actor: "cli", target_path: root, tool, risk: "write", event, detail, exit_code: result.exit_code ?? null, duration_ms: result.duration_ms ?? null });
    await audit("requested"); await audit("proposed");
    if (!(await (consent ? consent() : this.approvals.request(id, { type: "approval", kind: "code", path: root, command: body, native_dialog: true }, signal)))) { await audit("denied"); throw new Error("执行未获批准"); }
    signal.throwIfAborted();
    const fresh = await this.ports.data.request(project.remote_root ? "code.remote.get" : "code.get", { id: project.id });
    if (JSON.stringify(fresh) !== JSON.stringify(project)) { await audit("denied"); throw new Error("批准期间项目绑定已变化"); }
    if (!project.remote_root) await this.ports.execution.request("workspace.validate", { root }, signal);
    await audit("approved"); return audit;
  }
  private async run(p: Params, actionID: string, signal: AbortSignal): Promise<JsonValue> {
    const id = text(p, "id"), lease = this.leases.get(id), body = terminalCommand(text(p, "command"));
    if (!lease || lease.running || this.opening) throw new Error("终端不存在或已有命令在执行");
    lease.running = true;
    try {
      const audit = await this.authorize(lease.project, actionID, "lake_code_terminal_run", body, signal);
      await audit("started");
      const result = object(await this.ports.execution.request("workspace.terminal.run", { id, root: lease.project.path, command: body }, signal));
      await audit(text(result, "status"), result); return result;
    } finally { lease.running = false; }
  }
  async taskRun(project: Params, sessionID: string, body: string, actionID: string, signal: AbortSignal, started: (terminal: Params) => Promise<void>, consent?: () => Promise<boolean>): Promise<Params> {
    terminalCommand(body);
    let lease = sessionID ? this.leases.get(sessionID) : undefined;
    if (sessionID && (!lease || lease.owner !== "task" || JSON.stringify(lease.project) !== JSON.stringify(project))) throw new Error("任务终端绑定已变化");
    if (lease?.running) throw new Error("任务终端已有命令正在执行");
    if (lease) lease.running = true;
    try {
      const audit = await this.authorize(project, actionID, "lake_code_terminal_run", body, signal, consent);
      const physical = project.remote_root ? "remote" : "workspace", root = project.path ?? project.remote_root;
      let connection: Params = {};
      if (project.remote_root) {
        const fresh = object(await this.ports.data.request("code.remote.get", { id: project.id }));
        if (JSON.stringify(fresh) !== JSON.stringify(project)) throw new Error("远程终端主机绑定已变化");
        const resource = object(await this.ports.data.request("res.get", { resource: project.resource_id }));
        if (resource.kind !== "host" || resource.lake_id !== project.lake_id) throw new Error("远程终端主机范围无效");
        const credential = object(await this.ports.data.request("res.credential", { resource: project.resource_id }));
        connection = { resource, credential_ref: credential.ref };
      }
      if (!lease) {
        const terminal = object(await this.ports.execution.request(`${physical}.terminal.open`, { root, ...connection }, signal));
        sessionID = text(terminal, "id"); lease = { project, running: true, owner: "task" }; this.leases.set(sessionID, lease);
      }
      const terminal = object(await this.ports.execution.request(`${physical}.terminal.status`, { id: sessionID }, signal));
      if (terminal.closed) throw new Error("任务终端已关闭");
      await started(terminal); signal.throwIfAborted(); await audit("started");
      const result = object(await this.ports.execution.request(`${physical}.terminal.run`, { id: sessionID, root, command: body, ...connection }, signal));
      await audit(text(result, "status"), result);
      return { ...result, session_id: sessionID, terminal: { ...terminal, directory: result.next_directory, running: false, closed: result.status === "unknown" } };
    } finally { if (lease) lease.running = false; }
  }
}
