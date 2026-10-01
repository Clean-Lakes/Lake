import type { JsonValue } from "../domain/json.js";
import { resourceIdentity } from "../domain/inspection.js";
import { object, text, type Params } from "../domain/validation.js";
import { remotePlan } from "../domain/remote.js";
import { terminalCommand } from "../domain/workspace.js";
import type { RuntimePorts } from "./ports.js";
import { ApprovalGate } from "./approval.js";

export class RemoteWorkbenchService {
  constructor(private readonly ports: RuntimePorts, private readonly approvals: ApprovalGate) {}
  async request(method: string, p: Params, action: string, signal: AbortSignal): Promise<JsonValue> {
    const workspace = object(await this.ports.data.request("code.remote.get", { id: text(p, "id") }));
    const resource = object(await this.ports.data.request("res.get", { resource: workspace.resource_id }));
    if (!workspace.authorized || resource.kind !== "host" || resource.lake_id !== workspace.lake_id) throw new Error("远程工作区未授权或主机绑定已变化");
    if (p.expected_identity && p.expected_identity !== resourceIdentity(resource)) throw new Error("远程主机身份已变化");
    const operation = method.replace("remote.workbench.", ""), write = operation === "run" || operation === "write" || operation.startsWith("terminal.");
    const target = `${workspace.lake}/${workspace.name}`, tool = `lake_remote_code_${operation}`, input = { ...p, root: workspace.remote_root };
    if (operation === "run" || operation === "terminal.run") terminalCommand(text(p, "command"));
    else if (!operation.startsWith("terminal.")) remotePlan("remote." + operation, input);
    const detail = "arguments_sha256=" + this.ports.digest!(JSON.stringify([operation, p.path ?? "", p.command ?? "", p.content ?? "", p.expected_sha256 ?? ""]));
    const audit = (event: string, result: Params = {}) => this.ports.data.request("journal.append", { action_id: action, actor: text(p, "actor", "cli"), target_path: target, risk: write ? "write" : "read", tool, event, detail, exit_code: result.exit_code ?? null, duration_ms: result.duration_ms ?? null });
    await audit("requested");
    if (write) {
      await audit("proposed");
      if (!(await this.approvals.request(action, { type: "approval", kind: "code", path: target, command: operation === "write" ? `写入 ${text(p, "path")}，校验原 SHA-256 ${text(p, "expected_sha256")}，新 SHA-256 ${this.ports.digest!(text(p, "content"))}` : text(p, "command", operation), native_dialog: true }, signal))) { await audit("denied"); throw new Error("远程操作未获批准"); }
    }
    signal.throwIfAborted();
    const current = await this.ports.data.request("code.remote.get", { id: workspace.id }), fresh = object(await this.ports.data.request("res.get", { resource: resource.id }));
    if (JSON.stringify(current) !== JSON.stringify(workspace) || resourceIdentity(fresh) !== resourceIdentity(resource)) { await audit("denied"); throw new Error("远程工作区授权或身份已改变"); }
    await audit("approved");
    const credential = object(await this.ports.data.request("res.credential", { resource: resource.id }));
    signal.throwIfAborted(); await audit("started");
    try {
      const result = object(await this.ports.execution.request("remote." + operation, { ...input, resource, credential_ref: credential.ref }, signal));
      await audit(text(result, "status", "completed"), result);
      return result.value ?? { ...result, unknown: result.status === "unknown" };
    } catch (error) { await audit("unknown"); throw error; }
  }
}
