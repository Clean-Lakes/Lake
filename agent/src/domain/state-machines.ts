import { LakeError } from "./errors.js";
type Graph = Record<string, readonly string[]>;
const action: Graph = {
  proposed: ["waiting_approval", "authorized", "blocked", "cancelled"],
  waiting_approval: ["authorized", "blocked", "cancelled"],
  authorized: ["queued", "blocked", "cancelled"],
  queued: ["dispatched", "blocked", "cancelled"],
  dispatched: ["observed", "unknown", "failed", "cancelled"],
  observed: ["verifying", "succeeded", "failed", "cancelled"],
  verifying: ["succeeded", "failed", "unknown", "cancelled"],
  unknown: ["observed", "failed", "blocked"],
  succeeded: [],
  failed: [],
  blocked: [],
  cancelled: [],
};
const specialist: Graph = {
  queued: ["running", "cancelled", "interrupted"],
  running: ["waiting", "succeeded", "failed", "cancelled", "interrupted"],
  waiting: ["queued", "running", "cancelled", "interrupted", "failed"],
  interrupted: ["queued", "waiting", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};
const terminal: Graph = {
  opening: ["ready", "disconnected", "closed"],
  ready: ["disconnected", "reconciling", "closed"],
  disconnected: ["opening", "reconciling", "closed"],
  reconciling: ["opening", "ready", "disconnected", "closed"],
  closed: [],
};
const step: Graph = {
  pending: ["claimed", "blocked", "cancelled"],
  claimed: ["running", "waiting", "blocked", "cancelled"],
  running: ["waiting", "verifying", "blocked", "failed", "cancelled"],
  waiting: ["running", "verifying", "blocked", "cancelled"],
  verifying: ["succeeded", "failed", "blocked", "cancelled"],
  succeeded: [],
  failed: [],
  blocked: ["pending", "cancelled"],
  cancelled: [],
};
const task: Graph = {
  active: ["waiting", "succeeded", "qualified", "failed", "cancelled"],
  waiting: ["active", "succeeded", "qualified", "failed", "cancelled"],
  succeeded: [],
  qualified: [],
  failed: [],
  cancelled: [],
};
export function validateTransition(
  kind: "action" | "specialist" | "terminal" | "step" | "task",
  from: string,
  to: string,
  options: {
    reconciled?: boolean;
    verified?: boolean;
    stopped?: boolean;
  } = {},
): void {
  const graph = { action, specialist, terminal, step, task }[kind];
  if (from === to) return;
  if (!graph[from]?.includes(to))
    throw new LakeError("conflict", "Invalid state transition");
  if (kind === "action" && from === "unknown" && !options.reconciled)
    throw new LakeError("unknown_effect");
  if (
    kind === "action" &&
    from === "dispatched" &&
    to === "cancelled" &&
    !options.stopped
  )
    throw new LakeError("unknown_effect");
  if (
    ["action", "task", "step", "specialist"].includes(kind) &&
    to === "succeeded" &&
    !options.verified
  )
    throw new LakeError("precondition_failed", "Completion requires evidence");
}
