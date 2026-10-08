import type { StorePort } from "../domain/ports.js";
import type { Resource, Service } from "../domain/entities.js";
import { publicProjection } from "../domain/schemas.js";
import { requireCondition } from "../domain/errors.js";
import { getSnapshotWithCursor } from "../storage/projections.js";
import { SnapshotSchema } from "../domain/dto.js";
export class DataService {
  constructor(private readonly store: StorePort) {}
  async snapshot(sessionId: string): Promise<Record<string, unknown>> {
    return SnapshotSchema.parse(
      await getSnapshotWithCursor(this.store, sessionId),
    );
  }
  async serviceContext(id: string): Promise<unknown> {
    const service = await this.store.get<Service>("services", id);
    requireCondition(service, "not_found");
    const resources = (await this.store.list<Resource>("resources")).filter(
      (r) => service.resourceBindings.some((b) => b.resourceId === r.id),
    );
    return publicProjection({ service, resources });
  }
  async agentContext(sessionId: string): Promise<unknown> {
    const snapshot = await this.snapshot(sessionId);
    const rows = (key: string) =>
      (snapshot[key] ?? []) as Record<string, unknown>[];
    return {
      session: snapshot.session,
      task: rows("tasks").find(
        (t) => t.id === (snapshot.session as any).rootTaskId,
      ),
      resources: rows("resources").map(
        ({ id, name, kind, endpoint, identity, revision }) => ({
          id,
          name,
          kind,
          endpoint,
          identity,
          revision,
        }),
      ),
      services: rows("services"),
      steps: rows("task_steps"),
      specialists: rows("specialist_runs").map(
        ({ id, profileId, state, powerBindings }) => ({
          id,
          profileId,
          state,
          powerBindings,
        }),
      ),
      actions: rows("actions")
        .slice(-10)
        .map(
          ({
            id,
            actor,
            capability,
            status,
            result,
            proposalDigest,
            targets,
          }) => ({
            id,
            actor,
            capability,
            status,
            result: JSON.stringify(result ?? null).slice(0, 1024),
            proposalDigest,
            targets,
          }),
        ),
      observations: rows("observations")
        .slice(-12)
        .map(
          ({
            id,
            resourceId,
            source,
            observedAt,
            expiresAt,
            invalidatedAt,
            value,
            trusted,
          }) => ({
            id,
            resourceId,
            source,
            observedAt,
            expiresAt,
            invalidatedAt,
            trusted,
            value: JSON.stringify(value).slice(0, 1024),
          }),
        ),
      evidence: rows("evidence").slice(-12),
      hypotheses: rows("hypotheses"),
      terminals: rows("execution_sessions"),
    };
  }
}
