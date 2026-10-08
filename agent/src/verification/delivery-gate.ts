import type { StorePort } from "../domain/ports.js";
import type {
  TaskContract,
  Evidence,
  Observation,
  Action,
  TaskStep,
  Resource,
} from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
import { EvidencePolicy } from "./evidence-policy.js";
export interface DeliveryResult {
  status: "verified" | "qualified" | "blocked";
  criteria: {
    id: string;
    verified: boolean;
    required: boolean;
    evidenceIds: string[];
  }[];
  gaps: string[];
}
export class DeliveryGate {
  constructor(private readonly store: StorePort) {}
  async evaluate(taskId: string): Promise<DeliveryResult> {
    const task = await this.store.get<TaskContract>("tasks", taskId);
    requireCondition(task, "not_found");
    const resources = await this.store.list<Resource>("resources");
    const actions = (await this.store.list<Action>("actions")).filter(
      (a) => a.taskId === taskId,
    );
    const currentProof = (actionId: string | undefined) =>
      !actionId ||
      actions.some(
        (a) =>
          a.id === actionId &&
          a.taskRevision === Number(task.contractRevision ?? 1),
      );
    const evidence = (await this.store.list<Evidence>("evidence")).filter(
      (e) =>
        e.taskId === taskId &&
        e.result &&
        currentProof(e.actionId) &&
        resources.some(
          (r) => r.id === e.resourceId && r.identity === e.resourceIdentity,
        ) &&
        new EvidencePolicy().isFresh(e),
    );
    const observations = (
      await this.store.list<Observation>("observations")
    ).filter(
      (o) =>
        o.taskId === taskId &&
        currentProof(o.actionId) &&
        new EvidencePolicy().isFresh(o),
    );
    const criteria = task.acceptanceCriteria.map((c) => {
      const found =
        c.type === "observation"
          ? observations.filter(
              (o) => !c.resourceId || o.resourceId === c.resourceId,
            )
          : evidence.filter(
              (e) =>
                e.criterionId === c.id &&
                (!c.resourceId || e.resourceId === c.resourceId),
            );
      return {
        id: c.id,
        required: c.required,
        verified:
          c.type === "manual" ? Boolean(c.confirmedBy) : found.length > 0,
        evidenceIds: found.map((e) => e.id),
      };
    });

    const latestChanges = new Map<string, Action>();
    for (const a of actions)
      if (a.effect !== "read")
        for (const t of a.targets) latestChanges.set(t.id, a);
    const failedChange = [...latestChanges.values()].some(
      (a) => a.status === "failed" || a.status === "blocked",
    );
    const unknown = actions.some(
      (a) =>
        ["queued", "dispatched", "observed", "unknown", "verifying"].includes(
          a.status,
        ) ||
        (a.effect !== "read" &&
          ["proposed", "waiting_approval", "authorized"].includes(a.status)),
    );
    const unfinished = (await this.store.list<TaskStep>("task_steps")).some(
      (s) => s.taskId === taskId && s.status !== "succeeded",
    );
    const missingChange =
      task.intent === "change" &&
      !actions.some(
        (a) =>
          a.effect === "change" &&
          a.status === "succeeded" &&
          a.taskRevision === Number(task.contractRevision ?? 1),
      );
    const requiredMissing = criteria.some((c) => c.required && !c.verified),
      optionalMissing = criteria.some((c) => !c.required && !c.verified);
    return {
      status:
        unknown ||
        unfinished ||
        requiredMissing ||
        failedChange ||
        missingChange
          ? "blocked"
          : optionalMissing
            ? "qualified"
            : "verified",
      criteria,
      gaps: [
        ...criteria.filter((c) => !c.verified).map((c) => c.id),
        ...(unknown ? ["unsettled_action"] : []),
        ...(unfinished ? ["unfinished_steps"] : []),
        ...(failedChange ? ["failed_change"] : []),
        ...(missingChange ? ["requested_change_not_verified"] : []),
      ],
    };
  }
}
