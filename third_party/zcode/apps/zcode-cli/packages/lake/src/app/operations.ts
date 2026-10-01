import type { JsonValue } from "../domain/json.js";
import { command, FIXED_READ_CHECKS, object, redact, text, type Params } from "../domain/validation.js";
import type { RuntimePorts } from "./ports.js";

interface PendingApproval { resolve(approved: boolean): void }
export class OperationsService {
  private readonly approvals = new Map<string, PendingApproval>();
  constructor(private readonly ports: RuntimePorts) {}
  respond(id: string, approved: boolean): void {
    const pending = this.approvals.get(id);
    if (!pending) throw new Error("审批已过期或不属于当前任务");
    this.approvals.delete(id); pending.resolve(approved);
  }
  private approve(id: string, resource: Params, body: string, signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      const abort = () => { this.approvals.delete(id); resolve(false); };
      this.approvals.set(id, { resolve: approved => { signal.removeEventListener("abort", abort); resolve(approved); } });
      signal.addEventListener("abort", abort, { once: true });
      this.ports.emit({ type: "approval", id, kind: "ssh", path: `${resource.lake}/${resource.name}`, command: body });
      if (signal.aborted) abort();
    });
  }
  async run(method: string, p: Params, id: string, signal: AbortSignal): Promise<JsonValue> {
    const resource = object(await this.ports.data.request("res.get", { resource: text(p, "resource") }));
    if (!resource.execute_authz || resource.kind !== "host") throw new Error("SSH 资源未授权执行");
    const read = method === "ops.read", check = text(p, "check"), body = read ? FIXED_READ_CHECKS[check] : command(text(p, "command"));
    if (!body) throw new Error("未知的固定只读检查");
    const policy = object(await this.ports.data.request("permissions.get", {}));
    const target = `${resource.lake}/${resource.name}`, risk = read ? "read" : "write", tool = read ? "lake_ssh_read" : "lake_ssh_command";
    const audit = (event: string, detail = "", result: Params = {}) => this.ports.data.request("journal.append", { action_id: id, run_id: text(p, "run_id"), actor: text(p, "actor", "agent"), target_path: target, risk, tool, event, detail, exit_code: result.exit_code ?? null, duration_ms: result.duration_ms ?? null });
    await audit("requested", read ? check : redact(body, 2048));
    const silent = read ? policy.silent_ssh_read : policy.silent_ssh_command;
    if (!silent || p.require_approval === true) {
      await audit("proposed");
      if (!(await this.approve(id, resource, body, signal))) { await audit("denied"); throw new Error("执行未获批准"); }
    }
    signal.throwIfAborted();
    const current = object(await this.ports.data.request("res.get", { resource: String(resource.id) }));
    if (!current.execute_authz || JSON.stringify(current) !== JSON.stringify(resource)) { await audit("denied", "审批后资源身份或授权已改变"); throw new Error("资源授权或身份已改变，请重新发起检查"); }
    await audit("approved");
    const credential = object(await this.ports.data.request("res.credential", { resource: String(resource.id) }));
    signal.throwIfAborted();
    await audit("started");
    try {
      const result = object(await this.ports.execution.request("transport.ssh", { resource, credential_ref: credential.ref, command: body, timeout_ms: p.timeout_ms ?? (read ? 30_000 : 120_000) }, signal));
      await audit(text(result, "status"), text(result, "error"), result);
      this.ports.emit({ type: "tool_result", id, path: target, text: String(result.stdout), status: result.status });
      return result;
    } catch (error) {
      await audit("failed", redact(error instanceof Error ? error.message : String(error)));
      throw error;
    }
  }
}
