import type { StorePort, DbCommand } from "../domain/ports.js";
import type { Action, Approval } from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
import { canonicalActionDigest } from "./action-digest.js";
import { stableId } from "../specialists/task-progress.js";
export class ApprovalService {
  constructor(private readonly store: StorePort) {}
  async approve(
    actionId: string,
    digest: string,
    principal: string,
  ): Promise<Approval> {
    const a = await this.store.get<Action>("actions", actionId);
    requireCondition(
      a?.proposalDigest === digest && a.status === "waiting_approval",
      "conflict",
      "Action or digest changed",
    );
    const id = stableId("approval:" + actionId + ":" + digest);
    const existing = await this.store.get<Approval>("approvals", id);
    if (existing) return existing;
    const value: Approval = {
      id,
      revision: 1,
      sessionId: a.sessionId,
      taskId: a.taskId,
      principal,
      actionId,
      actionDigest: digest,
      targetDigest: canonicalActionDigest(a.targets),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      maxUses: 1,
      consumedUses: 0,
    };
    await this.store.transact([
      { op: "put", table: "approvals", value, expectedRevision: 0 },
    ]);
    return value;
  }
  async consume(
    action: Action,
    principal: string,
  ): Promise<{
    approval: Approval;
    command: DbCommand;
  }> {
    const a = (await this.store.list<Approval>("approvals")).find(
      (a) =>
        a.actionId === action.id &&
        a.consumedUses < a.maxUses &&
        a.actionDigest === action.proposalDigest &&
        a.taskId === action.taskId &&
        a.sessionId === action.sessionId &&
        a.principal === principal &&
        !a.revokedAt &&
        a.targetDigest === canonicalActionDigest(action.targets),
    );
    requireCondition(
      a && Date.parse(a.expiresAt) > Date.now() && a.consumedUses < a.maxUses,
      "approval_expired",
    );
    return {
      approval: a,
      command: {
        op: "put",
        table: "approvals",
        value: {
          ...a,
          revision: a.revision + 1,
          consumedUses: a.consumedUses + 1,
          consumedBy: action.id,
        },
        expectedRevision: a.revision,
      },
    };
  }
}
