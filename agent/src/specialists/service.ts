import type { StorePort } from "../domain/ports.js";
import type {
  SpecialistRun,
  SpecialistProfile,
  TaskContract,
} from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
import { SkillRegistry } from "../skills/registry.js";
import { freezeProfile, generalProfile } from "./profile.js";
import { createWorkOrder } from "./work-order.js";
import { initialBudget } from "../agent/budget.js";
import { stableId } from "./task-progress.js";
import { InboxService } from "./inbox.js";
export class SpecialistService {
  constructor(
    private readonly store: StorePort,
    private readonly skills: SkillRegistry,
    private readonly profiles: SpecialistProfile[],
    private readonly maxCalls = 30,
  ) {}
  async spawn(
    taskId: string,
    input: {
      objective: string;
      resourceIds: string[];
      stepIds: string[];
      profileId?: string;
    },
    callKey: string,
  ): Promise<SpecialistRun> {
    const id = stableId("specialist:" + callKey);
    const old = await this.store.get<SpecialistRun>("specialist_runs", id);
    if (old) return old;
    const task = await this.store.get<TaskContract>("tasks", taskId);
    requireCondition(task && !task.cancelRequestedAt, "not_found");
    const selected = input.profileId
      ? (this.profiles.find((p) => p.id === input.profileId) ??
        (input.profileId === generalProfile.id ? generalProfile : undefined))
      : generalProfile;
    requireCondition(selected, "not_found");
    const { profile, digest } = freezeProfile(selected);
    const workOrder = createWorkOrder(
      task,
      input,
      this.skills.resolve(profile.extraSkills),
    );
    const time = new Date().toISOString();
    const value: SpecialistRun = {
      id,
      revision: 1,
      sessionId: task.sessionId,
      taskId,
      profileId: profile.id,
      profileDigest: digest,
      profile,
      workOrder,
      modelSessionId: id,
      state: {
        status: "queued",
        phase: "collecting",
        activity: "idle",
        taskId,
        since: time,
        updatedAt: time,
        revision: 1,
      },
      powerBindings: [],
      budget: initialBudget(
        Math.min(profile.maxTurns, this.maxCalls),
        200000,
        task.deadline,
      ),
    };
    await this.store.transact(
      changeCommands(
        "specialist_runs",
        value,
        "specialist.queued",
        task.sessionId,
        time,
      ),
    );
    return value;
  }
  async send(id: string, text: string, messageId: string): Promise<void> {
    const r = await this.store.get<SpecialistRun>("specialist_runs", id);
    requireCondition(r, "not_found");
    await new InboxService(this.store).deliver(
      r.sessionId,
      id,
      text,
      messageId,
    );
  }
  async cancel(id: string): Promise<void> {
    const r = await this.store.get<SpecialistRun>("specialist_runs", id);
    requireCondition(r, "not_found");
    if (["succeeded", "failed", "cancelled"].includes(r.state.status)) return;
    await this.store.transact(
      changeCommands(
        "specialist_runs",
        {
          ...r,
          revision: r.revision + 1,
          cancelRequestedAt: new Date().toISOString(),
          state: {
            ...r.state,
            status: r.state.status === "queued" ? "cancelled" : "interrupted",
            activity: "idle",
            revision: r.state.revision + 1,
          },
        },
        "specialist.state_changed",
        id,
        new Date().toISOString(),
      ),
    );
  }
  async resume(id: string): Promise<void> {
    const r = await this.store.get<SpecialistRun>("specialist_runs", id);
    requireCondition(
      r &&
        ["waiting", "interrupted"].includes(r.state.status) &&
        !r.cancelRequestedAt,
      "conflict",
    );
    await this.store.transact(
      changeCommands(
        "specialist_runs",
        {
          ...r,
          revision: r.revision + 1,
          state: {
            ...r.state,
            status: "queued",
            revision: r.state.revision + 1,
          },
        },
        "specialist.queued",
        id,
        new Date().toISOString(),
      ),
    );
  }
  async await(
    id: string,
    signal: AbortSignal,
    timeoutMs = 30000,
  ): Promise<SpecialistRun> {
    const end = Date.now() + Math.min(timeoutMs, 30000);
    while (true) {
      const r = await this.store.get<SpecialistRun>("specialist_runs", id);
      requireCondition(r, "not_found");
      if (
        !["queued", "running"].includes(r.state.status) ||
        Date.now() >= end ||
        signal.aborted
      )
        return r;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
