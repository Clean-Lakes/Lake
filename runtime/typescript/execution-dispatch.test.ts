import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LakeExecution } from "./execution";
import { LakeSecurity } from "./security";
import { LakeStore } from "./store";
import { TaskLedger, digest, type Operation } from "./tasks";

// Actual host/SQLite accounting, controlled transport failure points; no model,
// real credentials, external target or existing Home is used.
async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "lake-ssh-dispatch-")), data = join(home, "data");
  const store = await LakeStore.open(home, data), project = store.createProject("dispatch test"), session = store.createSession(project.id);
  const resource = store.put<any>("resources", "host", {id:"host", projectId:project.id, name:"SSH fixture", kind:"ssh", status:"available"});
  let mode = "connect-failure", execCalls = 0;
  const ssh = { revision: () => "configuration", connect: async () => {
    if (mode === "connect-failure") throw new Error("SSH 网络连接超时");
    const connection = new EventEmitter() as any;
    connection.end = () => {};
    connection.exec = (_command: string, callback: (error: unknown, stream?: any) => void) => {
      execCalls++;
      const saved = store.list<any>("commandExecutions").find(record => record.status === "running");
      assert.equal(saved.sshDispatchPhase, "exec_requested", "phase is durable before entering transport code");
      if (mode === "exec-throw") throw new Error("transport lost during exec");
      if (mode === "request-loss") { queueMicrotask(() => connection.emit("close")); return; }
      const stream = new EventEmitter() as any; stream.stderr = new EventEmitter(); stream.close = () => {};
      callback(undefined, stream);
      queueMicrotask(() => {
        if (mode === "channel-loss") { stream.emit("error", new Error("channel lost")); return; }
        stream.emit("data", Buffer.from("ACTUAL_QUERY_RESULT")); stream.emit("exit", 0); stream.emit("close");
      });
    };
    return connection;
  }};
  const execution = new LakeExecution(store, new LakeSecurity(store), ssh as never, value => value);
  t.after(async () => { await execution.close(); store.close(); await rm(home, {recursive:true, force:true}); });
  const actor = {taskId:"goal", workerId:"worker", sessionId:session.id, generation:1, guard:() => {}};
  const ledger = new TaskLedger(store);
  ledger.create({id:actor.taskId, projectId:project.id, sessionId:session.id, workerId:actor.workerId, roleId:"role", sourceEventId:"event",
    originRootTurnId:"root", title:"检查日志", userText:"检查日志", status:"running", mode:"default", executionMode:"host_managed",
    deadlineAt:new Date(Date.now()+60000).toISOString()});
  const run = async (callId: string, command = "kubectl config current-context", background = false, signal?: AbortSignal) => {
    const plan = execution.plan(project.id, {asset_ref:resource.id, configuration_revision:"configuration", command});
    const executionId = execution.executionId(actor, callId), port = execution.bind({} as never, actor, plan, callId);
    return ledger.operation(actor.taskId, actor.generation, "policy", callId, "Bash", {command}, async () => {
      const request = {command:{} as never, timeoutMs:1000};
      if (!background) return JSON.parse(JSON.stringify(await port.run(request, {signal})));
      const result = await (port as any).runBashWithBackgroundLifecycle(request, {mode:"explicit"}, {signal});
      return result.kind === "backgrounded" ? {status:"backgrounded"} : result.result;
    }, value => value, {resourceId:resource.id, resourceRevision:plan.resourceRevision, hostConfigurationHash:plan.revision, commandExecutionId:executionId, readOnly:plan.readOnly});
  };
  const op = (callId: string) => store.require<Operation>("superOperations", digest([session.id,callId]));
  return {home, data, store, execution, ledger, actor, run, op, setMode:(value:string) => {mode=value;}, execCalls:() => execCalls};
}

test("a proven connection failure remains failed and permits a fresh call, never replay of the original ID", async t => {
  const f = await fixture(t); await f.run("failed-connect");
  const original = f.op("failed-connect"), originalRun = f.store.require<any>("commandExecutions", original.commandExecutionId!);
  assert.equal(original.status, "failed"); assert.equal(original.readOnly, false);
  assert.equal(originalRun.sshDispatchPhase, "not_sent"); assert.equal(f.execCalls(), 0); assert.equal(f.ledger.unresolved("goal"), false);
  f.setMode("success");
  await assert.rejects(f.run("failed-connect"), /cannot be replayed/);
  await f.run("fresh-connect");
  assert.equal(f.op("fresh-connect").status, "succeeded"); assert.equal(f.execCalls(), 1);
  assert.equal(f.store.require<any>("superAttempts", original.attemptId).state, "failed");
  assert.deepEqual(f.op("failed-connect"), original); assert.deepEqual(f.store.require("commandExecutions", originalRun.id), originalRun);
  assert.equal(f.ledger.finishHost("goal", {summary:"已取得新的查询结果。", outcome:"completed"}, 1, "policy").acceptanceState, "pass");
});

test("an explicit plan can retry a proven unsent step without changing its acceptance contract", async t => {
  const f = await fixture(t), goal = f.ledger.get("goal"); goal.executionMode = "explicit_plan"; f.ledger.save(goal);
  f.ledger.begin("goal", {title:"原始排查", items:[{id:"logs",title:"读取实际日志"}]});
  f.ledger.start("goal","logs",1,"policy");
  const plan = structuredClone(f.ledger.get("goal")); await f.run("explicit-connect-failed");
  f.ledger.start("goal","logs",1,"policy"); f.setMode("success"); await f.run("explicit-connect-retry");
  f.ledger.update("goal", {item_id:"logs",status:"completed",evidence_ids:["explicit-connect-retry"]},1,"policy");
  const finished = f.ledger.finish("goal","已取得实际日志。","policy");
  assert.equal(finished.acceptanceState,"pass"); assert.equal(finished.executionMode,"explicit_plan");
  assert.equal(finished.planHash,plan.planHash); assert.equal(finished.planRevision,plan.planRevision);
  assert.equal(f.op("explicit-connect-failed").status,"failed"); assert.equal(f.execCalls(),1);
});

for (const mode of ["exec-throw", "request-loss", "channel-loss"]) test(`uncertainty after ${mode} retains the original unknown while new commands and journal queries continue`, async t => {
  const f = await fixture(t); f.setMode(mode); await f.run("uncertain");
  const original = f.op("uncertain"), before = structuredClone(original), record = f.store.require<any>("commandExecutions", original.commandExecutionId!);
  assert.equal(original.status, "unknown"); assert.equal(f.ledger.unresolved("goal"), true);
  assert.equal(record.sshDispatchPhase, mode === "channel-loss" ? "channel_open" : "exec_requested");
  const count = f.execCalls(); f.setMode("success");
  await assert.rejects(f.run("uncertain"), /cannot be replayed/); assert.equal(f.execCalls(), count);
  await f.run("retry-write"); assert.equal(f.execCalls(), count+1); assert.equal(f.op("retry-write").status,"succeeded");
  await f.run("independent-read", "journalctl -b -1 -n 100 --no-pager -o short-iso");
  assert.equal(f.op("independent-read").readOnly, true); assert.equal(f.op("independent-read").status, "succeeded");
  assert.deepEqual(f.op("uncertain"), before);
  assert.throws(() => f.ledger.finishHost("goal", {summary:"完成。", outcome:"completed"}, 1, "policy"), /evidence/);
  assert.equal(f.ledger.finishHost("goal", {summary:"已取得日志；原命令结果仍待核实。", outcome:"partial"}, 1, "policy").status, "blocked");
  // Reopen exactly the original ledger; the phase and unknown do not disappear.
  const reopened = await LakeStore.open(f.home, f.data);
  try { assert.equal(new TaskLedger(reopened).unresolved("goal"), true); assert.deepEqual(reopened.require("commandExecutions",record.id),record); }
  finally { reopened.close(); }
});

test("background settlement uses host not-sent proof even when the worker lease has ended", async t => {
  const f = await fixture(t); await f.run("background-connect", undefined, true);
  const original = f.op("background-connect");
  const record = await f.execution.whenSettled(original.commandExecutionId!);
  f.ledger.settleCommand(original.id, record.id, record.result, false);
  assert.equal(f.op("background-connect").status, "failed"); assert.equal(f.ledger.unresolved("goal"), false);
  assert.equal(f.execCalls(), 0);
});

test("cancellation before exec has no remote effect and retains the actual cancellation result", async t => {
  const f = await fixture(t); f.setMode("success");
  const controller = new AbortController(); controller.abort();
  await f.run("cancelled-before-send", undefined, false, controller.signal);
  const operation = f.op("cancelled-before-send"), record = f.store.require<any>("commandExecutions", operation.commandExecutionId!);
  assert.equal(operation.status, "failed"); assert.equal(record.status, "cancelled"); assert.equal(record.sshDispatchPhase, "not_sent");
  assert.equal(f.execCalls(), 0);
});

test("missing or unrelated host evidence and model-provided phase labels never prove not-sent", async t => {
  for (const [i, change] of [{sshDispatchPhase:undefined}, {sessionId:"foreign"}, {configurationRevision:"foreign"}, {resourceId:"foreign"}].entries()) {
    // Each case has an independent Home so an earlier unknown cannot mask the assertion.
    const f = await fixture(t);
    const g = "bad-proof-"+i, session = f.actor.sessionId, callId = "call-"+i;
    f.ledger.create({...f.ledger.get("goal"), id:g, workerId:"worker-"+i});
    const commandId = digest([g,1,callId]);
    const output = {status:"spawn_error", sshDispatchPhase:"not_sent", stdout:{text:""}};
    f.store.put("commandExecutions",commandId,{id:commandId,taskId:g,workerId:"worker-"+i,sessionId:session,generation:1,resourceId:"host",resourceRevision:1,configurationRevision:"configuration",
      sshDispatchPhase:"not_sent",status:"spawn_error",result:output,...change});
    await f.ledger.operation(g,1,"policy",callId,"Bash",{},async()=>output,value=>value,
      {resourceId:"host",resourceRevision:1,hostConfigurationHash:"configuration",commandExecutionId:commandId,readOnly:false});
    assert.equal(f.ledger.unresolved(g),true);
  }
});
