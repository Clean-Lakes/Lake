import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LakeStore } from "./store";
import { digest, TaskLedger, type Operation } from "./tasks";
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
