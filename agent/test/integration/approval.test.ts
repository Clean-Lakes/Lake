import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { testApplication } from "../fixtures/application.js";
import { sha256 } from "../../src/adapters/workspace.js";
test("approval digest freezes the exact patch, revoked scope blocks dispatch", async (t) => {
  const h = await testApplication(),
    project = await mkdtemp(join(tmpdir(), "lake-patch-test-"));
  t.after(async () => {
    await h.close();
    await rm(project, { recursive: true, force: true });
  });
  await writeFile(join(project, "config.json"), "old");
  const resourceId = randomUUID();
  await h.app.importResources({
    resources: [
      {
        id: resourceId,
        lakeId: h.lakeId,
        environmentId: h.environmentId,
        kind: "local",
        name: "Patch fixture",
        endpoint: project,
        identity: project,
      },
    ],
  });
  const session = await h.app.createSession({
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    objective: "Patch fixture",
    resourceIds: [resourceId],
  });
  const grant = await h.app.grants.create(
    resourceId,
    ["read", "change"],
    "local-user",
  );
  const artifactId = await h.app.artifacts.put(
    JSON.stringify({
      kind: "patch",
      resourceId,
      path: "config.json",
      expectedHash: sha256("old"),
      content: "new",
    }),
    session.id,
  );
  let action = await h.app.gateway.prepare({
    sessionId: session.id,
    taskId: session.rootTaskId,
    actor: session.id,
    capability: "local-files.file.apply_patch",
    resourceId,
    parameters: {
      path: "config.json",
      expectedHash: sha256("old"),
      artifactId,
    },
    callKey: "patch",
  });
  action = await h.app.gateway.authorize(action.id);
  assert.equal(action.status, "waiting_approval");
  await assert.rejects(
    h.app.approvals.approve(action.id, "0".repeat(64), "local-user"),
  );
  await h.app.approvals.approve(action.id, action.proposalDigest, "local-user");
  action = await h.app.gateway.authorize(action.id);
  assert.equal(action.status, "authorized");
  await h.app.grants.revoke(grant.id, "local-user");
  await assert.rejects(h.app.gateway.dispatch(action.id));
});
