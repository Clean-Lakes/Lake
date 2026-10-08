import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LakeApplication } from "../app/application.js";
import type {
  TaskContract,
  Session,
  Action,
  ExecutionSession,
  SpecialistRun,
  Resource,
} from "../domain/entities.js";
import { publicProjection } from "../domain/schemas.js";
import { requireCondition, LakeError, publicError } from "../domain/errors.js";
import { canonicalActionDigest } from "../operations/action-digest.js";
import { resolveWorkspaces } from "../app/workspaces.js";
import { InvocationSchema } from "../domain/invocation.js";
import { stableId } from "../specialists/task-progress.js";
export const CommandSchema = z
  .object({
    requestId: z.uuid(),
    expectedRevision: z.int().nonnegative(),
    data: z.unknown(),
  })
  .strict();
export async function dispatchRoute(
  app: LakeApplication,
  method: string,
  path: string,
  query: URLSearchParams,
  input: unknown,
): Promise<unknown> {
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const [collection, id, operation] = parts;
  requireCondition(collection, "not_found");
  if (method === "GET") {
    if (collection === "diagnostics") return app.diagnostics();
    if (collection === "health")
      return { version: "0.0.1", nonce: (app as any).daemonNonce ?? null };
    if (collection === "resources")
      return publicProjection({
        lakes: await app.store.list("lakes"),
        environments: await app.store.list("environments"),
        resources: await app.store.list("resources"),
        grants: await app.store.list("resource_grants"),
      });
    if (collection === "services")
      return publicProjection(await app.store.list("services"));
    if (collection === "config")
      return {
        providers: app.config.providers.map((p) => ({
          id: p.id,
          model: p.model,
          supportsTools: p.supportsTools,
          contextWindowTokens: p.contextWindowTokens,
          maxOutputTokens: p.maxOutputTokens,
          supportsStreaming: p.supportsStreaming,
        })),
        defaultProvider: app.config.defaultProvider,
        cli: app.config.cli,
      };
    if (collection === "sessions") {
      if (!id) return publicProjection(await app.store.list("sessions"));
      if (operation === "snapshot") return app.data.snapshot(id);
      if (operation === "activity") {
        requireCondition(await app.store.get("sessions", id), "not_found");
        const after = query.get("after") ?? "0";
        requireCondition(/^\d+$/.test(after), "invalid_input");
        return app.events.replay(`session:${id}`, after);
      }
      if (operation === "messages")
        return (await app.store.list<any>("model_exchanges"))
          .filter(
            (e) =>
              e.sessionId === id && e.actor === id && e.status === "complete",
          )
          .map((e) => ({ text: e.assistant.content, createdAt: e.createdAt }));
    }
    if (collection === "terminals" && id && operation === "output") {
      const t = await app.store.get<ExecutionSession>("execution_sessions", id);
      requireCondition(t, "not_found");
      return app.sessions.read(t.sessionId, id, query.get("after") ?? "0");
    }
    if (collection === "artifacts" && id) {
      const meta = await app.store.get<any>("artifacts", id);
      requireCondition(meta, "not_found");
      return { id, content: await app.artifacts.read(id) };
    }
    const table =
      collection === "tasks"
        ? "tasks"
        : collection === "actions"
          ? "actions"
          : collection === "specialists"
            ? "specialist_runs"
            : undefined;
    if (table && id) {
      const value = await app.store.get(table, id);
      requireCondition(value, "not_found");
      return publicProjection(value);
    }
    throw new LakeError("not_found");
  }
  requireCondition(method === "POST", "not_found");
  const command = CommandSchema.parse(input),
    data = command.data as any,
    key = "local-user:" + command.requestId;
  const prior = await app.store.get<any>("api_requests", key);
  if (prior) {
    requireCondition(
      prior.method === method &&
        prior.path === path &&
        prior.input === canonicalActionDigest(command),
      "conflict",
      "Request ID was reused",
    );
    if (prior.status === "complete") return prior.result;
    if (prior.status === "failed")
      throw new LakeError(prior.error.code, prior.error.message);
    throw new LakeError("conflict", "Request result requires reconciliation");
  }
  const entityTable =
    collection === "sessions"
      ? operation === "messages" || operation === "cancel"
        ? "tasks"
        : "sessions"
      : collection === "specialists"
        ? "specialist_runs"
        : collection === "actions"
          ? "actions"
          : collection === "tasks"
            ? "tasks"
            : collection === "terminals"
              ? "execution_sessions"
              : collection === "grants" && id
                ? "resource_grants"
                : undefined;
  if (entityTable && id) {
    let entityId = id;
    if (collection === "sessions" && operation === "messages") {
      const s = await app.store.get<Session>("sessions", id);
      requireCondition(s, "not_found");
      entityId = s.rootTaskId;
    }
    const existing = await app.store.get<any>(entityTable, entityId);
    requireCondition(
      existing &&
        (collection === "terminals" && operation === "input"
          ? existing.inputEpoch === data?.epoch
          : existing.revision === command.expectedRevision),
      "conflict",
    );
  } else requireCondition(command.expectedRevision === 0, "conflict");
  const receipt = {
    id: key,
    revision: 1,
    principal: "local-user",
    requestId: command.requestId,
    method,
    path,
    input: canonicalActionDigest(command),
    status: "pending",
  };
  await app.store.transact([
    { op: "put", table: "api_requests", value: receipt, expectedRevision: 0 },
  ]);
  let result: unknown;
  try {
    if (
      collection === "workspaces" &&
      operation === undefined &&
      id === "resolve"
    ) {
      const p = z
        .object({
          roots: z.array(z.string()).min(1).max(32),
          sandboxMode: InvocationSchema.shape.sandboxMode,
        })
        .strict()
        .parse(data);
      result = await resolveWorkspaces(app, p.roots, p.sandboxMode);
    } else if (collection === "sessions" && !id) {
      const session = await app.createSession(
        data,
        stableId("session:" + command.requestId),
      );
      result = publicProjection(session);
      app.startRoot(session.id);
    } else if (collection === "sessions" && id && operation === "model") {
      const p = z
        .object({
          providerId: z.string().min(1),
          model: z.string().min(1).optional(),
          reasoningEffort: InvocationSchema.shape.reasoningEffort,
        })
        .strict()
        .parse(data);
      result = publicProjection(
        await app.configureModel(id, p.providerId, p.model, p.reasoningEffort),
      );
    } else if (collection === "sessions" && id && operation === "fork") {
      const p = z
        .object({
          objective: z.string().min(1).max(65536).optional(),
          providerId: z.string().optional(),
          invocation: InvocationSchema.optional(),
        })
        .strict()
        .parse(data);
      const s = await app.store.get<Session>("sessions", id);
      requireCondition(s, "not_found");
      const task = await app.store.get<TaskContract>("tasks", s.rootTaskId);
      requireCondition(task, "not_found");
      const messages = (await app.store.list<any>("model_exchanges"))
        .filter(
          (e) =>
            e.sessionId === id && e.actor === id && e.status === "complete",
        )
        .slice(-3)
        .map((e) => e.assistant.content ?? "")
        .join("\n")
        .slice(-12000);
      const child = await app.createSession(
        {
          lakeId: s.lakeId,
          environmentId: s.environmentId,
          resourceIds: task.scope,
          objective: p.objective ?? task.objective,
          providerId: p.providerId ?? s.providerId,
          invocation: p.invocation ?? s.invocation,
          parentSessionId: id,
          intent: task.intent ?? "diagnose",
          constraints: [
            ...task.constraints,
            `Previous task context (historical, re-observe before changing): ${task.objective}\n${messages}`,
          ],
          acceptanceCriteria: task.acceptanceCriteria.map(
            ({ confirmedBy, ...criterion }) => criterion,
          ),
        },
        stableId("session:" + command.requestId),
      );
      result = publicProjection(child);
      app.startRoot(child.id);
    } else if (collection === "sessions" && id && operation === "messages") {
      const p = z
        .object({
          text: z.string().min(1).max(65536),
          specialistId: z.uuid().optional(),
        })
        .strict()
        .parse(data);
      await app.userMessage(
        id,
        p.text,
        command.expectedRevision,
        stableId(command.requestId),
        p.specialistId,
      );
      result = { accepted: true };
    } else if (collection === "sessions" && id && operation === "resume") {
      await app.resumeSession(id);
      result = { resumed: true };
    } else if (collection === "sessions" && id && operation === "specialists") {
      const s = await app.store.get<Session>("sessions", id);
      requireCondition(s, "not_found");
      const p = z
        .object({
          objective: z.string(),
          resourceIds: z.array(z.uuid()),
          stepIds: z.array(z.uuid()),
          profileId: z.string().optional(),
        })
        .strict()
        .parse(data);
      result = await app.specialists.spawn(
        s.rootTaskId,
        {
          objective: p.objective,
          resourceIds: p.resourceIds,
          stepIds: p.stepIds,
          ...(p.profileId ? { profileId: p.profileId } : {}),
        },
        command.requestId,
      );
    } else if (collection === "sessions" && id && operation === "budget") {
      const p = z
        .object({ maxCalls: z.int().positive(), maxTokens: z.int().positive() })
        .strict()
        .parse(data);
      await app.budget.update(id, p.maxCalls, p.maxTokens, "local-user");
      result = { updated: true };
    } else if (collection === "tasks" && id && operation === "cancel") {
      await app.cancelTask(id);
      result = { cancelRequested: true };
    } else if (
      collection === "tasks" &&
      id &&
      operation === "criteria" &&
      parts[4] === "confirm"
    ) {
      z.object({ confirmed: z.literal(true) })
        .strict()
        .parse(data);
      const task = await app.store.get<TaskContract>("tasks", id);
      requireCondition(
        task && ["active", "waiting"].includes(task.status),
        "conflict",
      );
      const criterion = task.acceptanceCriteria.find((c) => c.id === parts[3]);
      requireCondition(criterion?.type === "manual", "invalid_input");
      await app.store.transact([
        {
          op: "put",
          table: "tasks",
          value: {
            ...task,
            revision: task.revision + 1,
            contractRevision: Number(task.contractRevision ?? 1),
            acceptanceCriteria: task.acceptanceCriteria.map((c) =>
              c.id === criterion.id ? { ...c, confirmedBy: "local-user" } : c,
            ),
          },
          expectedRevision: task.revision,
        },
        {
          op: "event",
          event: {
            streamId: `session:${task.sessionId}`,
            sessionId: task.sessionId,
            type: "session.context_changed",
            aggregateId: task.id,
            aggregateRevision: task.revision + 1,
            actor: "local-user",
            occurredAt: new Date().toISOString(),
            data: { criterionId: criterion.id, confirmed: true },
          },
        },
      ]);
      result = { confirmed: true };
    } else if (collection === "actions" && id && operation === "approve") {
      const p = z
        .object({ digest: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(data);
      await app.approve(id, p.digest);
      result = { approved: true };
    } else if (collection === "actions" && id && operation === "reconcile")
      result = await app.reconciler.reconcile(id);
    else if (collection === "actions" && id && operation === "resolve") {
      const p = z
        .object({ statement: z.literal("stopped_or_not_performed") })
        .strict()
        .parse(data);
      result = await app.reconciler.resolveByHuman(
        id,
        "local-user",
        p.statement,
      );
    } else if (collection === "specialists" && id && operation === "messages") {
      const p = z
        .object({ text: z.string().min(1).max(65536) })
        .strict()
        .parse(data);
      await app.specialists.send(id, p.text, stableId(command.requestId));
      result = { sent: true };
    } else if (collection === "specialists" && id && operation === "cancel") {
      await app.cancelSpecialist(id);
      result = { cancelRequested: true };
    } else if (collection === "resources" && !id) {
      await app.importResources(data);
      result = { imported: true };
    } else if (collection === "services" && !id) {
      await app.importServices(data);
      result = { imported: true };
    } else if (collection === "grants" && !id) {
      const p = z
        .object({
          resourceId: z.uuid(),
          effects: z.array(z.enum(["read", "change", "interactive"])).min(1),
        })
        .strict()
        .parse(data);
      result = await app.grants.create(
        p.resourceId,
        p.effects,
        "local-user",
        stableId("grant:" + command.requestId),
      );
    } else if (collection === "grants" && id && operation === "revoke") {
      await app.grants.revoke(id, "local-user");
      result = { revoked: true };
    } else if (collection === "terminals" && id && operation === "control") {
      z.object({ confirmed: z.literal(true) })
        .strict()
        .parse(data);
      result = { epoch: await app.requestControl(id) };
    } else if (collection === "terminals" && id && operation === "input") {
      const p = z
        .object({ text: z.string().max(4096), epoch: z.int().positive() })
        .strict()
        .parse(data);
      await app.terminalInput(id, p.text, p.epoch);
      result = { accepted: true };
    } else if (collection === "terminals" && id && operation === "release") {
      const p = z
        .object({ stopped: z.literal(true) })
        .strict()
        .parse(data);
      await app.handoff.returnToManaged(id, "local-user", p.stopped);
      result = { released: true };
    } else throw new LakeError("not_found");
    result = app.redactor.value(result ?? { ok: true });
    await app.store.transact([
      {
        op: "put",
        table: "api_requests",
        value: { ...receipt, revision: 2, status: "complete", result },
        expectedRevision: 1,
      },
    ]);
    return result;
  } catch (error) {
    const row = await app.store.get<any>("api_requests", key);
    if (row?.status === "pending")
      await app.store.transact([
        {
          op: "put",
          table: "api_requests",
          value: {
            ...row,
            revision: row.revision + 1,
            status: "failed",
            error: publicError(error),
          },
          expectedRevision: row.revision,
        },
      ]);
    throw error;
  }
}
