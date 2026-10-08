import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { testApplication } from "../fixtures/application.js";
import { sha256 } from "../../src/adapters/workspace.js";
test("cancelled specialist loses queued effects and its safe unfinished step can be claimed by a replacement", async (t) => {
  const h = await testApplication(undefined, false),
    project = await mkdtemp(join(tmpdir(), "lake-specialist-cancel-"));
  t.after(async () => {
    await h.close();
    await rm(project, { recursive: true, force: true });
  });
  await writeFile(join(project, "config"), "old");
  const resourceId = randomUUID();
  await h.app.importResources({
    resources: [
      {
        id: resourceId,
        lakeId: h.lakeId,
        environmentId: h.environmentId,
        kind: "local",
        name: "Fixture",
        endpoint: project,
        identity: project,
      },
    ],
  });
  await h.app.grants.create(resourceId, ["read", "change"], "local-user");
  const session = await h.app.createSession({
      lakeId: h.lakeId,
      environmentId: h.environmentId,
      objective: "Change",
      resourceIds: [resourceId],
    }),
    [step] = await h.app.progress.plan(
      session.rootTaskId,
      [{ label: "Edit", dependencies: [] }],
      "plan",
    );
  assert(step);
  const worker = await h.app.specialists.spawn(
    session.rootTaskId,
    { objective: "Edit", resourceIds: [resourceId], stepIds: [step.id] },
    "original",
  );
  await h.app.progress.claim(step.id, worker.id, 1);
  const artifactId = await h.app.artifacts.put(
    JSON.stringify({
      kind: "patch",
      resourceId,
      path: "config",
      expectedHash: sha256("old"),
      content: "new",
    }),
    session.id,
  );
  let action = await h.app.gateway.prepare({
    sessionId: session.id,
    taskId: session.rootTaskId,
    actor: worker.id,
    capability: "local-files.file.apply_patch",
    resourceId,
    parameters: { path: "config", expectedHash: sha256("old"), artifactId },
    callKey: "edit",
  });
  await h.app.gateway.authorize(action.id);
  await h.app.approvals.approve(action.id, action.proposalDigest, "local-user");
  await h.app.gateway.authorize(action.id);
  await h.app.gateway.dispatch(action.id);
  await h.app.cancelSpecialist(worker.id);
  assert.equal(
    (await h.app.store.get<any>("actions", action.id)).status,
    "cancelled",
  );
  const released = await h.app.store.get<any>("task_steps", step.id);
  assert.equal(released.status, "pending");
  assert.equal(released.assignee, undefined);
  const replacement = await h.app.specialists.spawn(
    session.rootTaskId,
    { objective: "Edit", resourceIds: [resourceId], stepIds: [step.id] },
    "replacement",
  );
  await h.app.progress.claim(step.id, replacement.id, released.revision);
  assert.equal((await h.app.store.list("action_attempts")).length, 0);
});
