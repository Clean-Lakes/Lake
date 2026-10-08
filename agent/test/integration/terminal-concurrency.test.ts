import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testApplication } from "../fixtures/application.js";
test("one terminal has one input holder, another resource writer still cannot race it", async (t) => {
  const h = await testApplication();
  t.after(() => h.close());
  const resourceId = randomUUID();
  await h.app.importResources({
    resources: [
      {
        id: resourceId,
        lakeId: h.lakeId,
        environmentId: h.environmentId,
        kind: "http",
        name: "Fixture",
        endpoint: "http://127.0.0.1:1",
        identity: "fixture",
      },
    ],
  });
  const session = await h.app.createSession({
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    objective: "Inspect fixture",
    resourceIds: [resourceId],
  });
  const resource = await h.app.store.get<any>("resources", resourceId),
    terminal = await h.app.sessions.open(session.id, resource, "http-health");
  const claims = await Promise.allSettled([
    h.app.inputs.claimInput(terminal.id, "worker-a"),
    h.app.inputs.claimInput(terminal.id, "worker-b"),
  ]);
  assert.equal(claims.filter((r) => r.status === "fulfilled").length, 1);
  const row = await h.app.store.get<any>("execution_sessions", terminal.id);
  await assert.rejects(
    h.app.inputs.validate(terminal.id, row.inputHolder, row.inputEpoch - 1),
  );
  await h.app.inputs.release(terminal.id, row.inputHolder, row.inputEpoch);
  await h.app.locks.acquireOrdered([resourceId], "owner-a", "write");
  await assert.rejects(
    h.app.locks.acquireOrdered([resourceId], "owner-b", "write"),
  );
  await h.app.locks.release("owner-a");
  await h.app.locks.acquireOrdered([resourceId], "owner-b", "write");
  await h.app.locks.release("owner-b");
});
