import type { JsonValue } from "../domain/json.js";
import { resourceIdentity } from "../domain/inspection.js";
import {
  bindWorkflow,
  dependencyDecision,
  terminalNode,
  validWorkflowResult,
  workflowCalls,
} from "../domain/workflow-run.js";
import { validateWorkflow } from "../domain/workflow.js";
import { object, text, type Params } from "../domain/validation.js";
import type { RuntimePorts } from "./ports.js";
import { ApprovalGate } from "./approval.js";
import { OperationsService } from "./operations.js";

export type WorkflowTask = (
  node: Params,
  call: Params,
  run: Params,
  signal: AbortSignal,
) => Promise<JsonValue>;
export class WorkflowRunService {
  private readonly running = new Set<string>();
  constructor(
    private readonly ports: RuntimePorts,
    private readonly operations: OperationsService,
    private readonly approvals: ApprovalGate,
    private readonly task: WorkflowTask,
  ) {}
  async execute(
    p: Params,
    action: string,
    signal: AbortSignal,
    scheduledConsent?: (node: Params, calls: Params[]) => Promise<boolean>,
  ): Promise<JsonValue> {
    const v2 = p.version === 2,
      prefix = v2 ? "workflow.v2." : "workflow.",
      resume = text(p, "run_id");
    let run: Params;
    if (resume) run = object(await this.ports.data.request(prefix + "status", { id: resume }));
    else {
      const definition = object(
        await this.ports.data.request(prefix + "get", { id: text(p, "definition_id") }),
      );
      const resources = (await this.ports.data.request("res.list", {
        lake: text(definition, "lake_id"),
      })) as Params[];
      const spec = {
        ...(v2 ? object(definition.spec) : bindWorkflow(object(definition.spec), p)),
        _lake_resources: resources.map(resourceIdentity),
      };
      run = object(
        await this.ports.data.request(prefix + "create_run", {
          definition_id: definition.id,
          spec,
          trigger: text(p, "trigger", "desktop"),
        }),
      );
    }
    const id = text(run, "id");
    if (this.running.has(id)) throw new Error("工作流已经在执行");
    if (p.lake_id && p.lake_id !== run.lake_id) throw new Error("工作流不属于任务的湖");
    this.running.add(id);
    const active = new Map<string, Promise<void>>(),
      controller = new AbortController(),
      parent = signal,
      abort = () => controller.abort();
    parent.addEventListener("abort", abort, { once: true });
    if (parent.aborted) abort();
    signal = controller.signal;
    try {
      const spec = object(run.spec),
        nodes = validateWorkflow(spec, v2 ? 2 : 1),
        saved = (v2 ? run.nodes : run.steps) as Params[],
        statuses = new Map(
          saved.map((node) => [text(node, v2 ? "node_id" : "step_id"), text(node, "status")]),
        ),
        results = new Map<string, JsonValue>();
      const resources = (await this.ports.data.request("res.list", {
        lake: text(run, "lake_id"),
      })) as Params[];
      const anchors = spec._lake_resources as string[] | undefined;
      if (anchors && resources.some((resource) => !anchors.includes(resourceIdentity(resource))))
        throw new Error("工作流资源范围已变化，请创建新的运行");
      const report = async (node: Params = {}) => {
        const value = object(await this.ports.data.request(prefix + "status", { id })),
          progress = {
            run_id: id,
            name: text(run, "name"),
            status: text(value, "status"),
            step_name: text(node, "name", text(node, "id")),
            step_status: statuses.get(text(node, "id")) ?? "",
            completed: [...statuses.values()].filter(terminalNode).length,
            total: nodes.length,
          };
        if (p.conversation_id) {
          const event = await this.ports.data.request("conversation.append_event", {
            id: p.conversation_id,
            kind: "workflow",
            payload: progress,
          });
          this.ports.emit({
            type: "activity",
            id: action,
            conversation_id: text(p, "conversation_id"),
            activity: event,
          });
        }
        this.ports.emit({
          type: "workflow",
          id: action,
          workflow: { ...progress, step_id: text(node, "id") },
        });
      };
      const transition = async (node: Params, to: string, extra: Params = {}) => {
        const key = text(node, "id");
        await this.ports.data.request(prefix + "node_status", {
          id,
          node_id: key,
          from: statuses.get(key) ?? "pending",
          to,
          ...extra,
        });
        statuses.set(key, to);
        await report(node);
      };
      if (resume) {
        if (!["interrupted", "failed", "waiting_approval"].includes(text(run, "status")))
          throw new Error("只有失败、中断或等待审批的工作流可以恢复");
        for (const node of nodes)
          if (statuses.get(text(node, "id")) === "running")
            await transition(node, "unknown", { error_code: "interrupted" });
        for (const node of nodes)
          if (
            ["unknown", "failed"].includes(statuses.get(text(node, "id")) ?? "") &&
            node.kind !== "ssh_check" &&
            p.retry_writes !== true
          )
            throw new Error("任务可能已产生副作用；核对后显式 retry_writes");
        for (const node of nodes)
          if (!["completed", "pending"].includes(statuses.get(text(node, "id")) ?? ""))
            await transition(node, "pending", { input: null, result: null, approval: null });
      }
      for (const node of saved)
        if (node.status === "completed" && node.result !== undefined)
          results.set(text(node, v2 ? "node_id" : "step_id"), node.result);
      await this.ports.data.request(prefix + "run_status", { id, status: "running" });
      await report();
      const maximum = v2 ? Number(spec.max_parallel ?? 4) : 4;
      const dispatch = async (node: Params) => {
        const key = text(node, "id"),
          risky = node.kind !== "ssh_check";
        try {
          let scheduled = false;
          const calls = v2
              ? workflowCalls(node, results)
              : [{ target: node.resource, command: node.command ?? "", request: node.goal ?? "" }],
            snapshot = { calls };
          if (v2 && risky) {
            await transition(node, "waiting_approval", { input: snapshot });
            if (p.unattended === true) {
              scheduled = (await scheduledConsent?.(node, calls)) ?? false;
              if (!scheduled) return;
            }
            const allowed =
              scheduled ||
              (await this.approvals.request(
                this.ports.id(),
                {
                  type: "approval",
                  kind: "workflow",
                  path: text(run, "name"),
                  command: JSON.stringify(snapshot),
                },
                signal,
                action,
              ));
            if (!allowed) {
              await transition(node, "failed", {
                approval: { outcome: "deny" },
                error_code: "approval_denied",
              });
              return;
            }
            await transition(node, "running", { approval: { outcome: "allow" } });
          } else {
            if (
              p.unattended === true &&
              node.kind === "ssh_check" &&
              object(await this.ports.data.request("permissions.get", {})).silent_ssh_read !== true
            ) {
              await transition(node, "waiting_approval", { input: snapshot });
              return;
            }
            await transition(node, "running", { input: snapshot });
          }
          const output: JsonValue[] = [];
          for (const call of calls) {
            signal.throwIfAborted();
            if (node.kind === "ssh_check" || node.kind === "ssh_command") {
              const target = resources.find(
                (resource) => resource.name === call.target || resource.id === call.target,
              );
              if (!target || (anchors && !anchors.includes(resourceIdentity(target))))
                throw new Error("工作流目标不在冻结范围内");
              const result = object(
                await this.operations.run(
                  node.kind === "ssh_check" ? "ops.read" : "ops.command",
                  {
                    resource: String(target.id),
                    expected_identity: resourceIdentity(target),
                    check: node.check ?? "",
                    command: call.command ?? "",
                    run_id: id,
                    turn_id: action,
                    timeout_ms: Number(node.timeout_seconds ?? 0) * 1000 || 120000,
                  },
                  this.ports.id(),
                  signal,
                  v2 && risky
                    ? () => statuses.get(key) === "running" && !signal.aborted
                    : undefined,
                ),
              );
              if (result.status === "unknown") {
                await transition(node, "unknown", { error_code: "execution_unknown" });
                return;
              }
              if (result.status !== "completed") {
                await transition(node, "failed", {
                  error_code: "executor_error",
                  stdout: result.stdout ?? "",
                  stderr: result.stderr ?? "",
                  exit_code: result.exit_code ?? -1,
                });
                return;
              }
              output.push(result);
            } else
              output.push(
                await this.task(
                  node,
                  call,
                  {
                    ...run,
                    conversation_id: p.conversation_id ?? "",
                    project_id: p.project_id ?? "",
                    resources,
                  },
                  signal,
                ),
              );
          }
          const result = node.for_each ? output : output[0];
          if (v2 && !validWorkflowResult(node, result))
            throw new Error("工作流节点结果类型或大小无效");
          await transition(node, "completed", {
            result,
            ...(v2
              ? {}
              : {
                  stdout: text(object(result), "stdout"),
                  stderr: text(object(result), "stderr"),
                  exit_code: object(result).exit_code ?? 0,
                }),
          });
          results.set(key, result);
        } catch {
          const from = statuses.get(key) ?? "pending",
            to =
              signal.aborted && from === "running" && risky
                ? "unknown"
                : signal.aborted
                  ? "cancelled"
                  : "failed";
          if (!terminalNode(from))
            await transition(node, to, {
              error_code: signal.aborted ? "interrupted" : "executor_error",
            });
        }
      };
      while ([...statuses.values()].some((status) => !terminalNode(status))) {
        let changed = false;
        if (!signal.aborted)
          for (const node of nodes) {
            if (statuses.get(text(node, "id")) !== "pending" || active.size >= maximum) continue;
            const decision = dependencyDecision(node, statuses);
            if (!decision.ready) continue;
            changed = true;
            if (!decision.run) {
              await transition(node, "skipped", { error_code: "condition_false" });
              continue;
            }
            const key = text(node, "id"),
              promise = dispatch(node);
            active.set(key, promise);
            void promise.finally(() => active.delete(key)).catch(() => {});
          }
        if (active.size) await Promise.race(active.values());
        else if (
          signal.aborted ||
          [...statuses.values()].some((status) => status === "waiting_approval")
        )
          break;
        else if (!changed) throw new Error("工作流依赖无法推进");
      }
      await Promise.allSettled(active.values());
      if (signal.aborted)
        for (const node of nodes)
          if (["pending", "waiting_approval"].includes(statuses.get(text(node, "id")) ?? ""))
            await transition(node, "cancelled", { error_code: "interrupted" });
      const status = signal.aborted
        ? "interrupted"
        : [...statuses.values()].some((value) => value === "waiting_approval")
          ? "waiting_approval"
          : [...statuses.values()].some((value) => ["failed", "unknown"].includes(value))
            ? "failed"
            : "completed";
      await this.ports.data.request(prefix + "run_status", { id, status });
      await report();
      return this.ports.data.request(prefix + "status", { id });
    } finally {
      controller.abort();
      parent.removeEventListener("abort", abort);
      await Promise.allSettled(active.values());
      this.running.delete(id);
    }
  }
}
