import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LakeStore } from "./store";
import { digest, TaskLedger, watchdogOutputHash, type Goal, type Operation } from "./tasks";
import { prepareWatchdogEvidence, watchdogEvidence } from "./watchdog-observation";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "lake-observation-"));
  const store = await LakeStore.open(root, join(root, "data"));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  prepareWatchdogEvidence(store);
  const ledger = new TaskLedger(store);
  const goal = ledger.create({
    id: "execution",
    projectId: "project",
    workerId: "worker",
    sessionId: "session",
    roleId: "role",
    sourceEventId: "input",
    title: "test",
    userText: "test",
    originRootTurnId: "root",
    status: "running",
    roundLimit: 16,
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    mode: "default",
    executionMode: "host_managed",
  });
  const observe = () =>
    watchdogEvidence(store, ledger.get(goal.id), (s) => s.replace("private", "[REDACTED]"));
  return { store, ledger, goal, observe };
}
function output(text: string) {
  return { status: "completed", exitCode: 0, stdout: text, stderr: "", durationMs: Date.now() };
}

test("both SDK Bash receipt shapes preserve actual changed output and ignore narration, command timings and call IDs", async (t) => {
  const { store, ledger, goal, observe } = await fixture(t);
  const resource = "resource";
  const invoke = async (id: string, text: string) => {
    await ledger.operation(
      goal.id,
      1,
      "policy",
      id,
      "Bash",
      { command: "hostname", description: id },
      async () => output(text),
      (v) => v,
      { commandExecutionId: id, resourceId: resource, resourceRevision: 1, readOnly: true },
    );
  };
  store.put("resources", resource, { projectId: goal.projectId, name: "读库 A" });
  await invoke("first", "one");
  const first = observe();
  assert.match(first.evidence.at(-1)!, /Z · Bash · 读库 A · 已成功/);
  await invoke("repeat", "one");
  assert.equal(observe().progressKey, first.progressKey);
  const second = store.list<Operation>("superOperations").find((op) => op.callId === "repeat")!;
  assert.notEqual(second.argsHash, store.list<Operation>("superOperations")[0].argsHash);
  assert.equal(second.outputHash, digest(second.output));
  await ledger.operation(
    goal.id,
    1,
    "policy",
    "background",
    "Bash",
    { command: "hostname", description: "后台" },
    async () => ({ status: "backgrounded" }),
    (v) => v,
    { commandExecutionId: "background", resourceId: resource, resourceRevision: 1, readOnly: true },
  );
  const bg = store.list<Operation>("superOperations").find((op) => op.callId === "background")!;
  ledger.settleCommand(
    bg.id,
    "background",
    { status: "completed", exitCode: 0, stdout: { text: "one" }, stderr: { text: "" }, durationMs: 9999 },
    true,
  );
  assert.equal(observe().progressKey, first.progressKey);
  await invoke("changed", "two");
  assert.notEqual(observe().progressKey, first.progressKey);
  store.put("resources", resource, { projectId: goal.projectId, name: "private-db" });
  assert.doesNotMatch(JSON.stringify(observe().evidence), /private-db|REDACTED/);
  store.put("resources", resource, { projectId: goal.projectId, name: "mysql://admin:secret@example" });
  assert.doesNotMatch(JSON.stringify(observe().evidence), /mysql:|admin:secret/);
});

test("historical command evidence is parsed once per exact stored receipt and metadata queries use the execution index", async (t) => {
  const { store, ledger, goal, observe } = await fixture(t);
  await ledger.operation(
    goal.id,
    1,
    "policy",
    "a",
    "Bash",
    { command: "hostname" },
    async () => output("old host"),
    (v) => v,
    { commandExecutionId: "cmd", resourceId: "resource", resourceRevision: 1, readOnly: true },
  );
  const op = store.list<Operation>("superOperations")[0];
  delete op.watchdogInputHash;
  delete op.watchdogOutputHash;
  store.put("superOperations", op.id, op);
  store.put("commandExecutions", "cmd", {
    taskId: goal.id,
    sessionId: goal.sessionId,
    resourceId: "resource",
    commandHash: digest("hostname"),
  });
  const first = observe();
  assert.deepEqual(store.get("superOperations", op.id), op);
  const cached = store.get<{ original: string }>("superWatchdogEvidence", op.id)!;
  assert.equal(cached.original, op.outputHash);
  const require = t.mock.method(store, "require");
  assert.equal(observe().progressKey, first.progressKey);
  assert.equal(require.mock.calls.filter((call) => call.arguments[0] === "superOperations").length, 0);
  const fresh = output("different host");
  store.put("superOperations", op.id, { ...op, output: fresh, outputHash: digest(fresh) });
  assert.notEqual(observe().progressKey, first.progressKey);
  store.put("superOperations", "foreign", { ...op, id: "foreign", sessionId: "another" });
  assert.equal(observe().count, 1);
  const plan = store.db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT id,json_extract(value,'$.outputHash') FROM records
    WHERE kind='superOperations' AND json_extract(value,'$.goalId')=? AND json_extract(value,'$.sessionId')=?
    AND json_extract(value,'$.projectId')=? ORDER BY rowid`,
    )
    .all(goal.id, goal.sessionId, goal.projectId);
  assert.match(JSON.stringify(plan), /watchdog_operations_by_execution/);
});

test("host and database capture timestamps do not simulate progress, actual query results do", async (t) => {
  const { store, ledger, goal, observe } = await fixture(t);
  for (const tool of ["inspect_host", "read_db_table"]) {
    await ledger.operation(
      goal.id,
      1,
      "policy",
      tool + "1",
      tool,
      { query: "SELECT" },
      async () => ({ observedAt: "yesterday", rows: [{ observedAt: "actual data" }] }),
      (v) => v,
      { databaseConfigurationHash: "revision", readOnly: true },
    );
    const first = observe();
    await ledger.operation(
      goal.id,
      1,
      "policy",
      tool + "2",
      tool,
      { query: "SELECT" },
      async () => ({ observedAt: "today", rows: [{ observedAt: "actual data" }] }),
      (v) => v,
      { databaseConfigurationHash: "revision", readOnly: true },
    );
    assert.equal(first.progressKey, observe().progressKey);
    await ledger.operation(
      goal.id,
      1,
      "policy",
      tool + "3",
      tool,
      { query: "SELECT" },
      async () => ({ observedAt: "today", rows: [{ observedAt: "changed data" }] }),
      (v) => v,
      { databaseConfigurationHash: "revision", readOnly: true },
    );
    assert.notEqual(first.progressKey, observe().progressKey);
  }
  const saved = ledger.get(goal.id);
  const before = observe();
  const failure = { ...saved, items: saved.items.map((step) => ({ ...step, status: "failed" })) } as Goal;
  assert.equal(watchdogEvidence(store, failure).progressKey, before.progressKey);
  assert.equal(
    typeof watchdogOutputHash({ tool: "Bash", commandExecutionId: "cmd", output: output("test") }),
    "string",
  );
});
