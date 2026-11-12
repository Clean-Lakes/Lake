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

test("ordinary tools retain actual receipts while report submission creates no acceptance", async t => {
 const f=await fixture(t);f.create();await f.invoke("current-host");
 const operations=f.store.list("superOperations"),attempts=f.store.list("superAttempts");
 const result=f.ledger.finishHost("goal",{summary:"当前负载为 0.4。",outcome:"completed"},1,"policy");
 assert.equal(result.status,"completed");assert.equal(result.acceptanceState,"not_evaluated");
 assert.equal(result.reportedOutcome,"completed");assert.equal(result.completionReportId,digest(["goal",1]));
 assert.deepEqual(f.store.list("superOperations"),operations);assert.equal(f.store.list<any>("superAttempts").at(-1).state,"succeeded");
 assert.equal(f.store.list("superAcceptance").length,0);assert.equal(f.store.list("superPendingReports").length,1);
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

test("a completed stage can submit its report while historical acceptance and execution rows stay unchanged", async t => {
 const {store,ledger}=await acceptedHostStep(t);
 store.put("superAcceptance","historical",{id:"historical",goalId:"old",state:"pass"});
 const attempts=store.list("superAttempts"),operations=store.list("superOperations"),old=store.list("superAcceptance");
 const result=ledger.finishHost("goal",{summary:"已核对真实启动时间。",outcome:"completed"},1,"policy");
 assert.equal(result.status,"completed");assert.equal(result.acceptanceState,"not_evaluated");
 assert.deepEqual(store.list("superAttempts"),attempts);assert.deepEqual(store.list("superOperations"),operations);
 assert.deepEqual(store.list("superAcceptance"),old);assert.equal(store.list("superPendingReports").length,1);
 assert.throws(()=>ledger.finishHost("goal",{summary:"再次完成。",outcome:"completed"},1,"policy"),/closed/);
});

test("report submission rejects stale execution bindings and never certifies modified observations",async t=>{
 const {store,ledger}=await acceptedHostStep(t);
 const finish=(generation=1,policy="policy")=>ledger.finishHost("goal",{summary:"已结束本轮。",outcome:"completed"},generation,policy);
 assert.throws(()=>finish(2),/binding changed/);assert.throws(()=>finish(1,"new-policy"),/binding changed/);
 const op=store.list<Operation>("superOperations")[0];op.output={changed:true};store.put("superOperations",op.id,op);
 assert.equal(finish().status,"completed");assert.deepEqual(store.require("superOperations",op.id),op);
 assert.equal(store.list("superAcceptance").length,0);
});

test("changed resources still reject new I/O without blocking an honest historical report",async t=>{
 let revoked=false,calls=0;const f=await fixture(t,()=>{if(revoked)throw Error("resource revision changed");});f.create();
 await f.invoke("original");revoked=true;
 await assert.rejects(f.invoke("new-read","inspect_host",1,async()=>{calls++;return {}; }),/resource revision changed/);
 assert.equal(calls,0);
 const before=f.store.list("superOperations");
 assert.equal(f.ledger.finishHost("goal",{summary:"先前已取得负载；连接配置随后变化。",outcome:"partial"},1,"policy").status,"completed");
 assert.deepEqual(f.store.list("superOperations"),before);assert.equal(f.store.list("superAcceptance").length,0);
});

test("discovery-only, failed and no-I/O reports can end without being certified successful",async t=>{
 const f=await fixture(t);f.create();await f.invoke("catalog","list_mcp_tools");
 await f.invoke("failed-host","inspect_host",1,async()=>({success:false,error:"authentication failed"}));
 const result=f.ledger.finishHost("goal",{summary:"SSH 认证失败，暂时没有运行数据。",outcome:"partial"},1,"policy");
 assert.equal(result.status,"completed");assert.equal(result.reportedOutcome,"partial");
 assert.equal(f.store.list("superAcceptance").length,0);
 f.create({id:"explanation",sessionId:"explanation-session"});
 assert.equal(f.ledger.finishHost("explanation",{summary:"这轮只整理了已有信息。",outcome:"completed"},1,"policy").status,"completed");
 assert.equal(f.store.list("superOperations").length,2);
});

test("completed and partial reports end with unknown results without another inspection or acceptance",async t=>{
 for(const outcome of ["completed","partial"] as const){
  const f=await fixture(t);f.create();let calls=0;
  await assert.rejects(f.invoke("lost","Bash",1,async()=>{calls++;throw Error("connection lost");},{readOnly:false}),/connection lost/);
  await f.invoke("read","inspect_host",1,async()=>{calls++;return {load:0.4};});
  const operations=f.store.list("superOperations"),attempts=f.store.list("superAttempts");
  const goal=f.ledger.finishHost("goal",{summary:"当前负载 0.4，原命令结果不确定。",outcome},1,"policy");
  assert.equal(goal.status,"completed");assert.equal(goal.reportedOutcome,outcome);assert.equal(calls,2);
  assert.deepEqual(f.store.list("superOperations"),operations);assert.deepEqual(f.store.list("superAttempts").slice(0,-1),attempts.slice(0,-1));
  assert.equal(f.store.list("superAcceptance").length,0);assert.equal(f.store.list("superPendingReports").length,1);
 }
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
  assert.equal(store.list("superAcceptance").length,0);
});

test("a new invocation retains original observations and can report without fresh business I/O",async t=>{
 const f=await fixture(t);f.create();await f.invoke("old-host");const old=f.store.list<Operation>("superOperations")[0];
 assert.throws(()=>f.ledger.finishHost("goal",{summary:"结束",outcome:"completed"},2,"policy"),/binding changed/);
 await f.invoke("new-catalog","list_mcp_tools",2);
 assert.equal(f.ledger.finishHost("goal",{summary:"这轮取得目录；主机信息来自上一轮。",outcome:"partial"},2,"policy").status,"completed");
 assert.deepEqual(f.store.require("superOperations",old.id),old);assert.equal(f.store.list("superAcceptance").length,0);
});

test("unknown original calls never replay while new authorized writes and reads remain usable",async t=>{
 const f=await fixture(t);f.create();let writes=0;
 await assert.rejects(f.invoke("lost","Write",1,async()=>{writes++;throw Error("lost response");},{readOnly:false}),/lost response/);
 const old=f.store.list<Operation>("superOperations")[0],attempt=f.store.require("superAttempts",old.attemptId);
 await assert.rejects(f.invoke("lost","Write",1,async()=>{writes++;return {};},{readOnly:false}),/cannot be replayed/);
 await f.invoke("new-write","Write",1,async()=>{writes++;return {};},{readOnly:false});await f.invoke("new-read","inspect_host",2);
 assert.deepEqual(f.store.require("superOperations",old.id),old);assert.deepEqual(f.store.require("superAttempts",old.attemptId),attempt);assert.equal(writes,2);
 assert.equal(f.ledger.finishHost("goal",{summary:"取得了新结果；早先写入影响不确定。",outcome:"partial"},2,"policy").status,"completed");
 assert.equal(f.store.list("superAcceptance").length,0);
});

test("legacy unknown operations no longer gate new authorized calls and remain unchanged",async t=>{
 const f=await fixture(t);f.create();const legacy={id:"legacy",projectId:"project",status:"unknown"};f.store.put("legacyOperations","legacy",legacy);
 await f.invoke("read");let writes=0;await f.invoke("write","Write",1,async()=>({writes:++writes}),{readOnly:false});
 assert.equal(writes,1);assert.deepEqual(f.store.require("legacyOperations","legacy"),legacy);
 assert.equal(f.ledger.finishHost("goal",{summary:"本轮结果已提交。",outcome:"completed"},1,"policy").status,"completed");
});

test("new command, file and MCP calls proceed after unknown results while exact original IDs remain fenced",async t=>{
 const f=await fixture(t);f.create();let calls=0;
 const run=(call:string,tool="Bash",binding:Record<string,unknown>={})=>f.ledger.operation("goal",1,"policy",call,tool,{command:"same requested work"},async()=>{calls++;if(call==="lost")throw Error("lost response");return {exitCode:0};},v=>v,{readOnly:false,...binding});
 await assert.rejects(run("lost"),/lost response/);const old=f.store.list<Operation>("superOperations")[0],attempt=f.store.require("superAttempts",old.attemptId);
 await run("new-command");await run("same-command-new-call");await run("file","Write");await run("mcp","call_mcp_tool",{mcpServerId:"same"});
 await assert.rejects(run("lost"),/cannot be replayed/);assert.equal(calls,5);
 assert.deepEqual(f.store.require("superOperations",old.id),old);assert.deepEqual(f.store.require("superAttempts",old.attemptId),attempt);
 assert.equal(f.ledger.finishHost("goal",{summary:"本轮调用已结束，旧结果仍保留。",outcome:"completed"},1,"policy").status,"completed");
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

test("Plan confirmation and explicit step ownership remain separate from report submission", async (t) => {
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

test("current I/O permissions and report ownership still reject stale policies before side effects",async t=>{
 let denied=false,calls=0;const f=await fixture(t,()=>{if(denied)throw Error("current policy denied");});f.create();denied=true;
 await assert.rejects(f.invoke("denied","inspect_host",1,async()=>{calls++;return {}; }),/policy denied/);assert.equal(calls,0);
 denied=false;await f.invoke("allowed");
 const owner={taskId:"goal",sessionId:"session",projectId:"project",state:"active",generation:1,policyHash:"changed-policy",leaseUntil:Date.now()+60000};
 f.store.put("superWorkers","worker",owner);
 assert.throws(()=>f.ledger.finishHost("goal",{summary:"结束",outcome:"completed"},1,"policy"),/binding changed/);
 assert.equal(storeDeliveries(f.ledger),0);
 f.store.put("superWorkers","worker",{...owner,policyHash:"policy"});
 assert.equal(f.ledger.finishHost("goal",{summary:"已取得本轮数据",outcome:"completed"},1,"policy").status,"completed");
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

test("report metadata remains bound to each invocation without creating a pass verdict",async t=>{
 const f=await fixture(t);f.create();f.ledger.finishHost("goal",{summary:"暂时没有运行数据。",outcome:"partial"},1,"policy");
 const old=f.store.require("superDeliveries",digest(["goal",1]));const goal=f.ledger.get("goal");goal.status="running";f.ledger.save(goal);
 await f.invoke("catalog","list_mcp_tools",2);
 f.ledger.finishHost("goal",{summary:"第二轮取得目录。",outcome:"partial"},2,"policy");
 assert.deepEqual(f.store.require("superDeliveries",digest(["goal",1])),old);
 assert.equal(f.store.require<any>("superDeliveries",digest(["goal",2])).outcome,"partial");assert.equal(f.store.list("superAcceptance").length,0);
});

test("shared reports aggregate once after both members submit and survive reopening without acceptance",async t=>{
 const f=await fixture(t);const a=f.create(),b=f.create({id:"b",sessionId:"b-session",workerId:"b-worker",roleId:"b-role",mode:"plan"});f.ledger.joinTask(a.id,[b.id]);
 await f.invoke("same-call-id");const original=f.store.list<Operation>("superOperations")[0];
 const first=f.ledger.finishHost(a.id,{summary:"甲的实际报告",outcome:"partial"},1,"policy");assert.equal(f.ledger.jointState(a.id)?.completed,1);
 const reopenedStore=await LakeStore.open(f.store.home,f.store.data);
 try{
  const reopened=new TaskLedger(reopenedStore);const plan=reopened.begin(b.id,{title:"乙的检查",items:[{id:"query",title:"检查数据库"}]});
  assert.throws(()=>reopened.finish(b.id,"尚未确认计划","policy",1),/active/);
  reopened.confirm(b.id,plan.revision,true);reopened.start(b.id,"query",1,"policy");
  await reopened.operation(b.id,1,"policy","same-call-id","read_db_table",{},async()=>({rows:1}),v=>v,{readOnly:true});
  assert.throws(()=>reopened.update(b.id,{item_id:"query",status:"completed",evidence_ids:[original.id]},1,"policy"),/exact attempt/);
  reopened.update(b.id,{item_id:"query",status:"completed",evidence_ids:["same-call-id"]},1,"policy");reopened.finish(b.id,"乙的实际报告","policy",1);
  assert.throws(()=>reopened.finish(b.id,"再次提交","policy",1),/closed/);
  assert.equal(f.ledger.jointState(a.id)?.status,"completed");assert.equal(f.ledger.jointState(a.id)?.completed,2);
  const report=f.store.require<any>("superPendingJointReports",a.id);assert.equal(report.reportId,f.ledger.jointTask(a.id)?.reportId);
  assert.ok(first.completionReportId);assert.equal(f.store.list("superAcceptance").length,0);assert.equal(f.ledger.jointState(a.id)?.acceptanceState,"not_evaluated");
 }finally{reopenedStore.db.close();}
});

test("shared aggregation does not reverify earlier observations or manufacture an acceptance receipt",async t=>{
 let revoked=false;const f=await fixture(t,op=>{if(revoked&&op.goalId==="goal")throw Error("first connection changed");});
 const a=f.create(),b=f.create({id:"b",sessionId:"b-session",roleId:"b-role",workerId:"b-worker"});f.ledger.joinTask(a.id,[b.id]);
 await f.invoke("a");await f.invoke("b","inspect_host",1,undefined,{readOnly:true},b.id);
 f.ledger.finishHost(a.id,{summary:"A 的先前观测",outcome:"completed"},1,"policy");
 const original=f.store.list("superOperations");revoked=true;
 f.ledger.finishHost(b.id,{summary:"B 的部分结果",outcome:"partial"},1,"policy");
 assert.equal(f.ledger.jointState(a.id)?.status,"completed");assert.deepEqual(f.store.list("superOperations"),original);
 assert.equal(f.store.list("superAcceptance").length,0);assert.equal(f.store.list("superPendingJointReports").length,1);
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
  assert.equal(ledger.jointState(a.id)?.acceptanceState, 'not_evaluated');
  assert.equal(store.list<any>('superAcceptance').some(receipt => receipt.scope === 'goal'), false);
});

test("independent calls retain their own IDs without an implicit cross-member mutation deduplication lock",async t=>{
 const f=await fixture(t);const a=f.create(),b=f.create({id:"b",sessionId:"b-session",roleId:"b-role",workerId:"b-worker"});f.ledger.joinTask(a.id,[b.id]);let writes=0;
 const write=(goal:string,call:string)=>f.ledger.operation(goal,1,"policy",call,"Write",{file:"one"},async()=>({writes:++writes}),v=>v,{readOnly:false,resourceId:"host"});
 const first=await write(a.id,"a");await write(b.id,"b");assert.deepEqual(await write(a.id,"a"),first);assert.equal(writes,2);
 await assert.rejects(f.ledger.operation(a.id,1,"policy","a","Write",{file:"different"},async()=>({writes:++writes}),v=>v,{readOnly:false}),/identity reused/);assert.equal(writes,2);
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
