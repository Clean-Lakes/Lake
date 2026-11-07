import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LakeStore } from "./store";
import { LakeSuperagent } from "./superagent";

// Exercise the actual host and SQLite ledger with a controlled SDK boundary.
// No model, credential, remote server or existing Dev data is accessed.
async function fixture(t: { after(fn: () => Promise<void>): void }, clock = Date.now) {
  const home = await mkdtemp(join(tmpdir(), "lake-dispatch-lifecycle-"));
  const store = await LakeStore.open(home, join(home, "data"));
  const requests: { sessionId: string; input: any }[] = [];
  let steering = 0;
  const agents = { redact: (value: string) => value, publish() {}, prepareRedaction: async () => {}, isRunning: () => false,
    send: async (sessionId: string, _text: string, options: any) => { requests.push({ sessionId, input: JSON.parse(options.input) }); },
    steer: async () => { steering++; return true; }, abort: async () => {} };
  const host = new LakeSuperagent(store, agents as any, undefined, undefined, undefined, undefined, undefined, clock), internal = host as any;
  internal.schedule = () => {};
  t.after(async () => { await host.close(); store.db.close(); await rm(home, { recursive: true, force: true }); });
  const project = store.createProject("isolated lifecycle"), router = host.ensure(project.id).routerSessionId;
  const role = { id: "role-checker", projectId: project.id, roleKey: "checker", name: "项目检查员", duties: "检查当前项目", revision: 1 };
  store.put("superRoles", role.id, role);
  const admit = async (value: string) => {
    const message = await host.send(router, value) as { id: string };
    const event = store.list<any>("superInputs").find((item) => item.messageId === message.id)!;
    internal.batches.set(router, { eventIds: [event.id], complete: new Set([event.id]), input: JSON.stringify({ event: event.id }) });
    return event;
  };
  const route = (event: any, input: Record<string, unknown>) => internal.route(router, { event_id: event.id, part_key: "work", quote: event.payload,
    reason: "current human instruction", ...input });
  const settleRouter = (error?: string) => {
    const view = store.view(router); view.status = error ? "failed" : "completed"; store.put("views", router, view);
    internal.routerFinished(router, error);
  };
  const activate = async () => { await internal.pump(); };
  const worker = (taskId?: string) => store.list<any>("superWorkers").find((item) => !taskId || item.taskId === taskId)!;
  const read = async (taskId?: string, callId?: string) => {
    const current = worker(taskId), profile = host.profile(current.sessionId)!;
    const entry = profile.tools.find((item) => item.metadata.name === "list_project_files")!;
    return profile.invoke!(entry, {}, { toolCallId: callId ?? `files-${current.generation}`, abortSignal: new AbortController().signal } as any);
  };
  const finish = async (taskId?: string) => {
    const current = worker(taskId), entry = host.profile(current.sessionId)!.tools.find((item) => item.metadata.name === "work_finish")!;
    return entry.handler({ outcome: "completed", summary: "已读取本次项目文件列表。" }, { abortSignal: new AbortController().signal } as any) as Promise<any>;
  };
  const settleWorker = (taskId?: string) => {
    const current = worker(taskId), view = store.view(current.sessionId); view.status = "completed"; store.put("views", current.sessionId, view);
    internal.workerFinished(current.sessionId);
  };
  const start = async () => {
    const event = await admit("检查本项目的当前文件列表。");
    const handoff = route(event, { action: "create", title: "检查当前项目文件", role_id: role.id });
    settleRouter(); await activate(); await read(handoff.taskId);
    return { event, handoff, taskId: handoff.taskId };
  };
  return { store, host, internal, agents, project, router, role, requests, admit, route, settleRouter, activate, worker, read, finish, settleWorker, start,
    steering: () => steering };
}

test("completed fresh checks preserve old acceptance, carry target context and use new current receipts", async (t) => {
  const f = await fixture(t), original = await f.start();
  assert.equal(original.handoff.handoff.recorded, true);
  assert.equal(original.handoff.dispatch.state, "queued");
  assert.equal(original.handoff.handoff.observedAt, original.handoff.dispatch.observedAt);
  await f.finish(); f.settleWorker();
  const source = f.host.ledger.get(original.taskId), oldReceipts = f.store.list("superAcceptance"), oldOperations = f.store.list("superOperations");
  const event = await f.admit("再试试");
  assert.throws(() => f.route(event, { action: "followup", task_id: source.id }), (error: any) => {
    const detail = JSON.parse(error.message.slice(error.message.indexOf("{")));
    assert.equal(detail.code, "task_closed"); assert.equal(detail.taskRef.id, source.id);
    assert.equal(detail.role_id, f.role.id); assert.equal(detail.recovery.predecessor_task_id, source.id); return true;
  });
  const input = { action: "create", title: "重新检查当前项目文件", role_id: f.role.id, predecessor_task_id: source.id };
  const next = f.route(event, input), duplicate = f.route(event, input);
  assert.equal(next.taskId, duplicate.taskId); assert.notEqual(next.taskId, source.id);
  assert.equal(f.store.list("superGoals").length, 2); assert.equal(f.store.list("superReferences").length, 0);
  assert.deepEqual(f.host.ledger.get(source.id), source); assert.deepEqual(f.store.list("superAcceptance"), oldReceipts);
  assert.deepEqual(f.store.list("superOperations"), oldOperations);
  f.settleRouter(); await f.activate();
  const assignment = f.requests.at(-1)!.input;
  assert.equal(assignment.originalRequirement, "再试试"); assert.equal(assignment.predecessor.originalDeliverable, original.event.payload);
  assert.equal(assignment.predecessor.historicalContextOnly, true); assert.equal(assignment.predecessor.taskRef.id, source.id);
  assert.equal(f.host.ledger.get(next.taskId).modelRounds, 0); assert.equal(f.host.ledger.get(next.taskId).acceptanceState, "not_evaluated");
  await assert.rejects(f.finish(next.taskId), /confirmed|binding|work_begin|active/i);
  await f.read(next.taskId); await f.finish(next.taskId); f.settleWorker(next.taskId);
  assert.equal(f.host.ledger.get(next.taskId).acceptanceState, "pass");
  assert.deepEqual(f.host.ledger.get(source.id), source);
  assert.equal(f.store.list<any>("superOperations").filter((operation) => operation.goalId === next.taskId).length, 1);
});

test("predecessor is context, cannot reuse an old event, cross scope, waive current policy or reset unfinished limits", async (t) => {
  const f = await fixture(t), initial = await f.start(), source = f.host.ledger.get(initial.taskId);
  let event = await f.admit("再检查一次");
  assert.throws(() => f.route(event, { action: "create", title: "检查", role_id: f.role.id, predecessor_task_id: source.id }), /accepted completed/);
  f.settleRouter(); await f.finish(); f.settleWorker();
  f.internal.batches.set(f.router, { eventIds: [initial.event.id], complete: new Set([initial.event.id]), input: "old input" });
  assert.throws(() => f.route(initial.event, { action: "create", title: "检查", role_id: f.role.id, predecessor_task_id: source.id }), /disposition/);
  event = await f.admit("重新检查");
  const other = { ...f.role, id: "other-role", roleKey: "other" }; f.store.put("superRoles", other.id, other);
  assert.throws(() => f.route(event, { action: "create", title: "检查", role_id: other.id, predecessor_task_id: source.id }), /project and specialist/);
  const foreign = f.store.createProject("foreign");
  f.store.put("superGoals", "foreign-goal", { ...f.host.ledger.get(source.id), id: "foreign-goal", projectId: foreign.id });
  assert.throws(() => f.route(event, { action: "create", title: "检查", role_id: f.role.id, predecessor_task_id: "foreign-goal" }), /project and specialist/);
  const options = f.store.session(f.router); options.options.denyLocalExecution = true; f.store.put("sessions", f.router, options);
  const next = f.route(event, { action: "create", title: "重新检查", role_id: f.role.id, predecessor_task_id: source.id });
  f.settleRouter(); await f.activate();
  await assert.rejects(f.read(next.taskId), /denies local resource access/);
  assert.equal(f.store.list<any>("superOperations").filter((operation) => operation.goalId === next.taskId).length, 0);
});

for (const routerFirst of [false, true]) test(`accepted followup crosses completion exactly once (router settles first: ${routerFirst})`, async (t) => {
  const f = await fixture(t), initial = await f.start(), before = f.host.ledger.get(initial.taskId);
  const event = await f.admit("再查一下当前文件"); f.route(event, { action: "followup", task_id: initial.taskId });
  if (routerFirst) f.settleRouter();
  assert.equal((await f.finish()).completionDeferred, true);
  assert.equal(f.store.list("superAcceptance").length, 0);
  f.settleWorker();
  if (!routerFirst) { assert.equal(f.worker().state, "parked"); f.settleRouter(); }
  assert.equal(f.worker().state, "queued"); assert.equal(f.steering(), 0);
  await f.activate();
  assert.deepEqual(f.worker().invocationInputIds, [event.id]); assert.equal(f.worker().generation, 2);
  assert.deepEqual(f.requests.at(-1)!.input.followups, [{ id: event.id, text: event.payload }]);
  await f.read(); await f.finish(); f.settleWorker();
  const goal = f.host.ledger.get(initial.taskId);
  assert.equal(goal.status, "completed"); assert.equal(goal.deadlineAt, before.deadlineAt); assert.equal(goal.roundLimit, before.roundLimit);
  assert.equal(f.store.list("superGoals").length, 1);
  assert.deepEqual(f.worker().settledInputIds, [initial.event.id, event.id]);
  assert.equal(f.store.messages(f.router).filter((message) => message.author?.taskId === goal.id).length, 1);
});

for (const routerFirst of [false, true]) test(`failed deferred routing is visible and a new followup skips the failed input (router settles first: ${routerFirst})`, async (t) => {
  const f = await fixture(t), initial = await f.start();
  const failed = await f.admit("第一次补充"); f.route(failed, { action: "followup", task_id: initial.taskId });
  assert.equal((await f.finish()).completionDeferred, true);
  if (routerFirst) f.settleRouter("synthetic routing failure");
  f.settleWorker(); if (!routerFirst) f.settleRouter("synthetic routing failure");
  assert.equal(f.worker().state, "parked"); assert.equal(f.host.ledger.get(initial.taskId).status, "paused");
  assert.ok(f.store.messages(f.router).some((message) => message.text.includes("消息没有处理成功")));
  const retry = await f.admit("新的补充请求"); f.route(retry, { action: "followup", task_id: initial.taskId });
  f.settleRouter(); await f.activate();
  assert.deepEqual(f.worker().invocationInputIds, [retry.id]);
  assert.ok(!JSON.stringify(f.requests.at(-1)!.input.followups).includes(failed.id));
  assert.equal(f.store.require<any>("superInputs", failed.id).disposition, "blocked");
});

test("a parked followup whose Router fails never starts an empty invocation or hides later valid queued activity", async (t) => {
  const f = await fixture(t), initial = await f.start();
  f.settleWorker(); assert.equal(f.worker().state, "parked");
  const failed = await f.admit("重新检查一次"); f.route(failed, { action: "followup", task_id: initial.taskId });
  assert.equal(f.worker().state, "queued");
  f.settleRouter("synthetic routing failure"); await f.activate();
  assert.equal(f.worker().state, "parked"); assert.equal(f.requests.length, 1);
  assert.equal(f.host.ledger.get(initial.taskId).status, "paused");
  assert.ok(f.store.messages(f.router).some((message) => message.text.includes("消息没有处理成功")));
  const retry = await f.admit("这次再检查"); f.route(retry, { action: "followup", task_id: initial.taskId }); f.settleRouter();
  const queued = f.host.workers(f.project.id).find((worker) => worker.task.taskId === initial.taskId)!;
  assert.equal(queued.activity?.phase, "queued"); assert.equal(queued.activity?.sourceMessageId, retry.messageId);
  await f.activate(); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.worker().invocationInputIds, [retry.id]);
  assert.deepEqual(f.requests.at(-1)!.input.followups, [{ id: retry.id, text: retry.payload }]);
  assert.equal(f.store.require<any>("superInputs", failed.id).disposition, "blocked");
});

test("stop wins a deferred finish and cannot be requeued by late Router completion", async (t) => {
  const f = await fixture(t), initial = await f.start();
  const event = await f.admit("继续检查"); f.route(event, { action: "followup", task_id: initial.taskId });
  await f.finish(); await f.host.stopTask(initial.taskId); f.settleWorker(); f.settleRouter(); await f.activate();
  assert.equal(f.worker().state, "stopped"); assert.equal(f.host.ledger.get(initial.taskId).status, "cancelled");
  assert.equal(f.requests.length, 1); assert.equal(f.store.list("superAcceptance").length, 0);
});

for(const readOnly of [true,false])test(`stop waits for ${readOnly?'read':'opaque write'} settlement before reporting and preserves a concurrent sibling`,async t=>{
 const f=await fixture(t),a=await f.start();
 const event=await f.admit('独立任务 B');const b=f.route(event,{action:'create',title:'独立任务 B',role_id:f.role.id});f.settleRouter();await f.activate();await f.read(b.taskId);
 let release!:()=>void,aborted!:()=>void,started!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),abortGate=new Promise<void>(resolve=>{aborted=resolve;}),startGate=new Promise<void>(resolve=>{started=resolve;});
 const worker=f.worker(a.taskId);
 const business=f.internal.serializeBusiness(worker.id,()=>f.host.ledger.operation(a.taskId,worker.generation,worker.policyHash,'in-flight','Bash',{},async()=>{
  started();await gate;if(!readOnly)throw new Error('opaque process interrupted');return {status:'cancelled',cancelled:true,exitCode:137};
 },(v:any)=>v,{readOnly}));
 const settled=business.catch(()=>{});await startGate;
 (f.agents as any).abort=async(session:string)=>{assert.equal(session,worker.sessionId);f.settleWorker(a.taskId);aborted();};
 const sibling=JSON.stringify(f.worker(b.taskId)),stopping=f.host.stopTask(a.taskId),duplicate=f.host.stopTask(a.taskId);await abortGate;
 assert.equal(f.store.messages(f.router).filter(m=>m.author?.taskId===a.taskId).length,0,'no provisional report while a receipt is in flight');
 assert.equal(f.worker(a.taskId).generation,worker.generation+1,'duplicate stop is coalesced');
 assert.equal(JSON.stringify(f.worker(b.taskId)),sibling);
 release();await settled;await Promise.all([stopping,duplicate]);
 const report=f.store.messages(f.router).filter(m=>m.author?.taskId===a.taskId);
 assert.equal(report.length,1);assert.equal(report[0]!.text,readOnly?'已停止这次工作。':'有一项操作的结果还需核实，暂时不能重复该操作。');
 assert.equal(f.host.ledger.get(a.taskId).status,readOnly?'cancelled':'blocked');
 const op=f.store.list<any>('superOperations').find(o=>o.callId==='in-flight');assert.equal(op.status,readOnly?'failed':'unknown');
 f.settleWorker(a.taskId);assert.equal(f.store.messages(f.router).filter(m=>m.author?.taskId===a.taskId).length,1,'late completion cannot add another stop report');
 await f.finish(b.taskId);f.settleWorker(b.taskId);assert.equal(f.host.ledger.get(b.taskId).acceptanceState,'pass');
});

test('stopping the remaining reply after business acceptance preserves the accepted goal and receipts',async t=>{
 const f=await fixture(t),work=await f.start();await f.finish(work.taskId);
 const goal=JSON.stringify(f.host.ledger.get(work.taskId)),receipts=JSON.stringify(f.store.list('superAcceptance'));
 (f.agents as any).abort=async()=>f.settleWorker(work.taskId);
 await f.host.stopTask(work.taskId);
 assert.equal(JSON.stringify(f.host.ledger.get(work.taskId)),goal);assert.equal(JSON.stringify(f.store.list('superAcceptance')),receipts);
 const reports=f.store.messages(f.router).filter(message=>message.author?.taskId===work.taskId);
 assert.equal(reports.length,1);assert.equal(reports[0]!.text,'已读取本次项目文件列表。');
});

test("explicit resume dispatches once without a new message and preserves the original task limits", async (t) => {
  const f = await fixture(t), initial = await f.start();
  f.settleWorker();
  const before = f.host.ledger.get(initial.taskId);
  await f.host.control(before.sessionId, { goalId: before.id, revision: before.revision, command: "resume" });
  const controlId = f.worker().resumeControlId;
  assert.ok(controlId); assert.equal(f.host.workers(f.project.id)[0].activity?.phase, "queued");
  await f.activate();
  assert.equal(f.requests.length, 2); assert.equal(f.worker().resumeControlId, undefined);
  assert.deepEqual(f.worker().invocationInputIds, []); assert.deepEqual(f.requests.at(-1)!.input.followups, []);
  assert.equal(f.requests.at(-1)!.input.humanControl.command, "resume");
  const control = f.store.require<any>("superHumanControls", controlId);
  assert.ok(control.consumedAt); assert.equal(control.generation, f.worker().generation);
  f.settleWorker(); await f.activate();
  assert.equal(f.requests.length, 2); assert.equal(f.worker().state, "parked");
  const after = f.host.ledger.get(initial.taskId);
  assert.equal(after.deadlineAt, before.deadlineAt); assert.equal(after.roundLimit, before.roundLimit);
  assert.equal(after.modelRounds, before.modelRounds); assert.equal(f.store.list("superGoals").length, 1);
});

test("stop revokes a queued explicit resume before dispatch", async (t) => {
  const f = await fixture(t), initial = await f.start(); f.settleWorker();
  const goal = f.host.ledger.get(initial.taskId);
  await f.host.control(goal.sessionId, { goalId: goal.id, revision: goal.revision, command: "resume" });
  const controlId = f.worker().resumeControlId;
  await f.host.stopTask(goal.id); await f.activate();
  assert.equal(f.requests.length, 1); assert.equal(f.worker().state, "stopped");
  assert.equal(f.worker().resumeControlId, undefined);
  const control = f.store.require<any>("superHumanControls", controlId);
  assert.ok(control.revokedAt); assert.equal(control.consumedAt, undefined);
});

test("cold restart and unrelated conversation never resume an interrupted worker", async (t) => {
  const f = await fixture(t), initial = await f.start();
  await f.host.close();
  const recovered = new LakeSuperagent(f.store, f.agents as any), internal = recovered as any;
  internal.schedule = () => {};
  try {
    assert.equal(f.worker().state, "parked");
    assert.equal(recovered.ledger.get(initial.taskId).status, "paused");
    const message = await recovered.send(f.router, "解释一下刚才的结果") as { id: string };
    const event = f.store.list<any>("superInputs").find((item) => item.messageId === message.id)!;
    internal.batches.set(f.router, { eventIds: [event.id], complete: new Set([event.id]), input: JSON.stringify({ event: event.id }) });
    internal.route(f.router, { event_id: event.id, part_key: "explanation", quote: event.payload, action: "respond", reason: "explanation only" });
    const view = f.store.view(f.router); view.status = "completed"; f.store.put("views", f.router, view);
    internal.routerFinished(f.router); await internal.pump();
    assert.equal(f.worker().state, "parked"); assert.equal(recovered.ledger.get(initial.taskId).status, "paused");
    assert.equal(f.requests.length, 1); assert.equal(f.store.list("superAcceptance").length, 0);
  } finally { await recovered.close(); }
});

for (const limit of ["rounds", "deadline"]) test(`deferred completion preserves the original ${limit} limit and reports it`, async (t) => {
  const f = await fixture(t), initial = await f.start();
  const event = await f.admit("继续检查"); f.route(event, { action: "followup", task_id: initial.taskId });
  await f.finish();
  const goal = f.host.ledger.get(initial.taskId);
  if (limit === "rounds") goal.modelRounds = goal.roundLimit; else goal.deadlineAt = new Date(Date.now() - 1000).toISOString();
  f.host.ledger.save(goal); f.settleWorker(); f.settleRouter(); await f.activate();
  const after = f.host.ledger.get(goal.id);
  assert.equal(after.status, "paused"); assert.equal(after.summary, limit === "rounds" ? "model_round_limit" : "deadline_reached");
  assert.equal(after.deadlineAt, goal.deadlineAt); assert.equal(after.modelRounds, goal.modelRounds);
  assert.equal(f.worker().state, "parked"); assert.equal(f.store.list("superAcceptance").length, 0);
  assert.ok(f.store.messages(f.router).some((message) => message.text.includes(limit === "rounds" ? "处理上限" : "截止时间")));
});

test('Pilot stop fences current queued/active work and late decisions without changing parked history or other projects',async t=>{
 const f=await fixture(t),old=await f.start();await f.finish();f.settleWorker();
 const oldGoal=JSON.stringify(f.host.ledger.get(old.taskId));
 const current=await f.start(),active=f.worker(current.taskId);
 f.store.put('superOperations','uncertain',{id:'uncertain',goalId:current.taskId,projectId:f.project.id,sessionId:active.sessionId,status:'unknown'});
 const pending=await f.admit('另外读取一项当前文件记录。');const queued=f.route(pending,{action:'create',title:'排队的独立工作',role_id:f.role.id});
 const other=f.store.createProject('other project');f.host.ensure(other.id);
 f.store.put('superWorkers','other-worker',{...active,id:'other-worker',projectId:other.id});
 await assert.rejects(()=>f.host.stopWorkspace(f.project.id,'wrong-router'),/不属于/);
 const count=f.requests.length,result=await f.host.stopWorkspace(f.project.id,f.router);
 assert.equal(result.tasks,2);assert.equal(f.worker(current.taskId).state,'stopped');
 assert.equal(f.host.ledger.get(current.taskId).status,'blocked');assert.equal(f.store.get<any>('superOperations','uncertain')!.status,'unknown');
 assert.equal(f.host.ledger.get(queued.taskId).status,'cancelled');assert.equal(f.store.get<any>('superInputs',pending.id)!.disposition,'stopped');
 assert.equal(JSON.stringify(f.host.ledger.get(old.taskId)),oldGoal);assert.equal(f.store.get<any>('superWorkers','other-worker')!.state,'active');
 assert.throws(()=>f.route(pending,{action:'create',title:'迟到任务',role_id:f.role.id}));
 f.settleRouter();await f.activate();assert.equal(f.requests.length,count);
});

test('a distinct follow-on task recalls same-role entrance clarifications and reports without borrowing execution authority',async t=>{
 const f=await fixture(t);
 const event=await f.admit('比较源库与 K2 数据。'),first=f.route(event,{action:'create',title:'比较两端数据库',role_id:f.role.id});
 f.settleRouter();await f.activate();await f.read(first.taskId);f.settleWorker(first.taskId);
 const entrance=await f.admit('192.0.2.75 是 K2 入口。');f.route(entrance,{action:'followup',task_id:first.taskId});
 f.settleRouter();await f.activate();
 const old=f.host.ledger.get(first.taskId);old.summary='K2 的数据库实例为 db/mysql141-0；这次只做了历史比较。';f.host.ledger.save(old);f.settleWorker(first.taskId);
 await f.host.stopTask(first.taskId);
 const original=JSON.stringify(f.host.ledger.get(first.taskId)),receipts=JSON.stringify(f.store.list('superOperations'));
 const next=await f.admit('同步到k2'),handoff=f.route(next,{action:'create',title:'同步源库到 K2',role_id:f.role.id});
 f.settleRouter();await f.activate();
 const assigned=f.requests.at(-1)!.input,previous=assigned.taskContext.items.find((row:any)=>row.taskRef.id===first.taskId);
 assert.match(JSON.stringify(previous),/192\.0\.2\.75/);assert.match(previous.summary,/db\/mysql141-0/);
 assert.equal(previous.historicalContextOnly,true);assert.equal(previous.state,'cancelled');
 assert.notEqual(assigned.assignment.sessionId,f.worker(first.taskId).sessionId);
 assert.equal(f.store.list<any>('superOperations').filter(op=>op.goalId===handoff.taskId).length,0);
 assert.equal(f.host.ledger.get(handoff.taskId).acceptanceState,'not_evaluated');
 const current=f.worker(handoff.taskId),recall=f.host.profile(current.sessionId)!.tools.find(tool=>tool.metadata.name==='recall_task_context')!;
 const found:any=await recall.handler({task_id:first.taskId,revision:previous.taskRef.revision,expected_hash:previous.taskRef.hash},{abortSignal:new AbortController().signal} as any);
 assert.equal(found.items[0].taskRef.id,first.taskId);
 await assert.rejects(async()=>recall.handler({task_id:first.taskId,expected_hash:'stale'},{abortSignal:new AbortController().signal} as any),/hash changed/);
 assert.equal(JSON.stringify(f.host.ledger.get(first.taskId)),original);assert.equal(JSON.stringify(f.store.list('superOperations')),receipts);
});

test('task recall rejects a different role and forged actor, and provider projection refreshes only the latest exact assignment',async t=>{
 const f=await fixture(t),first=await f.start();f.settleWorker(first.taskId);
 const next=await f.admit('进行另一项工作'),created=f.route(next,{action:'create',title:'后续工作',role_id:f.role.id});f.settleRouter();await f.activate();
 const current=f.worker(created.taskId),profile=f.host.profile(current.sessionId)!;
 const foreign={...f.worker(first.taskId),id:'other-worker',taskId:'other-task',roleId:'other-role'};
 f.store.put('superWorkers',foreign.id,foreign);f.store.put('superGoals',foreign.taskId,{...f.host.ledger.get(first.taskId),id:foreign.taskId,workerId:foreign.id,roleId:foreign.roleId});
 const recall=profile.tools.find(tool=>tool.metadata.name==='recall_task_context')!;
 await assert.rejects(async()=>recall.handler({task_id:foreign.taskId},{abortSignal:new AbortController().signal} as any),/not found/);
 const assigned=f.requests.at(-1)!.input;
 const request={messages:[{role:'system',content:'preserve system'},{role:'user',content:JSON.stringify({...assigned,taskContext:{stale:'OLD_CONTEXT'}})},{role:'assistant',content:'old reasoning'},{role:'user',content:JSON.stringify(assigned)}]};
 const before=JSON.stringify(request),projected:any=profile.projectRequest!(request);
 assert.equal(JSON.parse(projected.messages[1].content).taskContext,undefined);
 assert.equal(JSON.parse(projected.messages[3].content).taskContext.items[0].taskRef.id,first.taskId);
 assert.equal(projected.messages[2],request.messages[2]);assert.equal(JSON.stringify(request),before);
});

test('task context enforces actual actor identity and UTF-8/JSON budgets across paged history',async t=>{
 const {TaskContext}=await import('./task-context');
 const f=await fixture(t),first=await f.start(),current=f.worker(first.taskId),goal=f.host.ledger.get(first.taskId),context=new TaskContext(f.store,value=>value);
 for(let index=0;index<12;index++){
  const taskId='history-'+index,workerId='history-worker-'+index,sessionId='history-session-'+index;
  f.store.put('superGoals',taskId,{...goal,id:taskId,workerId,sessionId,summary:'中文上下文和入口线索。'.repeat(3000),title:'历史任务 '+index});
  f.store.put('superWorkers',workerId,{...current,id:workerId,taskId,sessionId,createdAt:`2026-11-06T08:00:${String(index).padStart(2,'0')}Z`,inputEventIds:[]});
 }
 const actor={projectId:current.projectId,roleId:current.roleId,sessionId:current.sessionId,taskId:current.taskId};
 const before=JSON.stringify(f.store.list('superGoals'));
 assert.throws(()=>context.recall({...actor,projectId:'foreign'}),/actor not found/);
 let cursor='',ids:string[]=[];
 do{const page=context.recall(actor,{limit:6,cursor});assert.ok(Buffer.byteLength(JSON.stringify(page))<=16384);for(const row of page.items){assert.ok(Buffer.byteLength(JSON.stringify(row))<=4096);assert.doesNotMatch(JSON.stringify(row),/�/);ids.push(row.taskRef.id);}cursor=page.nextCursor;}while(cursor);
 assert.equal(new Set(ids).size,12);assert.equal(ids.length,12);assert.equal(JSON.stringify(f.store.list('superGoals')),before);
});

test("shared handoff binds each contribution and scoped stop to its exact participant", async (t) => {
  const f = await fixture(t);
  const second = { ...f.role, id: "role-b", name: "数据库专员" };
  f.store.put("superRoles", second.id, second);
  const event = await f.admit("甲乙一起检查系统和数据库");
  const input = { action: "create", title: "联合检查", role_ids: [f.role.id, second.id], role_instructions: [
    { role_id: f.role.id, instruction: "只核对主机" }, { role_id: second.id, instruction: "只核对库表" },
  ] };
  const receipt = f.route(event, input), retry = f.route(event, input);
  const [a, b] = receipt.assignments;
  assert.equal(receipt.workerId, undefined);
  assert.equal(receipt.taskId, retry.taskId);
  assert.deepEqual(retry.assignments.map((row: any) => row.executionId), [a.executionId, b.executionId]);
  assert.notEqual(a.workerId, b.workerId);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.deepEqual(f.host.workspace(f.project.id).workers.map(worker => worker.task.taskId), [receipt.taskId, receipt.taskId]);
  assert.throws(() => f.route(event, { ...input, part_key: "overlap", role_ids: [second.id], role_instructions: [] }), /Overlapping/);
  f.settleRouter(); await f.activate();
  assert.deepEqual(f.requests.map(call => call.input.assignedDeliverable).sort(), ["只核对主机", "只核对库表"].sort());
  assert.ok(f.requests.every(call => call.input.assignment.taskId === receipt.taskId));
  const readTask = (args: object) => JSON.parse(f.internal.readObject(f.router, { kind: "task", id: receipt.taskId, ...args }).content);
  assert.equal(readTask({}).participants.length, 2);
  assert.equal(readTask({ role_id: second.id }).id, b.executionId);
  const followup = await f.admit("仅给乙补充：核对数据库名称");
  assert.equal(f.route(followup, { action: "followup", task_id: receipt.taskId, role_id: second.id }).workerId, b.workerId);
  assert.equal(f.worker(a.executionId).inputEventIds.includes(followup.id), false);
  f.settleRouter();
  const stop = await f.admit("只停止乙");
  assert.throws(() => f.route(stop, { action: "stop", task_id: receipt.taskId }), /participant role_id/);
  assert.throws(() => f.route(stop, { action: "stop", task_id: receipt.taskId, role_id: "unknown" }), /not assigned/);
  const stopped = f.route(stop, { action: "stop", task_id: receipt.taskId, role_id: second.id });
  assert.equal(stopped.workerId, b.workerId);
  f.settleRouter();
  await f.host.stopTask(b.executionId); // join the stop already dispatched by the Router
  assert.equal(f.host.ledger.get(b.executionId).status, "cancelled");
  assert.equal(f.host.ledger.get(a.executionId).status, "running");
});

test("Pilot cannot borrow a different specialist's receipt and can add a participant to the original task", async (t) => {
  const f = await fixture(t), second = { ...f.role, id: "beta" };
  f.store.put("superRoles", second.id, second);
  const initial = await f.admit("检查数据库"); const create = { action: "create", title: "检查数据库", role_id: f.role.id };
  const first = f.route(initial, create);
  assert.throws(() => f.route(initial, { ...create, role_id: second.id }), /decision conflict/);
  assert.throws(() => f.route(initial, { ...create, role_id: second.id, part_key: "other" }), /Overlapping/);
  f.settleRouter();
  const event = await f.admit("把乙加到刚才的任务，一起核对数据库");
  for (const action of ["stop", "followup", "context_only"]) {
    assert.throws(() => f.route(event, { action, task_id: first.taskId, role_id: second.id }), /not found in source specialist/);
  }
  assert.throws(() => f.route(event, { action: "assign", task_id: first.taskId, role_ids: [second.id, "unknown"] }));
  assert.equal(f.store.list("superWorkers").length, 1);
  const input = { action: "assign", task_id: first.taskId, role_id: second.id };
  const joined = f.route(event, input);
  assert.equal(joined.taskId, first.taskId);
  assert.equal(joined.roleId, second.id);
  assert.notEqual(joined.sessionId, first.sessionId);
  assert.equal(f.route(event, input).workerId, joined.workerId);
  f.settleRouter(); await f.activate();
  const b = f.requests.find(call => call.sessionId === joined.sessionId)?.input;
  assert.equal(b.originalRequirement, initial.payload);
  assert.deepEqual(b.followups, [{ id: event.id, text: event.payload }]);
  assert.equal(b.assignment.taskId, first.taskId);
  const channel = f.store.require<any>("superChannels", second.id);
  await f.host.send(channel.sessionId, "在乙频道继续", first.taskId);
  const request = f.store.list<any>("superInputs").find(row => row.payload === "在乙频道继续");
  f.internal.batches.set(f.router, { eventIds: [request.id], complete: new Set([request.id]), input: request.payload });
  assert.throws(() => f.route(request, { action: "followup", task_id: first.taskId, role_id: f.role.id }), /not found in source specialist/);
  assert.equal(f.route(request, { action: "followup", task_id: first.taskId }).workerId, joined.workerId);
});

test("a registered joint result exposes both original roles' evidence and rejects a changed member revision", async (t) => {
  const f = await fixture(t), secondary = { ...f.role, id: "role-b" };
  f.store.put("superRoles", secondary.id, secondary);
  const event = await f.admit("一起检查文件");
  const joint = f.route(event, { action: "create", title: "检查文件", role_ids: [f.role.id, secondary.id] });
  f.settleRouter(); await f.activate();
  for (const assignment of joint.assignments) {
    await f.read(assignment.executionId);
    await f.finish(assignment.executionId);
    f.settleWorker(assignment.executionId);
  }
  const review = await f.admit("读取上次联合检查的证据");
  const handoff = f.route(review, { action: "create", role_id: f.role.id, title: "复核结果", evidence_task_ids: [joint.taskId] });
  const actor = f.worker(handoff.taskId);
  const rows = f.internal.referencedEvidence(actor, { task_id: joint.taskId }).items;
  assert.deepEqual(rows.map((row: any) => row.roleId).sort(), [f.role.id, secondary.id].sort());
  for (const row of rows) {
    assert.equal(f.internal.readReferenced(actor, { task_id: joint.taskId, evidence_id: row.evidenceId, reference_id: row.referenceId }).state, "succeeded");
  }
  f.host.ledger.save(f.host.ledger.get(joint.assignments[1].executionId));
  assert.throws(() => f.internal.referencedEvidence(actor, { task_id: joint.taskId }), /source changed/);
});

for (const recovery of ["followup", "resume"] as const) test(`a failed additional handoff starts only on exact ${recovery} and preserves unknown operations`, async t => {
  const f = await fixture(t), first = await f.start();
  const beta = { ...f.role, id: "beta" }; f.store.put("superRoles", beta.id, beta);
  const addition = await f.admit("请让乙加入核对");
  const handoff = f.route(addition, { action: "assign", task_id: first.taskId, role_id: beta.id });
  f.settleRouter("simulated provider error after tool response");
  const a = f.worker(first.taskId), b = f.worker(handoff.assignments[0].executionId);
  assert.equal(b.state, "parked");
  await f.activate();
  assert.equal(f.requests.filter(call => call.sessionId === b.sessionId).length, 0);
  let dispatches = 0;
  const mutation = { path: "example" };
  await assert.rejects(f.host.ledger.operation(a.taskId, a.generation, a.policyHash, "write-A", "Write", mutation, async () => {
    dispatches++; throw new Error("unsettled external write");
  }, x => x, { readOnly: false }), /unsettled external write/);
  const prior = f.store.list<any>("superOperations").find(op => op.callId === "write-A");
  assert.equal(prior.status, "unknown");

  const unrelated = await f.admit("仅和甲继续");
  f.route(unrelated, { action: "followup", task_id: first.taskId, role_id: f.role.id });
  f.settleRouter(); await f.activate();
  assert.equal(f.requests.filter(call => call.sessionId === b.sessionId).length, 0);

  if (recovery === "followup") {
    const retry = await f.admit("继续乙自己的分工");
    f.route(retry, { action: "followup", task_id: first.taskId, role_id: beta.id });
    f.settleRouter();
  } else {
    await f.host.control(b.sessionId, { command: "resume", goalId: first.taskId, revision: f.host.ledger.get(b.taskId).revision });
  }
  await f.activate();
  const member = f.worker(b.taskId), runs = f.requests.filter(call => call.sessionId === b.sessionId);
  assert.equal(member.state, "active");
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].input.followups.map((row: any) => row.text), recovery === "followup" ? ["继续乙自己的分工"] : []);
  assert.equal(f.store.require<any>("superInputs", addition.id).disposition, "blocked");
  await f.read(member.taskId);
  const read = f.host.profile(member.sessionId)!.tools.find(entry => entry.metadata.name === "work_read")!;
  const snapshot = await read.handler({ goal_id: first.taskId }, { abortSignal: new AbortController().signal } as any) as any;
  assert.equal(snapshot.goal.id, member.taskId);
  assert.ok(snapshot.operations.length && snapshot.operations.every((op: any) => op.goalId === member.taskId));
  await assert.rejects(f.host.ledger.operation(member.taskId, member.generation, member.policyHash, "write-B", "Write",
    mutation, async () => { dispatches++; return {}; }, x => x, { readOnly: false }), /reconcil|unresolved|mutation/i);
  assert.equal(dispatches, 1);
  assert.deepEqual(f.store.require("superOperations", prior.id), prior);
});

async function watchdogFixture(t: Parameters<typeof fixture>[0], joint = false) {
  let time = Date.now();
  const f = await fixture(t, () => time);
  const second = { ...f.role, id: "watchdog-db", name: "数据库专员" };
  f.store.put("superRoles", second.id, second);
  const event = await f.admit("运维检查主机，数据库专员检查慢查询");
  const handoff = f.route(event, {
    action: "create", title: "共同排查超时",
    ...(joint ? {role_ids:[f.role.id,second.id],role_instructions:[
      {role_id:f.role.id,instruction:"检查主机"}, {role_id:second.id,instruction:"检查慢查询"}]} : {role_id:f.role.id}),
  });
  f.settleRouter();
  await f.activate();
  const member = f.worker(handoff.assignments[0].executionId);
  const fail = (statusCode = 503, currentFailure = true) => {
    const current = f.worker(member.taskId);
    const view = f.store.view(current.sessionId);
    view.rootTurnId = currentFailure ? "watchdog-root-" + current.generation : "previous-sdk-root";
    view.status = "failed";
    const failure = {message:"provider rejected",source:"provider",statusCode,phase:"response",retryable:statusCode===503};
    view.cards.push({id:"failure-"+current.generation,at:new Date(time).toISOString(),type:"error",status:"failed",content:"provider rejected",
      data:{root_turn_id:view.rootTurnId,taskId:current.taskId,failure}});
    f.store.put("views",current.sessionId,view);
    // A setup error may not emit an SDK root at all. The view can then still
    // show the previous turn's failure, matching its old root ID perfectly.
    f.host.settled(current.sessionId,currentFailure ? {error:failure.message,failure} : {error:"本轮本地准备失败"});
  };
  return {...f, member, fail, event, handoff, advance:(ms:number)=>{time+=ms;}};
}

test("watchdog retries a scoped pre-execution outage once due and marks recovery only after original acceptance", async t => {
  const f = await watchdogFixture(t), before = f.host.ledger.get(f.member.taskId);
  f.host.setWatchdogMode(f.project.id,"guide");
  f.fail();
  const ticket=f.store.require<any>("superWatchdogRetry",f.member.id);
  assert.equal(ticket.generation,f.member.generation);
  assert.deepEqual(ticket.inputIds,[f.event.id]);
  f.advance(59_999); await f.host.scanWatchdog(); await f.activate();
  assert.equal(f.requests.length,1);
  f.advance(1); await f.host.scanWatchdog(); await f.activate(); await f.activate();
  assert.equal(f.requests.length,2);
  const retry=f.requests[1]!;
  assert.equal(retry.sessionId,f.member.sessionId);
  assert.equal(retry.input.assignment.executionId,f.member.taskId);
  assert.equal(f.worker().generation,f.member.generation+1);
  assert.equal(f.host.ledger.get(f.member.taskId).deadlineAt,before.deadlineAt);
  assert.equal(f.store.list("superAcceptance").length,0);
  assert.equal(f.host.watchdog.records(f.project.id,f.member.taskId)[0]?.state,"retry_queued");
  await f.read(f.member.taskId); await f.finish(f.member.taskId); f.settleWorker(f.member.taskId);
  assert.equal(f.host.watchdog.records(f.project.id,f.member.taskId)[0]?.state,"recovered");
  assert.equal(f.host.ledger.get(f.member.taskId).acceptanceState,"pass");
  assert.equal(f.store.list("superGoals").length,1);
});

test("watchdog retry backoff stops after two actual retries on the original execution", async t => {
  const f=await watchdogFixture(t);
  f.host.setWatchdogMode(f.project.id,"guide");
  f.fail(); f.advance(60_000); await f.activate();
  f.fail(); f.advance(299_999); await f.activate();
  assert.equal(f.requests.length,2);
  f.advance(1); await f.activate();
  assert.equal(f.store.require<any>("superWatchdogLastRetry",f.member.id).attempt,2);
  f.fail(); f.advance(600_000); await f.host.scanWatchdog(); await f.activate();
  assert.equal(f.requests.length,3);
  assert.equal(f.store.get("superWatchdogRetry",f.member.id),undefined);
  assert.equal(f.store.list("superAcceptance").length,0);
});

for (const intervention of ["stop","disable","permission","unresolved sibling","restart"] as const) {
  test("watchdog pending recovery honors " + intervention, async t => {
    const f=await watchdogFixture(t,intervention==="unresolved sibling");
    f.host.setWatchdogMode(f.project.id,"guide");
    f.fail();
    assert.ok(f.store.get("superWatchdogRetry",f.member.id));
    const before=f.requests.length;
    if (intervention==="stop") await f.host.stopTask(f.member.taskId);
    if (intervention==="disable") f.host.setWatchdogMode(f.project.id,"off");
    if (intervention==="permission") {
      const session=f.store.session(f.router); session.options.denyLocalExecution=true;
      f.store.put("sessions",session.id,session);
    }
    if (intervention==="unresolved sibling") {
      const b=f.worker(f.handoff.assignments[1].executionId);
      await assert.rejects(f.host.ledger.operation(b.taskId,b.generation,b.policyHash,"ambiguous-change","Write",
        {path:"fixture"}, async()=>{throw new Error("delivery unknown");},value=>value,{readOnly:false}));
    }
    f.advance(600_000);
    if (intervention==="restart") {
      await f.host.close();
      const restored=new LakeSuperagent(f.store,f.agents as any,undefined,undefined,undefined,undefined,undefined,()=>Date.now()+600_000);
      try { await (restored as any).pump(); } finally { await restored.close(); }
    } else {
      await f.host.scanWatchdog();
      await f.activate();
    }
    assert.equal(f.requests.length,before);
    assert.equal(f.store.get("superWatchdogLastRetry",f.member.id),undefined);
    assert.equal(f.store.get("superWatchdogRetry",f.member.id),undefined);
    assert.equal(f.store.list("superAcceptance").length,0);
  });
}

test("watchdog only retries a transient model failure bound to this turn, before any business operations",async t=>{
  for (const condition of ["previous failure only","authentication","operation","observe"] as const) {
    const f=await watchdogFixture(t);
    if(condition!=="observe")f.host.setWatchdogMode(f.project.id,"guide");
    if(condition==="operation")await f.read(f.member.taskId);
    f.fail(condition==="authentication"?401:503,condition!=="previous failure only");
    f.advance(600_000); await f.activate();
    assert.equal(f.requests.length,1,condition);
    assert.equal(f.store.get("superWatchdogRetry",f.member.id),undefined,condition);
  }
});

test("watchdog reviews repeated identical evidence only on the affected member, preserving a sibling waiting on approval",async t=>{
  const f=await watchdogFixture(t,true);
  const a=f.member,b=f.worker(f.handoff.assignments[1].executionId);
  const pending={id:"original-approval",fingerprint:"fixed",call:{name:"Read"}} as any;
  const aView=f.store.view(a.sessionId); aView.pending=pending; f.store.put("views",a.sessionId,aView);
  const reviews:{projectId:string;sessionId:string;assignment:string;observations:string[]}[]=[], guided:string[]=[];
  Object.assign(f.agents,{
    isRunning:(sessionId:string)=>[a.sessionId,b.sessionId].includes(sessionId),
    currentActivity:()=>undefined,hasActiveChildren:()=>false,
    reviewWatchdog:async(input:typeof reviews[number])=>{reviews.push(input);return {verdict:"stalled",reason:"重复取得相同文件清单。"};},
    steer:async(sessionId:string)=>{guided.push(sessionId);return true;},
  });
  f.host.setWatchdogMode(f.project.id,"guide");
  await f.read(b.taskId,"first-file-list"); await f.host.scanWatchdog();
  for(let i=0;i<3;i++){
    f.advance(60_000); await f.read(b.taskId,"repeated-"+i); await f.host.scanWatchdog();
  }
  assert.deepEqual(reviews.map(input=>[input.sessionId,input.assignment]),[[b.sessionId,"检查慢查询"]]);
  assert.ok(reviews[0]!.observations.some(line=>line.includes("4 次工具调用") && line.includes("1 组")));
  assert.deepEqual(guided,[b.sessionId]);
  assert.equal(f.host.watchdog.records(f.project.id,a.taskId).length,0);
  const record=f.host.watchdog.records(f.project.id,b.taskId)[0]!;
  assert.deepEqual([record.taskId,record.executionId,record.workerId,record.state],[f.handoff.taskId,b.taskId,b.id,"guided"]);
  assert.deepEqual(f.store.view(a.sessionId).pending,pending);
  assert.equal(f.store.list("superAcceptance").length,0);
});

test("watchdog distinguishes changed foreground Bash output from a replay with a new command handle",async t=>{
  const f=await watchdogFixture(t);
  Object.assign(f.agents,{isRunning:()=>true,currentActivity:()=>undefined,hasActiveChildren:()=>false});
  const sample=()=>f.internal.watchdogSample(f.member.id);
  const command=(id:string,stdout:string,background:boolean)=>{
    // Foreground Bash returns flat strings, a settled background command
    // returns the SDK execution result with stdout/stderr text envelopes.
    const output={exitCode:0,stdout:background?{text:stdout}:stdout,stderr:background?{text:""}:""};
    f.store.put("superOperations",id,{id,projectId:f.project.id,sessionId:f.member.sessionId,
      goalId:f.member.taskId,generation:f.member.generation,tool:"Bash",argsHash:"same-shell-command",
      resourceId:"local",commandExecutionId:id,status:"succeeded",output,outputHash:id,readOnly:true});
  };
  command("one","ready",false); const first=sample().progressKey;
  command("two","ready",false); assert.equal(sample().progressKey,first);
  command("three","updated",false); const changed=sample().progressKey;
  assert.notEqual(first,changed,"a foreground command produced distinct evidence");
  command("four","updated",true); assert.equal(sample().progressKey,changed,"background Bash produced the same evidence");
  assert.doesNotMatch(JSON.stringify(sample().evidence),/updated|ready/,"raw output is not sent to the reviewer");
});
