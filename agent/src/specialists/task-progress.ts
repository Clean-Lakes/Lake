import { randomUUID, createHash } from "node:crypto";
import type { StorePort } from "../domain/ports.js";
import type { TaskStep, TaskContract } from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
import { validateTransition } from "../domain/state-machines.js";
export function stableId(key: string): string {
  const b = createHash("sha256").update(key).digest();
  b[6] = (b[6]! & 15) | 80;
  b[8] = (b[8]! & 63) | 128;
  const hex = b.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class TaskProgressService {
  constructor(
    private readonly store: StorePort,
    private readonly verify: (
      step: TaskStep,
      evidenceIds: string[],
    ) => Promise<boolean>,
  ) {}
  async plan(
    taskId: string,
    input: {
      id?: string;
      label: string;
      dependencies: string[];
    }[],
    callKey: string,
  ): Promise<TaskStep[]> {
    const task = await this.store.get<TaskContract>("tasks", taskId);
    requireCondition(task, "not_found");
    const rows: TaskStep[] = input.map((v, i) => ({
      id: v.id ?? stableId(callKey + ":" + i),
      revision: 1,
      taskId,
      sessionId: task.sessionId,
      label: v.label,
      dependencies: v.dependencies,
      status: "pending",
      evidenceIds: [],
    }));
    const all = [
      ...(await this.store.list<TaskStep>("task_steps")).filter(
        (s) => s.taskId === taskId,
      ),
      ...rows,
    ];
    const visit = (id: string, path: Set<string>): void => {
      requireCondition(!path.has(id), "invalid_input", "Step dependency cycle");
      const row = all.find((s) => s.id === id);
      requireCondition(row, "not_found", "Step dependency missing");
      for (const dep of row.dependencies) visit(dep, new Set([...path, id]));
    };
    for (const row of rows) visit(row.id, new Set());
    const existing = await Promise.all(
      rows.map((r) => this.store.get<TaskStep>("task_steps", r.id)),
    );
    if (existing.every(Boolean)) {
      requireCondition(
        existing.every(
          (s, i) =>
            s?.taskId === taskId &&
            s.label === rows[i]!.label &&
            JSON.stringify(s.dependencies) ===
              JSON.stringify(rows[i]!.dependencies),
        ),
        "conflict",
        "Step IDs cannot be reused for another plan",
      );
      return existing as TaskStep[];
    }
    requireCondition(
      new Set(rows.map((r) => r.id)).size === rows.length,
      "invalid_input",
      "Duplicate step IDs",
    );
    await this.store.transact(
      rows.flatMap((row) =>
        changeCommands(
          "task_steps",
          row,
          "step.updated",
          "coordinator",
          new Date().toISOString(),
        ),
      ),
    );
    return rows;
  }
  async claim(
    id: string,
    owner: string,
    expectedRevision: number,
  ): Promise<TaskStep> {
    const step = await this.store.get<TaskStep>("task_steps", id);
    requireCondition(
      step && step.revision === expectedRevision && step.status === "pending",
      "conflict",
    );
    for (const dep of step.dependencies)
      requireCondition(
        (await this.store.get<TaskStep>("task_steps", dep))?.status ===
          "succeeded",
        "precondition_failed",
        "Step dependency is unfinished",
      );
    const value = {
      ...step,
      revision: step.revision + 1,
      assignee: owner,
      status: "claimed" as const,
    };
    await this.store.transact(
      changeCommands(
        "task_steps",
        value,
        "step.claimed",
        owner,
        new Date().toISOString(),
      ),
    );
    return value;
  }
  async report(
    id: string,
    owner: string,
    evidenceIds: string[],
    complete = false,
  ): Promise<TaskStep> {
    let step = await this.store.get<TaskStep>("task_steps", id);
    requireCondition(step?.assignee === owner, "scope_denied");
    requireCondition(
      !["succeeded", "cancelled", "failed"].includes(step.status),
      "conflict",
    );
    if (complete)
      requireCondition(
        evidenceIds.length > 0 && (await this.verify(step, evidenceIds)),
        "precondition_failed",
        "Step requires verified evidence",
      );
    const states: TaskStep["status"][] = complete
      ? step.status === "claimed"
        ? ["running", "verifying", "succeeded"]
        : ["verifying", "succeeded"]
      : ["running"];
    const commands = [];
    for (const status of states) {
      validateTransition("step", step.status, status, { verified: complete });
      step = {
        ...step,
        revision: step.revision + 1,
        evidenceIds: [...new Set([...step.evidenceIds, ...evidenceIds])],
        status,
      };
      commands.push(
        ...changeCommands(
          "task_steps",
          step,
          "step.updated",
          owner,
          new Date().toISOString(),
        ),
      );
    }
    await this.store.transact(commands);
    return step;
  }
  async completeStep(
    id: string,
    owner: string,
    evidenceIds: string[],
  ): Promise<TaskStep> {
    return this.report(id, owner, evidenceIds, true);
  }
}
