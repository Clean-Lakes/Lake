import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { HttpProbeAdapter } from "../../src/adapters/http-probe.js";
import type { Resource, HealthProfile } from "../../src/domain/entities.js";
test("HTTP validation uses consecutive business success and refuses unbound redirects", async (t) => {
  let count = 0;
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "http://unbound.invalid" }).end();
      return;
    }
    count++;
    res.writeHead(count === 2 ? 500 : 200);
    res.end("healthy fixture");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    resource: Resource = {
      id: randomUUID(),
      revision: 1,
      lakeId: randomUUID(),
      environmentId: randomUUID(),
      kind: "http",
      name: "Fixture",
      endpoint,
      identity: endpoint,
      settings: {},
    };
  const profile: HealthProfile = {
    url: endpoint,
    statuses: [200],
    bodyIncludes: "healthy",
    timeoutMs: 500,
    intervalMs: 10,
    successes: 3,
    maxWaitMs: 1000,
  };
  const adapter = new HttpProbeAdapter(),
    result = await adapter.healthWindow(
      resource,
      profile,
      new AbortController().signal,
    );
  assert.equal((result.data as any).healthy, true);
  assert.equal(count, 5);
  await assert.rejects(
    adapter.probe(
      { ...resource, endpoint: endpoint + "/redirect" },
      undefined,
      new AbortController().signal,
    ),
  );
  await assert.rejects(
    adapter.probe(
      resource,
      { ...profile, url: endpoint + "/different" },
      new AbortController().signal,
    ),
  );
});
