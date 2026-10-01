import type { JsonValue } from "../domain/json.js";
import type { LakeCommand, LakeRuntime } from "../domain/protocol.js";
import { text } from "../domain/validation.js";
import type { RuntimePorts } from "./ports.js";
import { OperationsService } from "./operations.js";

export class LakeApplication implements Pick<LakeRuntime, "dispatch" | "close"> {
  private readonly operations: OperationsService;
  private readonly executions = new Map<string, { input: string; controller: AbortController; result: Promise<JsonValue> }>();
  private closed = false;
  constructor(private readonly ports: RuntimePorts) { this.operations = new OperationsService(ports); }
  async dispatch(command: LakeCommand): Promise<JsonValue> {
    if (this.closed) throw new Error("Lake runtime 已关闭");
    const { method, params } = command;
    if (method === "settings") return this.ports.settings.request(params);
    if (method === "approval.respond") { this.operations.respond(text(params, "id"), params.approved === true); return null; }
    if (method === "execution.cancel") {
      const execution = this.executions.get(text(params, "id"));
      if (!execution) throw new Error("执行不存在"); execution.controller.abort(); return null;
    }
    if (method === "ops.read" || method === "ops.command") {
      const id = command.id ?? this.ports.id(), input = JSON.stringify([method, command.params]), previous = this.executions.get(id);
      if (previous) { if (previous.input !== input) throw new Error("重复执行 ID 的输入不同"); return previous.result; }
      const controller = new AbortController(), result = this.operations.run(method, params, id, controller.signal);
      this.executions.set(id, { input, controller, result });
      return result;
    }
    return this.ports.data.request(method, params);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const execution of this.executions.values()) execution.controller.abort();
    await Promise.allSettled([...this.executions.values()].map(execution => execution.result));
    await this.ports.execution.close(); this.ports.data.close();
  }
}
