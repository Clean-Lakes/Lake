import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  OperatorEffectConfirmation,
  OperatorEffectEvidence,
  OperatorEffectReview,
} from "../../web-agent/shared/contracts";
import { requestedInspectionRoot } from "../../web-agent/shared/command-policy";
import { boundResourceRevision } from "./resource-pin";
import { validateDirectoryState } from "./directory-state";
import { sessionArchiveName } from "./session-archive";
import type { SessionId, SessionStorePort } from "./sdk";
import type { SSHTarget } from "./ssh-target";
import { HttpError, LakeStore, now } from "./store";
import { digest, type Attempt, type Goal, type Operation } from "./tasks";

type Judgment = NonNullable<OperatorEffectReview["judgment"]>;
type Evidence = { public: OperatorEffectEvidence; hash: string };
type Source = {
  operation: Operation;
  fingerprint: string;
  directory: string;
  peer: SSHTarget;
  command: string;
  output: string;
  executionStatus: string;
  backgroundTaskId?: string;
};
type Review = {
  sourceKind: "operator_action";
  operationId: string;
  sourceHash: string;
  evidenceHash: string;
  judgment: Judgment;
  recordedAt: string;
};
type Closure = {
  operationId: string;
  reviewHash: string;
  evidenceHash: string;
  sourceKind: "operator_action";
  closedAt: string;
};
const reviewTable = "commandOperatorEffectReviews",
  closureTable = "commandOperatorEffectClosures";
const sha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const isObject = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function peerIdentity(peer: unknown): peer is SSHTarget {
  return (
    isObject(peer) &&
    sha(peer.hostHash) &&
    sha(peer.endpointHash) &&
    [0, 4, 6].includes(peer.addressFamily) &&
    Array.isArray(peer.hostKeys) &&
    peer.hostKeys.length === 1 &&
    typeof peer.hostKeys[0]?.algorithm === "string" &&
    /^SHA256:[A-Za-z0-9+/]{43}$/.test(peer.hostKeys[0].fingerprint)
  );
}
function completeStream(stream: unknown) {
  return (
    isObject(stream) &&
    typeof stream.text === "string" &&
    stream.truncated === false &&
    Number.isSafeInteger(stream.bytes) &&
    stream.bytes <= 131072 &&
    Buffer.byteLength(stream.text) === stream.bytes
  );
}
function sdkReceipt(archive: DatabaseSync, op: Operation) {
  const rows = archive
    .prepare(
      `SELECT p.id, p.message_id, p.data FROM part AS p
    JOIN message AS m ON m.id=p.message_id AND m.session_id=p.session_id
    JOIN session AS s ON s.id=p.session_id AND s.project_id=? AND s.time_deleted IS NULL
    WHERE p.session_id=? AND json_extract(p.data,'$.callID')=?
    AND json_extract(m.data,'$.role')='assistant' LIMIT 2`,
    )
    .all(op.projectId, op.sessionId, op.callId);
  if (rows.length !== 1) return;
  const row = rows[0]!,
    part = JSON.parse(String(row.data));
  if (
    part.type !== "tool" ||
    part.tool !== op.tool ||
    part.state?.status !== "completed" ||
    !isObject(part.state.input) ||
    digest(part.state.input) !== op.argsHash ||
    typeof part.state.output !== "string" ||
    part.state.metadata?.serialization?.truncated === true
  )
    return;
  return {
    input: part.state.input,
    output: part.state.output,
    hash: digest([op.sessionId, row.message_id, row.id, part]),
  };
}

function matchesTerminal(
  run: Record<string, any>,
  op: Operation,
  sdk: NonNullable<ReturnType<typeof sdkReceipt>>,
) {
  const result = run.result,
    output = op.output;
  if (
    !isObject(result) ||
    !isObject(output) ||
    !["failed", "cancelled", "timed_out"].includes(run.status) ||
    result.status !== run.status ||
    !completeStream(result.stdout) ||
    !completeStream(result.stderr) ||
    !date(result.startedAt) ||
    !date(result.completedAt) ||
    !date(run.startedAt) ||
    !date(run.finishedAt) ||
    Date.parse(run.finishedAt) < Date.parse(run.startedAt) ||
    !date(op.at) ||
    !date(op.completedAt) ||
    Date.parse(op.completedAt!) < Date.parse(op.at) ||
    (result.exitCode != null && !Number.isInteger(result.exitCode)) ||
    typeof result.cancelled !== "boolean" ||
    typeof result.timedOut !== "boolean" ||
    (run.status === "failed" &&
      (!Number.isInteger(result.exitCode) || result.exitCode === 0 || result.cancelled || result.timedOut)) ||
    (run.status === "cancelled" && !result.cancelled) ||
    (run.status === "timed_out" && !result.timedOut)
  )
    return false;
  // Background promotion commits a handle to the SDK part; the durable operation
  // later settles to the ExecutionPort result, not the initial "backgrounded" text.
  const handle = run.backgroundTaskId;
  if (typeof handle === "string" && /^ssh_[0-9a-f-]{36}$/.test(handle) && digest(result) === digest(output)) {
    const timeout = sdk.input.timeout ?? 120000;
    if (sdk.input.run_in_background === true)
      return (
        sdk.output ===
        "Command running in background with ID: " + handle + ". You will be notified when it completes."
      );
    return (
      Number.isSafeInteger(timeout) &&
      timeout > 0 &&
      sdk.output ===
        "Command did not complete within its " +
          Math.max(1, Math.round(timeout / 1000)) +
          "s timeout and was moved to the background (ID: " +
          handle +
          "). You will be notified when it completes."
    );
  }
  const streams = result.stdout.text.replace(/^(\s*\n)+/, "").trimEnd();
  const stderr = [
    result.stderr.text.trim(),
    ...(output.interrupted ? ["<error>Command was aborted before completion</error>"] : []),
  ]
    .filter(Boolean)
    .join("\n");
  return (
    run.status === "failed" &&
    output.status === result.status &&
    output.cancelled === result.cancelled &&
    output.timedOut === result.timedOut &&
    output.interrupted === false &&
    output.exitCode === result.exitCode &&
    output.stdout === result.stdout.text &&
    output.stderr === result.stderr.text &&
    output.stdoutBytes === result.stdout.bytes &&
    output.stderrBytes === result.stderr.bytes &&
    output.stdoutTruncated === false &&
    output.stderrTruncated === false &&
    sdk.output === [`Exit code ${result.exitCode}`, streams, stderr].filter(Boolean).join("\n").trim()
  );
}

/** The management port only records what the operator attests. A fresh directory
 * snapshot is an observation, never proof of the complete effects of arbitrary Bash. */
export class OperatorEffectReviewService {
  constructor(
    readonly store: LakeStore,
    readonly sessions: Pick<SessionStorePort, "getSession">,
    readonly revalidate: (operation: Operation) => void,
    readonly isLive: (operation: Operation) => boolean,
  ) {}

  private archive<T>(work: (db: DatabaseSync) => T) {
    const db = new DatabaseSync(join(this.store.data, sessionArchiveName), { readOnly: true });
    try {
      db.exec("BEGIN");
      return work(db);
    } finally {
      db.close();
    }
  }
  private rooted(op: Operation) {
    if (
      op.agentRunId ||
      op.childSessionId ||
      op.originalCallId ||
      op.id !== digest([op.sessionId, op.callId]) ||
      !op.outputHash ||
      op.outputHash !== digest(op.output) ||
      !op.resourceId ||
      !op.hostConfigurationHash
    )
      return;
    const goal = this.store.get<Goal>("superGoals", op.goalId),
      attempt = this.store.get<Attempt>("superAttempts", op.attemptId);
    const resource = this.store.get<any>("resources", op.resourceId);
    if (
      !goal ||
      goal.projectId !== op.projectId ||
      goal.sessionId !== op.sessionId ||
      !attempt ||
      attempt.goalId !== op.goalId ||
      attempt.stepId !== op.stepId ||
      attempt.projectId !== op.projectId ||
      attempt.sessionId !== op.sessionId ||
      attempt.generation !== op.generation ||
      attempt.policyHash !== op.policyHash ||
      attempt.goalRevision !== op.goalRevision ||
      attempt.planRevision !== op.planRevision ||
      resource?.projectId !== op.projectId ||
      resource?.kind !== "ssh" ||
      resource.status !== "available" ||
      (this.store.get<number>("resourceRevisions", op.resourceId) ?? 1) !== op.resourceRevision
    )
      return;
    return goal;
  }
  private source(db: DatabaseSync, op: Operation): Source | undefined {
    if (
      op.tool !== "Bash" ||
      op.readOnly !== false ||
      op.status !== "unknown" ||
      this.store.get("commandReadReconciliations", op.id) ||
      this.store.get("commandObservedEffectReviews", op.id) ||
      op.commandExecutionId !== digest([op.goalId, op.generation, op.callId]) ||
      this.isLive(op)
    )
      return;
    const goal = this.rooted(op);
    if (!goal) return;
    const run = this.store.get<Record<string, any>>("commandExecutions", op.commandExecutionId);
    if (
      !run ||
      run.id !== op.commandExecutionId ||
      run.taskId !== op.goalId ||
      run.workerId !== goal.workerId ||
      run.sessionId !== op.sessionId ||
      run.generation !== op.generation ||
      run.resourceId !== op.resourceId ||
      run.resourceRevision !== op.resourceRevision ||
      run.configurationRevision !== op.hostConfigurationHash ||
      run.readOnly !== false ||
      run.peerRejected ||
      !peerIdentity(run.authenticatedTarget) ||
      typeof run.command !== "string" ||
      run.commandHash !== digest(run.command)
    )
      return;
    const sdk = sdkReceipt(db, op);
    if (
      !sdk ||
      sdk.input.asset_ref !== op.resourceId ||
      sdk.input.command !== run.command ||
      sdk.input.dangerouslyDisableSandbox ||
      !boundResourceRevision(
        this.store,
        { id: op.resourceId!, projectId: op.projectId },
        sdk.input.configuration_revision,
        op.hostConfigurationHash!,
      ) ||
      !matchesTerminal(run, op, sdk)
    )
      return;
    const event = this.store.get<any>("superInputs", goal.sourceEventId);
    const selected = event && this.store.get<any>("messageInputs", event.messageId);
    const msg = event && this.store.get<any>("messages", event.messageId);
    if (
      !event ||
      event.id !== goal.sourceEventId ||
      event.projectId !== op.projectId ||
      msg?.role !== "user" ||
      msg.id !== event.messageId ||
      event.payload !== msg.text ||
      msg.sessionId !== event.sessionId ||
      selected?.projectId !== event.projectId ||
      selected.sessionId !== event.sessionId ||
      selected.messageId !== event.messageId ||
      !Array.isArray(selected.resourceIds) ||
      selected.resourceIds.length !== 1 ||
      selected.resourceIds[0] !== op.resourceId ||
      digest(event.selectedReferences) !==
        digest({
          resourceIds: selected.resourceIds,
          mentions: selected.mentions,
          references: selected.references,
        })
    )
      return;
    const roots: string[] = [
      ...new Set<string>(String(event.payload).match(/\/tmp\/[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,80}/g) ?? []),
    ].filter((d) => requestedInspectionRoot(d, [event.payload]));
    if (
      roots.length !== 1 ||
      !(
        requestedInspectionRoot(roots[0]!, [run.command]) ||
        sdk.input.cwd === roots[0] ||
        String(sdk.input.cwd ?? "").startsWith(roots[0] + "/")
      )
    )
      return;
    this.revalidate(op);
    const promoted = typeof run.backgroundTaskId === "string" && digest(run.result) === digest(op.output);
    const output = [
      "SSH " + run.authenticatedTarget.hostKeys[0]!.fingerprint,
      "工作目录 " + (sdk.input.cwd ?? "/"),
      "命令状态 " +
        run.status +
        "，退出码 " +
        String(run.result.exitCode ?? "未取得") +
        "，完成于 " +
        run.finishedAt,
      "stdout",
      run.result.stdout.text,
      "stderr",
      run.result.stderr.text,
      ...(promoted ? ["SDK 后台回执", sdk.output] : []),
    ].join("\n");
    return {
      operation: op,
      fingerprint: digest([op, run, sdk.hash, event.id, digest(event.payload), digest(selected)]),
      directory: roots[0]!,
      peer: run.authenticatedTarget,
      command: run.command,
      output,
      executionStatus: run.status,
      backgroundTaskId: promoted ? run.backgroundTaskId : undefined,
    };
  }
  private evidence(db: DatabaseSync, source: Source, op: Operation): Evidence | undefined {
    const original = source.operation;
    if (
      op.tool !== "inspect_host" ||
      op.status !== "succeeded" ||
      op.readOnly !== true ||
      op.projectId !== original.projectId ||
      op.resourceId !== original.resourceId ||
      op.resourceRevision !== original.resourceRevision ||
      op.hostConfigurationHash !== original.hostConfigurationHash ||
      !date(op.at) ||
      !date(op.completedAt) ||
      !(Date.parse(op.at) > Date.parse(original.completedAt!)) ||
      Date.parse(op.completedAt!) < Date.parse(op.at) ||
      !this.rooted(op)
    )
      return;
    const out = op.output;
    if (
      !isObject(out) ||
      out.metric !== "directory_state" ||
      out.profileId !== "lake.host.directory-state" ||
      out.profileVersion !== 1 ||
      out.exitCode !== 0 ||
      out.resourceId !== op.resourceId ||
      out.configurationRevision !== op.hostConfigurationHash ||
      !date(out.observedAt) ||
      digest(out.authenticatedTarget) !== digest(source.peer) ||
      out.hostFingerprint !== source.peer.hostKeys[0]!.fingerprint ||
      typeof out.output !== "string" ||
      Buffer.byteLength(out.output) > 131072
    )
      return;
    const sdk = sdkReceipt(db, op);
    if (
      !sdk ||
      sdk.input.asset_ref !== op.resourceId ||
      sdk.input.metric !== "directory_state" ||
      sdk.input.observation_directory !== source.directory ||
      !boundResourceRevision(
        this.store,
        { id: op.resourceId!, projectId: op.projectId },
        sdk.input.configuration_revision,
        op.hostConfigurationHash!,
      )
    )
      return;
    let state;
    try {
      if (digest(JSON.parse(sdk.output)) !== op.outputHash) return;
      state = JSON.parse(validateDirectoryState(out.output, source.directory));
    } catch {
      return;
    }
    if (
      !isObject(state) ||
      state.schemaVersion !== 1 ||
      state.directory !== source.directory ||
      state.complete !== true ||
      !Array.isArray(state.issues) ||
      state.issues.length ||
      !Number.isSafeInteger(state.uid) ||
      state.uid <= 0 ||
      typeof state.present !== "boolean" ||
      Date.parse(state.startedAt) > Date.parse(state.observedAt) ||
      !Array.isArray(state.entries) ||
      !Array.isArray(state.processes)
    )
      return;
    this.revalidate(op);
    return {
      hash: digest([op, sdk.hash]),
      public: {
        operationId: op.id,
        sessionId: op.sessionId,
        taskId: op.goalId,
        at: op.completedAt!,
        directory: source.directory,
        summary: state.entries.length + " 条目录记录，" + state.processes.length + " 个关联进程",
        output: out.output,
      },
    };
  }
  private collect(db: DatabaseSync, source: Source) {
    const rows = this.store.db
      .prepare(
        "SELECT value FROM records WHERE kind='superOperations' AND json_extract(value,'$.tool')='inspect_host' AND json_extract(value,'$.resourceId')=? AND json_extract(value,'$.status')='succeeded' AND json_extract(value,'$.at')>? ORDER BY json_extract(value,'$.at'),id",
      )
      .all(source.operation.resourceId!, source.operation.completedAt!);
    return rows.flatMap((row) => {
      const e = this.evidence(db, source, JSON.parse(String(row.value)));
      return e ? [e] : [];
    });
  }
  private view(db: DatabaseSync, op: Operation): OperatorEffectReview {
    const source = this.source(db, op);
    const unavailable: OperatorEffectReview = {
      operationId: op.id,
      eligible: false,
      directories: [],
      evidence: [],
    };
    if (!source) return unavailable;
    const evidence = this.collect(db, source),
      review = this.store.get<Review>(reviewTable, op.id);
    const closure = this.store.get<Closure>(closureTable, op.id);
    if (
      review &&
      (review.operationId !== op.id ||
        review.sourceKind !== "operator_action" ||
        review.sourceHash !== source.fingerprint ||
        !evidence.some(
          (e) =>
            e.public.operationId === review.judgment.evidenceOperationId && e.hash === review.evidenceHash,
        ))
    )
      return unavailable;
    if (
      closure &&
      (!review ||
        closure.operationId !== op.id ||
        closure.reviewHash !== digest(review) ||
        closure.evidenceHash !== review.evidenceHash ||
        closure.sourceKind !== "operator_action" ||
        !date(closure.closedAt))
    )
      return { ...unavailable, reason: "原复核或结清记录不一致，需要核对" };
    const revision = digest([source.fingerprint, evidence.map((e) => e.hash), review, closure]);
    return {
      operationId: op.id,
      eligible: !review,
      revision,
      command: source.command,
      output: source.output,
      executionStatus: source.executionStatus,
      backgroundTaskId: source.backgroundTaskId,
      directories: [source.directory],
      evidence: evidence
        .filter((e) => !review || e.public.operationId === review.judgment.evidenceOperationId)
        .map((e) => e.public),
      ...(review && { recorded: true, judgment: review.judgment, closureEligible: !closure }),
      ...(closure && { closureState: "reconciled" as const }),
    };
  }
  private async original(sessionId: string, operationId: string) {
    const op = this.store.require<Operation>("superOperations", operationId);
    if (op.sessionId !== sessionId || this.store.session(sessionId).projectId !== op.projectId)
      throw new HttpError(404, "操作不属于当前会话");
    const session = await this.sessions.getSession(sessionId as SessionId);
    if (!session || session.id !== sessionId || session.projectID !== op.projectId || session.time.deleted)
      throw new HttpError(409, "原执行会话已变化");
    return op;
  }
  async reviewInfo(sessionId: string, operationId: string) {
    const op = await this.original(sessionId, operationId);
    return this.archive((db) => this.view(db, op));
  }
  async confirm(sessionId: string, operationId: string, input: OperatorEffectConfirmation) {
    await this.original(sessionId, operationId);
    if (
      !input ||
      !sha(input.revision) ||
      !sha(input.evidenceOperationId) ||
      typeof input.directory !== "string" ||
      input.directory.length > 100 ||
      input.confirmSourceRead !== true ||
      input.confirmAllEffectsKnown !== true ||
      input.confirmRemoteProcessesAccounted !== true ||
      !["none", "observed"].includes(input.effects) ||
      (input.reconcileRisk !== undefined && input.reconcileRisk !== true)
    )
      throw new HttpError(400, "需独立确认完整来源、全部影响及远程进程归属");
    for (const key of [
      "actualEffects",
      "processDisposition",
      "remainingWork",
      "operatorName",
      "note",
    ] as const)
      if (
        typeof input[key] !== "string" ||
        !input[key].trim() ||
        input[key].includes("\0") ||
        Buffer.byteLength(input[key]) > 2048
      )
        throw new HttpError(400, "请完整填写实际影响、进程处置、剩余工作、署名和依据");
    return this.store.transaction(() =>
      this.archive((db) => {
        const op = this.store.require<Operation>("superOperations", operationId),
          view = this.view(db, op);
        const source = this.source(db, op);
        if (!source || view.revision !== input.revision || input.directory !== source.directory)
          throw new HttpError(409, "原操作、范围或独立证据已变化，请刷新");
        const candidate = this.store.get<Operation>("superOperations", input.evidenceOperationId);
        const proof = candidate && this.evidence(db, source, candidate);
        if (!proof || !view.evidence.some((e) => e.operationId === candidate!.id))
          throw new HttpError(409, "需要同一已认证主机与原目录的完整后置观察");
        const judgment: Judgment = {
          effects: input.effects,
          directory: input.directory,
          evidenceOperationId: input.evidenceOperationId,
          actualEffects: input.actualEffects,
          processDisposition: input.processDisposition,
          remainingWork: input.remainingWork,
          operatorName: input.operatorName,
          note: input.note,
        };
        const review = this.store.get<Review>(reviewTable, op.id);
        if (review && digest(review.judgment) !== digest(judgment))
          throw new HttpError(409, "已有不可变的原复核，不能改判");
        if (input.reconcileRisk) {
          if (!review) throw new HttpError(409, "请先独立登记影响复核");
          if (!this.store.get(closureTable, op.id))
            this.store.put<Closure>(closureTable, op.id, {
              operationId: op.id,
              sourceKind: "operator_action",
              reviewHash: digest(review),
              evidenceHash: proof.hash,
              closedAt: now(),
            });
        } else if (!review) {
          this.store.put<Review>(reviewTable, op.id, {
            operationId: op.id,
            sourceKind: "operator_action",
            sourceHash: source.fingerprint,
            evidenceHash: proof.hash,
            judgment,
            recordedAt: now(),
          });
        }
        return {
          operationId: op.id,
          recorded: true as const,
          ...(!!this.store.get(closureTable, op.id) && { closureState: "reconciled" as const }),
        };
      }),
    );
  }
  resolution(op: Operation) {
    const closure = this.store.get<Closure>(closureTable, op.id);
    if (!closure) return;
    try {
      return this.archive((db) => {
        const review = this.store.get<Review>(reviewTable, op.id);
        if (
          !review ||
          review.operationId !== op.id ||
          review.sourceKind !== "operator_action" ||
          closure.operationId !== op.id ||
          closure.sourceKind !== "operator_action" ||
          !date(closure.closedAt) ||
          closure.reviewHash !== digest(review) ||
          closure.evidenceHash !== review.evidenceHash
        )
          return;
        const source = this.source(db, op);
        if (
          !source ||
          review.sourceHash !== source.fingerprint ||
          review.judgment.directory !== source.directory
        )
          return;
        const candidate = this.store.get<Operation>("superOperations", review.judgment.evidenceOperationId);
        if (candidate && this.evidence(db, source, candidate)?.hash === review.evidenceHash)
          return {
            effects: review.judgment.effects,
            closureState: "reconciled" as const,
            closedAt: closure.closedAt,
            replayScopes: [source.directory],
          };
      });
    } catch {
      return undefined;
    }
  }
}
