import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { startModelFixture } from "../fixtures/model-server.js";
import { testApplication } from "../fixtures/application.js";
import { makeIncidentScenario } from "../fixtures/scenarios/http-service.js";
test("one session uses three real Agent loops, a shared terminal and verified progress", async (t) => {
  const resourceId = randomUUID(),
    stepIds = [randomUUID(), randomUUID(), randomUUID()];
  const health = createServer((_req, res) => res.end("fixture healthy"));
  await new Promise<void>((r) => health.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(health.address() as AddressInfo).port}`;
  const model = await startModelFixture(
    makeIncidentScenario(resourceId, stepIds),
  );
  const h = await testApplication(model.baseUrl);
  t.after(async () => {
    await h.close();
    await model.close();
    await new Promise<void>((r) => health.close(() => r()));
  });
  await h.app.importResources({
    resources: [
      {
        id: resourceId,
        lakeId: h.lakeId,
        environmentId: h.environmentId,
        kind: "http",
        name: "Fixture HTTP",
        endpoint,
        identity: endpoint,
      },
    ],
  });
  await h.app.grants.create(resourceId, ["read"], "local-user");
  const s = await h.app.createSession({
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    objective: "Collect and independently verify fixture HTTP observations",
    resourceIds: [resourceId],
  });
  h.app.startRoot(s.id);
  const end = Date.now() + 20000;
  let snapshot: any;
  while (Date.now() < end) {
    snapshot = await h.app.data.snapshot(s.id);
    const task = snapshot.tasks.find((t: any) => t.id === s.rootTaskId);
    if (["succeeded", "failed", "qualified"].includes(task.status)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const task = snapshot.tasks.find((t: any) => t.id === s.rootTaskId);
  assert.equal(
    task.status,
    "succeeded",
    JSON.stringify({
      task,
      runs: snapshot.specialist_runs.map((r: any) => ({
        state: r.state,
        objective: r.workOrder.objective,
      })),
      actions: snapshot.actions.map((a: any) => ({
        status: a.status,
        result: a.result,
      })),
    }),
  );
  assert.equal(snapshot.specialist_runs.length, 3);
  assert(
    snapshot.specialist_runs.every((r: any) => r.state.status === "succeeded"),
  );
  assert.equal(snapshot.execution_sessions.length, 1);
  assert.equal(
    snapshot.task_steps.filter((s: any) => s.status === "succeeded").length,
    3,
  );
  assert(snapshot.observations.every((o: any) => o.trusted));
  const histories = await h.app.store.list<any>("model_exchanges");
  assert.equal(
    new Set(histories.filter((e) => e.actor !== s.id).map((e) => e.actor)).size,
    3,
  );
  assert(snapshot.session.budget.calls <= 100);
});
