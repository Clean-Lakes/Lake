import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LakeStore } from "./store";
import { digest, TaskLedger, type Goal, type Operation } from "./tasks";

async function fixture(t: { after: (fn: () => Promise<void>) => void }, revalidate?: (operation: Operation) => void) {
  const home = await mkdtemp(join(tmpdir(), "lake-host-task-"));
  const store = await LakeStore.open(home, join(home, "data"));
  t.after(async () => { store.db.close(); await rm(home, { recursive: true, force: true }); });
  const ledger = new TaskLedger(store, revalidate);
  const create = (overrides: Partial<Goal> = {}) => ledger.create({ id: "goal", projectId: "project", sessionId: "session", workerId: "worker",
    roleId: "role", sourceEventId: "event", originRootTurnId: "root", title: "检查服务器", userText: "检查服务器",
    status: "running", roundLimit: 500, deadlineAt: new Date(Date.now() + 60000).toISOString(), mode: "default",
    executionMode: "host_managed", ...overrides });
  const invoke = (callId: string, tool = "inspect_host", generation = 1, dispatch: () => Promise<unknown> = async () => ({ load: 0.4 }),
    binding: { readOnly?: boolean } = { readOnly: true }, goalId = "goal") => ledger.operation(goalId, generation, "policy", callId, tool,
    { resource: "host", callId }, dispatch, (value) => value, binding);
  return { store, ledger, create, invoke };
}

test("ordinary business tools create their own step and finish with current real receipts", async (t) => {
  const { store, ledger, create, invoke } = await fixture(t); create();
  await invoke("current-host");
  const result = ledger.finishHost("goal", { summary: "当前负载为 0.4。", outcome: "completed" }, 1, "policy");
  assert.equal(result.status, "completed"); assert.equal(result.acceptanceState, "pass");
  assert.equal(result.items.length, 1); assert.equal(result.items[0].evidenceIds.length, 1);
  assert.equal(store.list("superAcceptance").length, 2);
  assert.equal(store.list("superPendingReports").length, 1);
  assert.equal(store.require<any>("superDeliveries", digest(["goal", 1])).outcome, "completed");
});

test("discovery and failed observations cannot pass; a partial report preserves the actual business explanation", async (t) => {
  const { store, ledger, create, invoke } = await fixture(t); create();
  await invoke("catalog", "list_mcp_tools");
  assert.throws(() => ledger.finishHost("goal", { summary: "已完成。", outcome: "completed" }, 1, "policy"), /discovery/);
  await invoke("failed-host", "inspect_host", 1, async () => ({ success: false, error: "authentication failed" }));
  assert.throws(() => ledger.finishHost("goal", { summary: "已完成。", outcome: "completed" }, 1, "policy"), /Failed/);
  const partial = ledger.finishHost("goal", { summary: "SSH 认证失败，暂时没有取得运行数据。", outcome: "partial" }, 1, "policy");
  assert.equal(partial.status, "paused"); assert.equal(partial.acceptanceState, "not_evaluated");
  assert.equal(partial.summary, "SSH 认证失败，暂时没有取得运行数据。");
  assert.equal(store.list("superAcceptance").length, 0);
  assert.deepEqual(store.require<any>("superDeliveries", digest(["goal", 1])).summary, partial.summary);
  assert.equal(store.require<any>("superDeliveries", digest(["goal", 1])).outcome, "partial");
});

test("a settled read failure can obtain a fresh sample without model bookkeeping", async (t) => {
  const { store, ledger, create, invoke } = await fixture(t); create();
  await assert.rejects(invoke("read-failed", "inspect_host", 1, async () => { throw new Error("connection timed out"); }), /timed out/);
  const previous = store.list<Operation>("superOperations")[0];
  await invoke("read-recovered");
  const goal = ledger.finishHost("goal", { summary: "重试后已取得当前负载。", outcome: "completed" }, 1, "policy");
  assert.equal(goal.status, "completed");
  assert.equal(store.require<Operation>("superOperations", previous.id).status, "failed");
  assert.equal(store.require<any>("superAttempts", previous.attemptId).state, "failed");
  assert.ok(store.require<any>("superAttempts", previous.attemptId).reconciledAt);
  assert.equal(store.list<any>("superAttempts").at(-1).retryOf, previous.attemptId);
  assert.deepEqual(goal.items[0].evidenceIds, store.list<Operation>("superOperations").filter((operation) => operation.status === "succeeded").map((operation) => operation.id));
});

test("another invocation cannot accept stale observations or a discovery-only continuation", async (t) => {
  const { store, ledger, create, invoke } = await fixture(t); create();
  await invoke("old-host");
  const old = store.list<Operation>("superOperations")[0];
  assert.throws(() => ledger.finishHost("goal", { summary: "已完成。", outcome: "completed" }, 2, "policy"), /binding changed/);
  await invoke("new-catalog", "list_mcp_tools", 2);
  assert.throws(() => ledger.finishHost("goal", { summary: "已完成。", outcome: "completed" }, 2, "policy"), /discovery/);
  await invoke("new-host", "inspect_host", 2);
  const goal = ledger.finishHost("goal", { summary: "已取得本次检查数据。", outcome: "completed" }, 2, "policy");
  assert.ok(!goal.items[0].evidenceIds.includes(old.id));
  assert.equal(store.require<Operation>("superOperations", old.id).generation, 1);
});

test("unknown writes are never replayed while independent proven reads remain usable", async (t) => {
  const { store, ledger, create, invoke } = await fixture(t); create();
  let mutations = 0;
  await assert.rejects(invoke("uncertain-write", "Write", 1, async () => { mutations++; throw new Error("lost response"); }, { readOnly: false }), /lost response/);
  const unknown = store.list<Operation>("superOperations")[0];
  const before = structuredClone(unknown);
  const originalAttempt = store.require<any>("superAttempts", unknown.attemptId);
  await assert.rejects(invoke("uncertain-write", "Write", 1, async () => { mutations++; return {}; }, { readOnly: false }), /cannot be replayed/);
  await assert.rejects(invoke("new-write", "Write", 1, async () => { mutations++; return {}; }, { readOnly: false }), /reconciliation/);
  await invoke("independent-host", "inspect_host", 2);
  assert.deepEqual(store.require("superOperations", unknown.id), before);
  assert.deepEqual(store.require("superAttempts", unknown.attemptId), originalAttempt);
  assert.equal(mutations, 1); assert.equal(ledger.unresolved("goal"), true);
  assert.throws(() => ledger.finishHost("goal", { summary: "已完成。", outcome: "completed" }, 2, "policy"), /evidence/);
  const partial = ledger.finishHost("goal", { summary: "已取得负载；先前写入结果仍待核实。", outcome: "partial" }, 2, "policy");
  assert.equal(partial.status, "blocked"); assert.notEqual(partial.acceptanceState, "pass");
});

test("legacy unresolved operations do not prevent proven reads and still block mutations", async (t) => {
  const { store, ledger, create, invoke } = await fixture(t); create();
  store.put("legacyOperations", "legacy-unknown", { id: "legacy-unknown", projectId: "project", status: "unknown" });
  await invoke("current-host");
  let writes = 0;
  await assert.rejects(invoke("new-write", "Write", 1, async () => { writes++; return {}; }, { readOnly: false }), /旧 Go/);
  assert.equal(writes, 0); assert.equal(store.require<any>("legacyOperations", "legacy-unknown").status, "unknown");
  assert.equal(ledger.finishHost("goal", { summary: "已完成独立只读检查。", outcome: "completed" }, 1, "policy").status, "completed");
});

test("Plan and explicit contracts retain the existing model-driven acceptance path", async (t) => {
  const { ledger, create } = await fixture(t);
  create({ mode: "plan" });
  assert.equal(ledger.isHostManaged(ledger.get("goal")), false);
  assert.throws(() => ledger.prepareHostOperation("goal", 1, "policy", { readOnly: true }), /explicit/);
  create({ id: "explicit", executionMode: "explicit_plan" });
  assert.equal(ledger.isHostManaged(ledger.get("explicit")), false);
  assert.throws(() => ledger.finishHost("explicit", { summary: "完成。", outcome: "partial" }, 1, "policy"), /explicit/);
});

test("an old TS blocked single-step task is adopted without rewriting its plan or old records", async (t) => {
  const { store, ledger, create, invoke } = await fixture(t);
  create({ executionMode: undefined });
  ledger.begin("goal", { title: "原始检查", items: [{ id: "original-step", title: "检查服务器" }] });
  const old = ledger.get("goal"); delete old.executionMode;
  old.items[0].status = "blocked"; old.items[0].reason = "adapter unavailable";
  store.put("superGoals", old.id, old);
  assert.equal(ledger.isHostManaged(old), true);
  await invoke("current-host");
  const adopted = ledger.get("goal");
  assert.equal(adopted.items[0].id, "original-step"); assert.equal(adopted.planHash, old.planHash);
  assert.equal(store.require<any>("superHostAdoptions", old.id).originalItems[0].reason, "adapter unavailable");
  assert.equal(ledger.finishHost("goal", { summary: "已取得当前数据。", outcome: "completed" }, 1, "policy").status, "completed");
});

test("multi-step or already accepted legacy plans are not silently adopted", async (t) => {
  const { store, ledger, create } = await fixture(t); create({ executionMode: undefined });
  ledger.begin("goal", { title: "检查", items: [{ id: "one", title: "第一项" }, { id: "two", title: "第二项" }] });
  const old = ledger.get("goal"); delete old.executionMode; store.put("superGoals", old.id, old);
  assert.equal(ledger.isHostManaged(old), false);
  old.items = [old.items[0]]; old.items[0].status = "completed"; old.items[0].acceptanceId = "existing-receipt";
  store.put("superGoals", old.id, old);
  assert.equal(ledger.isHostManaged(old), false);
});

test("fresh reads and completion still revalidate current permissions", async (t) => {
  let denied = false, dispatched = 0;
  const { ledger, create, invoke } = await fixture(t, () => { if (denied) throw new Error("current policy denied"); }); create();
  denied = true;
  await assert.rejects(invoke("denied-host", "inspect_host", 1, async () => { dispatched++; return {}; }), /policy denied/);
  assert.equal(dispatched, 0);
  denied = false; await invoke("allowed-host"); denied = true;
  assert.throws(() => ledger.finishHost("goal", { summary: "完成。", outcome: "completed" }, 1, "policy"), /policy denied/);
  assert.notEqual(ledger.get("goal").acceptanceState, "pass");
  assert.equal(storeDeliveries(ledger), 0);
});

const storeDeliveries = (ledger: TaskLedger) => ledger.store.list("superDeliveries").length;

test("stop, pause and expiry cannot turn a late successful observation into task completion", async (t) => {
  const { store, ledger, create, invoke } = await fixture(t);
  for (const status of ["cancelled", "paused", "expired"]) {
    const goalId = status;
    create({ id: goalId, sessionId: "session-" + status });
    await invoke("host-" + status, "inspect_host", 1, async () => ({ load: 0.2 }), { readOnly: true }, goalId);
    const goal = ledger.get(goalId);
    if (status === "expired") goal.deadlineAt = new Date(Date.now() - 1000).toISOString();
    else goal.status = status;
    ledger.save(goal);
    assert.throws(() => ledger.finishHost(goalId, { summary: "完成。", outcome: "completed" }, 1, "policy"));
    assert.notEqual(ledger.get(goalId).acceptanceState, "pass");
    assert.equal(store.get("superDeliveries", digest([goalId, 1])), undefined);
  }
});

test("a report without an explicit valid outcome cannot create a delivery or acceptance", async (t) => {
  const { store, ledger, create, invoke } = await fixture(t); create(); await invoke("current-host");
  assert.throws(() => ledger.finishHost("goal", { summary: "我已经完成。" } as any, 1, "policy"), /outcome/);
  assert.equal(store.list("superDeliveries").length, 0); assert.equal(store.list("superAcceptance").length, 0);
});

test("delivery presentation is tied to the invocation and failed acceptance never creates a success delivery", async (t) => {
  const { store, ledger, create, invoke } = await fixture(t); create();
  ledger.finishHost("goal", { summary: "暂时还没有运行数据。", outcome: "partial" }, 1, "policy");
  const goal = ledger.get("goal"); goal.status = "running"; ledger.save(goal);
  await invoke("current-discovery", "list_mcp_tools", 2);
  assert.throws(() => ledger.finishHost("goal", { summary: "已完成。", outcome: "completed" }, 2, "policy"), /discovery/);
  assert.equal(store.get("superDeliveries", digest(["goal", 2])), undefined);
  assert.equal(store.require<any>("superDeliveries", digest(["goal", 1])).outcome, "partial");
});
