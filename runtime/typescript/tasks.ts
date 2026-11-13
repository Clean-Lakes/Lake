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
  contributionReceiptId?: string; // Historical acceptance, never written by report submission.
  completionReportId?: string;
  reportedOutcome?: "completed" | "partial";
  readOnlyRecoveryOf?: string;
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
  externalRunId?: string; externalSessionId?: string;
};

/** Derived observation metadata only; the original outputHash remains unchanged. */
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

// The execution ledger owns actual calls; reports end tasks without business acceptance.
export class TaskLedger {
  constructor(readonly store: LakeStore, readonly revalidate?: (operation: Operation) => void,
    readonly effectResolution?: (operation: Operation) => { effects: "none" | "observed"; closureState?: "reconciled";closedAt?:string;replayScopes?:string[] } | undefined) {}
  get(goalId: string) { return this.store.require<Goal>("superGoals", goalId); }
  jointTask(taskId: string) { return jointTask(this.store, taskId); }
  jointState(taskId: string) {
    const task = this.jointTask(taskId);
    return task && jointTaskState(task, task.memberIds.map(id => this.get(id)));
  }
  /** Usage accounting only. Legacy roundLimit values never gate execution. */
  totalModelRounds(goal: Goal) {
    if (!goal.sharedTaskId) return goal.modelRounds;
    const task = this.store.require<JointTask>('superJointTasks', goal.sharedTaskId);
    return task.memberIds.reduce((sum, memberId) => sum + this.get(memberId).modelRounds, 0);
  }
  joinTask(taskId: string, executionIds: string[]) {
    return joinExecutions(this.store, taskId, executionIds);
  }
  save(goal: Goal) {
    // A pending SDK callback may hold a snapshot from before a specialist joined.
    const current = this.store.get<Goal>('superGoals', goal.id);
    if (current?.readOnlyRecoveryOf) {
      goal.readOnlyRecoveryOf = current.readOnlyRecoveryOf;
      if (Date.parse(goal.deadlineAt) > Date.parse(current.deadlineAt)) goal.deadlineAt = current.deadlineAt;
    }
    if (current?.sharedTaskId) {
      goal.sharedTaskId = current.sharedTaskId;
      if (Date.parse(goal.deadlineAt) > Date.parse(current.deadlineAt)) goal.deadlineAt = current.deadlineAt;
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
  prepareHostOperation(goalId: string, generation: number, policyHash: string, binding: { readOnly?: boolean; commandExecutionId?: string } = {}) {
    return this.store.transaction(() => {
      const goal = this.get(goalId);
      if (!this.isHostManaged(goal)) throw new HttpError(409, "This task retains its explicit plan");
      if (terminal(goal.status) || goal.status !== "running" || Date.parse(goal.deadlineAt) <= Date.now())
        throw new HttpError(409, "An active task within its deadline is required");
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
      let step = goal.items.find(item => item.status !== "completed");
      if (!step) {
        step = { id: "host_work_" + (goal.items.length + 1), title: goal.title, status: "pending", dependsOn: [], evidenceIds: [] };
        goal.items.push(step);
      }
      const previous = step.attemptId ? this.store.require<Attempt>("superAttempts", step.attemptId) : undefined;
      const operations = previous ? this.store.list<Operation>("superOperations").filter((operation) => operation.attemptId === previous.id) : [];
      if (previous?.state === "running" && previous.generation === generation && previous.policyHash === policyHash &&
          !operations.some((operation) => ["failed", "unknown", "dispatched"].includes(operation.status))) {
        goal.activeItemId = step.id; step.status = "running"; return this.save(goal);
      }
      // New observations get a new attempt. An unresolved predecessor is kept
      // untouched; a read does not reconcile or replay its possible side effect.
      if (previous && previous.state !== "unknown" && operations.length &&
          operations.every((operation) => operation.readOnly === true && ["succeeded", "failed"].includes(operation.status) ||
            operation.status === "failed" && this.rejectedBeforeDispatch(operation))) {
        previous.state = operations.some((operation) => operation.status === "failed") ? "failed" : "succeeded";
        previous.reconciledAt = now(); previous.reconciliation = "Settled proven read-only or not-dispatched observations; fresh attempt without replay or goal acceptance";
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
    if (!this.isHostManaged(this.get(goalId))) throw new HttpError(409, "This task retains its explicit plan");
    return this.submitReport(goalId, input, generation, policyHash);
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
        throw new HttpError(409, "Step prerequisite is not completed");
      if (goal.activeItemId && goal.activeItemId !== stepId && goal.items.some((item) => item.id === goal.activeItemId && item.status === "running"))
        throw new HttpError(409, "Finish or explicitly block the active step first");
      let retryOf: string | undefined;
      if (step.status === "running" && step.attemptId) {
        const attempt = this.store.require<Attempt>("superAttempts", step.attemptId);
        const operations = this.store.list<Operation>("superOperations").filter((operation) => operation.attemptId === attempt.id);
        if (attempt.generation === generation && attempt.policyHash === policyHash && attempt.state === "running" &&
            !operations.some(operation => ["failed", "unknown"].includes(operation.status))) return goal;
        // Starting another attempt does not reconcile an uncertain predecessor.
        // Non-command tools still enforce their own pending-effect contract.
        if (operations.length && operations.every(operation => operation.readOnly && ["succeeded", "failed"].includes(operation.status) ||
            operation.status === "failed" && this.rejectedBeforeDispatch(operation))) {
          operations.forEach(operation => this.revalidate?.(operation));
          attempt.state = "failed"; attempt.reconciledAt = now();
          attempt.reconciliation = "Settled read-only or not-dispatched observations; no side effect replay or acceptance";
          this.store.put("superAttempts", attempt.id, attempt);
        }
        retryOf = attempt.id;
      }
      const attempt: Attempt = { id: id(), goalId: goal.id, sessionId: goal.sessionId, projectId: goal.projectId,
        stepId, goalRevision: goal.goalRevision, planRevision: goal.planRevision, generation,
        policyHash, state: "running", createdAt: now(), retryOf };
      this.store.put("superAttempts", attempt.id, attempt);
      step.attemptId = attempt.id; step.status = "running"; step.evidenceIds = []; step.acceptanceId = undefined;
      goal.activeItemId = step.id; return this.save(goal);
    });
  }
  private rejectedBeforeDispatch(op:Operation) {
    if (!op.commandExecutionId || op.commandExecutionId !== digest([op.goalId,op.generation,op.callId])) return false;
    const run=this.store.get<{id?:string;sessionId:string;taskId:string;workerId?:string;generation:number;resourceId?:string;resourceRevision?:number;configurationRevision?:string;
      peerRejected?:boolean;sshDispatchPhase?:string;status?:string;result?:{status?:string;stdout?:{text?:string}}}>("commandExecutions",op.commandExecutionId);
    if (!run || run.taskId!==op.goalId || run.sessionId!==op.sessionId || run.generation!==op.generation) return false;
    if (run.peerRejected === true) return true;
    return op.tool === "Bash" && run.id === op.commandExecutionId && run.workerId === this.get(op.goalId).workerId &&
      run.sshDispatchPhase === "not_sent" && !!op.resourceId && run.resourceId === op.resourceId &&
      op.resourceRevision !== undefined && run.resourceRevision === op.resourceRevision &&
      !!op.hostConfigurationHash && run.configurationRevision === op.hostConfigurationHash &&
      ["spawn_error","cancelled","failed","timed_out"].includes(run.status ?? "") &&
      run.result?.status === run.status && !run.result?.stdout?.text;
  }
  settleCommand(operationId:string,executionId:string,result:unknown,valid:boolean) {
    const operation=this.store.require<Operation>('superOperations',operationId);
    if(operation.commandExecutionId!==executionId||operation.status!=='dispatched')return;
    const output=JSON.parse(JSON.stringify(result)) as any;
    operation.status=this.rejectedBeforeDispatch(operation)?'failed':!valid?'unknown':output?.status==='completed'&&output.exitCode===0?'succeeded':operation.readOnly?'failed':'unknown';
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
    binding: Pick<Operation, "resourceId" | "resourceRevision" | "readOnly" | "mcpServerId" | "mcpTool" | "remoteMcp" | "configurationHash" | "bindingHash" | "catalogHash" | "skillName" | "skillHash" | "hostConfigurationHash" | "commandExecutionId" | "networkURL" | "databaseConfigurationHash" | "databaseScope" | "agentRunId" | "childSessionId" | "originalCallId" | "externalRunId" | "externalSessionId"> = {}): Promise<T> {
    const current = this.get(goalId);
    // Historical results never gate a new call. Exact call identities remain idempotent.
    if (current.readOnlyRecoveryOf && binding.readOnly !== true)
      throw new HttpError(409, "新的复查上下文仅允许独立只读检查；原任务的记录和未决操作仍保留");
    const key = digest([current.sessionId, callId]);
    const previous = this.store.get<Operation>("superOperations", key);
    if (previous) {
      if (previous.goalId !== goalId || previous.tool !== tool || previous.argsHash !== digest(input))
        throw new HttpError(409, "Operation identity reused with different arguments");
      if (previous.status === "succeeded") { this.revalidate?.(previous); return previous.output as T; }
      throw new HttpError(409, "The original operation is already recorded and cannot be replayed; use a new call for new work");
    }
    if (this.isHostManaged(this.get(goalId))) this.prepareHostOperation(goalId, generation, policyHash, binding);
    const operation = this.store.transaction(() => {
      const { goal, step, attempt } = this.active(goalId, generation, policyHash);
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
      operation.status = binding.commandExecutionId && !binding.readOnly && !this.rejectedBeforeDispatch(operation) && (failed || ["failed","timed_out","cancelled","spawn_error"].includes(result?.status)) ? "unknown" : binding.commandExecutionId && result?.status === "backgrounded" ? "dispatched" : failed || ["failed","timed_out","cancelled","spawn_error"].includes(result?.status) ? "failed" : "succeeded";
      operation.output = redact(output); operation.outputHash = digest(operation.output); operation.completedAt = operation.status === "dispatched" ? undefined : now();
      if (operation.status === "succeeded" && (binding.commandExecutionId || binding.databaseConfigurationHash || operation.tool === "inspect_host"))
        operation.watchdogOutputHash = watchdogOutputHash(operation);
      this.store.put("superOperations", key, operation);
      return output;
    } catch (error) {
      // Only the host's frozen proven read-only descriptor can settle a read
      // failure without an unknown side effect. Writes remain unknown.
      operation.status = binding.readOnly || this.rejectedBeforeDispatch(operation) ? "failed" : "unknown"; operation.completedAt = now();
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
        const operations = this.store.list<Operation>("superOperations").filter(operation => operation.attemptId === attempt.id);
        const refs: unknown[] = input.evidence_ids ?? [];
        if (!Array.isArray(refs) || new Set(refs).size !== refs.length ||
            refs.some(ref => typeof ref !== "string" || !operations.some(operation => operation.callId === ref || operation.id === ref)))
          throw new HttpError(400, "Evidence references must belong to this exact attempt");
        step.evidenceIds = operations.map(operation => operation.id);
        this.settleAttempt(attempt, operations);
        // Stage completion is the agent's progress report. It does not verify
        // or rewrite any operation/attempt result, including failed or unknown.
      }
      step.status = input.status; step.reason = typeof input.reason === "string" ? input.reason.slice(0, 4096) : undefined;
      if (input.status === "failed") attempt.state = "failed";
      this.store.put("superAttempts", attempt.id, attempt);
      return this.save(goal);
    });
  }
  private settleAttempt(attempt: Attempt, operations: Operation[]) {
    // Close this live execution from its actual settled calls. This supplies
    // no business verdict and never changes an earlier uncertain attempt.
    if (attempt.state !== "running" || !operations.length || operations.some(operation => !["succeeded", "failed"].includes(operation.status))) return;
    attempt.state = operations.every(operation => operation.status === "succeeded") ? "succeeded" : "failed";
    this.store.put("superAttempts", attempt.id, attempt);
  }
  private submitReport(goalId: string, input: { summary: string; outcome: "completed" | "partial" }, generation: number, policyHash: string) {
    const summary = text(input.summary, "summary", 32768);
    if (!["completed", "partial"].includes(input.outcome)) throw new HttpError(400, "A completed or partial report outcome is required");
    return this.store.transaction(() => {
      const goal = this.get(goalId);
      if (terminal(goal.status)) throw new HttpError(409, "Task is closed");
      if (this.isHostManaged(goal)) goal.confirmed = true;
      this.runnable(goal);
      const worker = this.store.get<{taskId: string; sessionId: string; projectId: string; state: string; generation: number; policyHash: string; leaseUntil?: number}>("superWorkers", goal.workerId);
      if (worker) {
        if (worker.taskId !== goal.id || worker.sessionId !== goal.sessionId || worker.projectId !== goal.projectId ||
            worker.state !== "active" || worker.generation !== generation || worker.policyHash !== policyHash ||
            !worker.leaseUntil || worker.leaseUntil <= Date.now()) throw new HttpError(409, "Current execution or permission binding changed");
      } else {
        const step = goal.items.find(item => item.id === goal.activeItemId);
        const attempt = step?.attemptId ? this.store.require<Attempt>("superAttempts", step.attemptId) : undefined;
        if (attempt && (attempt.generation !== generation || attempt.policyHash !== policyHash))
          throw new HttpError(409, "Attempt or current permission binding changed");
      }
      const reportId = digest([goal.id, generation]);
      const report = { taskId: goal.id, sessionId: goal.sessionId, workerId: goal.workerId,
        projectId: goal.projectId, generation, outcome: input.outcome, summary, at: now() };
      const step = goal.items.find(item => item.id === goal.activeItemId);
      const attempt = step?.attemptId ? this.store.require<Attempt>("superAttempts", step.attemptId) : undefined;
      if (attempt?.generation === generation && attempt.policyHash === policyHash) {
        const operations = this.store.list<Operation>("superOperations").filter(operation => operation.attemptId === attempt.id);
        this.settleAttempt(attempt, operations);
        if (step && this.isHostManaged(goal) && input.outcome === "completed") {
          step.status = "completed"; step.evidenceIds = operations.map(operation => operation.id);
        }
      }
      this.store.put("superDeliveries", reportId, report);
      goal.completionReportId = reportId; goal.reportedOutcome = input.outcome;
      goal.status = "completed"; goal.summary = summary;
      // Old acceptance fields and receipts are compatibility history. This
      // execution ends because it submitted a report, never because it passed.
      this.save(goal);
      if (goal.sharedTaskId) this.aggregateReports(goal);
      this.store.put("superPendingReports", digest([goal.id, goal.revision]), {
        taskId: goal.id, revision: goal.revision, snapshot: structuredClone(goal), createdAt: report.at });
      return goal;
    });
  }
  private aggregateReports(goal: Goal) {
    const task = this.store.require<JointTask>("superJointTasks", goal.sharedTaskId!);
    if (task.projectId !== goal.projectId || !task.memberIds.includes(goal.id)) throw new HttpError(409, "Shared task membership is stale");
    const members = task.memberIds.map(memberId => this.get(memberId));
    if (members.some(member => member.projectId !== task.projectId || member.sharedTaskId !== task.id))
      throw new HttpError(409, "Shared task assignment changed");
    if (members.some(member => member.status !== "completed" || !member.completionReportId && !member.contributionReceiptId)) return;
    const reports = members.map(member => member.completionReportId ?? member.contributionReceiptId!);
    const reportId = digest(["joint_report", task.id, task.revision, reports]);
    if (task.reportId === reportId) return;
    task.reportId = reportId;
    task.summary = members.map(member => {
      const worker = this.store.get<{roleSnapshot?: {name: string}}>("superWorkers", member.workerId);
      return (worker?.roleSnapshot?.name ?? member.roleId) + "：" + member.summary;
    }).join("\n\n");
    this.store.put("superJointTasks", task.id, task);
    this.store.put("superPendingJointReports", task.id, { taskId: task.id, reportId, createdAt: now() });
  }
  finish(goalId: string, summary: string, policyHash: string, generation: number, outcome: "completed" | "partial" = "completed") {
    return this.submitReport(goalId, {summary, outcome}, generation, policyHash);
  }
}
