import { randomUUID } from "node:crypto";
import type { StorePort } from "../../src/domain/ports.js";
import type { Session, TaskContract } from "../../src/domain/entities.js";
import { initialBudget } from "../../src/agent/budget.js";
export async function addSession(
  h: {
    store: StorePort;
    lakeId: string;
    environmentId: string;
  },
  calls = 100,
) {
  const sessionId = randomUUID(),
    taskId = randomUUID(),
    deadline = new Date(Date.now() + 1800000).toISOString();
  const session: Session = {
    id: sessionId,
    revision: 1,
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    status: "active",
    rootTaskId: taskId,
    providerId: "fixture",
    eventCursor: "0",
    budget: initialBudget(calls, 200000, deadline),
  };
  const task: TaskContract = {
    id: taskId,
    revision: 1,
    sessionId,
    objective: "Investigate fixture service",
    scope: [],
    constraints: ["Keep changes scoped"],
    acceptanceCriteria: [
      {
        id: "facts",
        label: "Sourced observation",
        type: "observation",
        required: true,
      },
    ],
    deadline,
    status: "active",
  };
  await h.store.transact([
    { op: "put", table: "sessions", value: session, expectedRevision: 0 },
    { op: "put", table: "tasks", value: task, expectedRevision: 0 },
  ]);
  return { session, task };
}
