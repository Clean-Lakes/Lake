import { randomUUID } from "node:crypto";
import { testApplication } from "./application.js";
import { startLinuxTarget } from "./linux-target.js";
export async function linuxApplication(baseUrl?: string, background = true) {
  const target = await startLinuxTarget(),
    h = await testApplication(baseUrl, background);
  const sshId = randomUUID(),
    httpId = randomUUID(),
    serviceId = randomUUID();
  await h.app.credentials.import("ssh/fixture", Buffer.from(target.privateKey));
  await h.app.importResources({
    resources: [
      {
        id: sshId,
        lakeId: h.lakeId,
        environmentId: h.environmentId,
        kind: "ssh",
        name: "Linux fixture",
        endpoint: target.endpoint,
        identity: target.identity,
        credentialRef: "ssh/fixture",
        settings: {
          username: "root",
          units: [target.unit],
          configs: {
            [target.configPath]: {
              checkArgv: ["/usr/bin/python3", "-m", "json.tool", "{{file}}"],
              unit: target.unit,
              action: "reload",
            },
          },
        },
      },
      {
        id: httpId,
        lakeId: h.lakeId,
        environmentId: h.environmentId,
        kind: "http",
        name: "HTTP fixture",
        endpoint: target.healthUrl,
        identity: target.healthUrl,
      },
    ],
  });
  await h.app.importServices([
    {
      id: serviceId,
      lakeId: h.lakeId,
      environmentId: h.environmentId,
      name: "Fixture service",
      resourceBindings: [
        { resourceId: sshId, locator: { unit: target.unit } },
        { resourceId: httpId, locator: {} },
      ],
      health: {
        url: target.healthUrl,
        statuses: [200],
        bodyIncludes: "fixture-ok",
        intervalMs: 30,
        maxWaitMs: 1000,
        timeoutMs: 500,
        successes: 3,
      },
    },
  ]);
  await h.app.grants.create(sshId, ["read", "change"], "local-user");
  await h.app.grants.create(httpId, ["read"], "local-user");
  const createSession = () =>
    h.app.createSession({
      lakeId: h.lakeId,
      environmentId: h.environmentId,
      objective: "Change and verify the HTTP service configuration",
      resourceIds: [sshId, httpId],
      acceptanceCriteria: [
        {
          id: "healthy",
          label: "Business HTTP healthy",
          type: "http_health",
          required: true,
          resourceId: httpId,
        },
      ],
    });
  return {
    ...h,
    target,
    sshId,
    httpId,
    serviceId,
    createSession,
    async close() {
      await h.close();
      await target.close();
    },
  };
}
