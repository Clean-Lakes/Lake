import { HttpError, LakeStore } from "./store";
import { digest } from "./tasks";
import type { WatchdogReviewResult } from "./watchdog-review";

export type WatchdogMode = "off" | "observe" | "guide";
export type WatchdogReview = WatchdogReviewResult;
export type WatchdogVerdict = WatchdogReview["verdict"];
type ExecutionIdentity = {
  projectId: string;
  workerId: string;
  sessionId: string;
  executionId: string;
  taskId: string;
  generation: number;
};
export type WatchdogSample = ExecutionIdentity & {
  policyHash: string;
  controlKey?: string;
  progressKey: string;
  eligible: boolean;
  waiting: boolean;
  unresolved: boolean;
  title: string;
  assignment: string;
  evidence: string[];
  recent: string[];
};
export type WatchdogRecord = ExecutionIdentity & {
  id: string;
  at: string;
  updatedAt: string;
  kind: "stall" | "periodic" | "infrastructure";
  state: "reviewing" | "observed" | "retry_queued" | "guiding" | "guided" | "recovered" | "stale" | "error";
  verdict?: WatchdogVerdict;
  reason: string;
  evidence: string[];
};

type Ports = {
  activeWorkerIds(): string[];
  snapshot(workerId: string): WatchdogSample | undefined;
  review(sample: WatchdogSample, signal: AbortSignal): Promise<WatchdogReview>;
  steer(sample: WatchdogSample, inputId: string, text: string, signal: AbortSignal): Promise<boolean>;
  changed?(sample: ExecutionIdentity): void;
};
type Policy = { mode: WatchdogMode; revision: number };
type Observation = {
  epoch: string;
  generation: number;
  progressKey: string;
  observedAt: number;
  since: number;
  windows: number;
  lastReview?: number;
  lastGuidance?: string;
  guidedVerdicts: WatchdogVerdict[];
};

const minute = 60_000,
  reviewInterval = 15 * minute,
  reviewTimeout = 30_000;
const verdicts: WatchdogVerdict[] = ["progress", "stalled", "drift", "uncertain"];
const recordsKind = "superWatchdogRecords",
  observationsKind = "superWatchdogObservations",
  policyKind = "superWatchdogPolicy";
function identity(sample: ExecutionIdentity): ExecutionIdentity {
  const { projectId, workerId, sessionId, executionId, taskId, generation } = sample;
  return { projectId, workerId, sessionId, executionId, taskId, generation };
}
function eligible(sample: WatchdogSample | undefined): sample is WatchdogSample {
  return !!sample && sample.eligible && !sample.waiting && !sample.unresolved;
}

function reviewInput(sample: WatchdogSample): WatchdogSample {
  return {
    ...sample,
    title: sample.title.slice(0, 400),
    assignment: sample.assignment.slice(0, 1200),
    evidence: sample.evidence.slice(-8).map((value) => value.slice(0, 240)),
    recent: sample.recent.slice(-6).map((value) => value.slice(0, 240)),
  };
}

/** Only the host can observe an execution or steer it. Review text is never a tool request or a durable user input. */
export class TaskWatchdog {
  private readonly inFlight = new Map<
    string,
    { controller: AbortController; sample: WatchdogSample; policy: Policy }
  >();
  private readonly pending = new Set<Promise<void>>();
  private closed = false;
  constructor(
    readonly store: LakeStore,
    private readonly ports: Ports,
    private readonly clock = Date.now,
  ) {
    store.db.exec(`CREATE INDEX IF NOT EXISTS watchdog_records_project_at ON records
      (json_extract(value,'$.projectId'),json_extract(value,'$.at')) WHERE kind='superWatchdogRecords'`);
    // A previous process may have sent its guide just before it exited. Its claim
    // stays charged and never retries. Only a live host can acknowledge delivery.
    const unfinished = store.db
      .prepare(
        `SELECT value FROM records WHERE kind='superWatchdogRecords'
      AND json_extract(value,'$.state') IN ('reviewing','guiding')`,
      )
      .all();
    for (const row of unfinished) {
      const record = JSON.parse(String(row.value)) as WatchdogRecord;
      this.update(record, { state: "stale", reason: "上次巡检被中断，原执行需要重新观察。" });
    }
  }

  private policy(projectId: string): Policy {
    return this.store.get<Policy>(policyKind, projectId) ?? { mode: "observe", revision: 0 };
  }
  mode(projectId: string) {
    return this.policy(projectId).mode;
  }
  setMode(projectId: string, mode: WatchdogMode) {
    if (!["off", "observe", "guide"].includes(mode)) throw new HttpError(400, "无效的巡检模式");
    const previous = this.policy(projectId);
    if (previous.mode !== mode) {
      this.store.put(policyKind, projectId, { mode, revision: previous.revision + 1 });
      for (const flight of this.inFlight.values())
        if (flight.sample.projectId === projectId) flight.controller.abort();
    }
    return mode;
  }
  records(projectId: string, executionId?: string, limit = 20): WatchdogRecord[] {
    const cap = Number.isSafeInteger(limit) ? Math.min(50, Math.max(1, limit)) : 20;
    const query = `SELECT value FROM records WHERE kind='superWatchdogRecords' AND json_extract(value,'$.projectId')=?
      ${executionId ? "AND json_extract(value,'$.executionId')=?" : ""} ORDER BY json_extract(value,'$.at') DESC,id DESC LIMIT ?`;
    return this.store.db
      .prepare(query)
      .all(...(executionId ? [projectId, executionId, cap] : [projectId, cap]))
      .map((row) => JSON.parse(String(row.value)) as WatchdogRecord);
  }
  private update(record: WatchdogRecord, change: Partial<WatchdogRecord>) {
    Object.assign(record, change, { updatedAt: new Date(this.clock()).toISOString() });
    this.store.put(recordsKind, record.id, record);
  }
  recordIncident(
    sample: ExecutionIdentity,
    reason: string,
    state: "observed" | "retry_queued" | "recovered" | "error" = "observed",
  ) {
    if (this.closed || this.mode(sample.projectId) === "off") return;
    const key = digest(["infrastructure", identity(sample), reason]);
    const previous = this.store.get<WatchdogRecord>(recordsKind, key);
    if (previous?.state === state || previous?.state === "recovered" || (previous && state === "observed"))
      return previous;
    const at = new Date(this.clock()).toISOString();
    const record: WatchdogRecord = {
      ...identity(sample),
      id: key,
      at: previous?.at ?? at,
      updatedAt: at,
      kind: "infrastructure",
      state,
      reason: reason.slice(0, 400),
      evidence: [],
    };
    this.store.put(recordsKind, key, record);
    this.ports.changed?.(sample);
    return record;
  }
  /** Explicit evidence of member completion can arrive between sampling windows. */
  completed(sample: ExecutionIdentity) {
    const observation = this.store.get<Observation>(observationsKind, sample.executionId);
    if (!observation?.lastGuidance || observation.generation !== sample.generation) return;
    const record = this.store.get<WatchdogRecord>(recordsKind, observation.lastGuidance);
    if (!record || record.state !== "guided" || digest(identity(record)) !== digest(identity(sample))) return;
    this.store.transaction(() => {
      this.update(record, { state: "recovered" });
      observation.lastGuidance = undefined;
      this.store.put(observationsKind, sample.executionId, observation);
    });
    this.ports.changed?.(sample);
  }
  private budgetAvailable(projectId: string, time: number) {
    const row = this.store.db
      .prepare(
        `SELECT count(*) AS n FROM records WHERE kind='superWatchdogRecords'
      AND json_extract(value,'$.projectId')=? AND json_extract(value,'$.at')>?
      AND json_extract(value,'$.kind') IN ('stall','periodic')`,
      )
      .get(projectId, new Date(time - 60 * minute).toISOString());
    return Number(row?.n ?? 0) < 4;
  }
  private epoch(sample: WatchdogSample, policy: Policy) {
    return digest([identity(sample), sample.policyHash, sample.controlKey, policy.revision]);
  }
  private observe(sample: WatchdogSample, policy: Policy, time: number) {
    // Keep the per-execution review clock even if the generation or mode changes.
    const old = this.store.get<Observation>(observationsKind, sample.executionId);
    const epoch = this.epoch(sample, policy);
    const fresh = !old || old.epoch !== epoch;
    const observation: Observation = fresh
      ? {
          epoch,
          generation: sample.generation,
          progressKey: sample.progressKey,
          observedAt: time,
          since: time,
          windows: 0,
          guidedVerdicts: old?.generation === sample.generation ? old.guidedVerdicts : [],
          lastReview: old?.lastReview,
        }
      : old;
    const changed = observation.progressKey !== sample.progressKey;
    if (changed && eligible(sample) && observation.lastGuidance) {
      const guide = this.store.get<WatchdogRecord>(recordsKind, observation.lastGuidance);
      if (guide?.state === "guided") this.update(guide, { state: "recovered" });
      observation.lastGuidance = undefined;
    }
    if (fresh || !eligible(sample) || changed) {
      observation.windows = 0;
      if (eligible(sample)) observation.progressKey = sample.progressKey;
      if (fresh || !eligible(sample)) observation.since = time;
      observation.observedAt = time;
    } else if (time - observation.observedAt >= minute) {
      // A sleeping host observes one interval on wake. Elapsed wall time alone
      // cannot establish multiple independent no-progress observations.
      observation.windows++;
      observation.observedAt = time;
    }
    this.store.put(observationsKind, sample.executionId, observation);
    if (!eligible(sample) || fresh || this.inFlight.has(sample.workerId)) return;
    const due =
      observation.windows >= 3
        ? "stall"
        : time - observation.since >= reviewInterval
          ? "periodic"
          : undefined;
    if (
      !due ||
      time - (observation.lastReview ?? -Infinity) < reviewInterval ||
      !this.budgetAvailable(sample.projectId, time)
    )
      return;
    observation.lastReview = time;
    observation.windows = 0;
    this.store.put(observationsKind, sample.executionId, observation);
    const at = new Date(time).toISOString();
    const record: WatchdogRecord = {
      ...identity(sample),
      id: digest([epoch, time]),
      at,
      updatedAt: at,
      kind: due,
      state: "reviewing",
      reason: "正在核对当前分工和执行记录。",
      evidence: sample.evidence,
    };
    this.store.put(recordsKind, record.id, record);
    return record;
  }

  async scan() {
    if (this.closed) return;
    const reviews: Promise<void>[] = [];
    const workers = new Set(this.ports.activeWorkerIds());
    for (const [id, flight] of this.inFlight)
      if (!workers.has(id) || !this.matches(flight.sample, flight.policy)) flight.controller.abort();
    const candidates = [...workers].flatMap((workerId) => {
      const sample = this.ports.snapshot(workerId);
      if (!sample) return [];
      const previous = this.store.get<Observation>(observationsKind, sample.executionId);
      return [{ sample, lastReview: previous?.lastReview ?? -Infinity }];
    });
    // Spend shared project quota on the least recently reviewed executions first.
    candidates.sort((a, b) => (a.lastReview === b.lastReview ? 0 : a.lastReview < b.lastReview ? -1 : 1));
    for (const { sample: current } of candidates) {
      const policy = this.policy(current.projectId);
      if (policy.mode === "off") continue;
      const sample = reviewInput(current);
      const record = this.store.transaction(() => this.observe(sample, policy, this.clock()));
      if (record) {
        const request = this.runReview(record, sample, policy);
        this.pending.add(request);
        reviews.push(request);
        void request.then(
          () => this.pending.delete(request),
          () => this.pending.delete(request),
        );
      }
    }
    await Promise.allSettled(reviews);
  }
  private matches(sample: WatchdogSample, policy: Policy) {
    if (this.closed || this.policy(sample.projectId).revision !== policy.revision) return false;
    const current = this.ports.snapshot(sample.workerId);
    return (
      eligible(current) &&
      this.epoch(current, policy) === this.epoch(sample, policy) &&
      current.progressKey === sample.progressKey
    );
  }
  private async runReview(record: WatchdogRecord, sample: WatchdogSample, policy: Policy) {
    const controller = new AbortController();
    this.inFlight.set(sample.workerId, { controller, sample, policy });
    const timeout = setTimeout(() => controller.abort(), reviewTimeout);
    timeout.unref();
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(new Error("watchdog-aborted")), {
        once: true,
      }),
    );
    try {
      if (this.closed) return;
      if (controller.signal.aborted || !this.matches(sample, policy)) {
        this.update(record, { state: "stale", reason: "任务状态已变化，本次巡检已失效。" });
        return;
      }
      const result = await Promise.race([aborted, this.ports.review(sample, controller.signal)]);
      if (this.closed) return;
      if (controller.signal.aborted || !this.matches(sample, policy)) {
        this.update(record, { state: "stale", reason: "任务状态或业务证据已变化，本次巡检已失效。" });
        return;
      }
      if (!verdicts.includes(result?.verdict) || typeof result.reason !== "string" || !result.reason.trim())
        throw new Error("invalid-review");
      this.update(record, {
        state: "observed",
        verdict: result.verdict,
        reason: result.reason.trim().slice(0, 400),
      });
      if (policy.mode !== "guide" || (result.verdict !== "stalled" && result.verdict !== "drift")) return;
      const observation = this.store.require<Observation>(observationsKind, sample.executionId);
      if (observation.guidedVerdicts.includes(result.verdict)) return;
      // Claim before calling the SDK, since it might receive the guide even if
      // the host never gets a reply. An ambiguous handoff is never sent again.
      observation.guidedVerdicts.push(result.verdict);
      this.store.transaction(() => {
        this.store.put(observationsKind, sample.executionId, observation);
        this.update(record, { state: "guiding" });
      });
      const message =
        result.verdict === "drift"
          ? "请重新核对原任务目标和你本次的分工，只推进与这项分工相关的工作。"
          : "请核对已有的工具回执和未完成的分工；如果重复同一步没有带来新证据，请改用适当的检查，或说明具体阻碍。";
      const queued = await Promise.race([
        aborted,
        this.ports.steer(sample, record.id, message, controller.signal),
      ]);
      if (this.closed) return;
      if (controller.signal.aborted || !this.matches(sample, policy)) {
        this.update(record, { state: "stale" });
        return;
      }
      this.update(record, { state: queued ? "guided" : "stale" });
      if (queued) {
        const latest = this.store.require<Observation>(observationsKind, sample.executionId);
        latest.lastGuidance = record.id;
        this.store.put(observationsKind, sample.executionId, latest);
      }
    } catch {
      if (!this.closed)
        this.update(record, {
          state: this.matches(sample, policy) ? "error" : "stale",
          reason: "巡检未完成，未确认新的处置结果。",
        });
    } finally {
      clearTimeout(timeout);
      this.inFlight.delete(sample.workerId);
      if (!this.closed) this.ports.changed?.(sample);
    }
  }
  async close() {
    this.closed = true;
    for (const { controller } of this.inFlight.values()) controller.abort();
    await Promise.allSettled([...this.pending]);
  }
}
