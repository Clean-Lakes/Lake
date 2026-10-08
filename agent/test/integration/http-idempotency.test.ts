import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testApplication } from "../fixtures/application.js";
import { createHttpServer } from "../../src/surfaces/http-server.js";
test("request IDs bind the exact input and creation has one durable effect", async (t) => {
  const h = await testApplication(),
    http = await createHttpServer(h.app);
  t.after(async () => {
    await http.close();
    await h.close();
  });
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
  const body = {
    requestId: randomUUID(),
    expectedRevision: 0,
    data: { resourceId, effects: ["read"] },
  };
  const send = (b: any) =>
    fetch(http.origin + "/api/v1/grants", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + http.auth.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(b),
    });
  const first = await send(body),
    second = await send(body);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), await second.json());
  assert.equal((await h.app.store.list("resource_grants")).length, 1);
  assert.equal(
    (await send({ ...body, data: { resourceId, effects: ["change"] } })).status,
    409,
  );
});
