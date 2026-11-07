import { createHash } from "node:crypto";
import type { WorkGoal } from "../../web-agent/shared/contracts";
import { HttpError, id, LakeStore, now } from "./store";
import { joinExecutions, jointTask, jointTaskState, type JointTask } from "./joint-tasks";

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
  executionMode?: "host_managed" | "explicit_plan";
  sharedTaskId?: string;
  contributionReceiptId?: string;
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
  watchdogInputHash?: string; watchdogOutputHash?: string;
  output?: unknown; outputHash?: string; at: string; completedAt?: string;
  resourceId?: string; resourceRevision?: number; readOnly?: boolean;
  mcpServerId?: string; mcpTool?: string; remoteMcp?: boolean; configurationHash?: string; bindingHash?: string; catalogHash?: string;
  skillName?: string; skillHash?: string;
  hostConfigurationHash?: string;
  commandExecutionId?:string;networkURL?:string;
  databaseConfigurationHash?:string;databaseScope?:{database:string;schema:string;maxRows:number;maxDurationMS:number};
  agentRunId?: string; childSessionId?: string; originalCallId?: string;
};

/** Derived observation metadata only. Acceptance still verifies the exact original outputHash. */
export function watchdogOutputHash(operation: Pick<Operation,"tool"|"commandExecutionId"|"output"|"outputHash">) {
  const output = operation.output as Record<string,unknown> | null;
  if (!output || typeof output !== "object") return operation.outputHash;
  if (operation.commandExecutionId) {
    const stream = (value:unknown) => typeof value === "string" ? value : (value as {text?:string} | null)?.text;
    return digest([output.exitCode, stream(output.stdout), stream(output.stderr)]);
  }
  if (["inspect_host","list_db_objects","db_table_ddl","read_db_table"].includes(operation.tool)) {
    const {observedAt, ...businessData} = output;
    return digest(businessData);
  }
  return operation.outputHash;
}

const businessReceiptTools = new Set(["Bash", "Glob", "Grep", "FindFiles", "SearchText", "WebFetch", "inspect_host", "list_db_objects","db_table_ddl","read_db_table", "Read", "Write", "Edit", "list_project_files", "call_mcp_tool", "read_referenced_task_evidence"]);

// The goal and immutable acceptance receipts are the only completion authority.
// Router replies, Worker prose and channel presentation never close a goal.
export class TaskLedger {
  constructor(readonly store: LakeStore, readonly revalidate?: (operation: Operation) => void,
    readonly effectResolution?: (operation: Operation) => { effects: "none" | "observed" } | undefined) {}
  get(goalId: string) { return this.store.require<Goal>("superGoals", goalId); }
  jointTask(taskId: string) { return jointTask(this.store, taskId); }
  jointState(taskId: string) {
    const task = this.jointTask(taskId);
    return task && jointTaskState(task, task.memberIds.map(id => this.get(id)));
  }
  roundsRemaining(goal: Goal) {
    if (!goal.sharedTaskId) return Math.max(0, goal.roundLimit - goal.modelRounds);
    const task = this.store.require<JointTask>('superJointTasks', goal.sharedTaskId);
    const members = task.memberIds.map(memberId => this.get(memberId));
    const sharedRemaining = members[0].roundLimit - members.reduce((sum, member) => sum + member.modelRounds, 0);
    return Math.max(0, Math.min(sharedRemaining, goal.roundLimit - goal.modelRounds));
  }
  joinTask(taskId: string, executionIds: string[]) {
    return joinExecutions(this.store, taskId, executionIds, id => this.unresolved(id));
  }
  save(goal: Goal) {
    // A pending SDK callback may hold a snapshot from before a specialist joined.
    const current = this.store.get<Goal>('superGoals', goal.id);
    if (current?.sharedTaskId) {
      goal.sharedTaskId = current.sharedTaskId;
      if (Date.parse(goal.deadlineAt) > Date.parse(current.deadlineAt)) goal.deadlineAt = current.deadlineAt;
      goal.roundLimit = Math.min(goal.roundLimit, current.roundLimit);
    }
    goal.revision++;
    goal.updatedAt = now();
    return this.store.put("superGoals", goal.id, goal);
  }
  create(goal: Omit<Goal, "revision" | "items" | "modelRounds" | "updatedAt" | "acceptanceState" | "planRevision" | "goalRevision" | "confirmed">) {
    const value: Goal = { ...goal, revision: 1, items: [], modelRounds: 0, updatedAt: now(),
      acceptanceState: "not_evaluated", planRevision: 0, goalRevision: 1, confirmed: false };
    return this.store.put("superGoals", value.id, value);
  }
  isHostManaged(goal: Goal) {
    if (goal.mode !== "default" || goal.executionMode === "explicit_plan") return false;
    if (goal.executionMode === "host_managed") return true;
    // Only the TS default, unaccepted single-step contract can be adopted.
    // Legacy Go goals live in a separate ledger and are never accepted here.
    return !goal.planHash || goal.confirmed && goal.items.length === 1 &&
      goal.items.every((step) => step.status !== "completed" && !step.acceptanceId) &&
      !this.store.list<any>("superAcceptance").some((receipt) => receipt.goalId === goal.id);
  }
  prepareHostOperation(goalId: string, generation: number, policyHash: string, binding: { readOnly?: boolean } = {}) {
    return this.store.transaction(() => {
      const goal = this.get(goalId);
      if (!this.isHostManaged(goal)) throw new HttpError(409, "This task retains its explicit plan and acceptance contract");
      if (terminal(goal.status) || goal.status !== "running" || Date.parse(goal.deadlineAt) <= Date.now())
        throw new HttpError(409, "An active task within its deadline is required");
      if (this.unresolved(goalId) && binding.readOnly !== true)
        throw new HttpError(409, "Original operation requires reconciliation before another mutation");
      if (goal.executionMode !== "host_managed") {
        this.store.put("superHostAdoptions", goal.id, { goalId, at: now(), originalPlanHash: goal.planHash, originalItems: goal.items });
        goal.executionMode = "host_managed";
      }
      if (!goal.planHash) {
        goal.items = [{ id: "host_work", title: goal.title, status: "pending", dependsOn: [], evidenceIds: [] }];
        goal.planHash = digest({ hostManaged: true, goalId, itemId: "host_work" });
        goal.planRevision = 1;
      }
      goal.confirmed = true;
      const step = goal.items.find((item) => item.status !== "completed" && !item.acceptanceId);
      if (!step) throw new HttpError(409, "No unfinished host-managed work remains");
      const previous = step.attemptId ? this.store.require<Attempt>("superAttempts", step.attemptId) : undefined;
      const operations = previous ? this.store.list<Operation>("superOperations").filter((operation) => operation.attemptId === previous.id) : [];
      if (previous?.state === "running" && previous.generation === generation && previous.policyHash === policyHash &&
          !operations.some((operation) => ["failed", "unknown", "dispatched"].includes(operation.status))) {
        goal.activeItemId = step.id; step.status = "running"; return this.save(goal);
      }
      // New observations get a new attempt. An unresolved predecessor is kept
      // untouched; a read does not reconcile or replay its possible side effect.
      if (previous && previous.state !== "unknown" && operations.length &&
          operations.every((operation) => operation.readOnly === true && ["succeeded", "failed"].includes(operation.status))) {
        previous.state = operations.some((operation) => operation.status === "failed") ? "failed" : "succeeded";
        previous.reconciledAt = now(); previous.reconciliation = "Settled proven read-only observations; fresh attempt without replay or goal acceptance";
        this.store.put("superAttempts", previous.id, previous);
      }
      const attempt: Attempt = { id: id(), goalId, sessionId: goal.sessionId, projectId: goal.projectId, stepId: step.id,
        goalRevision: goal.goalRevision, planRevision: goal.planRevision, generation, policyHash,
        state: "running", createdAt: now(), ...(previous ? { retryOf: previous.id } : {}) };
      this.store.put("superAttempts", attempt.id, attempt);
      step.attemptId = attempt.id; step.status = "running"; step.reason = undefined; step.evidenceIds = [];
      goal.activeItemId = step.id;
      return this.save(goal);
    });
  }
  finishHost(goalId: string, input: { summary: string; outcome: "completed" | "partial" }, generation: number, policyHash: string) {
    const summary = text(input.summary, "summary", 32768);
    if (!["completed", "partial"].includes(input.outcome)) throw new HttpError(400, "A completed or partial business outcome is required");
    return this.store.transaction(() => {
      const goal = this.get(goalId);
      if (!this.isHostManaged(goal) || terminal(goal.status)) throw new HttpError(409, "Task is closed or retains its explicit acceptance contract");
      if (input.outcome === "partial") {
        goal.status = this.unresolved(goalId) ? "blocked" : "paused"; goal.summary = summary;
        // Presentation provenance only: this records an explicit business report,
        // while task completion remains owned by the acceptance receipts below.
        this.store.put("superDeliveries", digest([goalId, generation]), { taskId: goalId, generation, outcome: input.outcome, summary, at: now() });
        return this.save(goal);
      }
      const active = this.active(goalId, generation, policyHash);
      const step = goal.items.find((item) => item.id === active.step.id)!, attempt = active.attempt;
      const operations = this.store.list<Operation>("superOperations").filter((operation) => operation.attemptId === attempt.id);
      if (this.unresolved(goalId) || !operations.some((operation) => businessReceiptTools.has(operation.tool)))
        throw new HttpError(409, "Current successful business evidence is required; discovery alone cannot complete the task");
      if (goal.items.some((item) => item.id !== step.id && (item.status !== "completed" || !item.acceptanceId)))
        throw new HttpError(409, "Other original plan items still need their own acceptance");
      if (operations.some((operation) => operation.status !== "succeeded" || operation.generation !== generation ||
          operation.policyHash !== policyHash || operation.goalRevision !== goal.goalRevision || operation.planRevision !== goal.planRevision ||
          !operation.outputHash || operation.outputHash !== digest(operation.output)))
        throw new HttpError(409, "Failed, stale or unrelated evidence cannot accept this task");
      operations.forEach((operation) => this.revalidate?.(operation));
      const receipt = { id: id(), goalId, sessionId: goal.sessionId, stepId: step.id, attemptId: attempt.id,
        projectId: goal.projectId, goalRevision: goal.goalRevision, planRevision: goal.planRevision,
        state: "pass", verifier: "host_tool_results/1", operationIds: operations.map((operation) => operation.id), at: now() };
      this.store.put("superAcceptance", receipt.id, receipt);
      attempt.state = "succeeded"; this.store.put("superAttempts", attempt.id, attempt);
      step.status = "completed"; step.evidenceIds = receipt.operationIds; step.acceptanceId = receipt.id;
      this.recordCompletion(goal, summary, policyHash);
      this.store.put("superDeliveries", digest([goalId, generation]), { taskId: goalId, generation, outcome: input.outcome, summary, at: now() });
      this.store.put("superPendingReports", digest([goal.id, goal.revision]), { taskId: goal.id, revision: goal.revision, snapshot: structuredClone(goal), createdAt: now() });
      return goal;
    });
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
      goal.executionMode ??= "explicit_plan";
      goal.confirmed = goal.mode !== "plan";
      goal.status = goal.confirmed ? "running" : "waiting_user";
      return this.save(goal);
    });
  }
  confirm(goalId: string, revision: number, accept: boolean, action?: {sessionId: string; interactionId: string}) {
    return this.store.transaction(() => {
      const goal = this.get(goalId);
      if (goal.revision !== revision || !goal.planHash || goal.confirmed || terminal(goal.status))
        throw new HttpError(409, "Plan confirmation is stale");
      goal.confirmed = accept; goal.status = accept ? "running" : "paused";
      const saved = this.save(goal);
      if (action) this.store.put('superPlanConfirmations', digest([goal.id, action.interactionId]), {goalId: goal.id, planRevision: goal.planRevision,
        planHash: goal.planHash, beforeRevision: revision, afterRevision: saved.revision, accept, sourceKind: 'user_action',
        sourceSessionId: action.sessionId, executionSessionId: goal.sessionId, interactionId: action.interactionId, at: now()});
      return saved;
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
  settleCommand(operationId:string,executionId:string,result:unknown,valid:boolean) {
    const operation=this.store.require<Operation>('superOperations',operationId);
    if(operation.commandExecutionId!==executionId||operation.status!=='dispatched')return;
    const output=JSON.parse(JSON.stringify(result)) as any;
    operation.status=!valid?'unknown':output?.status==='completed'&&output.exitCode===0?'succeeded':operation.readOnly?'failed':'unknown';
    operation.output=output;operation.outputHash=digest(output);operation.completedAt=now();
    if (operation.status === 'succeeded') operation.watchdogOutputHash = watchdogOutputHash(operation);
    this.store.put('superOperations',operation.id,operation);
  }
  runnable(goal: Goal) {
    if (!goal.confirmed || goal.status !== "running" || Date.parse(goal.deadlineAt) <= Date.now())
      throw new HttpError(409, "An active, confirmed task within its deadline is required");
  }
  unresolved(goalId: string) {
    return this.store.list<Operation>("superOperations").some((operation) => operation.goalId === goalId && this.requiresReconciliation(operation));
  }
  requiresReconciliation(operation: Operation) {
    return ["unknown", "dispatched"].includes(operation.status) && this.effectResolution?.(operation)?.effects !== "none";
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
    binding: Pick<Operation, "resourceId" | "resourceRevision" | "readOnly" | "mcpServerId" | "mcpTool" | "remoteMcp" | "configurationHash" | "bindingHash" | "catalogHash" | "skillName" | "skillHash" | "hostConfigurationHash" | "commandExecutionId" | "networkURL" | "databaseConfigurationHash" | "databaseScope" | "agentRunId" | "childSessionId" | "originalCallId"> = {}): Promise<T> {
    const key = digest([this.get(goalId).sessionId, callId]);
    const previous = this.store.get<Operation>("superOperations", key);
    if (previous) {
      if (previous.goalId !== goalId || previous.tool !== tool || previous.argsHash !== digest(input))
        throw new HttpError(409, "Operation identity reused with different arguments");
      if (previous.status === "succeeded") { this.revalidate?.(previous); return previous.output as T; }
      throw new HttpError(409, "The original operation must be reconciled; it cannot be replayed");
    }
    if (this.isHostManaged(this.get(goalId))) this.prepareHostOperation(goalId, generation, policyHash, binding);
    const operation = this.store.transaction(() => {
      const { goal, step, attempt } = this.active(goalId, generation, policyHash);
      if (binding.readOnly !== true && this.unresolved(goalId)) throw new HttpError(409, "Original operation requires reconciliation");
      if (binding.readOnly !== true && !binding.remoteMcp) {
        const command = (input as {command?: unknown} | null)?.command;
        const commandHash = typeof command === "string" ? digest(command) : undefined;
        for (const original of this.store.list<Operation>("superOperations")) {
          if (original.projectId !== goal.projectId || original.status !== "unknown") continue;
          const receipt = this.effectResolution?.(original);
          if (!receipt) {
            const resource = binding.resourceId && this.store.get<{kind:string}>("resources", binding.resourceId);
            const hint = binding.commandExecutionId && resource && resource.kind === "ssh"
              ? " This command was not dispatched. Inspect the target with a relevant read-only inspect_host profile (system, disks, processes, dns_a or https), or a bounded read of the authorized directory. Report any remaining mutation as blocked; never retry the uncertain write."
              : "";
            throw new HttpError(409, "A project operation still requires reconciliation (" + original.id + ")." + hint);
          }
          // A human may release independent work after observing actual effects.
          // Keep the original goal unresolved and fence its exact command across new tasks/IDs.
          if (receipt.effects === "observed" && commandHash && original.resourceId === binding.resourceId &&
              original.commandExecutionId && this.store.get<{commandHash:string}>("commandExecutions", original.commandExecutionId)?.commandHash === commandHash)
            throw new HttpError(409, "原命令已产生经人工核实的变更，禁止重复派发");
        }
      }
      if (binding.readOnly !== true && !binding.remoteMcp && this.store.list<any>("legacyOperations").some((operation) => operation.projectId === goal.projectId && !operation.riskResolvedAt &&
          (["running", "unknown", "dispatched"].includes(operation.status) || operation.orphanState === "unresolved")))
        throw new HttpError(409, "旧 Go 操作仍需核实；迁移不会解除原未决风险");
      if (tool === "call_mcp_tool") {
        const pending = (operation: any) => ["unknown", "dispatched", "running"].includes(operation.status) || operation.orphanState && !operation.riskResolvedAt;
        if (this.store.list<Operation>("superOperations").some((operation) => operation.tool === tool && pending(operation) && (!operation.mcpServerId || operation.mcpServerId === binding.mcpServerId)) ||
            this.store.list<any>("legacyOperations").some((operation) => operation.tool === tool && pending(operation) && (!operation.mcpServerId || operation.mcpServerId === binding.mcpServerId)))
          throw new HttpError(409, "同一 MCP 服务的原调用结果尚未核实，不能跨任务或项目重试");
      }
      if (!binding.readOnly) {
        const members = new Set(goal.sharedTaskId ? this.store.require<JointTask>('superJointTasks', goal.sharedTaskId).memberIds : [goalId]);
        const operations = this.store.list<Operation>("superOperations").filter(operation => members.has(operation.goalId));
        if (operations.some(operation => operation.goalId !== goalId && this.requiresReconciliation(operation)))
          throw new HttpError(409, "A shared-task operation still requires reconciliation");
        if (operations.some(operation => operation.tool === tool && operation.argsHash === digest(input) &&
            operation.resourceId === binding.resourceId && (operation.goalId === goal.id || operation.mcpServerId === binding.mcpServerId)))
          throw new HttpError(409, "Identical mutation already recorded; inspect the original operation instead of dispatching another call ID");
      }
      const operation: Operation = { id: key, callId, tool, argsHash: digest(input), projectId: goal.projectId,
        goalId, sessionId: goal.sessionId, stepId: step.id, attemptId: attempt.id, goalRevision: goal.goalRevision,
        planRevision: goal.planRevision, generation, policyHash, status: "dispatched", at: now(), ...binding };
      if (binding.commandExecutionId && typeof (input as {command?:unknown})?.command === "string") {
        const shell = input as {command:string;cwd?:string};
        operation.watchdogInputHash = digest([digest(shell.command),shell.cwd ?? null]);
      }
      this.revalidate?.(operation);
      return this.store.put("superOperations", key, operation);
    });
    try {
      const output = await dispatch();
      const result = output as any;
      const failed = result?.result === false || result?.isError === true || result?.success === false ||
        (typeof result?.exitCode === "number" && result.exitCode !== 0);
      operation.status = binding.commandExecutionId && !binding.readOnly && (failed || ["failed","timed_out","cancelled","spawn_error"].includes(result?.status)) ? "unknown" : binding.commandExecutionId && result?.status === "backgrounded" ? "dispatched" : failed || ["failed","timed_out","cancelled","spawn_error"].includes(result?.status) ? "failed" : "succeeded";
      operation.output = redact(output); operation.outputHash = digest(operation.output); operation.completedAt = operation.status === "dispatched" ? undefined : now();
      if (operation.status === "succeeded" && (binding.commandExecutionId || binding.databaseConfigurationHash || operation.tool === "inspect_host"))
        operation.watchdogOutputHash = watchdogOutputHash(operation);
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
  private verifySteps(goal: Goal, policyHash: string) {
    if (!goal.confirmed || !goal.items.length || this.unresolved(goal.id))
      throw new HttpError(409, "The execution still lacks verified evidence");
    for (const step of goal.items) {
      if (step.status !== "completed" || !step.acceptanceId || !step.attemptId)
        throw new HttpError(409, "All original plan items need accepted evidence before work_finish");
      const attempt = this.store.require<Attempt>("superAttempts", step.attemptId);
      const receipt = this.store.require<{id: string; goalId: string; sessionId: string; projectId: string; stepId: string;
        attemptId: string; state: string; goalRevision: number; planRevision: number; operationIds: string[]}>("superAcceptance", step.acceptanceId);
      if (attempt.policyHash !== policyHash || attempt.state !== "succeeded" || attempt.projectId !== goal.projectId ||
          attempt.goalId !== goal.id || attempt.sessionId !== goal.sessionId || attempt.stepId !== step.id ||
          attempt.goalRevision !== goal.goalRevision || attempt.planRevision !== goal.planRevision)
        throw new HttpError(409, "Current permissions or original attempt changed; acceptance requires revalidation");
      const operations = this.store.list<Operation>("superOperations").filter(operation => operation.attemptId === attempt.id);
      if (receipt.id !== step.acceptanceId || receipt.goalId !== goal.id || receipt.sessionId !== goal.sessionId ||
          receipt.projectId !== goal.projectId || receipt.stepId !== step.id || receipt.attemptId !== attempt.id ||
          receipt.state !== "pass" || receipt.goalRevision !== goal.goalRevision || receipt.planRevision !== goal.planRevision ||
          digest(receipt.operationIds) !== digest(operations.map(operation => operation.id)) ||
          digest(step.evidenceIds) !== digest(receipt.operationIds) || !operations.length)
        throw new HttpError(409, "Original step acceptance receipt no longer matches its evidence");
      for (const operation of operations) {
        if (operation.status !== "succeeded" || operation.goalId !== goal.id || operation.stepId !== step.id ||
            operation.sessionId !== goal.sessionId || operation.projectId !== goal.projectId ||
            operation.generation !== attempt.generation || operation.policyHash !== policyHash ||
            operation.goalRevision !== goal.goalRevision || operation.planRevision !== goal.planRevision ||
            !operation.outputHash || operation.outputHash !== digest(operation.output))
          throw new HttpError(409, "Original operation evidence cannot accept the goal");
        this.revalidate?.(operation);
      }
    }
  }

  // Called inside the same write transaction as the contributor's final step.
  private recordCompletion(goal: Goal, summary: string, policyHash: string) {
    const task = goal.sharedTaskId ? this.store.require<JointTask>("superJointTasks", goal.sharedTaskId) : undefined;
    const receipt = {id: id(), goalId: goal.id, sessionId: goal.sessionId, projectId: goal.projectId, roleId: goal.roleId,
      workerId: goal.workerId, sharedTaskId: task?.id, scope: task ? "contribution" : "goal", state: "pass",
      goalRevision: goal.goalRevision, planRevision: goal.planRevision, stepReceipts: goal.items.map(step => step.acceptanceId), at: now()};
    this.store.put("superAcceptance", receipt.id, receipt);
    goal.status = "completed";
    goal.acceptanceState = task ? "not_evaluated" : "pass";
    goal.summary = summary;
    if (task) goal.contributionReceiptId = receipt.id;
    this.save(goal);
    if (!task) return;
    const members = task.memberIds.map(memberId => this.get(memberId));
    if (task.acceptanceId || !task.memberIds.includes(goal.id)) throw new HttpError(409, "Shared task membership is stale");
    if (members.some(member => member.status !== "completed" || !member.contributionReceiptId)) return;
    for (const member of members) {
      const contribution = this.store.require<typeof receipt>("superAcceptance", member.contributionReceiptId!);
      if (member.projectId !== task.projectId || member.sharedTaskId !== task.id ||
          contribution.id !== member.contributionReceiptId || contribution.scope !== "contribution" || contribution.state !== "pass" ||
          contribution.sharedTaskId !== task.id || contribution.goalId !== member.id || contribution.projectId !== task.projectId ||
          contribution.sessionId !== member.sessionId || contribution.roleId !== member.roleId || contribution.workerId !== member.workerId ||
          contribution.goalRevision !== member.goalRevision || contribution.planRevision !== member.planRevision ||
          digest(contribution.stepReceipts) !== digest(member.items.map(step => step.acceptanceId)))
        throw new HttpError(409, "Specialist contribution does not match its original assignment");
      if (Date.parse(member.deadlineAt) <= Date.now()) throw new HttpError(409, "Shared task deadline reached");
      this.verifySteps(member, policyHash);
    }
    const contributionReceipts = members.map(member => member.contributionReceiptId!);
    const groupReceipt = {id: digest(["joint_goal", task.id, task.revision, contributionReceipts]), scope: "goal",
      goalId: task.id, projectId: task.projectId, membershipRevision: task.revision, state: "pass", contributionReceipts, at: now()};
    this.store.put("superAcceptance", groupReceipt.id, groupReceipt);
    task.acceptanceId = groupReceipt.id;
    task.revision++;
    task.summary = members.map(member => {
      const worker = this.store.get<{roleSnapshot?: {name: string}}>("superWorkers", member.workerId);
      return (worker?.roleSnapshot?.name ?? member.roleId) + "：" + member.summary;
    }).join("\n\n");
    this.store.put("superJointTasks", task.id, task);
    this.store.put("superPendingJointReports", task.id, {taskId: task.id, acceptanceId: groupReceipt.id, createdAt: groupReceipt.at});
  }

  finish(goalId: string, summary: string, policyHash: string) {
    text(summary, "summary", 32768);
    return this.store.transaction(() => {
      const goal = this.get(goalId); this.runnable(goal);
      if (!goal.items.length || this.unresolved(goal.id) || goal.items.some((step) => step.status !== "completed" || !step.acceptanceId))
        throw new HttpError(409, "All original plan items need accepted evidence before work_finish");
      this.verifySteps(goal, policyHash);
      this.recordCompletion(goal, summary, policyHash);
      this.store.put("superPendingReports", digest([goal.id, goal.revision]), { taskId: goal.id, revision: goal.revision, snapshot: structuredClone(goal), createdAt: now() });
      return goal;
    });
  }
}
