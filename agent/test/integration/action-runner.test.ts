import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testApplication } from "../fixtures/application.js";
import { sha256 } from "../../src/adapters/workspace.js";
import { ActionRunner } from "../../src/runner/action-runner.js";
import { LakeError } from "../../src/domain/errors.js";
test("delayed approval survives lifecycle revisions; contract change invalidates it", async (t) => {
  const h = await testApplication(undefined, false),
    project = await mkdtemp(join(tmpdir(), "lake-approval-"));
  t.after(async () => {
    await h.close();
    await rm(project, { recursive: true, force: true });
  });
  await writeFile(join(project, "config"), "old");
  const id = randomUUID();
  await h.app.importResources({
    resources: [
      {
        id,
        lakeId: h.lakeId,
        environmentId: h.environmentId,
        kind: "local",
        name: "Patch",
        endpoint: project,
        identity: project,
      },
    ],
  });
  await h.app.grants.create(id, ["read", "change"], "local-user");
  const session = await h.app.createSession({
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    objective: "Patch",
    resourceIds: [id],
  });
  const artifactId = await h.app.artifacts.put(
    JSON.stringify({
      kind: "patch",
      resourceId: id,
      path: "config",
      expectedHash: sha256("old"),
      content: "new",
    }),
    session.id,
  );
  const proposal = {
    sessionId: session.id,
    taskId: session.rootTaskId,
    actor: session.id,
    capability: "local-files.file.apply_patch",
    resourceId: id,
    parameters: { path: "config", expectedHash: sha256("old"), artifactId },
    callKey: "one",
  };
  let a = await h.app.gateway.prepare(proposal);
  await h.app.gateway.authorize(a.id);
  let task = await h.app.store.get<any>("tasks", session.rootTaskId);
  await h.app.store.transact([
    {
      op: "put",
      table: "tasks",
      value: {
        ...task,
        revision: task.revision + 1,
        status: "waiting",
        waitingReason: "approval_required",
      },
      expectedRevision: task.revision,
    },
  ]);
  await h.app.approvals.approve(a.id, a.proposalDigest, "local-user");
  await h.app.gateway.authorize(a.id);
  assert.equal(await h.app.gateway.dispatch(a.id), true);
  assert.equal(
    (await h.app.runner.run(a.id, new AbortController().signal)).status,
    "ok",
  );
  a = await h.app.gateway.prepare({ ...proposal, callKey: "two" });
  await h.app.gateway.authorize(a.id);
  await h.app.approvals.approve(a.id, a.proposalDigest, "local-user");
  await h.app.gateway.authorize(a.id);
  task = await h.app.store.get<any>("tasks", session.rootTaskId);
  await h.app.store.transact([
    {
      op: "put",
      table: "tasks",
      value: {
        ...task,
        revision: task.revision + 1,
        contractRevision: task.contractRevision + 1,
        constraints: ["No further writes"],
      },
      expectedRevision: task.revision,
    },
  ]);
  await assert.rejects(h.app.gateway.dispatch(a.id));
});

test("queued cancellation has no effect; dispatched cancellation holds unknown quarantine", async (t) => {
  const h = await testApplication(undefined, false),
    project = await mkdtemp(join(tmpdir(), "lake-cancel-"));
  t.after(async () => {
    await h.close();
    await rm(project, { recursive: true, force: true });
  });
  const id = randomUUID();
  await h.app.importResources({
    resources: [
      {
        id,
        lakeId: h.lakeId,
        environmentId: h.environmentId,
        kind: "local",
        name: "Patch",
        endpoint: project,
        identity: project,
      },
    ],
  });
  await h.app.grants.create(id, ["read", "change"], "local-user");
  const session = await h.app.createSession({
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    objective: "Cancel",
    resourceIds: [id],
  });
  const artifactId = await h.app.artifacts.put("fixture", session.id);
  const create = async (key: string) => {
    const a = await h.app.gateway.prepare({
      sessionId: session.id,
      taskId: session.rootTaskId,
      actor: session.id,
      capability: "local-files.file.apply_patch",
      resourceId: id,
      parameters: { path: "config", expectedHash: sha256("old"), artifactId },
      callKey: key,
    });
    await h.app.gateway.authorize(a.id);
    await h.app.approvals.approve(a.id, a.proposalDigest, "local-user");
    await h.app.gateway.authorize(a.id);
    await h.app.gateway.dispatch(a.id);
    return a;
  };
  const queued = await create("queued");
  await h.app.runner.cancel(queued.id);
  assert.equal(
    (await h.app.store.get<any>("actions", queued.id)).status,
    "cancelled",
  );
  assert.equal((await h.app.store.list("action_attempts")).length, 0);
  const active = await create("active");
  let dispatchSeen = false;
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const runner = new ActionRunner(
    h.app.store,
    {
      execute: async (_cap, _r, _p, signal) => {
        dispatchSeen =
          (await h.app.store.get<any>("actions", active.id)).status ===
          "dispatched";
        entered();
        await new Promise<void>((_r, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new LakeError("cancelled")),
            { once: true },
          ),
        );
        throw new Error("unreachable");
      },
    },
    {
      run: async () => {
        throw new Error("Uncertain execution cannot verify");
      },
    },
    (r) => r,
    async () => {},
  );
  const running = runner.run(active.id, new AbortController().signal);
  await ready;
  await runner.cancel(active.id);
  const result = await running;
  assert(dispatchSeen);
  assert.equal(result.status, "waiting");
  assert.equal(
    (await h.app.store.get<any>("actions", active.id)).status,
    "unknown",
  );
  await assert.rejects(h.app.locks.acquireOrdered([id], "new-writer", "write"));
});
