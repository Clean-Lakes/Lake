import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  symlink,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileSystemPort } from "@zcode/contracts";
import { LakeStore, id } from "./store";
import type { LakeMemory as LakeMemoryType, MemoryJob } from "./memory";
import { digest, type Goal, type Operation } from "./tasks";
process.env.LAKE_TS_IMPORT_ONLY = "1";
const { LakeMemory } = require("../../bin/lake-zcode/server.cjs") as {
  LakeMemory: typeof LakeMemoryType;
};

async function fixture(t: any) {
  const home = await mkdtemp(join(tmpdir(), "lake-memory-unit-")),
    store = await LakeStore.open(home, join(home, "data"));
  const memory = new LakeMemory(
    store,
    () => {},
    (value) => value.replaceAll("synthetic-test-secret", "[REDACTED]"),
  );
  await memory.initialize();
  t.after(async () => {
    await memory.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  const project = store.createProject("Example"),
    other = store.createProject("Other");
  const role = {
    id: id(),
    projectId: project.id,
    name: "运维专员",
    revision: 1,
  };
  store.put("superRoles", role.id, role);
  const role2 = { ...role, id: id() };
  store.put("superRoles", role2.id, role2);
  const scope = memory.scope("role", project.id, role.id),
    shared = memory.scope("project", project.id),
    user = memory.scope("user");
  const enable = (s = scope, use = true, capture = true) =>
    memory.setSettings(s, {
      useEnabled: use,
      extractionEnabled: capture,
      expectedRevision: memory.settings(s).revision,
    });
  const request = {
    messages: [{ role: "user", content: "请使用保存的方法处理本次检查" }],
  };
  const projected = (roleId = role.id) =>
    JSON.stringify(
      memory.projectRequest(request, {
        kind: "worker",
        projectId: project.id,
        roleId,
      }),
    );
  const save = async (
    s = scope,
    body = "检查独立数据分区再判断磁盘容量",
    title = "磁盘检查方法",
  ) => {
    await memory.remember(s, { body, title, expectedRevision: 0 });
    return memory.view(s).items.at(-1)!;
  };
  const task = () => {
    const session = store.createSession(project.id),
      resource = store
        .catalog()
        .resources.find((resource) => resource.projectId === project.id)!;
    const goal = {
      id: id(),
      workerId: id(),
      projectId: project.id,
      roleId: role.id,
      sessionId: session.id,
      goalRevision: 1,
      planRevision: 1,
      status: "completed",
      acceptanceState: "pass",
      mode: "default",
      title: "检查磁盘",
      summary: "已检查",
      updatedAt: new Date().toISOString(),
    } as Goal;
    store.put("superGoals", goal.id, goal);
    store.put("superWorkers", goal.workerId, {
      id: goal.workerId,
      projectId: goal.projectId,
      roleId: goal.roleId,
      taskId: goal.id,
      sessionId: goal.sessionId,
      inputEventIds: [],
    });
    const output = { available: 100 };
    const operation = {
      id: id(),
      callId: id(),
      tool: "Read",
      goalId: goal.id,
      projectId: project.id,
      sessionId: session.id,
      status: "succeeded",
      resourceId: resource.id,
      resourceRevision: 1,
      output,
      outputHash: digest(output),
      at: new Date().toISOString(),
    } as Operation;
    store.put("superOperations", operation.id, operation);
    return { goal, operation, resource, session };
  };
  return {
    home,
    store,
    memory,
    project,
    other,
    role,
    role2,
    scope,
    shared,
    user,
    enable,
    request,
    projected,
    save,
    task,
  };
}

test("角色改名保持知识；同名新角色和其他项目不继承", async (t) => {
  const f = await fixture(t);
  f.enable();
  await f.save();
  assert.match(f.projected(), /独立数据分区/);
  f.store.put("superRoles", f.role.id, {
    ...f.role,
    name: "新名称",
    revision: 2,
  });
  assert.equal(
    f.memory.scope("role", f.project.id, f.role.id).key,
    f.scope.key,
  );
  assert.match(f.projected(), /独立数据分区/);
  assert.doesNotMatch(f.projected(f.role2.id), /独立数据分区/);
  assert.throws(
    () => f.memory.resolveScope(f.scope.key, f.other.id),
    /当前项目/,
  );
  assert.doesNotMatch(
    JSON.stringify(
      f.memory.projectRequest(f.request, {
        kind: "pilot",
        projectId: f.other.id,
      }),
    ),
    /独立数据分区/,
  );
});
test("Pilot 只读用户/项目；Worker 只读项目与本角色，默认开关关闭", async (t) => {
  const f = await fixture(t);
  await f.save(f.scope, "角色私有方法");
  await f.save(f.shared, "项目公共术语");
  await f.save(f.user, "跨项目报告偏好");
  assert.doesNotMatch(f.projected(), /角色私有方法|项目公共术语/);
  f.enable();
  f.enable(f.user, true, false);
  const pilot = JSON.stringify(
    f.memory.projectRequest(f.request, {
      kind: "pilot",
      projectId: f.project.id,
    }),
  );
  assert.match(pilot, /项目公共术语/);
  assert.match(pilot, /跨项目报告偏好/);
  assert.doesNotMatch(pilot, /角色私有方法/);
  assert.match(f.projected(), /角色私有方法/);
  assert.match(f.projected(), /项目公共术语/);
  assert.doesNotMatch(f.projected(), /跨项目报告偏好/);
  assert.equal(JSON.stringify(f.request).includes("知识"), false); // projection did not mutate stored messages
});
test("新 Task 只共享长期知识，关闭使用及单轮忽略在同一 Runtime 后续请求生效", async (t) => {
  const f = await fixture(t);
  f.enable();
  await f.save();
  const a = f.store.createSession(f.project.id),
    b = f.store.createSession(f.project.id);
  const input = (sessionId: string) =>
    JSON.stringify(
      f.memory.projectRequest(f.request, {
        kind: "worker",
        projectId: f.project.id,
        roleId: f.role.id,
        sessionId,
      }),
    );
  assert.match(input(a.id), /独立数据分区/);
  assert.match(input(b.id), /独立数据分区/);
  f.memory.setIgnored(b.id, true);
  assert.throws(() => input(b.id), /新建任务/);
  assert.match(input(a.id), /独立数据分区/);
  f.enable(f.scope, false, true);
  assert.throws(() => input(a.id), /新建任务/);
  f.enable(f.scope, true, true);
  assert.match(input(a.id), /独立数据分区/);
});
test("来源关闭前不捕获，不回扫；真实消息更改后停止使用旧来源", async (t) => {
  const f = await fixture(t),
    session = f.store.createSession(f.project.id),
    first = f.store.addMessage(session.id, "user", "以后报告先给结论");
  f.memory.captureUser(session.id, first.id, f.role.id);
  assert.equal(f.store.list("memoryJobs").length, 0);
  f.enable();
  const next = f.store.addMessage(session.id, "user", "以后报告先给结论");
  f.memory.captureUser(session.id, next.id, f.role.id);
  f.memory.captureUser(session.id, next.id, f.role.id);
  assert.equal(f.store.list("memoryJobs").length, 1);
  f.memory.runNative = async (work) => {
    work.guard();
    await writeFile(join(work.root, "report.md"), "先给结论", { mode: 0o600 });
  };
  await f.memory.wait();
  assert.match(f.projected(), /先给结论/);
  f.store.put("messages", next.id, { ...next, text: "更正为先给证据" });
  assert.doesNotMatch(f.projected(), /先给结论/);
});
test("原任务验收、工具 hash 与连接版本控制知识资格，unknown 不进入提取", async (t) => {
  const f = await fixture(t);
  f.enable();
  const { goal, operation } = f.task();
  f.store.put("superOperations", operation.id, {
    ...operation,
    status: "unknown",
  });
  f.memory.captureTask(goal.id);
  assert.equal(f.store.list("memoryJobs").length, 0);
  f.store.put("superOperations", operation.id, operation);
  f.memory.captureTask(goal.id);
  f.memory.captureTask(goal.id);
  assert.equal(f.store.list("memoryJobs").length, 1);
  f.memory.runNative = async (work) => {
    assert.match(work.source.payload, /accepted_task/);
    await writeFile(
      join(work.root, "method.md"),
      "历史方法，重新检查当前磁盘",
      { mode: 0o600 },
    );
  };
  await f.memory.wait();
  assert.match(f.projected(), /历史方法/);
  f.store.put("resourceRevisions", operation.resourceId!, 2);
  assert.doesNotMatch(f.projected(), /历史方法/);
  f.store.put("resourceRevisions", operation.resourceId!, 1);
  f.store.put("superOperations", operation.id, {
    ...operation,
    output: { available: 0 },
    outputHash: digest({ available: 0 }),
  });
  assert.doesNotMatch(f.projected(), /历史方法/);
});
test("更正/遗忘清理正文与历史派生，原会话与业务账本保留", async (t) => {
  const f = await fixture(t);
  f.enable();
  const entry = await f.save();
  const old = f.store.require<any>("memoryEntries", entry.id),
    oldPath = join(f.memory.root, old.filePath);
  await f.memory.remember(
    f.scope,
    { title: "新方法", body: "新的准确方法", expectedRevision: entry.revision },
    entry.id,
  );
  assert.doesNotMatch(f.projected(), /独立数据分区/);
  assert.match(f.projected(), /新的准确方法/);
  await assert.rejects(readFile(oldPath), /ENOENT/);
  const current = f.memory
    .view(f.scope)
    .items.find((item) => item.id === entry.id)!;
  await f.memory.forget(f.scope, entry.id, current.revision);
  assert.doesNotMatch(f.projected(), /新的准确方法/);
  assert.ok(
    f.store.list<any>("memorySources").every((source) => source.payload === ""),
  );
});
test("遗忘发生在提取期间时阻止迟到发布，也不影响其他范围", async (t) => {
  const f = await fixture(t);
  f.enable();
  const entry = await f.save();
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  f.memory.runNative = async (work) => {
    started();
    await gate;
    work.guard();
    await writeFile(join(work.root, "late.md"), "不得复活旧记忆");
  };
  const session = f.store.createSession(f.project.id),
    message = f.store.addMessage(session.id, "user", "请保存新的长期方法");
  f.memory.captureUser(session.id, message.id, f.role.id);
  const waiting = f.memory.wait();
  await ready;
  await f.memory.forget(f.scope, entry.id, entry.revision);
  release();
  await waiting;
  assert.equal(f.memory.view(f.scope).items.length, 0);
  assert.equal(f.store.list<MemoryJob>("memoryJobs")[0].state, "withdrawn");
  assert.deepEqual(await readdir(join(f.memory.root, "staging")), []);
});
test("关闭再开启积累不能重新派发关闭前排队的来源", async (t) => {
  const f = await fixture(t);
  f.enable();
  const session = f.store.createSession(f.project.id),
    message = f.store.addMessage(session.id, "user", "请记录未来长期报告习惯");
  f.memory.captureUser(session.id, message.id, f.role.id);
  f.enable(f.scope, true, false);
  f.enable();
  let calls = 0;
  f.memory.runNative = async () => {
    calls++;
  };
  await f.memory.wait();
  assert.equal(calls, 0);
});
test("原生记忆文件工具拒绝越界、符号链接、凭据和非 Markdown 输出", async (t) => {
  const f = await fixture(t),
    root = join(f.memory.root, "staging");
  const base = {
    writeTextFile: async () => {
      throw new Error("must reject before adapter");
    },
    readTextFile: async () => {
      throw new Error("must reject before adapter");
    },
  } as unknown as FileSystemPort;
  const fs = f.memory.fileSystem(base, root, () => {});
  await assert.rejects(
    fs.writeTextFile({ path: join(f.home, "outside.md"), content: "no" }),
    /只能访问/,
  );
  await symlink(f.home, join(root, "link"));
  await assert.rejects(
    fs.readTextFile({ path: join(root, "link", "outside.md") }),
    /符号链接/,
  );
  await assert.rejects(
    fs.writeTextFile({
      path: join(root, "key.md"),
      content: "synthetic-test-secret",
    }),
    /凭据/,
  );
  await assert.rejects(
    fs.writeTextFile({ path: join(root, "run.sh"), content: "no" }),
    /Markdown/,
  );
  await assert.rejects(f.save(f.scope, "synthetic-test-secret"), /凭据/);
});
test("角色删除停止读写，重启不重放已经派发的记忆模型任务", async (t) => {
  const f = await fixture(t);
  f.enable();
  await f.save();
  await f.memory.retireRole(f.project.id, f.role.id);
  f.store.put("superRoles", f.role.id, {
    ...f.role,
    deletedAt: new Date().toISOString(),
  });
  assert.throws(() => f.projected(), /不存在/);
  f.store.put("memoryJobs", "interrupted", {
    id: "interrupted",
    scopeKey: f.scope.key,
    sourceId: "none",
    state: "running",
    createdAt: new Date().toISOString(),
  });
  const restarted = new LakeMemory(f.store, () => {});
  assert.equal(
    f.store.require<MemoryJob>("memoryJobs", "interrupted").state,
    "interrupted",
  );
  await restarted.close();
});

test("已知只读失败可以保存为失败经验，不能成为成功证据或释放 unknown", async (t) => {
  const f = await fixture(t);
  f.enable();
  const { goal, operation } = f.task();
  f.store.put("superGoals", goal.id, {
    ...goal,
    status: "paused",
    acceptanceState: "insufficient",
  });
  f.store.put("superOperations", operation.id, {
    ...operation,
    readOnly: true,
    status: "failed",
    output: { success: false, error: "file unavailable" },
    outputHash: digest({ success: false, error: "file unavailable" }),
  });
  f.memory.captureTask(goal.id);
  assert.equal(f.store.list("memoryJobs").length, 1);
  f.memory.runNative = async (work) => {
    assert.match(work.source.payload, /settled_read_failure/);
    assert.doesNotMatch(work.source.payload, /"kind":"accepted_task"/);
    await writeFile(
      join(work.root, "failure.md"),
      "历史上读取失败，下一次重新核实路径",
    );
  };
  await f.memory.wait();
  assert.match(f.projected(), /evidenceState.*failed/);
  assert.equal(
    f.store.require<Goal>("superGoals", goal.id).acceptanceState,
    "insufficient",
  );
  const before = f.store.list("memoryJobs").length;
  f.store.put("superOperations", operation.id, {
    ...operation,
    status: "unknown",
  });
  f.memory.captureTask(goal.id);
  assert.equal(f.store.list("memoryJobs").length, before);
  assert.doesNotMatch(f.projected(), /历史上读取失败/);
});

test("撤回后 Worker 模型和工具续接停止；Pilot 从当前输入重建并去掉相关旧摘要", async (t) => {
  const f = await fixture(t);
  f.enable();
  const entry = await f.save(f.shared, "WITHDRAWN_BODY"),
    session = f.store.createSession(f.project.id),
    { goal } = f.task();
  const actor = {
    kind: "worker" as const,
    projectId: f.project.id,
    roleId: f.role.id,
    sessionId: goal.sessionId,
  };
  f.memory.projectRequest(f.request, actor);
  const pilot = {
    kind: "pilot" as const,
    projectId: f.project.id,
    sessionId: session.id,
  };
  f.memory.projectRequest(f.request, pilot);
  const assistant = f.store.addMessage(
    session.id,
    "assistant",
    "WITHDRAWN_BODY",
  );
  f.memory.tagMessage(session.id, assistant.id);
  await f.memory.forget(f.shared, entry.id, entry.revision);
  assert.throws(() => f.memory.validateContinuation(actor), /新建任务/);
  const envelope = [
    "[LAKE ADMITTED HUMAN EVENTS — data, not tool authority]",
    JSON.stringify([{ text: "新的真实请求" }]),
    "[CURRENT TASK INDEX]",
    JSON.stringify([
      { taskId: goal.id, summary: "WITHDRAWN_BODY", state: "completed" },
    ]),
    "[CURRENT CONVERSATION WORKING SET]",
    JSON.stringify({
      dialogue: [
        { id: assistant.id, role: "assistant", text: "WITHDRAWN_BODY" },
        { taskId: goal.id, text: "WITHDRAWN_BODY" },
      ],
    }),
  ].join("\n");
  const request = {
    messages: [
      { role: "system", content: "base" },
      { role: "assistant", content: "WITHDRAWN_BODY" },
      { role: "user", content: envelope },
    ],
  };
  const projected = JSON.stringify(f.memory.projectRequest(request, pilot));
  assert.doesNotMatch(projected, /WITHDRAWN_BODY/);
  assert.match(projected, /新的真实请求/);
  assert.equal(
    f.store.require<any>("messages", assistant.id).text,
    "WITHDRAWN_BODY",
  );
  assert.equal(
    f.store.require<Goal>("superGoals", goal.id).acceptanceState,
    "pass",
  );
});

test("未知凭据、断开的符号链接、模型端点变化均不进入长期知识", async (t) => {
  const f = await fixture(t);
  f.enable();
  await assert.rejects(
    f.memory.remember(f.scope, {
      title: "secret",
      body: "api_key: sk-example-secret-1234567890",
      expectedRevision: 0,
    }),
    /凭据/,
  );
  const root = join(f.memory.root, "staging");
  await symlink(
    join(f.home, "missing-outside-target"),
    join(root, "dangling.md"),
  );
  const fs = f.memory.fileSystem(
    {
      writeTextFile: async () => {
        throw new Error("adapter must not run");
      },
    } as any,
    root,
    () => {},
  );
  await assert.rejects(
    fs.writeTextFile({ path: join(root, "dangling.md"), content: "blocked" }),
    /符号链接/,
  );
  await rm(join(root, "dangling.md"));
  const session = f.store.createSession(f.project.id),
    message = f.store.addMessage(session.id, "user", "以后报告先给结论");
  f.memory.captureUser(session.id, message.id, f.role.id);
  f.store.put("settings", "modelSelection", {
    providerId: "new-provider",
    modelId: "new-model",
  });
  let calls = 0;
  f.memory.runNative = async () => {
    calls++;
  };
  await f.memory.wait();
  assert.equal(calls, 0);
});

test("记忆暂不可用不阻断未使用记忆的新任务，已有知识续接保持关闭", async (t) => {
  const f = await fixture(t);
  f.enable();
  await f.save();
  const session = f.store.createSession(f.project.id);
  const actor = {
    kind: "worker" as const,
    projectId: f.project.id,
    roleId: f.role.id,
    sessionId: session.id,
  };
  f.memory.projectRequest(f.request, actor);
  f.memory.disable("fixture memory unavailable");
  assert.throws(() => f.memory.validateContinuation(actor), /unavailable/);
  assert.deepEqual(
    f.memory.projectRequest(f.request, {
      ...actor,
      sessionId: "fresh-session",
    }),
    f.request,
  );
});

test("重启清理未提交的文件版本与暂存，不重新发起模型或复活撤回内容", async (t) => {
  const f = await fixture(t);
  const staged = join(f.memory.root, "staging", "job-abc123");
  await require("node:fs/promises").mkdir(staged);
  await writeFile(join(staged, "session.sqlite"), "temporary source");
  const orphan = join(f.memory.root, "published", f.scope.key, `1-${id()}`);
  await require("node:fs/promises").mkdir(orphan, { recursive: true });
  await writeFile(join(orphan, "orphan.md"), "uncommitted knowledge");
  await f.memory.initialize();
  assert.deepEqual(await readdir(join(f.memory.root, "staging")), []);
  assert.deepEqual(await readdir(orphan), []);
  assert.equal(f.memory.view(f.scope).items.length, 0);
});

test("新的复查任务不从 predecessor 摘要恢复已撤回的专员知识", async (t) => {
  const f = await fixture(t);
  f.enable();
  const entry = await f.save(),
    { goal } = f.task();
  f.memory.projectRequest(f.request, {
    kind: "worker",
    projectId: f.project.id,
    roleId: f.role.id,
    sessionId: goal.sessionId,
  });
  await f.memory.forget(f.scope, entry.id, entry.revision);
  const request = {
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          assignment: { projectId: f.project.id, roleId: f.role.id },
          predecessor: {
            taskRef: { id: goal.id },
            summary: "已撤回的旧专员知识",
            originalDeliverable: "重新检查真实磁盘指标",
          },
        }),
      },
    ],
  };
  const projected = JSON.stringify(
    f.memory.projectRequest(request, {
      kind: "worker",
      projectId: f.project.id,
      roleId: f.role.id,
      sessionId: "new-worker",
    }),
  );
  assert.doesNotMatch(projected, /已撤回的旧专员知识/);
  assert.match(projected, /重新检查真实磁盘指标/);
  assert.match(projected, /withdrawn_knowledge/);
  f.memory.captureTask(goal.id);
  assert.equal(f.store.list("memoryJobs").length, 0);
});
