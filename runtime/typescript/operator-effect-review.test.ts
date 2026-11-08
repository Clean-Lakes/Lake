import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { LakeStore } from "./store";
import { digest, type Operation } from "./tasks";
import { sessionArchiveName } from "./session-archive";
import { OperatorEffectReviewService } from "./operator-effect-review";

async function fixture(t: TestContext, background = false, missingExitCode = false) {
  const home = await mkdtemp(join(tmpdir(), "lake-operator-effects-")),
    store = await LakeStore.open(home, join(home, "data"));
  const db = new DatabaseSync(join(store.data, sessionArchiveName));
  db.exec(
    "CREATE TABLE session(id TEXT,project_id TEXT,time_deleted INTEGER);CREATE TABLE message(id TEXT,session_id TEXT,data TEXT);CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,data TEXT)",
  );
  t.after(async () => {
    db.close();
    store.db.close();
    await rm(home, { recursive: true, force: true });
  });
  const root = "/tmp/managed-work",
    started = "2026-01-01T12:00:00Z",
    ended = "2026-01-01T12:01:00Z",
    after = "2026-01-01T12:02:00Z";
  const ssh = {
    hostHash: digest("host"),
    endpointHash: digest("endpoint"),
    addressFamily: 4,
    hostKeys: [{ algorithm: "ssh-ed25519", fingerprint: "SHA256:" + "z".repeat(43) }],
  };
  const config = digest("config"),
    scope = { resourceIds: ["asset"], mentions: [], references: [] };
  store.put("resources", "asset", { id: "asset", projectId: "p", kind: "ssh", status: "available" });
  store.put("messages", "human", { id: "human", role: "user", sessionId: "pilot", text: "请处理 " + root });
  store.put("superInputs", "source", {
    id: "source",
    projectId: "p",
    sessionId: "pilot",
    messageId: "human",
    receivedAt: started,
    payload: "请处理 " + root,
    selectedReferences: scope,
  });
  store.put("messageInputs", "human", { messageId: "human", projectId: "p", sessionId: "pilot", ...scope });
  function make(
    session: string,
    call: string,
    tool: string,
    input: Record<string, unknown>,
    output: unknown,
    modelText: string,
    at: string,
    completedAt: string,
    readOnly: boolean,
  ) {
    db.prepare("INSERT INTO session VALUES(?,?,NULL)").run(session, "p");
    db.prepare("INSERT INTO message VALUES(?,?,?)").run(
      "msg-" + session,
      session,
      JSON.stringify({ role: "assistant" }),
    );
    const part = {
      type: "tool",
      tool,
      callID: call,
      state: { status: "completed", input, output: modelText },
    };
    db.prepare("INSERT INTO part VALUES(?,?,?,?)").run(call, "msg-" + session, session, JSON.stringify(part));
    store.put("sessions", session, { id: session, projectId: "p" });
    store.put("superGoals", session, {
      id: session,
      sessionId: session,
      projectId: "p",
      workerId: "w-" + session,
      sourceEventId: "source",
      acceptanceState: "not_evaluated",
    });
    store.put("superAttempts", "a-" + session, {
      id: "a-" + session,
      goalId: session,
      projectId: "p",
      sessionId: session,
      stepId: "work",
      generation: 1,
      goalRevision: 1,
      planRevision: 1,
      policyHash: "policy",
    });
    const op: Operation = {
      id: digest([session, call]),
      callId: call,
      tool,
      goalId: session,
      projectId: "p",
      sessionId: session,
      generation: 1,
      stepId: "work",
      attemptId: "a-" + session,
      goalRevision: 1,
      planRevision: 1,
      policyHash: "policy",
      resourceId: "asset",
      resourceRevision: 1,
      hostConfigurationHash: config,
      readOnly,
      status: readOnly ? "succeeded" : "unknown",
      argsHash: digest(input),
      at,
      completedAt,
      output,
      outputHash: digest(output),
      ...(!readOnly && { commandExecutionId: digest([session, 1, call]) }),
    };
    store.put("superOperations", op.id, op);
    return { op, part };
  }
  const command = "cd " + root + " && ./deploy",
    handle = "ssh_00000000-0000-4000-8000-000000000001";
  const args = { asset_ref: "asset", configuration_revision: config, command };
  const status = background ? "cancelled" : "failed",
    n = background ? 0 : 1,
    stdout = "deployed\n";
  const result = {
    status,
    ...(!missingExitCode && { exitCode: n }),
    stdout: { text: stdout, bytes: Buffer.byteLength(stdout), truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
    startedAt: started,
    completedAt: ended,
    cancelled: background,
    timedOut: false,
  };
  const foreground = {
    status,
    ...(!missingExitCode && { exitCode: n }),
    stdout,
    stderr: "",
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false,
    interrupted: false,
  };
  const original = make(
    "source-session",
    "bash-call",
    "Bash",
    args,
    background ? result : foreground,
    background
      ? "Command did not complete within its 120s timeout and was moved to the background (ID: " +
          handle +
          "). You will be notified when it completes."
      : "Exit code 1\ndeployed",
    started,
    ended,
    false,
  );
  const run = {
    id: original.op.commandExecutionId!,
    command,
    commandHash: digest(command),
    sessionId: "source-session",
    workerId: "w-source-session",
    taskId: "source-session",
    resourceId: "asset",
    resourceRevision: 1,
    configurationRevision: config,
    generation: 1,
    status,
    startedAt: started,
    finishedAt: ended,
    readOnly: false,
    result,
    authenticatedTarget: ssh,
    ...(background && { backgroundTaskId: handle }),
  };
  store.put("commandExecutions", run.id, run);
  const observation = {
    schemaVersion: 1,
    directory: root,
    startedAt: after,
    observedAt: after,
    complete: true,
    issues: [],
    uid: 99,
    present: true,
    treeSha256: digest("tree"),
    entryCount: 1,
    hashedBytes: 0,
    displayDepth: 3,
    entries: [
      {
        path: ".",
        type: "directory",
        uid: 99,
        gid: 99,
        mode: 0o700,
        size: 4096,
        ino: 11,
        mtimeUs: 12,
        treeSha256: digest("tree"),
      },
    ],
    processes: [],
  };
  const envelope = {
    resourceId: "asset",
    configurationRevision: config,
    hostFingerprint: ssh.hostKeys[0]!.fingerprint,
    authenticatedTarget: ssh,
    profileVersion: 1,
    metric: "directory_state",
    profileId: "lake.host.directory-state",
    exitCode: 0,
    observedAt: after,
    output: JSON.stringify(observation),
  };
  const evidence = make(
    "new-session",
    "inspect-call",
    "inspect_host",
    {
      asset_ref: "asset",
      configuration_revision: config,
      metric: "directory_state",
      observation_directory: root,
    },
    envelope,
    JSON.stringify(envelope),
    after,
    after,
    true,
  );
  const flags = { live: false, changed: false };
  const svc = new OperatorEffectReviewService(
    store,
    { getSession: async (sid) => ({ id: sid, projectID: "p", time: {} }) as any },
    () => {
      if (flags.changed) throw new Error("Changed current peer");
    },
    () => flags.live,
  );
  const inspect = () => svc.reviewInfo(original.op.sessionId, original.op.id);
  const submit = async (closure = false, effects: "none" | "observed" = "observed") =>
    svc.confirm(original.op.sessionId, original.op.id, {
      revision: (await inspect()).revision!,
      directory: root,
      evidenceOperationId: evidence.op.id,
      effects,
      actualEffects: "Inspected the updated service",
      processDisposition: "Wrapper exited; retained verified service transferred to operator",
      remainingWork: "No unaccounted remote jobs",
      operatorName: "QA operator",
      note: "Checked the original and independent observation",
      confirmAllEffectsKnown: true,
      confirmRemoteProcessesAccounted: true,
      confirmSourceRead: true,
      ...(closure && { reconcileRisk: true as const }),
    });
  return { db, store, original, evidence, run, root, svc, inspect, submit, flags };
}

for (const background of [false, true])
  test(
    "separate operator effect and closure bind immutable " +
      (background ? "background" : "foreground") +
      " SSH receipts",
    async (t) => {
      const f = await fixture(t, background);
      const v = await f.inspect();
      assert.equal(v.eligible, true);
      assert.deepEqual(v.directories, [f.root]);
      assert.equal(v.evidence[0]?.operationId, f.evidence.op.id);
      await assert.rejects(f.submit(true), /先独立登记/);
      await f.submit();
      assert.equal(f.svc.resolution(f.original.op), undefined);
      const first = f.store.require("commandOperatorEffectReviews", f.original.op.id);
      assert.equal((await f.inspect()).closureEligible, true);
      await assert.rejects(f.submit(true, "none"), /不能改判/);
      await f.submit(true);
      assert.deepEqual(f.svc.resolution(f.original.op)?.replayScopes, [f.root]);
      assert.equal((await f.inspect()).closureState, "reconciled");
      assert.deepEqual(f.store.require("commandOperatorEffectReviews", f.original.op.id), first);
      assert.deepEqual(f.store.require("superOperations", f.original.op.id), f.original.op);
      assert.deepEqual(f.store.require("commandExecutions", f.run.id), f.run);
      assert.equal(f.store.list("superAcceptance").length, 0);
      const closure = f.store.require<any>("commandOperatorEffectClosures", f.original.op.id);
      f.store.put("commandOperatorEffectClosures", f.original.op.id, { ...closure, evidenceHash: "altered" });
      assert.equal((await f.inspect()).revision, undefined);
      assert.equal(f.svc.resolution(f.original.op), undefined);
      f.store.put("commandOperatorEffectClosures", f.original.op.id, closure);
      f.flags.live = true;
      assert.equal(f.svc.resolution(f.original.op), undefined);
      f.flags.live = false;
      f.flags.changed = true;
      assert.equal(f.svc.resolution(f.original.op), undefined);
      f.flags.changed = false;
      f.db
        .prepare("UPDATE part SET data=json_set(data,'$.state.output','changed') WHERE id=?")
        .run("inspect-call");
      assert.equal(f.svc.resolution(f.original.op), undefined);
    },
  );

test("unknown transport, repeated SDK calls and stale fingerprint cannot sign an effect review", async (t) => {
  const f = await fixture(t, true);
  assert.equal((await f.inspect()).eligible, true);
  const { authenticatedTarget: _peer, ...record } = f.run;
  f.store.put("commandExecutions", record.id, record);
  assert.equal((await f.inspect()).eligible, false);
  f.store.put("commandExecutions", record.id, f.run);
  f.db.exec("INSERT INTO part SELECT * FROM part WHERE id='bash-call'");
  assert.equal((await f.inspect()).eligible, false);
});
test("the operator must select a complete later same-directory and same-peer observation", async (t) => {
  const f = await fixture(t);
  for (const kind of ["incomplete", "directory", "peer", "revision", "old"]) {
    const op = structuredClone(f.evidence.op);
    const out = op.output as any;
    if (kind === "old") op.at = f.original.op.at;
    if (kind === "revision") op.hostConfigurationHash = "different";
    if (kind === "incomplete")
      out.output = JSON.stringify({ ...JSON.parse(out.output), complete: false, issues: ["capped"] });
    if (kind === "directory")
      out.output = JSON.stringify({ ...JSON.parse(out.output), directory: "/tmp/unrelated" });
    if (kind === "peer") out.authenticatedTarget.hostHash = digest("other");
    op.outputHash = digest(out);
    const part = structuredClone(f.evidence.part);
    part.state.output = JSON.stringify(out);
    f.db.prepare("UPDATE part SET data=? WHERE id='inspect-call'").run(JSON.stringify(part));
    f.store.put("superOperations", op.id, op);
    assert.equal((await f.inspect()).evidence.length, 0, kind);
  }
});

test("frozen input, evidence timing and management ownership cannot be replaced", async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(f.svc.reviewInfo("new-session", f.original.op.id), /当前会话/);
  const originalPart = structuredClone(f.original.part);
  f.db.prepare("UPDATE part SET data=? WHERE id='bash-call'").run(
    JSON.stringify({
      ...originalPart,
      state: { ...originalPart.state, output: "background execution with a different handle" },
    }),
  );
  assert.equal((await f.inspect()).eligible, false);
  f.db.prepare("UPDATE part SET data=? WHERE id='bash-call'").run(JSON.stringify(originalPart));
  const first = (await f.inspect()).revision!;
  f.store.put("superOperations", f.evidence.op.id, { ...f.evidence.op, status: "unknown" });
  await assert.rejects(
    f.svc.confirm(f.original.op.sessionId, f.original.op.id, {
      revision: first,
      directory: f.root,
      evidenceOperationId: f.evidence.op.id,
      effects: "none",
      actualEffects: "observed",
      processDisposition: "checked",
      remainingWork: "none",
      operatorName: "QA",
      note: "compared evidence",
      confirmSourceRead: true,
      confirmAllEffectsKnown: true,
      confirmRemoteProcessesAccounted: true,
    }),
    /已变化/,
  );
  f.store.put("superOperations", f.evidence.op.id, f.evidence.op);
  f.store.put("commandReadReconciliations", f.original.op.id, { effects: "none" });
  assert.equal((await f.inspect()).eligible, false);
});

test("SSH cancellation may lack a remote exit code; a foreground failure requires a recorded nonzero exit", async (t) => {
  const cancelled = await fixture(t, true, true);
  const view = await cancelled.inspect();
  assert.equal(view.executionStatus, "cancelled");
  assert.equal(view.eligible, true);
  assert.match(view.output!, /退出码 未取得/);
  await cancelled.submit();
  await cancelled.submit(true);
  assert.equal(cancelled.svc.resolution(cancelled.original.op)?.closureState, "reconciled");
  assert.equal(
    Object.hasOwn(cancelled.store.require<any>("commandExecutions", cancelled.run.id).result, "exitCode"),
    false,
  );
  const failed = await fixture(t, false, true);
  assert.equal((await failed.inspect()).eligible, false);
});
