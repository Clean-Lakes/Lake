import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { startModelFixture } from "./model-server.js";
import { makeIncidentScenario } from "./scenarios/http-service.js";
import { testApplication } from "./application.js";
import { createHttpServer } from "../../src/surfaces/http-server.js";
const resourceId = randomUUID(),
  steps = [randomUUID(), randomUUID(), randomUUID()];
const health = createServer((_req, res) =>
  res.end("Lake isolated demo healthy"),
);
await new Promise<void>((r) => health.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${(health.address() as AddressInfo).port}`;
const model = await startModelFixture(makeIncidentScenario(resourceId, steps));
const h = await testApplication(model.baseUrl);
await h.app.importResources({
  resources: [
    {
      id: resourceId,
      lakeId: h.lakeId,
      environmentId: h.environmentId,
      kind: "http",
      name: "隔离 HTTP 演示服务",
      endpoint,
      identity: endpoint,
    },
  ],
});
await h.app.grants.create(resourceId, ["read"], "local-user");
const session = await h.app.createSession({
  lakeId: h.lakeId,
  environmentId: h.environmentId,
  objective: "三位专员共享终端，诊断并验证隔离 HTTP 服务",
  resourceIds: [resourceId],
});
const http = await createHttpServer(h.app, {
  uiRoot: new URL("../../ui/dist", import.meta.url).pathname,
});
h.app.startRoot(session.id);
(http.auth as any).tickets.set(
  "lake-isolated-fixture-login",
  Date.now() + 60000,
);
if (!process.argv.includes("--no-open"))
  spawn("open", [http.origin + "/#bootstrap=lake-isolated-fixture-login"], {
    stdio: "ignore",
  });
console.log(
  JSON.stringify({
    origin: http.origin,
    sessionId: session.id,
    home: h.home,
    mode: "isolated synthetic-model demo",
  }),
);
const stop = async () => {
  await http.close();
  await h.close();
  await model.close();
  await new Promise<void>((r) => health.close(() => r()));
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
