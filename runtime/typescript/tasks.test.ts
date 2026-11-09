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

test("fresh read-only recovery rejects mutations, opaque calls and children before dispatch",async t=>{
  const f=await fixture(t);f.create({readOnlyRecoveryOf:"source-task"});let dispatched=0;
  for(const binding of [{readOnly:false},{},{readOnly:false,agentRunId:"child",childSessionId:"child-session"}])
    await assert.rejects(f.ledger.operation("goal",1,"policy","mutate-"+JSON.stringify(binding),"Write",{},async()=>{dispatched++;return {};},v=>v,binding),/仅允许独立只读/);
  assert.equal(dispatched,0);assert.equal(f.store.list("superOperations").length,0);
  const saved=f.ledger.get("goal"),deadline=saved.deadlineAt;delete saved.readOnlyRecoveryOf;saved.deadlineAt=new Date(Date.now()+86400000).toISOString();f.ledger.save(saved);
  assert.equal(f.ledger.get("goal").readOnlyRecoveryOf,"source-task");assert.equal(f.ledger.get("goal").deadlineAt,deadline);
  await f.invoke("new-observation");assert.equal(f.store.list("superOperations").length,1);
});

async function acceptedHostStep(t: Parameters<typeof fixture>[0], tool = "inspect_host", revalidate?: (operation: Operation) => void) {
  const f = await fixture(t, revalidate); f.create();
  // Older inline Pilot profiles exposed the manual protocol on a host-managed goal.
  f.ledger.begin("goal", { title: "检查服务器", items: [{ id: "check", title: "检查服务器" }] });
  f.ledger.update("goal", { item_id: "check", status: "running" }, 1, "policy");
  await f.invoke("actual-check", tool);
  f.ledger.update("goal", { item_id: "check", status: "completed", evidence_ids: ["actual-check"] }, 1, "policy");
  return f;
}

test("host completion closes an already accepted current step without replacing evidence or running I/O", async (t) => {
  const { store, ledger } = await acceptedHostStep(t);
  const attempts = store.list("superAttempts"), operations = store.list("superOperations"), receipt = store.list("superAcceptance")[0];
  const result = ledger.finishHost("goal", { summary: "已核对真实启动时间。", outcome: "completed" }, 1, "policy");
  assert.equal(result.status, "completed"); assert.equal(result.acceptanceState, "pass");
  assert.deepEqual(store.list("superAttempts"), attempts); assert.deepEqual(store.list("superOperations"), operations);
  assert.deepEqual(store.require("superAcceptance", (receipt as any).id), receipt);
  assert.equal(store.list("superAcceptance").length, 2); assert.equal(store.list("superPendingReports").length, 1);
  assert.throws(() => ledger.finishHost("goal", { summary: "再次完成。", outcome: "completed" }, 1, "policy"), /closed/);
  assert.equal(store.list("superAcceptance").length, 2);
});

test("accepted host steps still reject stale generations, changed policies and modified evidence", async (t) => {
  const { store, ledger } = await acceptedHostStep(t);
  const finish = (generation = 1, policy = "policy") => ledger.finishHost("goal", { summary: "完成。", outcome: "completed" }, generation, policy);
  assert.throws(() => finish(2), /binding changed/);
  assert.throws(() => finish(1, "new-policy"), /permissions|binding changed/);
  const operation = store.list<Operation>("superOperations")[0]; operation.output = { forged: true }; store.put("superOperations", operation.id, operation);
  assert.throws(() => finish(), /evidence/);
  assert.notEqual(ledger.get("goal").acceptanceState, "pass");
  assert.equal(store.list("superDeliveries").length, 0); assert.equal(store.list("superPendingReports").length, 0);
});

test("accepted host steps revalidate resources and cannot complete from discovery alone or unresolved effects", async (t) => {
  let revoked = false;
  const { store, ledger } = await acceptedHostStep(t, "inspect_host", () => { if (revoked) throw new Error("resource revision changed"); });
  revoked = true;
  assert.throws(() => ledger.finishHost("goal", { summary: "完成。", outcome: "completed" }, 1, "policy"), /resource revision/);
  revoked = false;
  const original = store.list<Operation>("superOperations")[0];
  store.put("superOperations", "unknown", { ...original, id: "unknown", status: "unknown", readOnly: false });
  assert.throws(() => ledger.finishHost("goal", { summary: "完成。", outcome: "completed" }, 1, "policy"), /evidence/);
  assert.equal(store.list("superDeliveries").length, 0);
  const discovery = await acceptedHostStep(t, "list_mcp_tools");
  assert.throws(() => discovery.ledger.finishHost("goal", { summary: "完成。", outcome: "completed" }, 1, "policy"), /discovery/);
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

test("new commands continue after unknown results without changing their original attempt or replaying an old call ID",async t=>{
  const f=await fixture(t);f.create();let dispatched=0;
  const run=(call:string,goal="goal",generation=1)=>f.ledger.operation(goal,generation,"policy",call,"Bash",{command:"same authorized command"},
    async()=>{dispatched++;if(call==="lost")throw new Error("lost response");return {exitCode:0};},v=>v,
    {readOnly:false,resourceId:"host",commandExecutionId:digest([goal,generation,call])});
  await assert.rejects(run("lost"),/lost response/);
  const old=f.store.list<Operation>("superOperations")[0],before=JSON.stringify(old),attempt=JSON.stringify(f.store.require("superAttempts",old.attemptId));
  f.store.put("legacyOperations","legacy-unknown",{projectId:"project",status:"unknown"});
  await run("new-call");await run("same-parameters-new-call");
  await assert.rejects(run("lost"),/cannot be replayed/);
  assert.equal(dispatched,3);assert.equal(JSON.stringify(f.store.require("superOperations",old.id)),before);
  assert.equal(JSON.stringify(f.store.require("superAttempts",old.attemptId)),attempt);
  assert.equal(f.ledger.unresolved("goal"),true);
  assert.throws(()=>f.ledger.finishHost("goal",{summary:"不能抹掉原未知结果",outcome:"completed"},1,"policy"),/evidence/);
  f.create({id:"next",workerId:"next-worker",sessionId:"next-session"});await run("next-task","next");
  assert.equal(f.ledger.finishHost("next",{summary:"新任务已实际执行",outcome:"completed"},1,"policy").status,"completed");
  // The original non-command contract remains independent of command dispatch.
  await assert.rejects(f.ledger.operation("goal",1,"policy","file-write","Write",{},async()=>({}),v=>v,{readOnly:false}),/reconciliation/);
  await assert.rejects(f.ledger.operation("goal",1,"policy","not-a-command","Write",{},async()=>({}),v=>v,{readOnly:false,commandExecutionId:"not-a-host-bash"}),/reconciliation/);
  await assert.rejects(f.ledger.operation("goal",1,"policy","missing-command-binding","Bash",{},async()=>({}),v=>v,{readOnly:false}),/reconciliation/);
});

test("reviewed change directories and closed historical failures impose no second authorization or replay-scope gate on new commands",async t=>{
  const f=await fixture(t);f.create();
  const old={id:"old",goalId:"goal",projectId:"project",sessionId:"session",callId:"old-call",tool:"Bash",status:"unknown",readOnly:false,
    commandExecutionId:"old-execution",at:new Date().toISOString()} as Operation;
  f.store.put("superOperations",old.id,old);
  const ledger=new TaskLedger(f.store,undefined,op=>op.id===old.id?{effects:"observed",closureState:"reconciled",closedAt:new Date().toISOString(),replayScopes:["/tmp/old"]}:undefined);
  for(const [index,command] of ["rm -- /tmp/old/maintenance","printf different","rm -- /tmp/old/maintenance"].entries())
    await ledger.operation("goal",1,"policy","fresh-"+index,"Bash",{command,cwd:"/tmp/old"},async()=>({exitCode:0}),v=>v,{readOnly:false,resourceId:"host",commandExecutionId:"new-"+index});
  assert.deepEqual(f.store.require("superOperations",old.id),old);assert.equal(f.store.list("superAcceptance").length,0);
});

test("a shared member's unknown command cannot block another member's authorized command",async t=>{
  const f=await fixture(t);const first=f.create(),second=f.create({id:"b",sessionId:"b-session",workerId:"b-worker",roleId:"b-role"});
  f.ledger.joinTask(first.id,[first.id,second.id]);
  f.store.put("superOperations","sibling-pending",{id:"sibling-pending",goalId:first.id,projectId:first.projectId,status:"unknown",tool:"Bash"});
  await f.ledger.operation(second.id,1,"policy","current-command","Bash",{command:"echo checked"},async()=>({exitCode:0}),v=>v,{readOnly:false,commandExecutionId:"current"});
  assert.equal(f.store.list<Operation>("superOperations").at(-1)?.status,"succeeded");
  assert.equal(f.store.require<any>("superOperations","sibling-pending").status,"unknown");
  assert.notEqual(f.ledger.jointState(first.id)?.acceptanceState,"pass");
});

test("explicit steps can start a fresh command attempt without reconciling the unknown predecessor",async t=>{
  const f=await fixture(t);f.create({executionMode:"explicit_plan"});
  f.ledger.begin("goal",{title:"check",items:[{id:"logs",title:"check logs"}]});f.ledger.start("goal","logs",1,"policy");
  await assert.rejects(f.ledger.operation("goal",1,"policy","lost","Bash",{},async()=>{throw new Error("lost");},v=>v,{commandExecutionId:"lost",readOnly:false}),/lost/);
  const old=f.store.list<Operation>("superOperations")[0],attempt=JSON.stringify(f.store.require("superAttempts",old.attemptId));
  f.ledger.start("goal","logs",2,"new-policy");
  await f.ledger.operation("goal",2,"new-policy","new","Bash",{},async()=>({exitCode:0}),v=>v,{commandExecutionId:"new",readOnly:false});
  assert.equal(JSON.stringify(f.store.require("superAttempts",old.attemptId)),attempt);assert.equal(f.ledger.unresolved("goal"),true);
  assert.equal(f.ledger.get("goal").acceptanceState,"not_evaluated");
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

test("shared task accepts once after both assignments submit their own evidence and survives reopening", async t => {
  const {store, ledger, create, invoke} = await fixture(t);
  const first = create();
  const second = create({id: 'b', sessionId: 'b-session', workerId: 'b-worker', roleId: 'b-role', mode: 'plan'});
  store.transaction(() => ledger.joinTask(first.id, [first.id, second.id]));
  assert.deepEqual(ledger.joinTask(first.id, [second.id]).memberIds, [first.id, second.id]);
  const {hasAcceptedExecution} = await import('./joint-tasks');
  await invoke('same-call-id');
  const firstDone = ledger.finishHost(first.id, {summary: '甲已检查服务', outcome: 'completed'}, 1, 'policy');
  assert.equal(firstDone.acceptanceState, 'not_evaluated');
  assert.equal(hasAcceptedExecution(store, firstDone), false);
  assert.equal(store.list<any>('superAcceptance').filter(receipt => receipt.scope === 'goal').length, 0);
  assert.equal(ledger.jointState(first.id)?.completed, 1);
  const reopenedStore = await LakeStore.open(store.home, store.data);
  try {
    const reopened = new TaskLedger(reopenedStore);
    const plan = reopened.begin(second.id, {title: '乙的检查', items: [{id: 'query', title: '检查数据库'}]});
    reopened.confirm(second.id, plan.revision, true);
    reopened.start(second.id, 'query', 1, 'policy');
    await reopened.operation(second.id, 1, 'policy', 'same-call-id', 'read_db_table', {}, async () => ({rows: 1}), v => v, {readOnly: true});
    assert.throws(() => reopened.update(second.id, {item_id: 'query', status: 'completed', evidence_ids: firstDone.items[0].evidenceIds}, 1, 'policy'), /unrelated/i);
    reopened.update(second.id, {item_id: 'query', status: 'completed', evidence_ids: ['same-call-id']}, 1, 'policy');
    reopened.finish(second.id, '乙已检查数据库', 'policy');
    assert.throws(() => reopened.finish(second.id, '再次提交', 'policy'));
    const receipts = store.list<any>('superAcceptance');
    assert.equal(receipts.filter(receipt => receipt.scope === 'contribution').length, 2);
    const goalReceipts = receipts.filter(receipt => receipt.scope === 'goal');
    assert.equal(goalReceipts.length, 1);
    assert.deepEqual(goalReceipts[0].contributionReceipts, [firstDone.contributionReceiptId, reopened.get(second.id).contributionReceiptId]);
    assert.equal(store.require<any>('superPendingJointReports', first.id).acceptanceId, goalReceipts[0].id);
    assert.equal(hasAcceptedExecution(store, firstDone), true);
    assert.equal(ledger.jointState(first.id)?.acceptanceState, 'pass');
  } finally { reopenedStore.db.close(); }
});

test("shared acceptance atomically rechecks the first contribution against current permissions and evidence", async t => {
  let revokeFirst = false;
  const {store, ledger, create, invoke} = await fixture(t, operation => {
    if (revokeFirst && operation.goalId === 'goal') throw new Error('first connection changed');
  });
  const a = create(), b = create({id: 'b', sessionId: 'b-session', roleId: 'b-role', workerId: 'b-worker'});
  ledger.joinTask(a.id, [b.id]);
  await invoke('a'); await invoke('b', 'inspect_host', 1, undefined, {readOnly: true}, b.id);
  ledger.finishHost(a.id, {summary: 'A', outcome: 'completed'}, 1, 'policy');
  const finishB = () => ledger.finishHost(b.id, {summary: 'B', outcome: 'completed'}, 1, 'policy');
  const op = store.list<Operation>('superOperations').find(operation => operation.goalId === a.id)!;
  store.put('superOperations', op.id, {...op, outputHash: 'tampered'});
  assert.throws(finishB, /evidence/);
  store.put('superOperations', op.id, op);
  revokeFirst = true;
  assert.throws(finishB, /first connection changed/);
  assert.equal(ledger.get(b.id).contributionReceiptId, undefined);
  assert.equal(ledger.jointState(a.id)?.completed, 1);
  assert.equal(store.list('superPendingJointReports').length, 0);
  revokeFirst = false;
  finishB();
  assert.equal(ledger.jointState(a.id)?.acceptanceState, 'pass');
});

test("joining a task enforces project and role identity, cancellation leaves the other member's work available", async t => {
  const {store, ledger, create, invoke} = await fixture(t);
  const a = create();
  const b = create({id: 'b', sessionId: 'b-session', roleId: 'b-role', workerId: 'b-worker'});
  const foreign = create({id: 'foreign', sessionId: 'foreign-session', projectId: 'elsewhere'});
  assert.throws(() => ledger.joinTask(a.id, [b.id, foreign.id]), /同一项目/);
  const duplicateRole = create({id: 'duplicate', sessionId: 'other-session', workerId: 'other-worker'});
  assert.throws(() => ledger.joinTask(a.id, [duplicateRole.id]), /不同的专员/);
  assert.equal(ledger.jointTask(a.id), undefined);
  ledger.joinTask(a.id, [b.id]);
  // Simulate a stop request that loaded the member before it became shared.
  a.status = 'cancelled'; ledger.save(a);
  assert.equal(ledger.get(a.id).sharedTaskId, a.id);
  await invoke('b', 'inspect_host', 1, undefined, {readOnly: true}, b.id);
  ledger.finishHost(b.id, {summary: 'B', outcome: 'completed'}, 1, 'policy');
  assert.equal(ledger.jointState(a.id)?.status, 'cancelled');
  assert.equal(ledger.jointState(a.id)?.acceptanceState, 'insufficient');
  assert.equal(store.list<any>('superAcceptance').some(receipt => receipt.scope === 'goal'), false);
});

test("independent assignments cannot replay one mutation with a different call ID", async t => {
  const {ledger, create} = await fixture(t);
  const a = create(), b = create({id: 'b', sessionId: 'b-session', roleId: 'b-role', workerId: 'b-worker'});
  ledger.joinTask(a.id, [b.id]);
  let writes = 0;
  const write = (goalId: string, call: string) => ledger.operation(goalId, 1, 'policy', call, 'Write', {file: 'one'},
    async () => ({writes: ++writes}), value => value, {readOnly: false, resourceId: 'host'});
  await write(a.id, 'a-call');
  await assert.rejects(write(b.id, 'b-call'), /Identical mutation/);
  assert.equal(writes, 1);
});

test("joint tasks retain per-member usage and sum it without a round ceiling", async t => {
  const {ledger, create} = await fixture(t);
  const a = create({roundLimit: 3});
  a.modelRounds = 2;
  ledger.save(a);
  const b = create({id: 'b', sessionId: 'b-session', roleId: 'b-role', workerId: 'b-worker', roundLimit: 9,
    deadlineAt: new Date(Date.parse(a.deadlineAt) + 60000).toISOString()});
  ledger.joinTask(a.id, [b.id]);
  assert.equal(ledger.get(b.id).deadlineAt, a.deadlineAt);
  assert.equal(ledger.get(b.id).roundLimit, 9); // Legacy metadata is preserved, not inherited.
  assert.equal(ledger.totalModelRounds(ledger.get(b.id)), 2);
  const member = ledger.get(b.id);
  member.modelRounds=1000;
  ledger.save(member);
  assert.equal(ledger.totalModelRounds(ledger.get(a.id)), 1002);
  assert.equal(ledger.totalModelRounds(ledger.get(b.id)), 1002);
});

test("recalling a shared task by public ID returns this specialist's own report and evidence reference", async t => {
  const {store, ledger, create} = await fixture(t);
  const {TaskContext} = await import('./task-context');
  const a = create();
  const b = create({id: 'execution-b', workerId: 'worker-b', roleId: 'b', sessionId: 'session-b'});
  const followup = create({id: 'followup', workerId: 'worker-next', roleId: 'b', sessionId: 'session-next'});
  ledger.joinTask(a.id, [b.id]);
  store.put('superProjects', a.projectId, {routerSessionId: 'pilot'});
  for (const goal of [a, b]) {
    store.put('superWorkers', goal.workerId, {id: goal.workerId, taskId: goal.id, sessionId: goal.sessionId,
      roleId: goal.roleId, projectId: goal.projectId, createdAt: goal.updatedAt, inputEventIds: []});
    store.put('messages', 'report-' + goal.id, {id: 'report-' + goal.id, sessionId: 'pilot', role: 'assistant', text: 'report from ' + goal.id,
      createdAt: goal.updatedAt, author: {workerId: goal.workerId, roleId: goal.roleId, sessionId: goal.sessionId, taskId: a.id}});
  }
  const context = new TaskContext(store, value => value);
  const rows = context.recall({projectId: followup.projectId, sessionId: followup.sessionId, roleId: followup.roleId,
    taskId: followup.id}, {task_id: a.id}).items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].taskRef.id, b.id);
  assert.equal(rows[0].sharedTaskId, a.id);
  assert.deepEqual(rows[0].reports.map(report => report.id), ['report-' + b.id]);
});
