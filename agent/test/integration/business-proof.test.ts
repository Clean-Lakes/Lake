import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { testApplication } from "../fixtures/application.js";
test("read-only health windows satisfy business criteria, but prior contract proofs cannot satisfy new instructions", async (t) => {
  const server = createServer((_req, res) => res.end("fixture-ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const h = await testApplication(undefined, false);
  t.after(async () => {
    await h.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const id = randomUUID(),
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await h.app.importResources({
    resources: [
      {
        id,
        lakeId: h.lakeId,
        environmentId: h.environmentId,
        kind: "http",
        name: "Healthy fixture",
        endpoint,
        identity: endpoint,
      },
    ],
  });
  await h.app.importServices([
    {
      id: randomUUID(),
      lakeId: h.lakeId,
      environmentId: h.environmentId,
      name: "Fixture",
      resourceBindings: [{ resourceId: id, locator: {} }],
      health: {
        url: endpoint,
        bodyIncludes: "fixture-ok",
        intervalMs: 10,
        timeoutMs: 200,
        maxWaitMs: 500,
        successes: 3,
      },
    },
  ]);
  await h.app.grants.create(id, ["read"], "local-user");
  const session = await h.app.createSession({
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    objective: "Verify recovery",
    intent: "recover",
    resourceIds: [id],
  });
  const execute = (key: string) =>
    h.app.gateway.execute(
      {
        sessionId: session.id,
        taskId: session.rootTaskId,
        actor: session.id,
        capability: "http-health.health_window",
        resourceId: id,
        parameters: {},
        callKey: key,
      },
      new AbortController().signal,
    );
  assert.equal((await execute("initial")).status, "ok");
  assert.equal(
    (await h.app.gate.evaluate(session.rootTaskId)).status,
    "verified",
  );
  const task = await h.app.store.get<any>("tasks", session.rootTaskId);
  await h.app.store.transact([
    {
      op: "put",
      table: "tasks",
      value: {
        ...task,
        revision: task.revision + 1,
        contractRevision: 2,
        constraints: ["Collect a fresh health window"],
      },
      expectedRevision: task.revision,
    },
  ]);
  assert.equal(
    (await h.app.gate.evaluate(session.rootTaskId)).status,
    "blocked",
  );
  await execute("fresh");
  assert.equal(
    (await h.app.gate.evaluate(session.rootTaskId)).status,
    "verified",
  );
});
