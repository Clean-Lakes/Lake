import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LakeStore } from "./store";
import { digest, type Operation } from "./tasks";
import { memoryContextUnavailable, memoryContextUnavailableNotice } from "./memory-errors";
import { memoryFailureReportProjection } from "./task-cancellation";
import {
  cancelledReadOperation,
  stoppedReportProjection,
  stoppedNotice,
  unresolvedNotice,
} from "./task-cancellation";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(tmpdir(), "lake-cancel-projection-")),
    store = await LakeStore.open(home, join(home, "data"));
  t.after(async () => {
    store.db.close();
    await rm(home, { recursive: true, force: true });
  });
  const output = {
    status: "cancelled",
    cancelled: true,
    timedOut: false,
    exitCode: 137,
  };
  const op = {
    id: "operation",
    tool: "Bash",
    goalId: "goal",
    sessionId: "worker-session",
    projectId: "project",
    generation: 1,
    resourceId: "local",
    resourceRevision: 1,
    hostConfigurationHash: "config",
    commandExecutionId: "execution",
    readOnly: true,
    status: "failed",
    completedAt: "2026-11-06T08:50:35Z",
    output,
    outputHash: digest(output),
  } as Operation;
  const execution = {
    id: "execution",
    taskId: "goal",
    sessionId: "worker-session",
    generation: 1,
    resourceId: "local",
    resourceRevision: 1,
    configurationRevision: "config",
    readOnly: true,
    status: "cancelled",
    finishedAt: op.completedAt,
    result: output,
  };
  const goal = {
    id: "goal",
    projectId: "project",
    sessionId: "worker-session",
    workerId: "worker",
    status: "cancelled",
    revision: 8,
  };
  const worker = {
    id: "worker",
    projectId: "project",
    roleId: "role",
    sessionId: "worker-session",
    taskId: "goal",
    state: "stopped",
    generation: 2,
  };
  const key = digest(["goal", 7]),
    report = {
      key,
      workerId: "worker",
      goalRevision: 7,
      deliveredAt: op.completedAt,
    };
  const message = {
    id: "report_" + digest([key, "channel"]),
    sessionId: "channel",
    role: "assistant" as const,
    text: unresolvedNotice,
    createdAt: op.completedAt!,
    author: {
      kind: "specialist" as const,
      name: "checker",
      roleId: "role",
      workerId: "worker",
      sessionId: "worker-session",
      taskId: "goal",
    },
  };
  for (const [kind, id, value] of [
    ["superOperations", op.id, op],
    ["commandExecutions", execution.id, execution],
    ["superGoals", goal.id, goal],
    ["superWorkers", worker.id, worker],
    ["superProjects", "project", { routerSessionId: "router" }],
    ["superChannels", "role", { projectId: "project", sessionId: "channel" }],
    ["superReports", key, report],
  ] as const)
    store.put(kind, id, value);
  return { store, op, execution, goal, worker, report, message };
}

test("an exact cancelled read has a stopped projection while all original records remain unchanged", async (t) => {
  const f = await fixture(t),
    before = f.store.db
      .prepare("select kind,id,value from records order by kind,id")
      .all();
  assert.equal(cancelledReadOperation(f.store, f.op), true);
  assert.equal(
    stoppedReportProjection(f.store, f.message, () => false).text,
    stoppedNotice,
  );
  assert.equal(f.message.text, unresolvedNotice);
  assert.deepEqual(
    f.store.db
      .prepare("select kind,id,value from records order by kind,id")
      .all(),
    before,
  );
});

test("a matching host Memory failure corrects only its exact report and never the stored history",async t=>{
  const f=await fixture(t),root="failed-memory-root";
  f.store.put("superGoals",f.goal.id,{...f.goal,status:"blocked",roleId:f.worker.roleId});
  const message={...f.message,author:{...f.message.author,rootTurnId:root}};
  const view=f.store.view(f.worker.sessionId);view.status="failed";view.rootTurnId=root;
  view.cards=[{id:"host-error",type:"error",title:"Error",content:memoryContextUnavailable,status:"failed",data:{taskId:f.goal.id,root_turn_id:root}} as any];
  f.store.put("views",f.worker.sessionId,view);f.store.put("messages",message.id,message);
  const before=f.store.db.prepare("select kind,id,value from records order by kind,id").all();
  assert.equal(memoryFailureReportProjection(f.store,message).text,memoryContextUnavailableNotice);
  for(const other of [{...message,id:"model-message"},{...message,sessionId:"foreign"},{...message,text:"Model: "+unresolvedNotice},
    {...message,author:{...message.author,rootTurnId:"other-root"}},{...message,author:{...message.author,roleId:"other-role"}}])
    assert.deepEqual(memoryFailureReportProjection(f.store,other),other);
  assert.deepEqual(f.store.db.prepare("select kind,id,value from records order by kind,id").all(),before);
  view.cards[0].data={taskId:"other-task",root_turn_id:root};f.store.put("views",f.worker.sessionId,view);
  assert.equal(memoryFailureReportProjection(f.store,message).text,unresolvedNotice);
});

for (const variant of [
  "write",
  "unknown",
  "missing",
  "resource",
  "session",
  "generation",
  "configuration",
  "hash",
  "running",
  "timeout",
] as const)
  test(`a ${variant} receipt cannot claim a cancelled read`, async (t) => {
    const f = await fixture(t);
    switch (variant) {
      case "write":
        f.op.readOnly = false;
        break;
      case "unknown":
        f.op.status = "unknown";
        break;
      case "missing":
        f.store.delete("commandExecutions", "execution");
        break;
      case "resource":
        f.execution.resourceId = "foreign";
        break;
      case "session":
        f.execution.sessionId = "foreign";
        break;
      case "generation":
        f.execution.generation = 2;
        break;
      case "configuration":
        f.execution.configurationRevision = "changed";
        break;
      case "hash":
        f.op.outputHash = "changed";
        break;
      case "running":
        f.execution.status = "running";
        break;
      case "timeout":
        f.execution.result = { ...f.execution.result, timedOut: true };
        break;
    }
    if (variant !== "missing")
      f.store.put("commandExecutions", "execution", f.execution);
    f.store.put("superOperations", f.op.id, f.op);
    assert.equal(cancelledReadOperation(f.store, f.op), false);
    assert.equal(
      stoppedReportProjection(f.store, f.message, () => false),
      f.message,
    );
  });

for (const variant of [
  "unresolved",
  "model-prose",
  "foreign-message",
  "foreign-worker",
  "foreign-role",
  "not-stopped",
  "no-outbox",
  "wrong-outbox",
  "old-generation",
] as const)
  test(`historical report projection preserves ${variant}`, async (t) => {
    const f = await fixture(t);
    switch (variant) {
      case "model-prose":
        f.message.text = "原始具体发现：" + unresolvedNotice;
        break;
      case "foreign-message":
        f.message.id = "ordinary-message";
        break;
      case "foreign-worker":
        f.message.author.workerId = "foreign";
        break;
      case "foreign-role":
        f.message.author.roleId = "foreign";
        break;
      case "not-stopped":
        f.goal.status = "blocked";
        f.store.put("superGoals", f.goal.id, f.goal);
        break;
      case "no-outbox":
        f.store.delete("superReports", f.report.key);
        break;
      case "wrong-outbox":
        f.report.workerId = "foreign";
        f.store.put("superReports", f.report.key, f.report);
        break;
      case "old-generation":
        f.worker.generation = 3;
        f.store.put("superWorkers", f.worker.id, f.worker);
        break;
    }
    assert.equal(
      stoppedReportProjection(
        f.store,
        f.message,
        () => variant === "unresolved",
      ),
      f.message,
    );
  });

test("a joint task's stop notice resolves the author's execution, including when the public task ID names another worker", async t => {
  const f = await fixture(t);
  f.store.put('superGoals', 'goal', {...f.goal, sharedTaskId: 'public'});
  f.store.put('superGoals', 'public', {...f.goal, id: 'public', workerId: 'other', status: 'running'});
  f.message.author.taskId = 'public';
  assert.equal(stoppedReportProjection(f.store, f.message, () => false).text, stoppedNotice);
  f.message.author.taskId = 'unrelated';
  assert.equal(stoppedReportProjection(f.store, f.message, () => false), f.message);
});
