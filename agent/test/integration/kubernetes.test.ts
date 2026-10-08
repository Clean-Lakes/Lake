import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testHome } from "../fixtures/home.js";
import { startKubeApi } from "../fixtures/kube-api.js";
import { KubeAdapter } from "../../src/adapters/kubernetes.js";
import type { Resource } from "../../src/domain/entities.js";
test("real kubectl reads only its bound context and namespace, Secret and exec plugins are rejected", async (t) => {
  const h = await testHome(),
    api = await startKubeApi();
  t.after(async () => {
    await api.close();
    await h.close();
  });
  const config = {
    apiVersion: "v1",
    kind: "Config",
    clusters: [{ name: "fixture", cluster: { server: api.endpoint } }],
    contexts: [
      {
        name: "fixture",
        context: { cluster: "fixture", user: "fixture", namespace: "test" },
      },
    ],
    users: [{ name: "fixture", user: {} }],
    "current-context": "fixture",
  };
  await h.credentials.import(
    "kubeconfig/fixture",
    Buffer.from(JSON.stringify(config)),
  );
  const resource: Resource = {
    id: randomUUID(),
    revision: 1,
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    kind: "k8s",
    name: "Kube fixture",
    endpoint: api.endpoint,
    identity: "fixture-cluster",
    credentialRef: "kubeconfig/fixture",
    settings: { context: "fixture", namespace: "test" },
  };
  const adapter = new KubeAdapter(h.credentials);
  const result = await adapter.executeRead(
    resource,
    "get",
    { kind: "pod" },
    new AbortController().signal,
  );
  assert.equal(result.status, "ok");
  assert(String((result.data as any).output).includes("fixture-pod"));
  assert(api.requests.includes("/api/v1/namespaces/test/pods"));
  await assert.rejects(
    adapter.executeRead(
      resource,
      "get",
      { kind: "secret" },
      new AbortController().signal,
    ),
  );
  await h.credentials.import(
    "kubeconfig/fixture",
    Buffer.from(
      JSON.stringify({
        ...config,
        users: [
          {
            name: "fixture",
            user: {
              exec: {
                apiVersion: "client.authentication.k8s.io/v1",
                command: "not-trusted",
              },
            },
          },
        ],
      }),
    ),
  );
  await assert.rejects(
    adapter.executeRead(
      resource,
      "get",
      { kind: "pod" },
      new AbortController().signal,
    ),
  );
});
