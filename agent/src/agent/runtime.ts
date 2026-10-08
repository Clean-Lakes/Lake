import { createHash } from "node:crypto";
import type { StorePort, ModelPort, ModelMessage } from "../domain/ports.js";
import type {
  ToolResult,
  SpecialistRun,
  Activity,
} from "../domain/entities.js";
import { LakeError, requireCondition } from "../domain/errors.js";
import type { Provider } from "../domain/config.js";
import { ModelHistory } from "./history.js";
import { BudgetService } from "./budget.js";
import { ContextBuilder, type ContextInput } from "./context.js";
import { compact } from "./compaction.js";
import { ToolProtocol } from "./tool-protocol.js";
import { ToolExecutor } from "./tool-executor.js";
import { ToolCatalog, type ToolContext } from "./tool-catalog.js";
export interface RuntimeHooks {
  context(): Promise<
    Omit<ContextInput, "history" | "tools" | "window" | "maxOutput">
  >;
  activity(value: string): Promise<void>;
  delta(text: string): Promise<void>;
  isFinished(): Promise<boolean>;
  checkpoint(state: unknown): Promise<void>;
  progress?(): Promise<string>;
}
export interface RuntimeLimits {
  maxEquivalentTools: number;
  maxNoProgressCalls: number;
  maxModelRetries: number;
}
export class AgentRuntime {
  private controller = new AbortController();
  private summary: string | undefined;
  private retained = 0;
  constructor(
    private readonly store: StorePort,
    private readonly model: ModelPort,
    private readonly provider: Provider,
    private readonly catalog: ToolCatalog,
    private readonly executor: ToolExecutor,
    private readonly budget: BudgetService,
    private readonly context: Omit<ToolContext, "callKey" | "signal">,
    private readonly hooks: RuntimeHooks,
    private readonly maxCalls = 100,
    private readonly limits: RuntimeLimits = {
      maxEquivalentTools: 3,
      maxNoProgressCalls: 5,
      maxModelRetries: 2,
    },
  ) {}
  interrupt(): void {
    this.controller.abort();
  }
  restore(state: { summary?: string; retained?: number }): void {
    this.summary = state.summary;
    this.retained = state.retained ?? 0;
  }
  async resume(state?: {
    summary?: string;
    retained?: number;
  }): Promise<ToolResult> {
    this.controller = new AbortController();
    this.summary = state?.summary;
    this.retained = state?.retained ?? 0;
    return this.run();
  }
  async run(): Promise<ToolResult> {
    const history = new ModelHistory(
      this.store,
      this.context.sessionId,
      this.context.actor,
    );
    let repeats = 0,
      lastTool = "",
      noProgress = 0;
    try {
      for (let turn = 0; turn < this.maxCalls; turn++) {
        requireCondition(!this.controller.signal.aborted, "cancelled");
        if (await this.hooks.isFinished())
          return {
            status: "ok",
            data: { finished: true },
            artifactRefs: [],
            truncated: false,
            retryPolicy: "never",
          };
        const progressBefore = await this.hooks.progress?.();
        if (this.context.actor !== this.context.sessionId) {
          const current = await this.store.get<SpecialistRun>(
            "specialist_runs",
            this.context.actor,
          );
          requireCondition(current && !current.cancelRequestedAt, "cancelled");
          this.context.powerBindings = [...current.powerBindings];
        }
        let pending = await history.pending();
        if (!pending) {
          await this.hooks.activity("model_call");
          const input = await this.hooks.context();
          const tools = this.catalog.project(this.context);
          let completed = await history.messages();
          let built = new ContextBuilder().build({
            ...input,
            history: completed.slice(this.retained),
            tools,
            window: this.provider.contextWindowTokens,
            maxOutput: this.provider.maxOutputTokens,
            ...(this.summary ? { summary: this.summary } : {}),
          });
          if (built.needsCompaction) {
            requireCondition(
              completed.length > this.retained,
              "context_exhausted",
            );
            this.summary = await compact(
              this.model,
              this.budget,
              this.context.sessionId,
              this.context.actor,
              this.provider.id,
              completed.slice(this.retained),
              Math.min(this.provider.maxOutputTokens, 2048),
              this.controller.signal,
              this.summary,
            );
            this.retained = completed.length;
            built = new ContextBuilder().build({
              ...input,
              history: [],
              tools,
              window: this.provider.contextWindowTokens,
              maxOutput: this.provider.maxOutputTokens,
              summary: this.summary,
            });
            requireCondition(
              built.tokens + this.provider.maxOutputTokens <=
                this.provider.contextWindowTokens * 0.45,
              "context_exhausted",
            );
          }
          new ContextBuilder().assertFits(
            built.tokens,
            this.provider.maxOutputTokens,
            this.provider.contextWindowTokens,
          );
          let assistant: ModelMessage | undefined;
          for (
            let attempt = 0;
            attempt <= this.limits.maxModelRetries;
            attempt++
          ) {
            const reservation = await this.budget.reserve(
              this.context.sessionId,
              this.context.actor,
              built.tokens + this.provider.maxOutputTokens,
              {
                kind: "model",
                prefixHash: createHash("sha256")
                  .update(JSON.stringify([built.messages[0], tools]))
                  .digest("hex"),
              },
            );
            let usage = null;
            try {
              for await (const event of this.model.stream({
                messages: built.messages,
                tools,
                maxOutputTokens: this.provider.maxOutputTokens,
                signal: this.controller.signal,
              })) {
                if (event.type === "text") await this.hooks.delta(event.text);
                else {
                  assistant = event.message;
                  usage = event.usage;
                }
              }
              requireCondition(assistant, "model_protocol_error");
              break;
            } catch (error) {
              if (
                !(
                  error instanceof LakeError &&
                  error.retryable &&
                  attempt < this.limits.maxModelRetries
                )
              )
                throw error;
              await new Promise((r) =>
                setTimeout(r, attempt === 0 ? 250 : 1000),
              );
            } finally {
              await this.budget.settle(reservation, usage, this.provider.id);
            }
          }
          requireCondition(assistant, "model_protocol_error");
          ToolProtocol.validate(assistant.tool_calls ?? []);
          pending = await history.commitExchange(assistant);
        }
        let waiting = false,
          waitingReason = "waiting_dependency";
        for (const call of pending.assistant.tool_calls ?? []) {
          const latest = await this.store.get<typeof pending>(
            "model_exchanges",
            pending.id,
          );
          if (latest?.results.some((r) => r.tool_call_id === call.id)) continue;
          const signature = call.function.name + call.function.arguments;
          repeats = signature === lastTool ? repeats + 1 : 1;
          lastTool = signature;
          await this.hooks.activity(toolActivity(call.function.name));
          const result =
            repeats > this.limits.maxEquivalentTools
              ? {
                  status: "waiting" as const,
                  data: { reason: "no_progress" },
                  artifactRefs: [],
                  truncated: false,
                  retryPolicy: "never" as const,
                }
              : await this.executor.execute(call, {
                  ...this.context,
                  callKey: pending.id + ":" + call.id,
                  signal: this.controller.signal,
                });
          await history.settle(pending.id, ToolProtocol.settle(call, result));
          if (result.status === "waiting") {
            waiting = true;
            waitingReason =
              typeof (result.data as { reason?: unknown })?.reason === "string"
                ? (result.data as { reason: string }).reason
                : "waiting_dependency";
          }
        }
        await history.finish(pending.id);
        await this.hooks.activity("idle");
        await this.hooks.checkpoint({
          summary: this.summary ?? null,
          retained: this.retained,
        });
        if (await this.hooks.isFinished())
          return {
            status: "ok",
            data: { finished: true },
            artifactRefs: [],
            truncated: false,
            retryPolicy: "never",
          };
        if (waiting)
          return {
            status: "waiting",
            data: { reason: waitingReason },
            artifactRefs: [],
            truncated: false,
            retryPolicy: "never",
          };
        const progressed = this.hooks.progress
          ? progressBefore !== (await this.hooks.progress())
          : Boolean(pending.assistant.tool_calls?.length);
        noProgress = progressed ? 0 : noProgress + 1;
        if (noProgress >= this.limits.maxNoProgressCalls)
          throw new LakeError("no_progress");
      }
      throw new LakeError("budget_exhausted");
    } finally {
      await this.hooks.activity("idle");
    }
  }
}
function toolActivity(name: string): Activity {
  if (name === "skill_load") return "loading_skill";
  if (name === "terminal_open") return "opening_terminal";
  if (name === "terminal_attach") return "attaching_terminal";
  if (name === "specialist_await") return "waiting_dependency";
  if (/read_log|_logs$/.test(name)) return "reading_logs";
  if (/apply_patch|replace_config/.test(name)) return "editing_config";
  if (/service_action|workspace_test|terminal_execute/.test(name))
    return "executing_command";
  if (/health_window|probe/.test(name)) return "verifying_health";
  return "querying_resource";
}
