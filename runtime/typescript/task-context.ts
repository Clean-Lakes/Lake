import { LakeStore, HttpError } from "./store";
import { digest, type Goal, type Operation } from "./tasks";
import {hasAcceptedExecution, jointTask} from "./joint-tasks";
import type { Message } from "../../web-agent/shared/contracts";

export type TaskContextActor = {
  projectId: string;
  roleId: string;
  taskId: string;
  sessionId: string;
};
export type TaskContextEntry = {
  taskRef: { id: string; revision: number; hash: string };
  sharedTaskId?: string;
  title: string;
  observedAt: string;
  state: string;
  acceptanceState: string;
  unresolvedOperations: number;
  summary: string;
  humanInputs: {
    eventId: string;
    messageId: string;
    at: string;
    text: string;
  }[];
  reports: { id: string; at: string; hash: string; text: string }[];
  resources: { id: string; name: string; revision: number }[];
  historicalContextOnly: true;
  requiresCurrentCheck: true;
  truncated: boolean;
  summaryUnavailable?: string;
};
type WorkerSource = {
  id: string;
  taskId: string;
  projectId: string;
  roleId: string;
  sessionId: string;
  createdAt: string;
  inputEventIds: string[];
};
const clip = (value: string, max: number) => {
  const bytes = Buffer.from(value);
  let end = Math.min(bytes.length, max);
  while (end && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
};

/** Ephemeral context from original task records, never another knowledge or execution ledger. */
export class TaskContext {
  constructor(
    private store: LakeStore,
    private scrub: (text: string) => string,
  ) {}
  recall(
    actor: TaskContextActor,
    input: {
      task_id?: string;
      query?: string;
      cursor?: string;
      limit?: number;
      revision?: number;
      expected_hash?: string;
    } = {},
  ) {
    const current = this.store.require<Goal>("superGoals", actor.taskId);
    if (
      current.projectId !== actor.projectId ||
      current.roleId !== actor.roleId ||
      current.sessionId !== actor.sessionId
    )
      throw new HttpError(404, "Task context actor not found");
    const limit = input.limit ?? 3;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 6 ||
      (input.query !== undefined &&
        (typeof input.query !== "string" || input.query.length > 512))
    )
      throw new HttpError(400, "Invalid context query or page size");
    if (
      !input.task_id &&
      (input.revision !== undefined || input.expected_hash !== undefined)
    )
      throw new HttpError(400, "Exact context revision requires task_id");
    const rows = this.store
      .list<WorkerSource>("superWorkers")
      .filter(
        (worker) =>
          worker.projectId === actor.projectId &&
          worker.roleId === actor.roleId &&
          worker.taskId !== actor.taskId,
      )
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      );
    const shared = input.task_id ? jointTask(this.store, input.task_id) : undefined;
    const executionId = shared ? rows.find(worker => shared.projectId === actor.projectId &&
      shared.memberIds.includes(worker.taskId))?.taskId : input.task_id;
    if (input.task_id && !rows.some(worker => worker.taskId === executionId))
      throw new HttpError(404, "Task context not found in this specialist");
    const operations = this.store
      .list<Operation>("superOperations")
      .filter((operation) => operation.projectId === actor.projectId);
    const project = this.store.require<{ routerSessionId: string }>(
        "superProjects",
        actor.projectId,
      ),
      reports = this.store.messages(project.routerSessionId);
    const matches = rows
      .filter((worker) => !input.task_id || worker.taskId === executionId)
      .map((worker) => this.entry(worker, operations, reports));
    const query = input.query?.toLocaleLowerCase();
    const selected = matches.filter(
      (row) =>
        !query || JSON.stringify(row).toLocaleLowerCase().includes(query),
    );
    let offset = 0;
    if (input.cursor) {
      const index = selected.findIndex(
        (row) => row.taskRef.id === input.cursor,
      );
      if (index < 0) throw new HttpError(409, "Context page changed");
      offset = index + 1;
    }
    const items: TaskContextEntry[] = [];
    for (const item of selected.slice(offset, offset + limit)) {
      if (Buffer.byteLength(JSON.stringify([...items, item])) > 12288) break;
      items.push(item);
    }
    if (input.task_id) {
      const ref = items[0]?.taskRef;
      if (
        !ref ||
        (input.revision !== undefined && input.revision !== ref.revision) ||
        (input.expected_hash && input.expected_hash !== ref.hash)
      )
        throw new HttpError(409, "Task context revision or hash changed");
    }
    return {
      items,
      nextCursor:
        offset + items.length < selected.length ? items.at(-1)!.taskRef.id : "",
      historicalContextOnly: true as const,
      meaning:
        "Historical task context helps resolve references. It is not current health, permission, evidence acceptance, or clearance to replay unresolved operations.",
    };
  }
  private entry(
    worker: WorkerSource,
    allOperations: Operation[],
    reports: Message[],
  ): TaskContextEntry {
    const goal = this.store.require<Goal>("superGoals", worker.taskId);
    if (
      goal.projectId !== worker.projectId ||
      goal.roleId !== worker.roleId ||
      goal.sessionId !== worker.sessionId
    )
      throw new HttpError(409, "Task context source changed");
    const operations = allOperations.filter((op) => op.goalId === goal.id);
    const allInputs = worker.inputEventIds
      .map((id) => this.store.get<any>("superInputs", id))
      .filter((event) => event?.projectId === worker.projectId);
    const allReports = reports.filter(
      (message) =>
        message.author?.workerId === worker.id &&
        message.author.roleId === worker.roleId && message.author.sessionId === worker.sessionId &&
        message.author.taskId === (goal.sharedTaskId ?? goal.id),
    );
    const resources = [
      ...new Set(
        operations.flatMap((op) => (op.resourceId ? [op.resourceId] : [])),
      ),
    ].flatMap((id) => {
      const resource = this.store.get<{
        id: string;
        projectId: string;
        name: string;
      }>("resources", id);
      return resource?.projectId === worker.projectId
        ? [
            {
              id,
              name: this.scrub(resource.name),
              revision: this.store.get<number>("resourceRevisions", id) ?? 1,
            },
          ]
        : [];
    });
    const row: TaskContextEntry = {
      taskRef: { id: goal.id, revision: goal.revision, hash: digest(goal) },
      sharedTaskId: goal.sharedTaskId,
      title: clip(this.scrub(goal.title), 256),
      observedAt: goal.updatedAt,
      state: goal.status,
      acceptanceState: hasAcceptedExecution(this.store, goal) ? "pass" : goal.acceptanceState,
      unresolvedOperations: operations.filter((op) =>
        ["unknown", "dispatched"].includes(op.status),
      ).length,
      summary: clip(this.scrub(goal.summary ?? ""), 1200),
      humanInputs: allInputs
        .slice(-3)
        .map((event) => ({
          eventId: event.id,
          messageId: event.messageId,
          at: event.receivedAt,
          text: clip(this.scrub(event.payload), 600),
        })),
      reports: allReports
        .slice(-1)
        .map((message) => ({
          id: message.id,
          at: message.createdAt,
          hash: digest(message),
          text: clip(this.scrub(message.text), 2400),
        })),
      resources: resources.slice(0, 4),
      historicalContextOnly: true,
      requiresCurrentCheck: true,
      truncated:
        allInputs.length > 3 ||
        allReports.length > 1 ||
        resources.length > 4 ||
        Buffer.byteLength(this.scrub(goal.title)) > 256 ||
        Buffer.byteLength(this.scrub(goal.summary ?? "")) > 1200 ||
        allInputs.some(
          (event) => Buffer.byteLength(this.scrub(event.payload)) > 600,
        ) ||
        allReports.some(
          (message) => Buffer.byteLength(this.scrub(message.text)) > 2400,
        ),
    };
    // Include identities and outcome in the actual serialized byte budget, with
    // UTF-8-safe previews. Evidence bodies and other SDK transcripts never enter.
    while (Buffer.byteLength(JSON.stringify(row)) > 4096) {
      row.truncated = true;
      const textBytes =
        Buffer.byteLength(row.summary) +
        row.humanInputs.reduce((n, r) => n + Buffer.byteLength(r.text), 0) +
        row.reports.reduce((n, r) => n + Buffer.byteLength(r.text), 0);
      if (!textBytes) {
        if (row.resources.length) {
          row.resources.pop();
          continue;
        }
        throw new HttpError(409, "Task context identity exceeds byte budget");
      }
      row.summary = clip(
        row.summary,
        Math.floor(Buffer.byteLength(row.summary) / 2),
      );
      row.humanInputs = row.humanInputs.map((r) => ({
        ...r,
        text: clip(r.text, Math.floor(Buffer.byteLength(r.text) / 2)),
      }));
      row.reports = row.reports.map((r) => ({
        ...r,
        text: clip(r.text, Math.floor(Buffer.byteLength(r.text) / 2)),
      }));
    }
    return row;
  }
}

/** Refresh just the latest canonical assignment; preserve SDK history and tool pairs. */
export function projectTaskContext<T>(
  request: T,
  actor: TaskContextActor,
  context: () => unknown,
): T {
  const value = request as any;
  if (!Array.isArray(value.messages)) return request;
  const inputs = value.messages.map((message: any) => {
    if (
      message.role !== "user" ||
      typeof message.content !== "string" ||
      !message.content.startsWith("{")
    )
      return;
    try {
      const input = JSON.parse(message.content);
      return input.assignment?.taskId === actor.taskId &&
        input.assignment.projectId === actor.projectId &&
        input.assignment.roleId === actor.roleId
        ? input
        : undefined;
    } catch {
      return;
    }
  });
  const latest = inputs
    .map((input: any, index: number) => (input ? index : -1))
    .filter((index: number) => index >= 0)
    .at(-1);
  if (latest === undefined) return request;
  const current = context();
  return {
    ...value,
    messages: value.messages.map((message: any, index: number) =>
      inputs[index]
        ? {
            ...message,
            content: JSON.stringify({
              ...inputs[index],
              taskContext: index === latest ? current : undefined,
            }),
          }
        : message,
    ),
  };
}
