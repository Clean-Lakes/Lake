import { randomUUID } from "node:crypto";
import type {
  StorePort,
  ExecutionAdapterPort,
  VerificationPort,
} from "../domain/ports.js";
import type {
  Action,
  Resource,
  TaskContract,
  Approval,
  ToolResult,
  ExecutionSession,
  SpecialistRun,
} from "../domain/entities.js";
import { toolResult } from "../domain/entities.js";
import { requireCondition, LakeError, publicError } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
import { GrantService } from "../operations/grants.js";
import { executionSignal } from "./timeouts.js";
export class ActionRunner {
  private readonly running = new Map<string, Promise<ToolResult>>();
  private readonly controllers = new Map<string, AbortController>();
  private stopped = false;
  constructor(
    private readonly store: StorePort,
    private readonly adapter: ExecutionAdapterPort,
    private readonly verifier: VerificationPort,
    private readonly sanitize: (result: ToolResult) => ToolResult,
    private readonly output: (
      terminalId: string,
      text: string,
      actionId: string,
    ) => Promise<void>,
    private readonly principal = "local-user",
    private readonly fault: (
      point: string,
      action: Action,
    ) => Promise<void> = async () => {},
    private readonly limits = {
      readTimeoutMs: 30000,
      changeTimeoutMs: 120000,
      maxReadRetries: 2,
    },
    private readonly observe: (
      action: Action,
      stage: "execution" | "verification" | "idle",
    ) => Promise<void> = async () => {},
  ) {}
  async tick(): Promise<void> {
    if (this.stopped) return;
    for (const a of await this.store.list<Action>("actions"))
      if (a.status === "queued" && !this.running.has(a.id))
        void this.run(a.id, new AbortController().signal).catch(() => {});
  }
  async run(id: string, signal: AbortSignal): Promise<ToolResult> {
    const existing = this.running.get(id);
    if (existing) return existing;
    const promise = this.perform(id, signal);
    this.running.set(id, promise);
    try {
      return await promise;
    } finally {
      this.running.delete(id);
    }
  }
  private async perform(id: string, signal: AbortSignal): Promise<ToolResult> {
    let a = await this.store.get<Action>("actions", id);
    requireCondition(a, "not_found");
    if (a.result && a.status !== "queued") return a.result;
    requireCondition(a.status === "queued", "conflict");
    const controller = new AbortController();
    this.controllers.set(id, controller);
    let dispatched = false;
    let activeSignal = executionSignal(
      AbortSignal.any([signal, controller.signal]),
      a.effect === "read"
        ? this.limits.readTimeoutMs
        : this.limits.changeTimeoutMs,
    );
    try {
      const task = await this.store.get<TaskContract>("tasks", a.taskId);
      requireCondition(
        task &&
          Number(task.contractRevision ?? 1) === a.taskRevision &&
          !task.cancelRequestedAt &&
          ["active", "waiting"].includes(task.status),
        "precondition_failed",
      );
      const remaining = Date.parse(task.deadline) - Date.now();
      requireCondition(remaining > 0, "budget_exhausted");
      activeSignal = AbortSignal.any([
        activeSignal,
        AbortSignal.timeout(Math.max(1, remaining)),
      ]);
      if (a.actor !== a.sessionId) {
        const worker = await this.store.get<SpecialistRun>(
          "specialist_runs",
          a.actor,
        );
        requireCondition(
          worker?.sessionId === a.sessionId &&
            worker.taskId === a.taskId &&
            !worker.cancelRequestedAt &&
            a.targets.every((target) =>
              worker.workOrder.resourceIds.includes(target.id),
            ),
          "cancelled",
        );
      }
      const resource = await this.store.get<Resource>(
        "resources",
        a.targets[0]!.id,
      );
      requireCondition(
        resource &&
          resource.identity === a.targets[0]!.identity &&
          resource.revision === a.targets[0]!.revision,
        "identity_mismatch",
      );
      await new GrantService(this.store).resolve(
        resource,
        a.effect,
        this.principal,
      );
      if (a.approvalId) {
        const approval = await this.store.get<Approval>(
          "approvals",
          a.approvalId,
        );
        requireCondition(
          approval &&
            approval.consumedBy === a.id &&
            !approval.revokedAt &&
            Date.parse(approval.expiresAt) > Date.now(),
          "approval_expired",
        );
      }
      if (a.terminalSessionId) {
        const t = await this.store.get<ExecutionSession>(
          "execution_sessions",
          a.terminalSessionId,
        );
        requireCondition(
          t &&
            t.inputEpoch === a.inputEpoch &&
            t.inputHolder === a.actor &&
            !t.paused,
          "conflict",
        );
      }
      requireCondition(!activeSignal.aborted, "cancelled");
      a = {
        ...a,
        revision: a.revision + 1,
        status: "dispatched",
        attemptId: randomUUID(),
      };
      await this.store.transact([
        ...changeCommands(
          "actions",
          a,
          "action.dispatched",
          a.actor,
          new Date().toISOString(),
        ),
        {
          op: "put",
          table: "action_attempts",
          value: {
            id: a.attemptId!,
            revision: 1,
            sessionId: a.sessionId,
            actionId: a.id,
            startedAt: new Date().toISOString(),
            status: "dispatched",
          },
          expectedRevision: 0,
        },
      ]);
      dispatched = true;
      await this.observe(a, "execution");
      await this.fault("before_external", a);
      let result: ToolResult | undefined;
      for (
        let attempt = 0;
        attempt < (a.effect === "read" ? 1 + this.limits.maxReadRetries : 1);
        attempt++
      ) {
        try {
          result = this.sanitize(
            await this.adapter.execute(
              a.capability,
              resource,
              { ...a.parameters, __actionId: a.id, __sessionId: a.sessionId },
              activeSignal,
            ),
          );
          break;
        } catch (e) {
          if (
            a.effect !== "read" ||
            !(e instanceof LakeError && e.retryable) ||
            attempt === this.limits.maxReadRetries ||
            activeSignal.aborted
          )
            throw e;
          await new Promise((r) => setTimeout(r, attempt === 0 ? 250 : 1000));
        }
      }
      requireCondition(result, "capability_unavailable");
      await this.fault("after_external", a);
      if (a.terminalSessionId)
        await this.output(
          a.terminalSessionId,
          JSON.stringify(result.data),
          a.id,
        );
      a = (await this.store.get<Action>("actions", id))!;
      a = {
        ...a,
        revision: a.revision + 1,
        status: "observed",
        result: { ...result, actionId: a.id },
      };
      await this.store.transact(
        changeCommands(
          "actions",
          a,
          "action.observed",
          a.actor,
          new Date().toISOString(),
        ),
      );
      await this.fault("after_observed", a);
      if (result.status !== "ok") {
        const failure = this.sanitize({ ...result, actionId: a.id });
        await this.finish(a, "failed", failure, true);
        return failure;
      }
      a = { ...a, revision: a.revision + 1, status: "verifying" };
      await this.store.transact(
        changeCommands(
          "actions",
          a,
          "action.observed",
          a.actor,
          new Date().toISOString(),
        ),
      );
      await this.observe(a, "verification");
      const verification = await this.verifier.run(a.id);
      a = (await this.store.get<Action>("actions", id))!;
      const ok = verification.status === "ok";
      const final = this.sanitize(
        toolResult(
          { execution: result.data, verification: verification.data },
          {
            status: ok ? "ok" : "error",
            actionId: a.id,
            ...(!ok
              ? {
                  error: {
                    code: "precondition_failed",
                    message: "Verification did not pass",
                    retryable: false,
                  },
                }
              : {}),
          },
        ),
      );
      await this.finish(a, ok ? "succeeded" : "failed", final, true);
      return final;
    } catch (error) {
      a = (await this.store.get<Action>("actions", id))!;
      const uncertain =
        dispatched &&
        a.effect !== "read" &&
        !(
          error instanceof LakeError &&
          [
            "precondition_failed",
            "invalid_input",
            "scope_denied",
            "identity_mismatch",
          ].includes(error.code)
        );
      const result = toolResult(
        { reason: uncertain ? "unknown_effect" : "execution_failed" },
        {
          status: uncertain ? "waiting" : "error",
          actionId: id,
          error: uncertain
            ? {
                code: "unknown_effect",
                message: "External effect requires reconciliation",
                retryable: false,
              }
            : publicError(error),
        },
      );
      await this.finish(
        a,
        uncertain ? "unknown" : dispatched ? "failed" : "blocked",
        result,
        !uncertain,
      );
      return result;
    } finally {
      if (a) await this.observe(a, "idle").catch(() => {});
      this.controllers.delete(id);
    }
  }
  private async finish(
    action: Action,
    status: Action["status"],
    result: ToolResult,
    release: boolean,
  ): Promise<void> {
    const proof = (
      result.data as {
        verification?: { evidenceIds?: string[]; observationId?: string };
      } | null
    )?.verification;
    const verificationRefs = proof
      ? [
          ...(proof.evidenceIds ?? []),
          ...(proof.observationId ? [proof.observationId] : []),
        ]
      : action.verificationRefs;
    const value = {
      ...action,
      revision: action.revision + 1,
      status,
      result,
      verificationRefs,
    };
    const commands = changeCommands(
      "actions",
      value,
      status === "unknown" ? "action.unknown" : "action.finished",
      action.actor,
      new Date().toISOString(),
    );
    if (release) {
      commands.push({ op: "unlock", owner: action.id });
      if (action.terminalSessionId) {
        const t = await this.store.get<ExecutionSession>(
          "execution_sessions",
          action.terminalSessionId,
        );
        if (
          t?.inputHolder === action.actor &&
          t.inputEpoch === action.inputEpoch
        )
          commands.push(
            ...changeCommands(
              "execution_sessions",
              {
                ...t,
                revision: t.revision + 1,
                inputHolder: null,
                inputEpoch: t.inputEpoch + 1,
                inputExpiresAt: null,
              },
              "terminal.control_released",
              action.actor,
              new Date().toISOString(),
            ),
          );
      }
    }
    await this.store.transact(commands);
  }
  async cancel(id: string): Promise<void> {
    const a = await this.store.get<Action>("actions", id);
    requireCondition(a, "not_found");
    if (["succeeded", "failed", "cancelled", "blocked"].includes(a.status))
      return;
    if (["dispatched", "verifying", "observed", "unknown"].includes(a.status)) {
      await this.store.transact(
        changeCommands(
          "actions",
          {
            ...a,
            revision: a.revision + 1,
            cancelRequestedAt: new Date().toISOString(),
          },
          "action.unknown",
          "user",
          new Date().toISOString(),
        ),
      );
      this.controllers.get(id)?.abort();
    } else
      await this.finish(
        a,
        "cancelled",
        toolResult(null, {
          status: "error",
          error: {
            code: "cancelled",
            message: "Action cancelled before dispatch",
            retryable: false,
          },
        }),
        true,
      );
  }
  stop(): void {
    this.stopped = true;
    for (const controller of this.controllers.values()) controller.abort();
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }
}
