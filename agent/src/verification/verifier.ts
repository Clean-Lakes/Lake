import { randomUUID } from "node:crypto";
import type { StorePort } from "../domain/ports.js";
import type {
  Action,
  Resource,
  Service,
  TaskContract,
  Observation,
  Evidence,
  ToolResult,
} from "../domain/entities.js";
import { toolResult } from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
import { canonicalActionDigest } from "../operations/action-digest.js";
export class Verifier {
  constructor(
    private readonly store: StorePort,
    private readonly health: (
      resource: Resource,
      service: Service,
    ) => Promise<ToolResult>,
    private readonly postcondition: (
      action: Action,
      resource: Resource,
    ) => Promise<boolean>,
  ) {}
  async run(actionId: string): Promise<ToolResult> {
    const a = await this.store.get<Action>("actions", actionId);
    requireCondition(a?.result, "not_found");
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
    const task = await this.store.get<TaskContract>("tasks", a.taskId);
    requireCondition(task, "not_found");
    const time = new Date().toISOString();
    const observation: Observation = {
      id: randomUUID(),
      revision: 1,
      sessionId: a.sessionId,
      taskId: a.taskId,
      resourceId: resource.id,
      actionId: a.id,
      source: a.capability,
      observedAt: time,
      expiresAt: new Date(
        Date.now() + (a.capability.includes("log") ? 300000 : 30000),
      ).toISOString(),
      fingerprint: canonicalActionDigest(a.result.data),
      value: a.result.data,
      trusted: true,
    };
    await this.store.transact(
      changeCommands(
        "observations",
        observation,
        "observation.recorded",
        a.actor,
        time,
      ),
    );
    if (a.effect === "read") {
      const evidenceIds =
        a.capability === "http-health.health_window"
          ? await this.recordHealthEvidence(a, task, resource, a.result)
          : [];
      return toolResult({
        verified: true,
        observationId: observation.id,
        evidenceIds,
      });
    }
    requireCondition(
      await this.postcondition(a, resource),
      "precondition_failed",
      "Action postcondition failed",
    );
    if (resource.kind === "local")
      return toolResult({ verified: true, observationId: observation.id });
    const services = (await this.store.list<Service>("services")).filter(
      (s) =>
        s.resourceBindings.some((b) => b.resourceId === resource.id) &&
        s.health,
    );
    requireCondition(
      services.length === 1,
      "precondition_failed",
      "One bound service health profile is required",
    );
    const service = services[0]!;
    const http = (await this.store.list<Resource>("resources")).find(
      (r) =>
        r.lakeId === service.lakeId &&
        r.environmentId === service.environmentId &&
        r.kind === "http" &&
        r.endpoint === service.health!.url &&
        service.resourceBindings.some((b) => b.resourceId === r.id),
    );
    requireCondition(
      http && task.scope.includes(http.id),
      "scope_denied",
      "Health resource is outside the task",
    );
    const checked = await this.health(http, service),
      healthy =
        (
          checked.data as {
            healthy?: boolean;
          }
        )?.healthy === true;
    const ids = await this.recordHealthEvidence(a, task, http, checked);
    requireCondition(
      ids.length > 0,
      "precondition_failed",
      "Business acceptance criterion is missing",
    );
    return toolResult(
      { verified: healthy, evidenceIds: ids, health: checked.data },
      { status: healthy ? "ok" : "error" },
    );
  }
  private async recordHealthEvidence(
    a: Action,
    task: TaskContract,
    http: Resource,
    checked: ToolResult,
  ): Promise<string[]> {
    const healthy = (checked.data as { healthy?: boolean })?.healthy === true;
    const ids: string[] = [];
    for (const c of task.acceptanceCriteria.filter(
      (c) =>
        c.type === "http_health" && (!c.resourceId || c.resourceId === http.id),
    )) {
      const e: Evidence = {
        id: randomUUID(),
        revision: 1,
        sessionId: a.sessionId,
        taskId: a.taskId,
        actionId: a.id,
        resourceId: http.id,
        resourceIdentity: http.identity,
        criterionId: c.id,
        source: "http-service-v1",
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        fingerprint: canonicalActionDigest(checked.data),
        result: healthy,
        trusted: true,
      };
      await this.store.transact(
        changeCommands(
          "evidence",
          e,
          "verification.finished",
          a.actor,
          new Date().toISOString(),
        ),
      );
      ids.push(e.id);
    }
    return ids;
  }
}
