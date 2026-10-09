import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { testApplication } from "../fixtures/application.js";
import { resolveWorkspaces } from "../../src/app/workspaces.js";
import { startModelFixture } from "../fixtures/model-server.js";
import { dispatchRoute } from "../../src/surfaces/routes.js";
async function workspace(h: any, t: any) {
  const path = h.home + "-workspace";
  await mkdir(path);
  t.after(() => rm(path, { recursive: true, force: true }));
  return { path, scope: await resolveWorkspaces(h.app, [path], "read-only") };
}
test("fixed host probe has real metrics and evidence, zero model calls and no unscoped permission", async (t) => {
  const h = await testApplication(undefined, false);
  t.after(() => h.close());
  const { path } = await workspace(h, t);
  const result = (await h.app.inspectLocalStatus(
    path,
    crypto.randomUUID(),
  )) as any;
  assert.equal(result.modelCalls, 0);
  assert(result.status.cpu.logicalCores > 0);
  assert(result.status.memory.totalBytes > 0);
  assert(result.status.disk.totalBytes > 0);
  assert(result.status.uptimeSeconds >= 0);
  assert.equal(result.status.source, "local-system-status");
  const snap = (await h.app.data.snapshot(result.sessionId)) as any;
  assert.equal(snap.tasks[0].status, "succeeded");
  assert.equal(snap.actions.length, 1);
  assert.equal(snap.observations[0].source, "local-files.system.status");
  assert.equal(snap.specialist_runs.length, 0);
  assert.equal(snap.session.budget.calls, 0);
  const resource = snap.resources[0],
    grant = await h.app.grants.resolve(resource, "read", "local-user");
  const other = await h.app.createSession({
    lakeId: resource.lakeId,
    environmentId: resource.environmentId,
    resourceIds: [resource.id],
    objective: "inspect revoked grant",
    invocation: { sandboxMode: "read-only" },
  });
  await h.app.grants.revoke(grant.id, "local-user");
  await assert.rejects(
    h.app.gateway.prepare({
      sessionId: other.id,
      taskId: other.rootTaskId,
      actor: other.id,
      capability: "local-files.system.status",
      resourceId: resource.id,
      parameters: {},
      callKey: "revoked",
    }),
    { code: "scope_denied" },
  );
});
test("simple status is two actual Agent model turns with schemas and catalogs present on first request", async (t) => {
  let resourceId = "";
  const fixture = await startModelFixture((body, n) => {
    const context = JSON.parse(body.messages[1].content);
    assert(
      context.shared.availablePowers.some((p: any) => p.id === "local-files"),
    );
    assert(
      context.shared.specialistProfiles.some(
        (p: any) => p.id === "sre-general",
      ),
    );
    const spawn = body.tools.find(
      (t: any) => t.function.name === "specialist_spawn",
    );
    assert(
      spawn.function.parameters.properties.profileId.enum.includes(
        "sre-general",
      ),
    );
    if (n === 1) {
      assert(
        body.tools.some(
          (t: any) => t.function.name === "local_files_system_status",
        ),
      );
      assert(
        !body.tools.some(
          (t: any) => t.function.name === "local_files_file_apply_patch",
        ),
      );
      return {
        calls: [
          {
            id: "inspect",
            name: "local_files_system_status",
            arguments: JSON.stringify({ resourceId }),
          },
        ],
      };
    }
    return {
      text: "本机系统状态已检查。",
      calls: [{ id: "deliver", name: "task_deliver", arguments: "{}" }],
    };
  });
  t.after(() => fixture.close());
  const h = await testApplication(fixture.baseUrl, false);
  t.after(() => h.close());
  const { scope } = await workspace(h, t);
  resourceId = scope.resourceIds[0]!;
  const session = await h.app.createSession({
    lakeId: scope.lakeId,
    environmentId: scope.environmentId,
    resourceIds: scope.resourceIds,
    objective: "查看这台Mac本机的系统状态",
    invocation: { sandboxMode: "read-only" },
  });
  h.app.startRoot(session.id);
  const deadline = Date.now() + 5000;
  let snap: any;
  do {
    await new Promise((r) => setTimeout(r, 20));
    snap = await h.app.data.snapshot(session.id);
  } while (snap.tasks[0].status === "active" && Date.now() < deadline);
  assert.equal(snap.tasks[0].status, "succeeded");
  assert.equal(fixture.attempts, 2);
  assert.equal(snap.specialist_runs.length, 0);
  assert.equal(snap.actions[0].status, "succeeded");
  assert.equal(snap.session.budget.calls, 2);
});
test("unclear target asks once and waits; legal general profile ID is spawnable", async (t) => {
  const fixture = await startModelFixture(() => ({
    calls: [
      {
        id: "ask",
        name: "task_request_input",
        arguments: JSON.stringify({
          question: "你要检查本机还是哪台远端服务器？",
        }),
      },
    ],
  }));
  t.after(() => fixture.close());
  const h = await testApplication(fixture.baseUrl, false);
  t.after(() => h.close());
  const { scope } = await workspace(h, t);
  const session = await h.app.createSession({
    lakeId: scope.lakeId,
    environmentId: scope.environmentId,
    resourceIds: scope.resourceIds,
    objective: "查看服务器状态",
  });
  h.app.startRoot(session.id);
  let snap: any;
  const deadline = Date.now() + 5000;
  do {
    await new Promise((r) => setTimeout(r, 20));
    snap = await h.app.data.snapshot(session.id);
  } while (snap.tasks[0].status === "active" && Date.now() < deadline);
  assert.equal(snap.tasks[0].waitingReason, "waiting_user_input");
  assert.equal(fixture.attempts, 1);
  assert.equal(snap.actions.length, 0);
  const events = await h.app.events.replay("session:" + session.id);
  assert(
    events.some(
      (e) =>
        e.type === "model.delta" && String(e.data.text).includes("远端服务器"),
    ),
  );
  const run = await h.app.specialists.spawn(
    session.rootTaskId,
    {
      objective: "Inspect local status",
      resourceIds: scope.resourceIds,
      stepIds: [],
      profileId: "sre-general",
    },
    "general-profile",
  );
  assert.equal(run.profileId, "sre-general");
});
