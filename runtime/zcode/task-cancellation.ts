import type { Message } from "../../web-agent/shared/contracts";
import type { LakeStore } from "./store";
import { digest, type Goal, type Operation } from "./tasks";

export const stoppedNotice = "已停止这次工作。";
export const unresolvedNotice =
  "有一项操作的结果还需核实，暂时不能重复该操作。";

/** Presentation only: a cancelled process never becomes successful evidence. */
export function cancelledReadOperation(
  store: LakeStore,
  operation: Operation,
): boolean {
  if (
    operation.tool !== "Bash" ||
    operation.status !== "failed" ||
    operation.readOnly !== true ||
    !operation.commandExecutionId ||
    !operation.completedAt ||
    !operation.outputHash ||
    operation.outputHash !== digest(operation.output)
  )
    return false;
  const execution = store.get<any>(
    "commandExecutions",
    operation.commandExecutionId,
  );
  const output = operation.output as any,
    result = execution?.result;
  return (
    !!execution &&
    execution.id === operation.commandExecutionId &&
    execution.taskId === operation.goalId &&
    execution.sessionId === operation.sessionId &&
    execution.generation === operation.generation &&
    execution.resourceId === operation.resourceId &&
    execution.resourceRevision === operation.resourceRevision &&
    execution.configurationRevision === operation.hostConfigurationHash &&
    execution.readOnly === true &&
    execution.status === "cancelled" &&
    !!execution.finishedAt &&
    result?.status === "cancelled" &&
    result.cancelled === true &&
    result.timedOut === false &&
    output?.status === "cancelled" &&
    output.cancelled === true &&
    output.timedOut === false
  );
}

/** Correct only the exact old host notice, with its durable outbox identity and
 * actual cancelled read receipt. User/model prose and original rows stay intact. */
export function stoppedReportProjection(
  store: LakeStore,
  message: Message,
  unresolved: (goalId: string) => boolean,
): Message {
  const author = message.author;
  if (
    message.role !== "assistant" ||
    message.text !== unresolvedNotice ||
    author?.kind !== "specialist" ||
    !author.taskId
  )
    return message;
  const goal = store.get<Goal>("superGoals", author.taskId),
    worker = store.get<any>("superWorkers", author.workerId);
  if (
    !goal ||
    !worker ||
    goal.status !== "cancelled" ||
    unresolved(goal.id) ||
    worker.state !== "stopped" ||
    goal.workerId !== worker.id ||
    worker.taskId !== goal.id ||
    worker.sessionId !== goal.sessionId ||
    author.sessionId !== worker.sessionId ||
    author.roleId !== worker.roleId
  )
    return message;
  const project = store.get<any>("superProjects", goal.projectId),
    channel = store.get<any>("superChannels", worker.roleId);
  if (
    !project ||
    !channel ||
    channel.projectId !== goal.projectId ||
    ![project.routerSessionId, channel.sessionId].includes(message.sessionId)
  )
    return message;
  const source = store
    .list<any>("superReports")
    .find(
      (report) =>
        report.workerId === worker.id &&
        Number.isSafeInteger(report.goalRevision) &&
        report.goalRevision <= goal.revision &&
        report.key === digest([goal.id, report.goalRevision]) &&
        message.id === "report_" + digest([report.key, message.sessionId]),
    );
  if (
    !source ||
    !store
      .list<Operation>("superOperations")
      .some(
        (operation) =>
          operation.goalId === goal.id &&
          operation.generation === worker.generation - 1 &&
          cancelledReadOperation(store, operation),
      )
  )
    return message;
  return { ...message, text: stoppedNotice };
}
