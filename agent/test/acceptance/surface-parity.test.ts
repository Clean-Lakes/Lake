import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { testApplication } from "../fixtures/application.js";
import { startModelFixture } from "../fixtures/model-server.js";
import { createHttpServer } from "../../src/surfaces/http-server.js";
test("CLI JSON and API report the same durable task and waiting state", async (t) => {
  const model = await startModelFixture(() => ({
      calls: [{ id: "deliver", name: "task_deliver", arguments: "{}" }],
    })),
    h = await testApplication(model.baseUrl);
  const http = await createHttpServer(h.app);
  t.after(async () => {
    await http.close();
    await h.close();
    await model.close();
  });
  await writeFile(
    join(h.home, "agent/runtime/daemon.json"),
    JSON.stringify({
      origin: http.origin,
      token: http.auth.token,
      nonce: http.auth.nonce,
      pid: process.pid,
    }),
    { mode: 0o600 },
  );
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
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/surfaces/cli.ts",
      "run",
      "--home",
      h.home,
      "--lake",
      h.lakeId,
      "--environment",
      h.environmentId,
      "--resource",
      resourceId,
      "--prompt",
      "Inspect fixture",
      "--json",
    ],
    { cwd: resolveAgent(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  const exit = await new Promise<number | null>((r) => child.on("exit", r));
  assert.equal(exit, 3);
  const result = JSON.parse(output);
  const response = await fetch(
    http.origin + `/api/v1/sessions/${result.sessionId}/snapshot`,
    { headers: { Authorization: "Bearer " + http.auth.token } },
  );
  const snapshot = (await response.json()) as any;
  assert.equal(snapshot.session.id, result.sessionId);
  assert.equal(snapshot.session.rootTaskId, result.taskId);
  assert.equal(snapshot.session.invocation.sandboxMode, "danger-full-access");
  assert.equal(snapshot.session.invocation.bypassApprovals, false);
  assert.equal(snapshot.tasks[0].status, result.status);
  assert(!output.includes(http.auth.token));
});
function resolveAgent() {
  return new URL("../../", import.meta.url).pathname;
}
