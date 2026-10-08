import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testApplication } from "../fixtures/application.js";
import { recordObservation } from "../../src/app/investigation.js";
test("model-authored observations do not satisfy business completion", async (t) => {
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
  const s = await h.app.createSession({
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    objective: "Verify fixture",
    resourceIds: [resourceId],
  });
  await recordObservation(h.app.store, s.id, s.rootTaskId, resourceId, {
    healthy: true,
  });
  const result = await h.app.gate.evaluate(s.rootTaskId);
  assert.equal(result.status, "blocked");
  assert(result.gaps.includes("sourced-findings"));
});
