import type { Message, SuperProject } from "../../web-agent/shared/contracts";
import type { LakeStore } from "./store";
import { digest, type Goal } from "./tasks";

/** Project the already delivered message into its own Worker transcript. The
 * outbox receipt and its exact destination key are the authority across restarts. */
export function workerDeliveries(store: LakeStore, goal: Goal, channelId: string) {
  const project = store.require<SuperProject>("superProjects", goal.projectId);
  const rows = store.db.prepare(
    "SELECT value FROM records WHERE kind='superReports' AND json_extract(value,'$.workerId')=? ORDER BY json_extract(value,'$.goalRevision')"
  ).all(goal.workerId);
  const byTurn = new Map<string, Message>();
  for (const row of rows) {
    const receipt = JSON.parse(String(row.value));
    if (receipt.inline || receipt.key !== digest([goal.id, receipt.goalRevision])) continue;
    for (const destination of [channelId, project.routerSessionId]) {
      const id = "report_" + digest([receipt.key, destination]);
      const message = store.get<Message>("messages", id);
      const author = message?.author;
      if (!message || !author?.rootTurnId || message.id !== id || message.sessionId !== destination ||
          message.role !== "assistant" || !message.text.trim() || author.workerId !== goal.workerId ||
          author.sessionId !== goal.sessionId || author.roleId !== goal.roleId || author.channelSessionId !== channelId ||
          (author.taskId !== goal.id && (!goal.sharedTaskId || author.taskId !== goal.sharedTaskId))) continue;
      byTurn.set(author.rootTurnId, message);
      break;
    }
  }
  return [...byTurn.values()];
}
