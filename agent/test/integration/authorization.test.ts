import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testApplication } from "../fixtures/application.js";
test("Power enable is not authority, revoked grants and cross-resource scope are rejected", async (t) => {
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
        name: "Probe",
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
  const proposal = {
    sessionId: session.id,
    taskId: session.rootTaskId,
    actor: session.id,
    capability: "http-health.probe",
    resourceId,
    parameters: {},
    callKey: "fixture",
  };
  await assert.rejects(h.app.gateway.prepare(proposal));
  const grant = await h.app.grants.create(resourceId, ["read"], "local-user");
  assert((await h.app.gateway.prepare(proposal)).id);
  await h.app.grants.revoke(grant.id, "local-user");
  await assert.rejects(
    h.app.gateway.prepare({ ...proposal, callKey: "after-revocation" }),
  );
  const snapshots = await h.app.data.snapshot(session.id);
  assert(!JSON.stringify(snapshots).includes("credentialRef"));
});
