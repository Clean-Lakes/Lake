import type { StorePort, VerificationPort } from "../domain/ports.js";
import type {
  Action,
  Resource,
  ToolResult,
  ExecutionSession,
} from "../domain/entities.js";
import { toolResult } from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
export class Reconciler {
  constructor(
    private readonly store: StorePort,
    private readonly inspect: (
      action: Action,
      resource: Resource,
    ) => Promise<"observed" | "not_observed" | "unknown">,
    private readonly verifier: VerificationPort,
  ) {}
  async reconcile(id: string): Promise<ToolResult> {
    let a = await this.store.get<Action>("actions", id);
    requireCondition(a?.status === "unknown", "conflict");
    const r = await this.store.get<Resource>("resources", a.targets[0]!.id);
    requireCondition(
      r &&
        r.identity === a.targets[0]!.identity &&
        r.revision === a.targets[0]!.revision,
      "identity_mismatch",
    );
    let outcome: "observed" | "not_observed" | "unknown" = "unknown";
    try {
      outcome = await this.inspect(a, r);
    } catch {}
    if (outcome === "unknown")
      return toolResult(
        { reason: "unknown_effect", actionId: id },
        { status: "waiting" },
      );
    if (outcome === "observed") {
      a = {
        ...a,
        revision: a.revision + 1,
        status: "observed",
        result: a.result ?? toolResult({ reconciled: true }),
      };
      await this.store.transact(
        changeCommands(
          "actions",
          a,
          "action.observed",
          "reconciler",
          new Date().toISOString(),
        ),
      );
      let verification: ToolResult;
      try {
        verification = await this.verifier.run(id);
      } catch {
        verification = toolResult({ verified: false }, { status: "error" });
      }
      a = (await this.store.get<Action>("actions", id))!;
      return this.finish(
        a,
        verification.status === "ok" ? "succeeded" : "failed",
        verification,
      );
    }
    return this.finish(
      a,
      "failed",
      toolResult(
        {
          reconciled: true,
          effect: "not_currently_observed",
          automaticReplay: false,
        },
        { status: "error" },
      ),
    );
  }
  async resolveByHuman(
    id: string,
    principal: string,
    statement: string,
  ): Promise<ToolResult> {
    const a = await this.store.get<Action>("actions", id);
    requireCondition(
      a?.status === "unknown" &&
        principal === "local-user" &&
        statement === "stopped_or_not_performed",
      "scope_denied",
    );
    return this.finish(
      a,
      "failed",
      toolResult(
        { manualDisposition: statement, principal, automaticReplay: false },
        { status: "error" },
      ),
    );
  }
  private async finish(
    a: Action,
    status: "succeeded" | "failed",
    result: ToolResult,
  ): Promise<ToolResult> {
    const commands = changeCommands(
      "actions",
      { ...a, revision: a.revision + 1, status, result },
      "action.finished",
      "reconciler",
      new Date().toISOString(),
    );
    commands.push({ op: "unlock", owner: a.id });
    if (a.terminalSessionId) {
      const t = await this.store.get<ExecutionSession>(
        "execution_sessions",
        a.terminalSessionId,
      );
      if (t && t.inputEpoch === a.inputEpoch)
        commands.push(
          ...changeCommands(
            "execution_sessions",
            {
              ...t,
              revision: t.revision + 1,
              inputHolder: null,
              inputEpoch: t.inputEpoch + 1,
              inputExpiresAt: null,
              paused: false,
            },
            "terminal.control_released",
            "reconciler",
            new Date().toISOString(),
          ),
        );
    }
    await this.store.transact(commands);
    return result;
  }
}
