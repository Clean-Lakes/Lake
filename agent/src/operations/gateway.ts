import type {
  StorePort,
  DbCommand,
  OperationGatewayPort,
} from "../domain/ports.js";
import type {
  Action,
  TaskContract,
  ExecutionSession,
  Approval,
  ToolResult,
  Resource,
  Service,
  Session,
} from "../domain/entities.js";
import { toolResult } from "../domain/entities.js";
import { ActionProposalSchema } from "../domain/schemas.js";
import { requireCondition, LakeError } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
import { PowerRegistry } from "./power-registry.js";
import { GrantService } from "./grants.js";
import { ApprovalService } from "./approvals.js";
import { resolveTargets } from "./scope.js";
import { canonicalActionDigest } from "./action-digest.js";
import { stableId } from "../specialists/task-progress.js";
import { checkInvocation, autoApprove } from "./invocation-policy.js";
import { ResourceLockService } from "../runner/resource-locks.js";
export class OperationGateway implements OperationGatewayPort {
  constructor(
    private readonly store: StorePort,
    private readonly powers: PowerRegistry,
    private readonly grants: GrantService,
    private readonly approvals: ApprovalService,
    private readonly locks: ResourceLockService,
    private readonly run: (
      id: string,
      signal: AbortSignal,
    ) => Promise<ToolResult>,
    private readonly maxChanges = 5,
    readonly principal = "local-user",
    private readonly inputLeaseMs = 30000,
  ) {}
  private async requireBusinessAcceptance(
    task: TaskContract,
    resource: Resource,
  ): Promise<void> {
    if (resource.kind !== "ssh") return;
    const services = (await this.store.list<Service>("services")).filter(
      (s) =>
        s.lakeId === resource.lakeId &&
        s.environmentId === resource.environmentId &&
        s.health &&
        s.resourceBindings.some((b) => b.resourceId === resource.id),
    );
    requireCondition(
      services.length === 1,
      "precondition_failed",
      "One service health profile must be bound before a change",
    );
    const service = services[0]!;
    const http = (await this.store.list<Resource>("resources")).find(
      (r) =>
        r.kind === "http" &&
        r.endpoint === service.health!.url &&
        service.resourceBindings.some((b) => b.resourceId === r.id),
    );
    requireCondition(
      http && task.scope.includes(http.id),
      "scope_denied",
      "Business health resource must be in task scope",
    );
    requireCondition(
      task.acceptanceCriteria.some(
        (c) =>
          c.required &&
          c.type === "http_health" &&
          (!c.resourceId || c.resourceId === http.id),
      ),
      "precondition_failed",
      "A required business health criterion is needed before a change",
    );
    await this.grants.resolve(http, "read", this.principal);
  }
  async prepare(proposal: unknown): Promise<Action> {
    const request = ActionProposalSchema.parse(proposal),
      id = stableId(
        "action:" +
          request.sessionId +
          ":" +
          request.actor +
          ":" +
          request.callKey,
      ),
      existing = await this.store.get<Action>("actions", id);
    const resource = await resolveTargets(
      this.store,
      request.sessionId,
      request.taskId,
      request.actor,
      request.resourceId,
    );
    const { manifest, tool, schema } = this.powers.capability(
      request.capability,
    );
    const session = await this.store.get<Session>(
      "sessions",
      request.sessionId,
    );
    requireCondition(session, "not_found");
    checkInvocation(session, resource, tool.effect);
    requireCondition(
      manifest.requiredResourceKinds.includes(resource.kind),
      "scope_denied",
    );
    await this.grants.resolve(resource, tool.effect, this.principal);
    const parameters = schema.parse({
      ...request.parameters,
      resourceId: resource.id,
    }) as Record<string, unknown>;
    const task = await this.store.get<TaskContract>("tasks", request.taskId);
    requireCondition(task, "not_found");
    requireCondition(
      !task.cancelRequestedAt && ["active", "waiting"].includes(task.status),
      "cancelled",
    );
    requireCondition(
      Date.now() < Date.parse(task.deadline),
      "budget_exhausted",
    );
    const targets = [
      {
        id: resource.id,
        identity: resource.identity,
        revision: resource.revision,
      },
    ];
    const digest = canonicalActionDigest({
      actor: request.actor,
      sessionId: request.sessionId,
      capability: request.capability,
      version: manifest.version,
      effect: tool.effect,
      targets,
      parameters,
      taskId: task.id,
      taskRevision: Number(task.contractRevision ?? 1),
      constraints: task.constraints,
      acceptanceCriteria: task.acceptanceCriteria.map(
        ({ confirmedBy, ...criterion }) => criterion,
      ),
      maxAttempts: tool.effect === "read" ? 3 : 1,
      terminalSessionId: request.terminalSessionId ?? null,
    });
    if (existing) {
      requireCondition(
        existing.proposalDigest === digest,
        "conflict",
        "Call key was reused for a different action",
      );
      return existing;
    }
    if (tool.effect !== "read")
      requireCondition(
        (await this.store.list<Action>("actions")).filter(
          (a) =>
            a.taskId === task.id &&
            a.effect !== "read" &&
            !["blocked", "cancelled"].includes(a.status),
        ).length < this.maxChanges,
        "budget_exhausted",
      );
    const a: Action = {
      id,
      revision: 1,
      sessionId: request.sessionId,
      taskId: request.taskId,
      actor: request.actor,
      capability: request.capability,
      effect: tool.effect,
      targets,
      parameters,
      proposalDigest: digest,
      status: "proposed",
      taskRevision: Number(task.contractRevision ?? 1),
      callKey: request.callKey,
      preconditionRefs: [],
      verificationRefs: [],
      createdAt: new Date().toISOString(),
      ...(request.terminalSessionId
        ? { terminalSessionId: request.terminalSessionId }
        : {}),
      ...(request.inputEpoch !== undefined
        ? { inputEpoch: request.inputEpoch }
        : {}),
    };
    await this.store.transact([
      ...changeCommands(
        "tasks",
        { ...task, revision: task.revision + 1 },
        "task.updated",
        a.actor,
        new Date().toISOString(),
      ),
      ...changeCommands(
        "actions",
        a,
        "action.proposed",
        a.actor,
        new Date().toISOString(),
      ),
    ]);
    return a;
  }
  async authorize(id: string): Promise<Action> {
    const a = await this.store.get<Action>("actions", id);
    requireCondition(a, "not_found");
    if (a.status !== "proposed" && a.status !== "waiting_approval") return a;
    let status: "authorized" | "waiting_approval" = "authorized";
    if (a.effect !== "read") {
      const session = await this.store.get<Session>("sessions", a.sessionId),
        resources = await Promise.all(
          a.targets.map((t) => this.store.get<Resource>("resources", t.id)),
        );
      requireCondition(session && resources.every(Boolean), "not_found");
      if (autoApprove(session, resources as Resource[])) {
        if (a.status === "proposed")
          await this.store.transact(
            changeCommands(
              "actions",
              { ...a, revision: a.revision + 1, status: "waiting_approval" },
              "action.approval_required",
              a.actor,
              new Date().toISOString(),
            ),
          );
        await this.approvals.approve(a.id, a.proposalDigest, this.principal);
        return this.authorizeApproved(a.id);
      }
      try {
        await this.approvals.consume(a, this.principal);
      } catch {
        status = "waiting_approval";
      }
    }
    const value = { ...a, revision: a.revision + 1, status };
    await this.store.transact(
      changeCommands(
        "actions",
        value,
        status === "authorized"
          ? "action.authorized"
          : "action.approval_required",
        a.actor,
        new Date().toISOString(),
      ),
    );
    return value;
  }
  private async authorizeApproved(id: string): Promise<Action> {
    const a = await this.store.get<Action>("actions", id);
    requireCondition(a, "not_found");
    await this.approvals.consume(a, this.principal);
    const value = {
      ...a,
      revision: a.revision + 1,
      status: "authorized" as const,
    };
    await this.store.transact(
      changeCommands(
        "actions",
        value,
        "action.authorized",
        a.actor,
        new Date().toISOString(),
      ),
    );
    return value;
  }
  async dispatch(id: string): Promise<boolean> {
    const a = await this.store.get<Action>("actions", id);
    requireCondition(a?.status === "authorized", "conflict");
    const task = await this.store.get<TaskContract>("tasks", a.taskId);
    requireCondition(
      task && Number(task.contractRevision ?? 1) === a.taskRevision,
      "precondition_failed",
      "Task contract changed",
    );
    requireCondition(
      Date.now() < Date.parse(task.deadline),
      "budget_exhausted",
    );
    for (const target of a.targets) {
      const r = await resolveTargets(
        this.store,
        a.sessionId,
        a.taskId,
        a.actor,
        target.id,
      );
      requireCondition(
        r.identity === target.identity && r.revision === target.revision,
        "identity_mismatch",
      );
      await this.grants.resolve(r, a.effect, this.principal);
      const session = await this.store.get<Session>("sessions", a.sessionId);
      requireCondition(session, "not_found");
      checkInvocation(session, r, a.effect);
      if (a.effect === "change") await this.requireBusinessAcceptance(task, r);
    }
    const commands: DbCommand[] = this.locks.commands(
      a.targets.map((t) => t.id),
      a.id,
      a.effect === "read" ? "read" : "write",
    );
    let approvalId: string | undefined;
    if (a.effect !== "read") {
      const approved = await this.approvals.consume(a, this.principal);
      commands.push(approved.command);
      approvalId = approved.approval.id;
    }
    let epoch: number | undefined;
    if (a.terminalSessionId) {
      const t = await this.store.get<ExecutionSession>(
        "execution_sessions",
        a.terminalSessionId,
      );
      requireCondition(
        t?.sessionId === a.sessionId &&
          t.resourceId === a.targets[0]?.id &&
          t.status === "ready" &&
          !t.paused,
        "scope_denied",
      );
      const first = (await this.store.list<Action>("actions")).find(
        (candidate) =>
          candidate.terminalSessionId === t.id &&
          candidate.status === "authorized",
      );
      if (first && first.id !== id) return false;
      const busy = (await this.store.list<Action>("actions")).some(
        (other) =>
          other.id !== id &&
          other.terminalSessionId === t.id &&
          ["queued", "dispatched", "unknown", "verifying"].includes(
            other.status,
          ),
      );
      if (
        busy ||
        (t.inputHolder &&
          t.inputHolder !== a.actor &&
          Date.parse(t.inputExpiresAt ?? "") > Date.now())
      )
        return false;
      epoch = t.inputEpoch + 1;
      commands.push(
        ...changeCommands(
          "execution_sessions",
          {
            ...t,
            revision: t.revision + 1,
            inputHolder: a.actor,
            inputEpoch: epoch,
            inputExpiresAt: new Date(
              Date.now() + this.inputLeaseMs,
            ).toISOString(),
          },
          "terminal.control_granted",
          a.actor,
          new Date().toISOString(),
        ),
      );
    }
    const value: Action = {
      ...a,
      revision: a.revision + 1,
      status: "queued",
      ...(approvalId ? { approvalId } : {}),
      ...(epoch !== undefined ? { inputEpoch: epoch } : {}),
    };
    commands.push(
      ...changeCommands(
        "actions",
        value,
        "action.queued",
        a.actor,
        new Date().toISOString(),
      ),
    );
    try {
      await this.store.transact(commands);
      return true;
    } catch (e) {
      if (e instanceof LakeError && e.code === "conflict") return false;
      throw e;
    }
  }
  async execute(proposal: unknown, signal: AbortSignal): Promise<ToolResult> {
    let a = await this.prepare(proposal);
    if (
      ["succeeded", "failed", "cancelled", "blocked"].includes(a.status) &&
      a.result
    )
      return a.result;
    if (a.status === "unknown")
      return toolResult(
        { reason: "unknown_effect", actionId: a.id },
        { status: "waiting", actionId: a.id },
      );
    a = await this.authorize(a.id);
    if (a.status === "waiting_approval")
      return toolResult(
        {
          reason: "approval_required",
          actionId: a.id,
          digest: a.proposalDigest,
        },
        { status: "waiting", actionId: a.id },
      );
    if (a.status === "authorized" && !(await this.dispatch(a.id)))
      return toolResult(
        { reason: "waiting_input_control", actionId: a.id },
        { status: "waiting", actionId: a.id },
      );
    return this.run(a.id, signal);
  }
}
