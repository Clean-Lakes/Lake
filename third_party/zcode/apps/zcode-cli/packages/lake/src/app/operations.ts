import type { JsonValue } from "../domain/json.js";
import { command, FIXED_READ_CHECKS, object, redact, text, type Params } from "../domain/validation.js";
import type { RuntimePorts } from "./ports.js";
import { ApprovalGate } from "./approval.js";
import { inspectionSQL, kubeArgs, resourceIdentity } from "../domain/inspection.js";

export class OperationsService {
  constructor(private readonly ports: RuntimePorts, private readonly approvals = new ApprovalGate(ports.emit)) {}
  respond(id: string, approved: boolean): void {
    this.approvals.respond(id, approved);
  }
  async run(method: string, p: Params, id: string, signal: AbortSignal): Promise<JsonValue> {
    const resource = object(await this.ports.data.request("res.get", { resource: text(p, "resource") }));
    const ssh = method === "ops.read" || method === "ops.command", kube = method === "ops.k8s", database = method === "ops.database";
    if (!ssh && !kube && !database) throw new Error("未知的运维检查");
    if (!resource.execute_authz || (ssh && resource.kind !== "host") || (kube && resource.kind !== "k8s")) throw new Error("资源未授权执行或类型不符");
    if (p.expected_identity && resourceIdentity(resource) !== p.expected_identity) throw new Error("资源授权或身份已改变，请重新发起检查");
    const read = method !== "ops.command", check = text(p, "check"), body = kube ? kubeArgs(p, object(resource.k8s)).join(" ") : database ? inspectionSQL(text(resource, "kind"), check, text(object(resource.db), "database")) : read ? FIXED_READ_CHECKS[check] : command(text(p, "command"));
    if (!body) throw new Error("未知的固定只读检查");
    const policy = object(await this.ports.data.request("permissions.get", {}));
    const target = `${resource.lake}/${resource.name}`, risk = read ? "read" : "write", tool = kube ? "lake_k8s_get" : database ? "lake_database_inspect" : read ? "lake_ssh_read" : "lake_ssh_command";
    const audit = (event: string, detail = "", result: Params = {}) => this.ports.data.request("journal.append", { action_id: id, run_id: text(p, "run_id"), actor: text(p, "actor", "agent"), target_path: target, risk, tool, event, detail, exit_code: result.exit_code ?? null, duration_ms: result.duration_ms ?? null });
    await audit("requested", read ? check : redact(body, 2048));
    const silent = !ssh || (read ? policy.silent_ssh_read : policy.silent_ssh_command);
    if (!silent || p.require_approval === true) {
      await audit("proposed");
      if (!(await this.approvals.request(id, { type: "approval", kind: ssh ? "ssh" : "read", path: target, command: body }, signal, text(p, "turn_id")))) { await audit("denied"); throw new Error("执行未获批准"); }
    }
    signal.throwIfAborted();
    const current = object(await this.ports.data.request("res.get", { resource: String(resource.id) }));
    if (!current.execute_authz || JSON.stringify(current) !== JSON.stringify(resource)) { await audit("denied", "审批后资源身份或授权已改变"); throw new Error("资源授权或身份已改变，请重新发起检查"); }
    await audit("approved");
    const credential = object(await this.ports.data.request("res.credential", { resource: String(resource.id), optional: database }));
    signal.throwIfAborted();
    await audit("started");
    try {
      const result = object(await this.ports.execution.request(kube ? "transport.k8s" : database ? "transport.database" : "transport.ssh", { ...p, resource, credential_ref: credential.ref ?? "", command: body, timeout_ms: p.timeout_ms ?? (read ? 30_000 : 120_000) }, signal));
      await audit(text(result, "status"), text(result, "error"), result);
      this.ports.emit({ type: "tool_result", id, path: target, text: String(result.stdout), status: result.status });
      return result;
    } catch (error) {
      await audit("unknown", "派发后结果未能确认");
      throw error;
    }
  }
}
