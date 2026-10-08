import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testApplication } from "../fixtures/application.js";
import { startSshFixture } from "../fixtures/ssh-server.js";
test("human takeover consumes bound approval, blocks other writes and invalidates old facts on return", async (t) => {
  const h = await testApplication(),
    ssh = await startSshFixture();
  t.after(async () => {
    await h.close();
    await ssh.close();
  });
  await h.app.credentials.import("ssh/fixture", Buffer.from(ssh.privateKey));
  const resourceId = randomUUID();
  await h.app.importResources({
    resources: [
      {
        id: resourceId,
        lakeId: h.lakeId,
        environmentId: h.environmentId,
        kind: "ssh",
        name: "Fixture",
        endpoint: ssh.endpoint,
        identity: ssh.identity,
        credentialRef: "ssh/fixture",
        settings: { username: "fixture", units: ["fixture.service"] },
      },
    ],
  });
  const session = await h.app.createSession({
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    objective: "Inspect fixture",
    resourceIds: [resourceId],
  });
  const grant = await h.app.grants.create(
    resourceId,
    ["read", "interactive"],
    "local-user",
  );
  const resource = await h.app.store.get<any>("resources", resourceId),
    terminal = await h.app.sessions.open(session.id, resource, "ssh");
  const epoch = await h.app.requestControl(terminal.id);
  const current = await h.app.store.get<any>("execution_sessions", terminal.id);
  const approval = await h.app.store.get<any>(
    "approvals",
    current.controlApprovalId,
  );
  assert.equal(approval.consumedUses, 1);
  await assert.rejects(h.app.handoff.grantHandoff(terminal.id, "local-user"));
  await assert.rejects(
    h.app.locks.acquireOrdered([resourceId], "other-writer", "write"),
  );
  await h.app.terminalInput(terminal.id, "fixture-input\n", epoch);
  await assert.rejects(
    h.app.terminalInput(terminal.id, "old-input", epoch - 1),
  );
  await h.app.handoff.expireLeases(Date.now() + 600001);
  const expired = await h.app.store.get<any>("execution_sessions", terminal.id);
  assert(expired.controlExpiredAt);
  assert.equal(expired.paused, true);
  await assert.rejects(h.app.terminalInput(terminal.id, "after-expiry", epoch));
  await assert.rejects(
    h.app.locks.acquireOrdered([resourceId], "after-expiry-writer", "write"),
  );
  await h.app.handoff.returnToManaged(terminal.id, "local-user", true);
  const returned = await h.app.store.get<any>(
    "execution_sessions",
    terminal.id,
  );
  assert.equal(returned.mode, "managed");
  assert(returned.inputEpoch > epoch);
  await h.app.grants.revoke(grant.id, "local-user");
  await assert.rejects(h.app.handoff.requestHandoff(terminal.id, "local-user"));
});
