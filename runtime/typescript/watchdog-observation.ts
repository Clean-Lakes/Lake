import type { LakeStore } from "./store";
import { digest, watchdogOutputHash, type Goal, type Operation } from "./tasks";
import type { TurnFailure } from "./model-errors";

export type WatchdogRetry = {
  workerId: string;
  projectId: string;
  generation: number;
  executionId: string;
  sessionId: string;
  revision: number;
  policyHash: string;
  inputIds: string[];
  controlKey: string;
  attempt: number;
  due: number;
  reason: string;
  owner: string;
};

export function transientModelFailure(failure?: TurnFailure) {
  if (!failure || !["network", "provider"].includes(failure.source ?? "") || failure.retryable === false)
    return false;
  return (
    failure.statusCode === 429 ||
    [502, 503, 504].includes(failure.statusCode ?? 0) ||
    (failure.source === "network" && failure.retryable === true && failure.phase === "connect")
  );
}

const metadata = {
  goal: "goalId",
  session: "sessionId",
  project: "projectId",
  resource: "resourceId",
  resourceRevision: "resourceRevision",
  tool: "tool",
  status: "status",
  args: "argsHash",
  original: "outputHash",
  command: "commandExecutionId",
  input: "watchdogInputHash",
  output: "watchdogOutputHash",
  time: "completedAt",
  started: "at",
} as const;
const expression = (key: string) => "json_extract(value,'$." + key + "')";
const indexColumns = Object.values(metadata).map(expression);
const selectColumns = Object.entries(metadata)
  .map(([key, path]) => expression(path) + ' AS "' + key + '"')
  .join(",");
const scope = ["goalId", "sessionId", "projectId"].map((field) => expression(field) + "=?").join(" AND ");

/** A covering metadata index keeps large original operation envelopes off the sampling path. */
export function prepareWatchdogEvidence(store: LakeStore) {
  store.db.exec(`CREATE INDEX IF NOT EXISTS watchdog_operations_by_execution
    ON records(${indexColumns.join(",")}, id) WHERE kind='superOperations'`);
}

type Row = Record<keyof typeof metadata, string | null> & { id: string };
type HistoricSignature = { original: string; input: string; output: string };
const normalizedTools = new Set(["inspect_host", "list_db_objects", "db_table_ddl", "read_db_table"]);

function signature(store: LakeStore, row: Row) {
  if (row.status !== "succeeded" || !row.original) return;
  let input = row.input ?? row.args,
    output = row.output ?? row.original;
  if (!row.output && (row.command || normalizedTools.has(row.tool!))) {
    // Pre-Watchdog receipts are immutable. Derive their metadata on first use,
    // keyed by original output hash so a changed receipt invalidates the cache.
    const saved = store.get<HistoricSignature>("superWatchdogEvidence", row.id);
    if (saved?.original === row.original) {
      input = saved.input;
      output = saved.output;
    } else {
      const op = store.require<Operation>("superOperations", row.id);
      output = watchdogOutputHash(op) ?? row.original;
      if (row.command) {
        const command = store.db
          .prepare(
            `SELECT json_extract(value,'$.commandHash') AS hash
          FROM records WHERE kind='commandExecutions' AND id=? AND json_extract(value,'$.taskId')=? AND
          json_extract(value,'$.sessionId')=? AND json_extract(value,'$.resourceId')=?`,
          )
          .get(row.command, row.goal, row.session, row.resource);
        if (typeof command?.hash === "string") input = digest([command.hash, null]);
      }
      store.put("superWatchdogEvidence", row.id, { original: row.original, input, output });
    }
  }
  return digest([row.tool, input, row.resource, row.resourceRevision, output]);
}

function resourceLabel(store: LakeStore, row: Row, redact?: (value: string) => string) {
  if (!row.resource || !redact) return "";
  const resource = store.db
    .prepare(
      `SELECT json_extract(value,'$.name') AS name FROM records
    WHERE kind='resources' AND id=? AND json_extract(value,'$.projectId')=?`,
    )
    .get(row.resource, row.project);
  if (typeof resource?.name !== "string") return "";
  if (Number(row.resourceRevision) !== (store.get<number>("resourceRevisions", row.resource) ?? 1)) return "";
  const name = redact(resource.name).trim();
  // Keep short human labels only. URLs, addresses and credential-like strings
  // should not become model input or persist in the review evidence records.
  if (
    !name ||
    name !== resource.name.trim() ||
    !/^[\p{L}\p{N} _-]{1,32}$/u.test(name) ||
    /token|secret|passw|credential|bearer|basic |api.?key|密钥|密码|[a-z\d_-]{20,}/i.test(name)
  )
    return "";
  return " · " + name;
}

export function watchdogEvidence(store: LakeStore, goal: Goal, redact?: (value: string) => string) {
  const rows = store.db
    .prepare(
      `SELECT id,${selectColumns} FROM records WHERE kind='superOperations' AND ${scope} ORDER BY rowid`,
    )
    .all(goal.id, goal.sessionId, goal.projectId) as Row[];
  const signatures = new Set(
    rows.flatMap((row) => {
      const value = signature(store, row);
      return value ? [value] : [];
    }),
  );
  const progressKey = digest([
    goal.items
      .filter((step) => step.status === "completed")
      .map((step) => [step.id, step.attemptId]),
    [...signatures].sort(),
  ]);
  const recent = rows.slice(-5).map((row) => {
    const status =
      (
        { succeeded: "已成功", failed: "已失败", unknown: "结果未知", dispatched: "已派发" } as Record<
          string,
          string
        >
      )[String(row.status)] ?? "已记录";
    const time = Date.parse(row.time ?? row.started ?? "");
    const observed = Number.isFinite(time) ? new Date(time).toISOString() + " · " : "";
    return observed + String(row.tool).slice(0, 64) + resourceLabel(store, row, redact) + " · " + status;
  });
  return {
    progressKey,
    count: rows.length,
    evidence: [`累计 ${rows.length} 次工具调用，取得 ${signatures.size} 组不同的成功回执`, ...recent],
  };
}
