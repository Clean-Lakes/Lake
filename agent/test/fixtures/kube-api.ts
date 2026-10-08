import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
export async function startKubeApi() {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(path);
    const resources = [
      {
        name: "pods",
        singularName: "pod",
        namespaced: true,
        kind: "Pod",
        verbs: ["get", "list"],
      },
      {
        name: "services",
        singularName: "service",
        namespaced: true,
        kind: "Service",
        verbs: ["get", "list"],
      },
      {
        name: "events",
        singularName: "event",
        namespaced: true,
        kind: "Event",
        verbs: ["get", "list"],
      },
    ];
    let data: unknown;
    if (path === "/version")
      data = { major: "1", minor: "34", gitVersion: "v1.34.0" };
    else if (path === "/api")
      data = {
        kind: "APIVersions",
        apiVersion: "v1",
        versions: ["v1"],
        serverAddressByClientCIDRs: [],
      };
    else if (path === "/apis")
      data = { kind: "APIGroupList", apiVersion: "v1", groups: [] };
    else if (path === "/api/v1")
      data = { kind: "APIResourceList", groupVersion: "v1", resources };
    else if (path === "/api/v1/namespaces/test/pods")
      data = {
        apiVersion: "v1",
        kind: "PodList",
        metadata: { resourceVersion: "1" },
        items: [
          {
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
              name: "fixture-pod",
              namespace: "test",
              resourceVersion: "1",
            },
            spec: { containers: [{ name: "fixture", image: "fixture:1" }] },
            status: { phase: "Running" },
          },
        ],
      };
    else if (path === "/api/v1/namespaces/test/pods/fixture-pod/log") {
      res.end("fixture log line\n");
      return;
    } else if (path === "/api/v1/namespaces/test/events")
      data = { apiVersion: "v1", kind: "EventList", items: [] };
    else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          apiVersion: "v1",
          kind: "Status",
          status: "Failure",
          reason: "NotFound",
          code: 404,
        }),
      );
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
