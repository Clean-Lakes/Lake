import type {LakeStore} from "./store";
import type {Attempt, Goal, Step} from "./tasks";
import type {WorkAttemptView} from "../../web-agent/shared/contracts";

type Owner = {state: string; generation: number};
type Pending = {attemptId: string; stepId: string; status: string; commandId?: string};

function inactiveState(goal: Goal, owner?: Owner) {
  switch (goal.status) {
    case "blocked": case "paused": case "cancelled": case "failed":
    case "waiting_external": case "waiting_user": return goal.status;
    case "completed": return "ended";
    default: return owner?.state === "stopped" ? "cancelled" : owner?.state === "parked" ? "paused" :
      owner?.state === "queued" ? "queued" : "running";
  }
}

/** Historical attempts keep their ledger state. Presentation follows the owning
 * generation and actual command handles without closing an attempt or accepting a goal. */
export function projectTaskProgress(store: LakeStore, goal: Goal, owner: Owner | undefined,
  commandIsLive: (commandId: string) => boolean): Step[] {
  if (!goal.items.some(item => item.attemptId || item.status === "running")) return goal.items;
  const unsettled = store.db.prepare(`
    SELECT json_extract(value, '$.attemptId') AS attemptId, json_extract(value, '$.stepId') AS stepId,
      json_extract(value, '$.status') AS status, json_extract(value, '$.commandExecutionId') AS commandId
    FROM records WHERE kind='superOperations' AND json_extract(value, '$.goalId')=?
      AND json_extract(value, '$.sessionId')=? AND json_extract(value, '$.projectId')=?
      AND json_extract(value, '$.status') IN ('unknown','dispatched')`).all(goal.id, goal.sessionId, goal.projectId) as Pending[];
  const currentState = inactiveState(goal,owner);
  return goal.items.map(item => {
    const history: WorkAttemptView[] = [];
    const seen = new Set<string>();
    let cursor = item.attemptId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const attempt = store.get<Attempt>("superAttempts",cursor);
      if (!attempt || attempt.goalId !== goal.id || attempt.stepId !== item.id ||
          attempt.sessionId !== goal.sessionId || attempt.projectId !== goal.projectId) break;
      let status: string = attempt.state;
      if (status === "running") {
        const operations = unsettled.filter(op => op.attemptId === attempt.id && op.stepId === item.id);
        if (operations.some(op => op.status === "dispatched" && op.commandId && commandIsLive(op.commandId))) status = "running";
        else if (operations.some(op => op.status === "unknown")) status = "unknown";
        else if (operations.some(op => op.status === "dispatched")) status = "waiting_external";
        else if (cursor !== item.attemptId || (owner && attempt.generation !== owner.generation)) status = "ended";
        else status = currentState;
      }
      history.push({id:attempt.id, status, createdAt:attempt.createdAt});
      cursor = attempt.retryOf;
    }
    const latest = history[0]?.status;
    const status = item.status === "running" ? latest === "unknown" ? "blocked" :
      latest === "succeeded" ? "ended" : latest ?? currentState : item.status;
    return {...item,status,...(history.length && {attempts:history.reverse()})};
  });
}
