import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testHome } from "../fixtures/home.js";
import { startSshFixture } from "../fixtures/ssh-server.js";
import { SshAdapter } from "../../src/adapters/ssh.js";
import type { Resource } from "../../src/domain/entities.js";
test("real SSH exec checks host identity and preserves command result boundaries", async (t) => {
  const h = await testHome(),
    server = await startSshFixture();
  const adapter = new SshAdapter(h.credentials, h.artifacts);
  t.after(async () => {
    await adapter.close();
    await server.close();
    await h.close();
  });
  await h.credentials.import("ssh/fixture", Buffer.from(server.privateKey));
  const resource: Resource = {
    id: randomUUID(),
    revision: 1,
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    kind: "ssh",
    name: "Synthetic SSH",
    endpoint: server.endpoint,
    identity: server.identity,
    credentialRef: "ssh/fixture",
    settings: { username: "fixture", units: ["fixture.service"] },
  };
  const result = await adapter.execute(
    "ssh.service_status",
    resource,
    { unit: "fixture.service" },
    new AbortController().signal,
  );
  assert.equal((result.data as any).exitCode, 0);
  assert(String((result.data as any).stdout).includes("ActiveState=active"));
  await assert.rejects(
    adapter.execute(
      "ssh.service_status",
      resource,
      { unit: "fixture.service; touch anything" },
      new AbortController().signal,
    ),
  );
  const untrusted = {
    ...resource,
    id: randomUUID(),
    identity: "SHA256:invalid",
  };
  await assert.rejects(adapter.connect(untrusted));
  const output: string[] = [];
  const pty = await adapter.openInteractive(resource, (b) =>
    output.push(b.toString()),
  );
  pty.write("echo-fixture\n");
  await new Promise((r) => setTimeout(r, 30));
  pty.close();
  assert(output.join("").includes("echo-fixture"));
  assert(!JSON.stringify(result).includes(server.privateKey));
});
