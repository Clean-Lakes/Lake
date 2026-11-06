import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LakeStore } from "./store";
import { LakeSuperagent } from "./superagent";

// Exercise the actual host and SQLite ledger with a controlled SDK boundary.
// No model, credential, remote server or existing Dev data is accessed.
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(tmpdir(), "lake-dispatch-lifecycle-"));
  const store = await LakeStore.open(home, join(home, "data"));
  const requests: { sessionId: string; input: any }[] = [];
  let steering = 0;
  const agents = { redact: (value: string) => value, publish() {}, prepareRedaction: async () => {}, isRunning: () => false,
    send: async (sessionId: string, _text: string, options: any) => { requests.push({ sessionId, input: JSON.parse(options.input) }); },
    steer: async () => { steering++; return true; }, abort: async () => {} };
  const host = new LakeSuperagent(store, agents as any), internal = host as any;
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
  const read = async (taskId?: string) => {
    const current = worker(taskId), profile = host.profile(current.sessionId)!;
    const entry = profile.tools.find((item) => item.metadata.name === "list_project_files")!;
    return profile.invoke!(entry, {}, { toolCallId: `files-${current.generation}`, abortSignal: new AbortController().signal } as any);
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
    settleRouter(); await activate(); await read();
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
