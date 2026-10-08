import type { StorePort } from "../domain/ports.js";
import type {
  ExecutionSession,
  Action,
  Resource,
  Observation,
  Evidence,
  Session,
  Approval,
} from "../domain/entities.js";
import { requireCondition, LakeError } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
import { GrantService } from "../operations/grants.js";
import { ResourceLockService } from "../runner/resource-locks.js";
import { randomUUID } from "node:crypto";
import { checkInvocation } from "../operations/invocation-policy.js";
import { canonicalActionDigest } from "../operations/action-digest.js";
export class HandoffService {
  constructor(
    private readonly store: StorePort,
    private readonly grants: GrantService,
    private readonly locks: ResourceLockService,
    private readonly closePty: (id: string) => Promise<void>,
    private readonly leaseMs = 600000,
  ) {}
  async expireLeases(now = Date.now()): Promise<void> {
    for (const terminal of await this.store.list<ExecutionSession>(
      "execution_sessions",
    )) {
      if (
        terminal.mode !== "interactive" ||
        terminal.controlExpiredAt ||
        Date.parse(terminal.inputExpiresAt ?? "") > now
      )
        continue;
      await this.closePty(terminal.id);
      // Closing SSH does not prove a remote process stopped. Keep the resource lock
      // and require the user's stopped confirmation before managed execution resumes.
      for (let attempt = 0; attempt < 10; attempt++) {
        const current = await this.store.get<ExecutionSession>(
          "execution_sessions",
          terminal.id,
        );
        if (
          !current ||
          current.mode !== "interactive" ||
          current.controlExpiredAt
        )
          break;
        try {
          await this.store.transact(
            changeCommands(
              "execution_sessions",
              {
                ...current,
                revision: current.revision + 1,
                paused: true,
                inputEpoch: current.inputEpoch + 1,
                controlExpiredAt: new Date(now).toISOString(),
              },
              "terminal.control_expired",
              "system",
              new Date(now).toISOString(),
            ),
          );
          break;
        } catch (error) {
          if (!(error instanceof LakeError && error.code === "conflict"))
            throw error;
          if (attempt === 9) throw error;
        }
      }
    }
  }
  async requestHandoff(id: string, principal: string): Promise<void> {
    const terminal = await this.store.get<ExecutionSession>(
      "execution_sessions",
      id,
    );
    requireCondition(
      terminal?.status === "ready" && terminal.mode === "managed",
      "conflict",
    );
    const resource = await this.store.get<Resource>(
      "resources",
      terminal.resourceId,
    );
    requireCondition(
      resource?.kind === "ssh" &&
        resource.identity === terminal.resourceIdentity,
      "identity_mismatch",
    );
    await this.grants.resolve(resource, "interactive", principal);
    const session = await this.store.get<Session>(
      "sessions",
      terminal.sessionId,
    );
    requireCondition(session, "not_found");
    checkInvocation(session, resource, "interactive");
    const targetDigest = canonicalActionDigest({
      id: resource.id,
      identity: resource.identity,
      revision: resource.revision,
    });
    const approval: Approval = {
      id: randomUUID(),
      revision: 1,
      sessionId: terminal.sessionId,
      taskId: session.rootTaskId,
      principal,
      actionDigest: canonicalActionDigest({
        purpose: "interactive_handoff",
        terminalId: id,
        epoch: terminal.inputEpoch,
        targetDigest,
      }),
      targetDigest,
      expiresAt: new Date(Date.now() + this.leaseMs).toISOString(),
      maxUses: 1,
      consumedUses: 0,
    };
    await this.store.transact([
      { op: "put", table: "approvals", value: approval, expectedRevision: 0 },
      ...changeCommands(
        "execution_sessions",
        {
          ...terminal,
          revision: terminal.revision + 1,
          paused: true,
          controlApprovalId: approval.id,
        },
        "terminal.control_requested",
        principal,
        new Date().toISOString(),
      ),
    ]);
  }
  async grantHandoff(id: string, principal: string): Promise<number> {
    const terminal = await this.store.get<ExecutionSession>(
      "execution_sessions",
      id,
    );
    requireCondition(terminal?.paused, "conflict");
    const resource = await this.store.get<Resource>(
      "resources",
      terminal.resourceId,
    );
    requireCondition(
      resource && resource.identity === terminal.resourceIdentity,
      "identity_mismatch",
    );
    await this.grants.resolve(resource, "interactive", principal);
    const approval = await this.store.get<Approval>(
      "approvals",
      String(terminal.controlApprovalId),
    );
    const targetDigest = canonicalActionDigest({
      id: resource.id,
      identity: resource.identity,
      revision: resource.revision,
    });
    requireCondition(
      approval &&
        approval.principal === principal &&
        approval.targetDigest === targetDigest &&
        approval.actionDigest ===
          canonicalActionDigest({
            purpose: "interactive_handoff",
            terminalId: id,
            epoch: terminal.inputEpoch,
            targetDigest,
          }) &&
        !approval.revokedAt &&
        approval.consumedUses === 0 &&
        Date.parse(approval.expiresAt) > Date.now(),
      "approval_expired",
    );
    requireCondition(
      !(await this.store.list<Action>("actions")).some(
        (a) =>
          a.terminalSessionId === id &&
          ["queued", "dispatched", "observed", "unknown", "verifying"].includes(
            a.status,
          ),
      ),
      "unknown_effect",
    );
    const epoch = terminal.inputEpoch + 1;
    const reset = { ...terminal };
    delete reset.controlExpiredAt;
    await this.store.transact([
      ...this.locks.commands([terminal.resourceId], `human:${id}`, "write"),
      {
        op: "put",
        table: "approvals",
        value: {
          ...approval,
          revision: approval.revision + 1,
          consumedUses: 1,
          consumedBy: id,
        },
        expectedRevision: approval.revision,
      },
      ...changeCommands(
        "execution_sessions",
        {
          ...reset,
          revision: terminal.revision + 1,
          mode: "interactive",
          inputHolder: principal,
          inputEpoch: epoch,
          inputExpiresAt: approval.expiresAt,
        },
        "terminal.control_granted",
        principal,
        new Date().toISOString(),
      ),
    ]);
    return epoch;
  }
  async returnToManaged(
    id: string,
    principal: string,
    stopped: boolean,
  ): Promise<void> {
    const original = await this.store.get<ExecutionSession>(
      "execution_sessions",
      id,
    );
    requireCondition(
      original?.inputHolder === principal && stopped,
      "scope_denied",
      "Confirm manual work has stopped",
    );
    await this.closePty(id);
    for (let attempt = 0; attempt < 10; attempt++) {
      const terminal = await this.store.get<ExecutionSession>(
        "execution_sessions",
        id,
      );
      requireCondition(terminal?.inputHolder === principal, "scope_denied");
      const time = new Date().toISOString();
      const commands = changeCommands(
        "execution_sessions",
        {
          ...terminal,
          revision: terminal.revision + 1,
          mode: "managed",
          inputHolder: null,
          inputEpoch: terminal.inputEpoch + 1,
          inputExpiresAt: null,
          paused: false,
          cwd: "/",
        },
        "terminal.manual_activity",
        principal,
        time,
      );
      commands.push({ op: "unlock", owner: `human:${id}` });
      for (const table of ["observations", "evidence"])
        for (const entry of await this.store.list<Observation | Evidence>(
          table,
        ))
          if (entry.resourceId === terminal.resourceId)
            commands.push({
              op: "put",
              table,
              value: {
                ...entry,
                revision: entry.revision + 1,
                invalidatedAt: time,
              },
              expectedRevision: entry.revision,
            });
      try {
        await this.store.transact(commands);
        return;
      } catch (error) {
        if (!(error instanceof LakeError && error.code === "conflict"))
          throw error;
      }
    }
    throw new LakeError("conflict");
  }
}
