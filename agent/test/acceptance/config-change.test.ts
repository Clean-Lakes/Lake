import test from "node:test";
import assert from "node:assert/strict";
import { linuxApplication } from "../fixtures/linux-application.js";
async function waitAction(
  h: Awaited<ReturnType<typeof linuxApplication>>,
  id: string,
) {
  for (let i = 0; i < 100; i++) {
    const action = await h.app.store.get<any>("actions", id);
    if (["succeeded", "failed", "unknown", "blocked"].includes(action.status))
      return action;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Action did not settle");
}
test("Linux/systemd configuration replacement, failed verification rollback and drift rejection", async (t) => {
  const h = await linuxApplication();
  t.after(() => h.close());
  const session = await h.createSession();
  const execute = (
    capability: string,
    parameters: Record<string, unknown>,
    callKey: string,
  ) =>
    h.app.gateway.execute(
      {
        sessionId: session.id,
        taskId: session.rootTaskId,
        actor: session.id,
        capability,
        resourceId: h.sshId,
        parameters,
        callKey,
      },
      new AbortController().signal,
    );
  const change = async (content: string, key: string) => {
    const read = await execute(
      "ssh.read_config",
      { path: h.target.configPath },
      key + "-read",
    );
    const hash = (read.data as any).execution.hash;
    const proposal = await execute(
      "ssh.propose_config",
      { path: h.target.configPath, expectedHash: hash, content },
      key + "-proposal",
    );
    const artifactId = (proposal.data as any).execution.artifactId;
    const waiting = await execute(
      "ssh.replace_config",
      {
        path: h.target.configPath,
        expectedHash: hash,
        artifactId,
        rollback: true,
      },
      key + "-change",
    );
    assert.equal(waiting.status, "waiting");
    const action = await h.app.store.get<any>("actions", waiting.actionId!);
    await h.app.approve(action.id, action.proposalDigest);
    return action.id;
  };
  const successId = await change(
    JSON.stringify({ message: "fixture-ok updated", healthy: true }),
    "valid",
  );
  const success = await waitAction(h, successId);
  assert.equal(success.status, "succeeded", JSON.stringify(success.result));
  assert(
    (await h.target.exec(["cat", h.target.configPath])).includes("updated"),
  );
  assert.equal(
    (await h.app.gate.evaluate(session.rootTaskId)).status,
    "verified",
  );
  assert.equal(
    await h.target.exec([
      "stat",
      "-c",
      "%a",
      h.target.configPath + ".lake-backup-" + successId,
    ]),
    "600",
  );
  const failedId = await change(
    JSON.stringify({ message: "bad change", healthy: false }),
    "rollback",
  );
  const failed = await waitAction(h, failedId);
  assert.equal(failed.status, "failed", JSON.stringify(failed.result));
  assert.equal(failed.result.data.rolledBack, true);
  assert(
    (await h.target.exec(["cat", h.target.configPath])).includes("updated"),
  );
  assert.equal(
    await h.target.exec(["stat", "-c", "%a", h.target.configPath]),
    "644",
  );
  assert.equal(
    (await h.app.gate.evaluate(session.rootTaskId)).status,
    "blocked",
  );
  const driftId = await change(
    JSON.stringify({ message: "pending-drift", healthy: false }),
    "drift",
  );
  for (let i = 0; i < 50; i++) {
    if (
      (await h.target.exec(["cat", h.target.configPath])).includes(
        "pending-drift",
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 30));
  }
  await h.target.exec([
    "python3",
    "-c",
    `import json;json.dump({'message':'external-change','healthy':True},open('${h.target.configPath}','w'))`,
  ]);
  const drift = await waitAction(h, driftId);
  assert.equal(drift.status, "failed");
  assert(
    (await h.target.exec(["cat", h.target.configPath])).includes(
      "external-change",
    ),
  );
  assert.equal(drift.result.error.code, "precondition_failed");
});
