import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testApplication } from "../fixtures/application.js";
import {
  recordObservation,
  updateHypothesis,
} from "../../src/app/investigation.js";
import { buildEvidenceReport } from "../../src/app/report.js";
test("explicit multi-resource services import atomically and conflicting observations remain sourced", async (t) => {
  const h = await testApplication(undefined, false);
  t.after(() => h.close());
  const resources = ["ssh", "k8s", "postgres", "http"].map((kind, i) => ({
    id: randomUUID(),
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    kind,
    name: kind,
    endpoint: [
      "ssh://127.0.0.1:22",
      "https://127.0.0.1:6443",
      "postgres://127.0.0.1:5432/test",
      "http://127.0.0.1:8080",
    ][i],
    identity: kind,
  }));
  await h.app.importResources({ resources });
  const service = {
    id: randomUUID(),
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    name: "Synthetic service",
    resourceBindings: resources.map((r) => ({ resourceId: r.id, locator: {} })),
    dependencies: [],
    health: { url: resources[3]!.endpoint },
  };
  await h.app.importServices([service]);
  const context = (await h.app.data.serviceContext(service.id)) as any;
  assert.equal(context.resources.length, 4);
  await assert.rejects(
    h.app.importServices([
      { ...service, id: randomUUID() },
      {
        ...service,
        id: randomUUID(),
        resourceBindings: [{ resourceId: randomUUID(), locator: {} }],
      },
    ]),
  );
  assert.equal((await h.app.store.list("services")).length, 1);
  const session = await h.app.createSession({
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    objective: "Investigate",
    resourceIds: resources.map((r) => r.id),
  });
  const a = await recordObservation(
      h.app.store,
      session.id,
      session.rootTaskId,
      resources[0]!.id,
      { healthy: true },
    ),
    b = await recordObservation(
      h.app.store,
      session.id,
      session.rootTaskId,
      resources[0]!.id,
      { healthy: false },
    );
  assert.equal((await h.app.store.list("observations")).length, 2);
  await assert.rejects(
    updateHypothesis(h.app.store, {
      sessionId: session.id,
      taskId: session.rootTaskId,
      claim: "Model root cause",
      status: "confirmed",
      supportingEvidence: [a.id],
      refutingEvidence: [b.id],
      nextProbe: "Check independently",
    }),
  );
  const delivery = await h.app.gate.evaluate(session.rootTaskId);
  assert.equal(delivery.status, "blocked");
  const report = (await buildEvidenceReport(
    h.app.store,
    session.rootTaskId,
    delivery,
  )) as any;
  assert.equal(report.findings.length, 2);
  assert(report.findings.every((f: any) => f.trusted === false));
  await assert.rejects(
    h.app.createSession({
      lakeId: h.lakeId,
      environmentId: h.environmentId,
      objective: "Recover",
      intent: "recover",
      resourceIds: [resources[0]!.id],
    }),
  );
  const recovery = await h.app.createSession({
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    objective: "Recover",
    intent: "recover",
    resourceIds: resources.map((r) => r.id),
  });
  assert.equal(
    (await h.app.store.get<any>("tasks", recovery.rootTaskId))
      .acceptanceCriteria[0].type,
    "http_health",
  );
});
