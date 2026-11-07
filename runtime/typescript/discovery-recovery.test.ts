import { test } from "node:test";
import { EventEmitter } from "node:events";
import { LakeExecution } from "./execution";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LakeStore } from "./store";
import { digest, TaskLedger, type Operation } from "./tasks";
import { issueResourcePin } from "./resource-pin";
import { ProgramDiscoveryRecovery } from "./discovery-recovery";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), "lake-discovery-recovery-"));
  const store = await LakeStore.open(home, join(home, "data"));
  t.after(async () => {
    store.db.close();
    await rm(home, { recursive: true, force: true });
  });
  const input = {
    command:
      "hostname; command -v mysql; command -v kubectl; command -v mysqldump",
    asset_ref: "host",
    configuration_revision: "configuration",
    description: "Inspect installed tools",
  };
  const output = {
    status: "failed",
    exitCode: 1,
    stdout: "fixture-host\n",
    stderr: "",
    cancelled: false,
    timedOut: false,
  };
  const operation: Operation = {
    id: digest(["session", "original"]),
    callId: "original",
    tool: "Bash",
    argsHash: digest(input),
    projectId: "project",
    goalId: "goal",
    sessionId: "session",
    stepId: "host_work",
    attemptId: "old-attempt",
    goalRevision: 1,
    planRevision: 1,
    generation: 1,
    policyHash: "policy",
    status: "unknown",
    at: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    resourceId: "host",
    resourceRevision: 1,
    hostConfigurationHash: "configuration",
    commandExecutionId: digest(["goal", 1, "original"]),
    readOnly: false,
    output,
    outputHash: digest(output),
  };
  const execution = {
    id: operation.commandExecutionId,
    taskId: "goal",
    sessionId: "session",
    generation: 1,
    resourceId: "host",
    resourceRevision: 1,
    configurationRevision: "configuration",
    commandHash: digest(input.command),
    readOnly: false,
    status: "failed",
    startedAt: operation.at,
    finishedAt: operation.completedAt,
    result: {
      ...output,
      stdout: { text: output.stdout, truncated: false },
      stderr: { text: output.stderr, truncated: false },
    },
  };
  const part = {
    id: "part",
    messageID: "message",
    sessionID: "session",
    type: "tool",
    callID: "original",
    tool: "Bash",
    state: { status: "completed", input, output: JSON.stringify(output) },
  };
  const session = { id: "session", projectID: "project", time: {} };
  const messages = [
    {
      info: { id: "message", sessionID: "session", role: "assistant" },
      parts: [part],
    },
  ];
  const sessions = {
    getSession: async () => session,
    messages: async () => messages,
  } as any;
  const recovery = new ProgramDiscoveryRecovery(store, sessions);
  const ledger = new TaskLedger(store, undefined, (operation) =>
    recovery.resolution(operation),
  );
  ledger.create({
    id: "goal",
    projectId: "project",
    sessionId: "session",
    workerId: "worker",
    roleId: "role",
    sourceEventId: "event",
    originRootTurnId: "root",
    title: "Compare test databases",
    userText: "Compare test databases",
    status: "running",
    roundLimit: 100,
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    mode: "default",
    executionMode: "host_managed",
  });
  store.put("superOperations", operation.id, operation);
  store.put("commandExecutions", execution.id!, execution);
  return {
    store,
    recovery,
    ledger,
    operation,
    execution,
    input,
    part,
    session,
    messages,
  };
}

test("historical literal lookup is mechanically reconciled without changing results, replay or acceptance", async (t) => {
  const f = await fixture(t),
    { store, recovery, ledger, operation } = f;
  const original = ["superOperations", "commandExecutions", "superGoals"].map(
    (kind) => store.list(kind),
  );
  assert.equal(ledger.unresolved("goal"), true);
  assert.equal(await recovery.verify("other-project"), 0);
  assert.equal(await recovery.verify("project"), 1);
  assert.equal(ledger.unresolved("goal"), false);
  assert.equal(recovery.resolution(operation)?.effects, "none");
  assert.deepEqual(
    ["superOperations", "commandExecutions", "superGoals"].map((kind) =>
      store.list(kind),
    ),
    original,
  );
  assert.equal(await recovery.verify(), 0);
  const restored = new ProgramDiscoveryRecovery(store, {} as any);
  assert.equal(
    restored.resolution(operation)?.method,
    "literal_program_discovery_v1",
  );
  let calls = 0;
  await assert.rejects(
    ledger.operation(
      "goal",
      1,
      "policy",
      "original",
      "Bash",
      f.input,
      async () => {
        calls++;
        return {};
      },
      (v) => v,
    ),
    /cannot be replayed/,
  );
  assert.equal(calls, 0);
  assert.throws(() =>
    ledger.finishHost(
      "goal",
      { outcome: "completed", summary: "done" },
      1,
      "policy",
    ),
  );
  await ledger.operation(
    "goal",
    2,
    "policy",
    "fresh-command",
    "Bash",
    { command: "opaque fixture inspection" },
    async () => {
      calls++;
      return { status: "completed", exitCode: 0 };
    },
    (v) => v,
    { readOnly: false },
  );
  assert.equal(
    calls,
    1,
    "a new ordinary command is no longer locked by harmless program discovery",
  );
  assert.equal(
    store.require<Operation>("superOperations", operation.id).status,
    "unknown",
  );
  assert.equal(store.list("superAcceptance").length, 0);
});

for (const variant of [
  "command",
  "input",
  "hash",
  "output",
  "execution",
  "resource",
  "generation",
  "session",
  "project",
  "child",
  "timeout",
  "cancelled",
  "running",
  "duplicate",
  "missing",
  "opaque",
  "redirection",
  "substitution",
  "late-change",
] as const) {
  test(`historical verification rejects ${variant} without changing the blocker`, async (t) => {
    const f = await fixture(t),
      { store, operation, execution, part } = f;
    switch (variant) {
      case "command":
        execution.commandHash = digest("different command");
        break;
      case "input":
        part.state.input = { ...f.input, description: "different input" };
        break;
      case "hash":
        operation.outputHash = "wrong";
        break;
      case "output":
        (operation.output as any).stdout = "different result";
        operation.outputHash = digest(operation.output);
        break;
      case "execution":
        execution.result.exitCode = 2;
        break;
      case "resource":
        execution.resourceId = "other-resource";
        break;
      case "generation":
        execution.generation = 2;
        break;
      case "session":
        execution.sessionId = "other-session";
        break;
      case "project":
        f.session.projectID = "other-project";
        break;
      case "child":
        operation.childSessionId = "child-session";
        break;
      case "timeout":
        execution.result.timedOut = true;
        break;
      case "cancelled":
        execution.result.cancelled = true;
        break;
      case "running":
        execution.status = "running";
        break;
      case "duplicate":
        f.messages[0]!.parts.push(structuredClone(part));
        break;
      case "missing":
        f.messages.length = 0;
        break;
      case "opaque":
      case "redirection":
      case "substitution": {
        f.input.command =
          variant === "opaque"
            ? "mysql -e 'SHOW DATABASES'"
            : variant === "redirection"
              ? "command -v mysql > fixture"
              : "command -v $(touch fixture)";
        operation.argsHash = digest(f.input);
        execution.commandHash = digest(f.input.command);
        break;
      }
      case "late-change": {
        const original = f.recovery.sessions.messages;
        f.recovery.sessions.messages = async (args) => {
          const result = await original(args);
          const changed = store.require<Operation>(
            "superOperations",
            operation.id,
          );
          changed.argsHash = "changed-during-read";
          store.put("superOperations", changed.id, changed);
          return result;
        };
      }
    }
    store.put("superOperations", operation.id, operation);
    store.put("commandExecutions", execution.id!, execution);
    assert.equal(await f.recovery.verify(), 0);
    assert.equal(f.ledger.unresolved("goal"), true);
    assert.equal(store.list("commandReadReconciliations").length, 0);
    let calls = 0;
    await assert.rejects(
      f.ledger.operation(
        "goal",
        2,
        "policy",
        "later",
        "Bash",
        {},
        async () => {
          calls++;
          return {};
        },
        (v) => v,
        { readOnly: false },
      ),
      /requires reconciliation/,
    );
    assert.equal(calls, 0);
  });
}

test("verification becomes invalid when either frozen operation or execution changes", async (t) => {
  const f = await fixture(t);
  await f.recovery.verify();
  assert.equal(f.ledger.unresolved("goal"), false);
  const record = f.store.require<any>("commandExecutions", f.execution.id!);
  record.commandHash = "changed";
  f.store.put("commandExecutions", record.id, record);
  assert.equal(f.ledger.unresolved("goal"), true);
  f.store.put("commandExecutions", f.execution.id!, f.execution);
  const op = f.store.require<Operation>("superOperations", f.operation.id);
  op.resourceRevision = 2;
  f.store.put("superOperations", op.id, op);
  assert.equal(f.ledger.unresolved("goal"), true);
});

async function inventoryFixture(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t),
    { store, operation, input, execution, part } = f;
  const directory = "/tmp/lake-ops-UK-fixture",
    command =
      "runuser -u nobody -- /bin/bash -c 'id; ls -la " +
      directory +
      "; find " +
      directory +
      ' -maxdepth 4 -printf "%y %s %p\\n"' +
      String.fromCharCode(39);
  const { compileNobodyInspection } =
    await import("../../web-agent/shared/command-policy");
  input.command = command;
  operation.argsHash = digest(input);
  execution.commandHash = digest(command);
  const stdout =
    "uid=99(nobody) gid=99(nobody) groups=99(nobody)\ntotal 1\nd 10 " +
    directory +
    "\n";
  const stderr =
    "find: failed to restore initial working directory: Permission denied\n";
  const output = {
    ...(operation.output as any),
    stdout,
    stderr,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stdoutTruncated: false,
    stderrTruncated: false,
    interrupted: false,
  };
  operation.output = output;
  operation.outputHash = digest(output);
  Object.assign(execution, { command, workerId: "worker" });
  execution.result.stdout = {
    text: stdout,
    truncated: false,
    bytes: Buffer.byteLength(stdout),
  } as any;
  execution.result.stderr = {
    text: stderr,
    truncated: false,
    bytes: Buffer.byteLength(stderr),
  } as any;
  part.state.output = ["Exit code 1", stdout.trimEnd(), stderr.trimEnd()].join(
    "\n",
  );
  store.put("projects", "project", { id: "project" });
  store.put("resources", "host", {
    id: "host",
    projectId: "project",
    kind: "ssh",
  });
  store.put("sessions", "session", {
    id: "session",
    projectId: "project",
    tags: [],
  });
  store.put("sessions", "else", { id: "else", projectId: "project", tags: [] });
  store.put("superInputs", "event", {
    id: "event",
    projectId: "project",
    sessionId: "router",
    messageId: "user",
    payload: "检查 " + directory,
    selectedReferences: { resourceIds: ["host"] },
  });
  store.put("superOperations", operation.id, operation);
  store.put("commandExecutions", execution.id!, execution);
  const verify = {
    ...operation,
    at: new Date(Date.parse(operation.completedAt!) + 1000).toISOString(),
    completedAt: new Date(
      Date.parse(operation.completedAt!) + 1200,
    ).toISOString(),
    callId: "recheck",
    generation: 2,
    status: "succeeded" as const,
    readOnly: true,
    output: {
      ...output,
      exitCode: 0,
      status: "completed",
      stderr: "",
      stderrBytes: 0,
    },
    id: digest(["session", "recheck"]),
    commandExecutionId: digest(["goal", 2, "recheck"]),
  };
  verify.outputHash = digest(verify.output);
  const compiled = compileNobodyInspection(command)!;
  const run = {
    ...execution,
    id: verify.commandExecutionId,
    generation: 2,
    readOnly: true,
    status: "completed",
    command: compiled.command,
    nobodyInspection: { directory, inventoryDepth: 4 },
    commandHash: digest(compiled.command),
    result: {
      ...execution.result,
      status: "completed",
      exitCode: 0,
      stderr: { text: "", truncated: false, bytes: 0 },
    },
  };
  return { ...f, directory, verify, run };
}

test("cwd inventory requires explicit human confirmation and immutable same-directory follow-up; never upgrades or replays original", async (t) => {
  const f = await inventoryFixture(t),
    { store, recovery, ledger, operation, run, verify } = f;
  const original = structuredClone(operation);
  assert.equal(await recovery.verify("project"), 0);
  assert.equal(ledger.unresolved("goal"), true);
  await assert.rejects(recovery.reviewInfo("else", operation.id), /会话/);
  const before = await recovery.reviewInfo("session", operation.id);
  assert.ok(before.eligible);
  assert.deepEqual(before.evidence, []);
  store.put("superOperations", verify.id, verify);
  store.put("commandExecutions", run.id, run);
  const ready = await recovery.reviewInfo("session", operation.id);
  assert.equal(ready.evidence.length, 1);
  assert.equal(ready.evidence[0]!.operationId, verify.id);
  const submit = {
    confirmNoWrite: true,
    evidenceOperationId: verify.id,
    revision: ready.revision,
    note: "独立重采与命令/目录状态一致。",
  };
  await assert.rejects(
    recovery.confirmInventoryReview(
      "session",
      operation.id,
      { ...submit, confirmNoWrite: false },
      () => {},
    ),
  );
  await assert.rejects(
    recovery.confirmInventoryReview(
      "session",
      operation.id,
      { ...submit, revision: before.revision },
      () => {},
    ),
  );
  await assert.rejects(
    recovery.confirmInventoryReview(
      "session",
      operation.id,
      { ...submit, evidenceOperationId: "foreign" },
      () => {},
    ),
  );
  await assert.rejects(
    recovery.confirmInventoryReview("session", operation.id, submit, () => {
      throw Error("permission changed");
    }),
  );
  assert.equal(ledger.unresolved("goal"), true);
  const revalidate = (id: string, task: string, generation: number) =>
    assert.deepEqual([id, task, generation], [run.id, verify.goalId, 2]);
  assert.equal(
    (
      await recovery.confirmInventoryReview(
        "session",
        operation.id,
        submit,
        revalidate,
      )
    ).resolved,
    true,
  );
  await recovery.confirmInventoryReview(
    "session",
    operation.id,
    submit,
    revalidate,
  );
  assert.equal(store.list("commandReadReconciliations").length, 1);
  assert.equal(ledger.unresolved("goal"), false);
  assert.deepEqual(store.get("superOperations", operation.id), original);
  assert.equal(store.list("superAcceptance").length, 0);
  assert.equal(recovery.resolution(original)?.sourceKind, "user_action");
  store.put("commandExecutions", run.id, {
    ...run,
    result: { ...run.result, exitCode: 3 },
  });
  assert.equal(ledger.unresolved("goal"), true);
});

test("other mutations, wrong failures, incomplete historical data and unrelated validation cannot qualify for this review", async (t) => {
  const f = await inventoryFixture(t),
    { recovery, store, operation, execution, verify, run, part } = f;
  for (const altered of [
    { ...execution, workerId: "foreign" },
    {
      ...execution,
      result: {
        ...execution.result,
        stderr: { ...execution.result.stderr, truncated: true },
      },
    },
  ]) {
    store.put("commandExecutions", execution.id!, altered);
    assert.equal(
      (await recovery.reviewInfo("session", operation.id)).eligible,
      false,
    );
  }
  store.put("commandExecutions", execution.id!, {
    ...execution,
    command: execution.commandHash + "; rm -f /tmp/x",
  });
  assert.equal(
    (await recovery.reviewInfo("session", operation.id)).eligible,
    false,
  );
  store.put("commandExecutions", execution.id!, execution);
  const old = part.state.output;
  part.state.output = "Exit code 1";
  assert.equal(
    (await recovery.reviewInfo("session", operation.id)).eligible,
    false,
  );
  part.state.output = old;
  store.put("superOperations", verify.id, verify);
  for (const altered of [
    {
      ...run,
      nobodyInspection: {
        directory: "/tmp/lake-ops-JD-other",
        inventoryDepth: 4,
      },
    },
    { ...run, nobodyInspection: { directory: f.directory, inventoryDepth: 3 } },
    { ...run, resourceId: "foreign" },
    { ...run, result: { ...run.result, cancelled: true } },
    { ...run, command: run.command + "; touch /tmp/leak" },
  ]) {
    store.put("commandExecutions", run.id, altered);
    assert.deepEqual(
      (await recovery.reviewInfo("session", operation.id)).evidence,
      [],
    );
  }
});

test("review accepts resource pins only for the exact archived project, target and ledger revision", async (t) => {
  const f = await inventoryFixture(t);
  for (const [projectId, resourceId, revision, expected] of [
    ["other", "host", "configuration", false],
    ["project", "different", "configuration", false],
    ["project", "host", "stale", false],
    ["project", "host", "configuration", true],
  ] as const) {
    f.input.configuration_revision = issueResourcePin(
      f.store,
      { projectId, id: resourceId },
      revision,
    )!;
    f.operation.argsHash = digest(f.input);
    f.store.put("superOperations", f.operation.id, f.operation);
    assert.equal(
      (await f.recovery.reviewInfo("session", f.operation.id)).eligible,
      expected,
    );
  }
});

test("historical command discovery can resolve a valid issued revision pin", async (t) => {
  const f = await fixture(t);
  f.input.configuration_revision = issueResourcePin(
    f.store,
    { projectId: "project", id: "host" },
    "configuration",
  )!;
  f.operation.argsHash = digest(f.input);
  f.store.put("superOperations", f.operation.id, f.operation);
  assert.equal(await f.recovery.verify("project"), 1);
});

test("SSH dispatches the compiled identity inspection directly and retains original permission checks", async (t) => {
  const { store, input } = await inventoryFixture(t);
  store.put("resources", "host", {
    id: "host",
    projectId: "project",
    kind: "ssh",
    status: "available",
  });
  const commands: string[] = [],
    permissionChecks: boolean[] = [];
  const connection = Object.assign(new EventEmitter(), {
    end() {},
    exec(command: string, callback: (error: null, stream: any) => void) {
      commands.push(command);
      const stream = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        close() {},
      });
      callback(null, stream);
      queueMicrotask(() => {
        stream.emit("data", Buffer.from("finished\n"));
        stream.emit("exit", 0);
        stream.emit("close");
      });
    },
  });
  const host = new LakeExecution(
    store,
    {
      command: (_project: string, _resource: string, readOnly: boolean) => {
        permissionChecks.push(readOnly);
        return "allow";
      },
    } as any,
    { revision: () => "configuration", connect: async () => connection } as any,
    (value) => value,
  );
  const scope = "/tmp/lake-ops-UK-fixture";
  assert.equal(host.plan("project",input,["inspect "+scope+"-other"]).readOnly,false);
  const plan = host.plan("project", input, ["inspect "+scope]);
  assert.equal(plan.readOnly, true);
  assert.equal(plan.risk, "write");
  const actor = {
    sessionId: "session",
    taskId: "goal",
    workerId: "worker",
    generation: 2,
    guard() {},
  };
  const result = await host
    .bind({} as any, actor, plan, "transport")
    .run({} as any);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(commands, [plan.nobodyInspection!.command]);
  assert.match(commands[0]!, /^\/usr\/bin\/env -i /);
  const delayInput = {...input, command: "runuser -u nobody -- /bin/sh -c 'sleep 1 && printf \"finished\\n\"'", run_in_background:true};
  const delay = host.plan("project",delayInput);
  assert.equal(delay.readOnly,true);
  assert.equal(delay.risk,"write");
  assert.equal(host.plan("project",{...delayInput,run_in_background:false}).readOnly,false);
  assert.equal(host.plan("project",{...delayInput,cwd:"/tmp"}).readOnly,false);
  const runtime = host.runtime({} as any,actor.sessionId);
  const bound = host.bind(runtime,actor,delay,"delayed");
  const task = await Reflect.get(bound,"runBashWithBackgroundLifecycle")({},{mode:"explicit"});
  assert.equal(task.kind,"backgrounded");
  const done=await Reflect.get(runtime,"waitForBackgroundTask")(task.task.taskId);
  assert.equal(done?.result?.exitCode,0);
  assert.equal(done?.result?.stdout.text,"finished\n");
  assert.deepEqual(commands,[plan.nobodyInspection!.command,delay.command]);
  assert.ok(permissionChecks.length >= 3);
  assert.ok(permissionChecks.every((readOnly) => readOnly === false));
});

test("a human may release distinct work after a verified removal; original failure and cross-task replay stay fenced", async t => {
  const f = await inventoryFixture(t);
  const {store, operation, execution, input, part, directory, verify, run, recovery, ledger} = f;
  const {compileNobodyInspection} = await import("../../web-agent/shared/command-policy");
  const command = "runuser -u nobody -- /bin/bash -c 'cd " + directory +
    " || exit 1; rm -- maintenance || exit 1; test result = expected'";
  input.command = command;
  operation.argsHash = digest(input);
  const out = Object.assign(operation.output as Record<string,unknown>, {stdout: "ready\n", stdoutBytes: 6, stderr: "", stderrBytes: 0});
  operation.outputHash = digest(out);
  Object.assign(execution, {command, commandHash:digest(command)});
  Object.assign(execution.result, {stdout:{text:"ready\n",bytes:6,truncated:false},stderr:{text:"",bytes:0,truncated:false}});
  part.state.output = "Exit code 1\nready";
  store.put("superOperations", operation.id, operation);
  store.put("commandExecutions", execution.id!, execution);
  const check = compileNobodyInspection('runuser -u nobody -- /bin/bash -c \'id; ls -la ' +
    directory + '; find ' + directory + ' -maxdepth 1 -printf "%y %s %p\\n"\'')!;
  Object.assign(run, {command:check.command,commandHash:digest(check.command),nobodyInspection:{directory,inventoryDepth:1}});
  store.put("commandExecutions", run.id, run);
  store.put("superOperations", verify.id, verify);
  const view = await recovery.reviewInfo(operation.sessionId, operation.id);
  assert.equal(view.effects,"observed");
  assert.equal(view.evidence.length,1);
  const req = {revision:view.revision,evidenceOperationId:verify.id,note:"原权限复查了已删除的标志和进程终态。"};
  await assert.rejects(recovery.confirmInventoryReview(operation.sessionId,operation.id,{...req,confirmNoWrite:true},()=>{}), /判定/);
  assert.equal(await recovery.verify(operation.projectId),0);
  await recovery.confirmInventoryReview(operation.sessionId,operation.id,{...req,confirmObservedEffects:true},()=>{});
  assert.equal(recovery.resolution(operation)?.effects,"observed");
  assert.equal(ledger.unresolved(operation.goalId), true);
  assert.equal(store.require<Operation>("superOperations",operation.id).status,"unknown");
  assert.equal(store.list("superAcceptance").length,0);
  const originalGoal = ledger.get(operation.goalId);
  ledger.create({...originalGoal,id:"next",workerId:"other",sessionId:"worker-next",sourceEventId:"another-event"});
  const bind={resourceId:operation.resourceId,readOnly:false};
  const unrelated = (cmd:string,callId:string) => ledger.operation("next",1,"policy",callId,"Bash",{command:cmd},async()=>({exitCode:0}),v=>v,bind);
  await assert.rejects(unrelated(command,"replay"), /禁止重复/);
  await unrelated("a distinct approved operation","another");
  store.put("commandExecutions",run.id,{...run,configurationRevision:"unrelated"});
  assert.equal(recovery.resolution(operation),undefined);
  await assert.rejects(unrelated("new action","later"), /requires reconciliation/);
});
