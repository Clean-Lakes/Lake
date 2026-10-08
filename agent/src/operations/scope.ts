import type { StorePort } from "../domain/ports.js";
import type {
  Resource,
  TaskContract,
  Session,
  SpecialistRun,
} from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
export async function resolveTargets(
  store: StorePort,
  sessionId: string,
  taskId: string,
  actor: string,
  resourceId: string,
): Promise<Resource> {
  const [session, task, resource] = await Promise.all([
    store.get<Session>("sessions", sessionId),
    store.get<TaskContract>("tasks", taskId),
    store.get<Resource>("resources", resourceId),
  ]);
  requireCondition(
    session && task?.sessionId === sessionId && resource,
    "scope_denied",
  );
  requireCondition(
    task.scope.includes(resourceId) &&
      resource.lakeId === session.lakeId &&
      resource.environmentId === session.environmentId,
    "scope_denied",
  );
  requireCondition(
    !task.cancelRequestedAt &&
      !["cancelled", "failed", "succeeded", "qualified"].includes(task.status),
    "cancelled",
  );
  if (actor !== sessionId) {
    const run = await store.get<SpecialistRun>("specialist_runs", actor);
    requireCondition(
      run?.sessionId === sessionId &&
        run.taskId === taskId &&
        run.workOrder.resourceIds.includes(resourceId) &&
        !run.cancelRequestedAt,
      "scope_denied",
    );
  }
  return resource;
}
