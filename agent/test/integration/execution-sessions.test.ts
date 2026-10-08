import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testApplication } from "../fixtures/application.js";
test("logical terminal survives connection loss without restoring an old input lease", async (t) => {
  const h = await testApplication();
  t.after(() => h.close());
  const id = randomUUID();
  await h.app.importResources({
    resources: [
      {
        id,
        lakeId: h.lakeId,
        environmentId: h.environmentId,
        kind: "http",
        name: "Fixture",
        endpoint: "http://127.0.0.1:1",
        identity: "fixture",
      },
    ],
  });
  const a = await h.app.createSession({
      lakeId: h.lakeId,
      environmentId: h.environmentId,
      objective: "Inspect",
      resourceIds: [id],
    }),
    b = await h.app.createSession({
      lakeId: h.lakeId,
      environmentId: h.environmentId,
      objective: "Inspect other",
      resourceIds: [id],
    });
  const r = await h.app.store.get<any>("resources", id),
    terminal = await h.app.sessions.open(a.id, r, "http-health");
  await h.app.output.appendOutput(terminal.id, "recorded history");
  await assert.rejects(h.app.sessions.attach(b.id, terminal.id));
  const old = await h.app.store.get<any>("execution_sessions", terminal.id);
  await h.app.store.transact([
    {
      op: "put",
      table: "execution_sessions",
      value: {
        ...old,
        revision: old.revision + 1,
        status: "disconnected",
        inputHolder: "old-worker",
        inputExpiresAt: new Date().toISOString(),
      },
      expectedRevision: old.revision,
    },
  ]);
  const reopened = await h.app.sessions.open(
    a.id,
    r,
    "http-health",
    terminal.id,
  );
  assert.equal(reopened.id, terminal.id);
  assert.equal(reopened.status, "ready");
  assert.equal(reopened.inputHolder, null);
  assert(reopened.inputEpoch > old.inputEpoch);
  assert.equal((await h.app.sessions.read(a.id, terminal.id)).length, 1);
});
