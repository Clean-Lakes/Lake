import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testApplication } from "../fixtures/application.js";
import { EvidencePolicy } from "../../src/verification/evidence-policy.js";
import { dispatchRoute } from "../../src/surfaces/routes.js";
test("expired or replaced-identity proofs cannot deliver; optional gaps qualify and manual criteria require user confirmation", async (t) => {
  const h = await testApplication(undefined, false);
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
        identity: "current",
      },
    ],
  });
  const session = await h.app.createSession({
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    objective: "Check",
    resourceIds: [id],
    acceptanceCriteria: [
      {
        id: "business",
        label: "HTTP healthy",
        type: "http_health",
        required: true,
        resourceId: id,
      },
      {
        id: "optional",
        label: "Extra check",
        type: "observation",
        required: false,
      },
      {
        id: "human",
        label: "Business signoff",
        type: "manual",
        required: true,
      },
    ],
  });
  const evidence = {
    id: randomUUID(),
    revision: 1,
    sessionId: session.id,
    taskId: session.rootTaskId,
    resourceId: id,
    resourceIdentity: "old",
    criterionId: "business",
    source: "http-service-v1",
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    result: true,
    trusted: true,
  };
  await h.app.store.transact([
    { op: "put", table: "evidence", value: evidence, expectedRevision: 0 },
  ]);
  assert.equal(
    (await h.app.gate.evaluate(session.rootTaskId)).status,
    "blocked",
  );
  assert(
    !new EvidencePolicy().isFresh({
      ...evidence,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    } as any),
  );
  await h.app.store.transact([
    {
      op: "put",
      table: "evidence",
      value: { ...evidence, revision: 2, resourceIdentity: "current" },
      expectedRevision: 1,
    },
  ]);
  let task = await h.app.store.get<any>("tasks", session.rootTaskId);
  await dispatchRoute(
    h.app,
    "POST",
    `tasks/${task.id}/criteria/human/confirm`,
    new URLSearchParams(),
    {
      requestId: randomUUID(),
      expectedRevision: task.revision,
      data: { confirmed: true },
    },
  );
  assert.equal(
    (await h.app.gate.evaluate(session.rootTaskId)).status,
    "qualified",
  );
  const action = {
    id: randomUUID(),
    revision: 1,
    sessionId: session.id,
    taskId: task.id,
    actor: session.id,
    capability: "ssh.service_action",
    effect: "change",
    targets: [{ id, identity: "current", revision: 1 }],
    status: "waiting_approval",
  };
  await h.app.store.transact([
    { op: "put", table: "actions", value: action, expectedRevision: 0 },
  ]);
  assert(
    (await h.app.gate.evaluate(session.rootTaskId)).gaps.includes(
      "unsettled_action",
    ),
  );
});
