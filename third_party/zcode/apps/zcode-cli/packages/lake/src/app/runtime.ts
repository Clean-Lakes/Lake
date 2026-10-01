import type { JsonValue } from "../domain/json.js";
import type { LakeCommand, LakeRuntime } from "../domain/protocol.js";
import { object, text } from "../domain/validation.js";
import type { RuntimePorts } from "./ports.js";
import { OperationsService } from "./operations.js";
import { ConversationService } from "./conversation.js";
import { ApprovalGate } from "./approval.js";
import { WorkflowSchedules } from "./workflow-schedules.js";
import { WorkflowRunService } from "./workflow-run.js";

export class LakeApplication implements Pick<LakeRuntime, "dispatch" | "close"> {
  private readonly operations: OperationsService;
  private readonly conversations: ConversationService;
  private readonly workflows: WorkflowRunService;
  private readonly executions = new Map<
    string,
    { input: string; controller: AbortController; result: Promise<JsonValue> }
  >();
  private closed = false;
  private readonly schedules: WorkflowSchedules;
  constructor(private readonly ports: RuntimePorts) {
    const approvals = new ApprovalGate(ports.emit);
    this.operations = new OperationsService(ports, approvals);
    this.workflows = new WorkflowRunService(
      ports,
      this.operations,
      approvals,
      (node, call, run, signal) => this.conversations.workflowTask(node, call, run, signal),
    );
    this.conversations = new ConversationService(ports, this.operations, this.workflows);
    this.schedules = new WorkflowSchedules(ports, this.workflows);
  }
  async dispatch(command: LakeCommand): Promise<JsonValue> {
    if (this.closed) throw new Error("Lake runtime 已关闭");
    const { method, params } = command;
    if (method === "schedule.poll") {
      await this.schedules.tick();
      return null;
    }
    if (method === "settings") return this.ports.settings.request(params);
    if (method === "conversation.start") return this.conversations.start(text(params, "id"));
    if (method === "native.subagents") {
      if (!params.id) return [];
      const conversation = object(
        await this.ports.data.request("conversation.get", { id: params.id }),
      );
      return (
        (await this.ports.agent?.inspect?.({
          id: params.id,
          workspace: conversation.project_path ?? "",
        })) ?? []
      );
    }
    if (method === "approval.respond") {
      if (!(await this.ports.agent?.respond?.(text(params, "id"), params)))
        this.operations.respond(text(params, "id"), params.approved === true);
      return null;
    }
    if (method === "question.answer") {
      if (!(await this.ports.agent?.respond?.(text(params, "question_id"), params)))
        throw new Error("原生问题已过期");
      return null;
    }
    if (method === "execution.cancel") {
      const execution = this.executions.get(text(params, "id"));
      if (!execution) throw new Error("执行不存在");
      execution.controller.abort();
      return null;
    }
    if (
      [
        "native.extensions",
        "workbench.files",
        "workbench.read",
        "workbench.git",
        "workbench.diff",
        "workbench.terminal.status",
        "task.status",
        "remote.workbench.files",
        "remote.workbench.read",
        "remote.workbench.status",
      ].includes(method)
    )
      return this.native(method, params, new AbortController().signal);
    if (
      method.startsWith("native.") ||
      method.startsWith("ops.") ||
      method.startsWith("remote.workbench.") ||
      method === "conversation.ask" ||
      method === "workflow.execute" ||
      method === "workflow.v2.execute" ||
      method.startsWith("workbench.") ||
      method.startsWith("task.")
    ) {
      const id = command.id ?? this.ports.id(),
        input = JSON.stringify([method, command.params]),
        previous = this.executions.get(id);
      if (previous) {
        if (previous.input !== input) throw new Error("重复执行 ID 的输入不同");
        return previous.result;
      }
      if (this.executions.size >= 8192)
        throw new Error("本次运行的执行记录已达上限，请重启桌面应用");
      const controller = new AbortController(),
        result =
          method === "conversation.ask"
            ? this.conversations.ask(params, id, controller.signal)
            : method === "workflow.execute" || method === "workflow.v2.execute"
              ? this.workflows.execute(
                  { ...params, version: method === "workflow.v2.execute" ? 2 : 1 },
                  id,
                  controller.signal,
                )
              : method.startsWith("ops.")
                ? this.operations.run(method, params, id, controller.signal)
                : this.native(method, params, controller.signal);
      this.executions.set(id, { input, controller, result });
      return result;
    }
    if (
      ["code.bind", "code.remote.bind"].includes(method) &&
      this.conversations.isActive(text(params, "id"))
    )
      throw new Error("请先停止当前任务再切换工作区");
    const value = await this.ports.data.request(method, params);
    if (
      [
        "res.authorize",
        "res.set_credential",
        "code.remote.authorize",
        "code.bind",
        "code.remote.bind",
      ].includes(method)
    ) {
      for (const execution of this.executions.values()) execution.controller.abort();
      await this.ports.agent?.close?.();
      await this.ports.native?.close();
    }
    return value;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const execution of this.executions.values()) execution.controller.abort();
    await Promise.allSettled([...this.executions.values()].map((execution) => execution.result));
    await this.schedules.close();
    await this.ports.agent?.close?.();
    await this.ports.native?.close();
    await this.ports.execution.close();
    this.ports.data.close();
  }
  private async native(
    method: string,
    params: LakeCommand["params"],
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (!this.ports.native) throw new Error("ZCode 原生宿主未配置");
    return this.ports.native.request(method, params, signal);
  }
}
