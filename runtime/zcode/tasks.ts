import { createHash } from "node:crypto";
import type { WorkGoal } from "../../web-agent/shared/contracts";
import { HttpError, id, LakeStore, now } from "./store";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value)
    .filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => JSON.stringify(key) + ":" + canonical(value)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const terminal = (state: string) => ["completed", "failed", "cancelled"].includes(state);
export function text(value: unknown, field: string, max = 4096) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max || value.includes("\0") || Buffer.from(value).toString("utf8") !== value)
    throw new HttpError(400, `${field} must be nonempty text (max ${max} bytes)`);
  return value;
}
export type Step = NonNullable<WorkGoal["items"]>[number] & {
  dependsOn: string[]; evidenceIds: string[]; attemptId?: string; acceptanceId?: string;
};
export type Goal = Omit<WorkGoal, "items"> & {
  projectId: string; workerId: string; roleId: string; sourceEventId: string;
  items: Step[]; planHash?: string; planRevision: number; goalRevision: number;
  acceptanceState: "not_evaluated" | "insufficient" | "pass" | "fail";
  activeItemId?: string; confirmed: boolean; mode: "default" | "plan";
};
export type Attempt = {
  id: string; goalId: string; sessionId: string; stepId: string; projectId: string;
  goalRevision: number; planRevision: number; generation: number; policyHash: string;
  state: "running" | "succeeded" | "failed" | "unknown"; createdAt: string;
  retryOf?: string; reconciledAt?: string; reconciliation?: string;
};
export type Operation = {
  id: string; callId: string; tool: string; argsHash: string; projectId: string;
  goalId: string; sessionId: string; stepId: string; attemptId: string;
  goalRevision: number; planRevision: number; generation: number; policyHash: string;
  status: "dispatched" | "succeeded" | "failed" | "unknown";
  output?: unknown; outputHash?: string; at: string; completedAt?: string;
  resourceId?: string; resourceRevision?: number; readOnly?: boolean;
  mcpServerId?: string; mcpTool?: string; remoteMcp?: boolean; configurationHash?: string; bindingHash?: string; catalogHash?: string;
  skillName?: string; skillHash?: string;
  hostConfigurationHash?: string;
};

// The goal and immutable acceptance receipts are the only completion authority.
// Router replies, Worker prose and channel presentation never close a goal.
export class TaskLedger {
  constructor(readonly store: LakeStore, readonly revalidate?: (operation: Operation) => void) {}
  get(goalId: string) { return this.store.require<Goal>("superGoals", goalId); }
  save(goal: Goal) {
    goal.revision++;
    goal.updatedAt = now();
    return this.store.put("superGoals", goal.id, goal);
  }
  create(goal: Omit<Goal, "revision" | "items" | "modelRounds" | "updatedAt" | "acceptanceState" | "planRevision" | "goalRevision" | "confirmed">) {
    const value: Goal = { ...goal, revision: 1, items: [], modelRounds: 0, updatedAt: now(),
      acceptanceState: "not_evaluated", planRevision: 0, goalRevision: 1, confirmed: false };
    return this.store.put("superGoals", value.id, value);
  }
  begin(goalId: string, input: Record<string, any>) {
    const title = text(input.title, "title", 1000);
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 64)
      throw new HttpError(400, "items must contain 1 to 64 substantive work items");
    const keys = input.items.map((item: any, index: number) => String(item.id ?? `step_${index + 1}`));
    if (new Set(keys).size !== keys.length) throw new HttpError(400, "Duplicate plan item");
    const steps: Step[] = input.items.map((item: any, index: number) => ({
      id: text(keys[index], "item id", 128), title: text(item.title, "item title", 2000), status: "pending",
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map((value: unknown) => text(value, "dependency", 128)) : [], evidenceIds: [],
    }));
    const visited = new Set<string>(), visiting = new Set<string>();
    const visit = (stepId: string) => {
      if (visiting.has(stepId)) throw new HttpError(400, "Plan dependency cycle");
      if (visited.has(stepId)) return;
      const step = steps.find((step) => step.id === stepId);
      if (!step) throw new HttpError(400, "Plan dependency not found");
      visiting.add(stepId); step.dependsOn.forEach(visit); visiting.delete(stepId); visited.add(stepId);
    };
    keys.forEach(visit);
    return this.store.transaction(() => {
      const goal = this.get(goalId);
      if (terminal(goal.status)) throw new HttpError(409, "A closed task cannot be restarted by work_begin");
      const hash = digest({ title, steps: steps.map(({ id, title, dependsOn }) => ({ id, title, dependsOn })) });
      if (goal.planHash) {
        if (goal.planHash !== hash) throw new HttpError(409, "The existing plan is frozen; preserve original items and attempts");
        return goal;
      }
      goal.planHash = hash; goal.planRevision = 1; goal.items = steps;
      goal.confirmed = goal.mode !== "plan";
      goal.status = goal.confirmed ? "running" : "waiting_user";
      return this.save(goal);
    });
  }
  confirm(goalId: string, revision: number, accept: boolean) {
    return this.store.transaction(() => {
      const goal = this.get(goalId);
      if (goal.revision !== revision || !goal.planHash || goal.confirmed || terminal(goal.status))
        throw new HttpError(409, "Plan confirmation is stale");
      goal.confirmed = accept; goal.status = accept ? "running" : "paused";
      return this.save(goal);
    });
  }
  start(goalId: string, stepId: string, generation: number, policyHash: string) {
    return this.store.transaction(() => {
      const goal = this.get(goalId);
      this.runnable(goal);
      const step = goal.items.find((step) => step.id === stepId);
      if (!step) throw new HttpError(404, "Plan item not found");
      if (step.status === "completed") throw new HttpError(409, "A completed step cannot be replayed");
      if (step.dependsOn.some((dependency) => goal.items.find((item) => item.id === dependency)?.status !== "completed"))
        throw new HttpError(409, "Step prerequisite not accepted");
      if (this.unresolved(goal.id)) throw new HttpError(409, "Original operation requires reconciliation");
      if (goal.activeItemId && goal.activeItemId !== stepId && goal.items.some((item) => item.id === goal.activeItemId && item.status === "running"))
        throw new HttpError(409, "Finish or explicitly block the active step first");
      let retryOf: string | undefined;
      if (step.status === "running" && step.attemptId) {
        const attempt = this.store.require<Attempt>("superAttempts", step.attemptId);
        if (attempt.generation !== generation || attempt.policyHash !== policyHash) throw new HttpError(409, "Step belongs to an earlier invocation");
        const operations = this.store.list<Operation>("superOperations").filter((operation) => operation.attemptId === attempt.id);
        if (!operations.some((operation) => operation.status === "failed")) return goal;
        if (operations.some((operation) => !operation.readOnly || !["succeeded", "failed"].includes(operation.status)))
          throw new HttpError(409, "Only settled proven read-only attempts may obtain a fresh diagnostic sample");
        operations.forEach((operation) => this.revalidate?.(operation));
        attempt.state = "failed"; attempt.reconciledAt = now(); attempt.reconciliation = "Settled read-only observations; no side effect replay or acceptance";
        this.store.put("superAttempts", attempt.id, attempt); retryOf = attempt.id;
      }
      const attempt: Attempt = { id: id(), goalId: goal.id, sessionId: goal.sessionId, projectId: goal.projectId,
        stepId, goalRevision: goal.goalRevision, planRevision: goal.planRevision, generation,
        policyHash, state: "running", createdAt: now(), retryOf };
      this.store.put("superAttempts", attempt.id, attempt);
      step.attemptId = attempt.id; step.status = "running"; step.evidenceIds = []; step.acceptanceId = undefined;
      goal.activeItemId = step.id; return this.save(goal);
    });
  }
  runnable(goal: Goal) {
    if (!goal.confirmed || goal.status !== "running" || Date.parse(goal.deadlineAt) <= Date.now())
      throw new HttpError(409, "An active, confirmed task within its deadline is required");
  }
  unresolved(goalId: string) {
    return this.store.list<Operation>("superOperations").some((operation) => operation.goalId === goalId && ["unknown", "dispatched"].includes(operation.status));
  }
  active(goalId: string, generation: number, policyHash: string) {
    const goal = this.get(goalId); this.runnable(goal);
    const step = goal.items.find((step) => step.id === goal.activeItemId && step.status === "running");
    if (!step?.attemptId) throw new HttpError(409, "Call work_begin, then work_update(running) before resource access");
    const attempt = this.store.require<Attempt>("superAttempts", step.attemptId);
    if (attempt.state !== "running" || attempt.generation !== generation || attempt.policyHash !== policyHash ||
        attempt.goalRevision !== goal.goalRevision || attempt.planRevision !== goal.planRevision)
      throw new HttpError(409, "Attempt or current permission binding changed");
    return { goal, step, attempt };
  }
  async operation<T>(goalId: string, generation: number, policyHash: string, callId: string, tool: string,
    input: unknown, dispatch: () => Promise<T>, redact: <V>(value: V) => V,
    binding: Pick<Operation, "resourceId" | "resourceRevision" | "readOnly" | "mcpServerId" | "mcpTool" | "remoteMcp" | "configurationHash" | "bindingHash" | "catalogHash" | "skillName" | "skillHash" | "hostConfigurationHash"> = {}): Promise<T> {
    const key = digest([this.get(goalId).sessionId, callId]);
    const previous = this.store.get<Operation>("superOperations", key);
    if (previous) {
      if (previous.goalId !== goalId || previous.tool !== tool || previous.argsHash !== digest(input))
        throw new HttpError(409, "Operation identity reused with different arguments");
      if (previous.status === "succeeded") { this.revalidate?.(previous); return previous.output as T; }
      throw new HttpError(409, "The original operation must be reconciled; it cannot be replayed");
    }
    const operation = this.store.transaction(() => {
      const { goal, step, attempt } = this.active(goalId, generation, policyHash);
      if (this.unresolved(goalId)) throw new HttpError(409, "Original operation requires reconciliation");
      if (!binding.remoteMcp && this.store.list<Operation>("superOperations").some((operation) => operation.projectId === goal.projectId && operation.status === "unknown"))
        throw new HttpError(409, "A project operation still requires reconciliation");
      if (!binding.remoteMcp && this.store.list<any>("legacyOperations").some((operation) => operation.projectId === goal.projectId && !operation.riskResolvedAt &&
          (["running", "unknown", "dispatched"].includes(operation.status) || operation.orphanState === "unresolved")))
        throw new HttpError(409, "旧 Go 操作仍需核实；迁移不会解除原未决风险");
      if (tool === "call_mcp_tool") {
        const pending = (operation: any) => ["unknown", "dispatched", "running"].includes(operation.status) || operation.orphanState && !operation.riskResolvedAt;
        if (this.store.list<Operation>("superOperations").some((operation) => operation.tool === tool && pending(operation) && (!operation.mcpServerId || operation.mcpServerId === binding.mcpServerId)) ||
            this.store.list<any>("legacyOperations").some((operation) => operation.tool === tool && pending(operation) && (!operation.mcpServerId || operation.mcpServerId === binding.mcpServerId)))
          throw new HttpError(409, "同一 MCP 服务的原调用结果尚未核实，不能跨任务或项目重试");
      }
      if (!binding.readOnly && this.store.list<Operation>("superOperations").some((operation) => operation.goalId === goalId && operation.tool === tool &&
          operation.argsHash === digest(input) && operation.resourceId === binding.resourceId))
        throw new HttpError(409, "Identical mutation already recorded; inspect the original operation instead of dispatching another call ID");
      const operation: Operation = { id: key, callId, tool, argsHash: digest(input), projectId: goal.projectId,
        goalId, sessionId: goal.sessionId, stepId: step.id, attemptId: attempt.id, goalRevision: goal.goalRevision,
        planRevision: goal.planRevision, generation, policyHash, status: "dispatched", at: now(), ...binding };
      this.revalidate?.(operation);
      return this.store.put("superOperations", key, operation);
    });
    try {
      const output = await dispatch();
      const result = output as any;
      const failed = result?.result === false || result?.isError === true || result?.success === false ||
        (typeof result?.exitCode === "number" && result.exitCode !== 0);
      operation.status = failed ? "failed" : "succeeded";
      operation.output = redact(output); operation.outputHash = digest(operation.output); operation.completedAt = now();
      this.store.put("superOperations", key, operation);
      return output;
    } catch (error) {
      // Only the host's frozen proven read-only descriptor can settle a read
      // failure without an unknown side effect. Writes remain unknown.
      operation.status = binding.readOnly ? "failed" : "unknown"; operation.completedAt = now();
      operation.output = redact({ success: false, error: error instanceof Error ? error.message : String(error) });
      operation.outputHash = digest(operation.output);
      this.store.put("superOperations", key, operation);
      throw error;
    }
  }
  update(goalId: string, input: Record<string, any>, generation: number, policyHash: string) {
    const stepId = text(input.item_id, "item_id", 128);
    if (input.status === "running") return this.start(goalId, stepId, generation, policyHash);
    if (!["waiting_user", "blocked", "completed", "failed"].includes(input.status)) throw new HttpError(400, "Invalid work status");
    return this.store.transaction(() => {
      const { goal, step, attempt } = this.active(goalId, generation, policyHash);
      if (step.id !== stepId) throw new HttpError(409, "Only the active attempt may update this step");
      if (input.status === "completed") {
        const operations = this.store.list<Operation>("superOperations").filter((operation) => operation.attemptId === attempt.id);
        const refs: string[] = Array.isArray(input.evidence_ids) ? input.evidence_ids : [];
        if (!operations.length || this.unresolved(goal.id) || !refs.length || new Set(refs).size !== refs.length)
          throw new HttpError(409, "Actual committed evidence from this attempt is required");
        if (refs.some((ref) => !operations.some((operation) => operation.callId === ref || operation.id === ref)) ||
            operations.some((operation) => operation.status !== "succeeded" || operation.policyHash !== policyHash ||
              operation.goalRevision !== goal.goalRevision || operation.planRevision !== goal.planRevision || !operation.outputHash || operation.outputHash !== digest(operation.output)))
          throw new HttpError(409, "Failed, stale or unrelated evidence cannot accept this step");
        operations.forEach((operation) => this.revalidate?.(operation));
        const receipt = { id: id(), goalId, sessionId: goal.sessionId, stepId, attemptId: attempt.id,
          projectId: goal.projectId, goalRevision: goal.goalRevision, planRevision: goal.planRevision,
          state: "pass", verifier: "tool_results/1", operationIds: operations.map((op) => op.id), at: now() };
        this.store.put("superAcceptance", receipt.id, receipt);
        attempt.state = "succeeded"; step.evidenceIds = operations.map((op) => op.id); step.acceptanceId = receipt.id;
      }
      step.status = input.status; step.reason = typeof input.reason === "string" ? input.reason.slice(0, 4096) : undefined;
      if (input.status === "failed") attempt.state = "failed";
      this.store.put("superAttempts", attempt.id, attempt);
      return this.save(goal);
    });
  }
  finish(goalId: string, summary: string, policyHash: string) {
    text(summary, "summary", 32768);
    return this.store.transaction(() => {
      const goal = this.get(goalId); this.runnable(goal);
      if (!goal.items.length || this.unresolved(goal.id) || goal.items.some((step) => step.status !== "completed" || !step.acceptanceId))
        throw new HttpError(409, "All original plan items need accepted evidence before work_finish");
      for (const step of goal.items) {
        const attempt = this.store.require<Attempt>("superAttempts", step.attemptId!);
        if (attempt.policyHash !== policyHash || attempt.state !== "succeeded") throw new HttpError(409, "Current permissions changed; acceptance requires revalidation");
        const receipt = this.store.require<any>("superAcceptance", step.acceptanceId!);
        const operations = this.store.list<Operation>("superOperations").filter((operation) => operation.attemptId === attempt.id);
        if (receipt.goalId !== goal.id || receipt.attemptId !== attempt.id || receipt.state !== "pass" ||
            receipt.goalRevision !== goal.goalRevision || receipt.planRevision !== goal.planRevision ||
            digest(receipt.operationIds) !== digest(operations.map((operation) => operation.id)) || !operations.length)
          throw new HttpError(409, "Original step acceptance receipt no longer matches its evidence");
        for (const operation of operations) {
          if (operation.status !== "succeeded" || operation.goalId !== goal.id || operation.stepId !== step.id || operation.policyHash !== policyHash ||
              operation.goalRevision !== goal.goalRevision || operation.planRevision !== goal.planRevision || operation.outputHash !== digest(operation.output))
            throw new HttpError(409, "Original operation evidence cannot accept the goal");
          this.revalidate?.(operation);
        }
      }
      const receipt = { id: id(), goalId, sessionId: goal.sessionId, scope: "goal", state: "pass",
        goalRevision: goal.goalRevision, planRevision: goal.planRevision, stepReceipts: goal.items.map((step) => step.acceptanceId), at: now() };
      this.store.put("superAcceptance", receipt.id, receipt);
      goal.status = "completed"; goal.acceptanceState = "pass"; goal.summary = summary;
      this.save(goal);
      this.store.put("superPendingReports", digest([goal.id, goal.revision]), { taskId: goal.id, revision: goal.revision, snapshot: structuredClone(goal), createdAt: now() });
      return goal;
    });
  }
}
