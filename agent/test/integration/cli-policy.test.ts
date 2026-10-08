import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { testApplication } from "../fixtures/application.js";
import { resolveWorkspaces } from "../../src/app/workspaces.js";
import { InvocationSchema } from "../../src/domain/invocation.js";
import { sha256 } from "../../src/adapters/workspace.js";
import { dispatchRoute } from "../../src/surfaces/routes.js";
import type { TaskContract } from "../../src/domain/entities.js";
test("read-only blocks a granted patch; local never binds exact auto approval and isolated model override", async (t) => {
  const h = await testApplication(undefined, false);
  t.after(() => h.close());
  const project = join(h.home + "-workspace");
  await mkdir(project);
  t.after(() =>
    import("node:fs/promises").then((f) =>
      f.rm(project, { recursive: true, force: true }),
    ),
  );
  await writeFile(join(project, "app.ts"), "old");
  const scope = await resolveWorkspaces(h.app, [project], "workspace-write");
  // Creation schema does not accept UI workspace metadata.
  const base = {
    lakeId: scope.lakeId,
    environmentId: scope.environmentId,
    objective: "Inspect",
    resourceIds: scope.resourceIds,
  };
  const readonly = await h.app.createSession({
    ...base,
    invocation: InvocationSchema.parse({
      workspaceRoots: scope.roots,
      sandboxMode: "read-only",
    }),
  });
  const write = await h.app.createSession({
    ...base,
    invocation: InvocationSchema.parse({
      workspaceRoots: scope.roots,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      model: "ds-test",
      maxCalls: 12,
    }),
  });
  const resource = (await h.app.store.list<any>("resources")).find(
    (r) => r.id === scope.resourceIds[0],
  );
  const artifactId = await h.app.artifacts.put(
    JSON.stringify({
      kind: "patch",
      resourceId: resource.id,
      path: "app.ts",
      expectedHash: sha256("old"),
      content: "new",
    }),
    write.id,
  );
  const proposal = (s: any) => ({
    sessionId: s.id,
    taskId: s.rootTaskId,
    actor: s.id,
    capability: "local-files.file.apply_patch",
    resourceId: resource.id,
    parameters: { path: "app.ts", expectedHash: sha256("old"), artifactId },
    callKey: "patch",
  });
  await assert.rejects(h.app.gateway.prepare(proposal(readonly)), {
    code: "scope_denied",
  });
  const a = await h.app.gateway.prepare(proposal(write)),
    authorized = await h.app.gateway.authorize(a.id);
  assert.equal(authorized.status, "authorized");
  const approval = (await h.app.store.list<any>("approvals")).find(
    (a) => a.actionId === authorized.id,
  );
  assert.equal(approval.actionDigest, a.proposalDigest);
  assert.equal(await h.app.gateway.dispatch(a.id), true);
  await h.app.runner.run(a.id, new AbortController().signal);
  assert.equal(await readFile(join(project, "app.ts"), "utf8"), "new");
  assert.equal(write.budget.maxCalls, 12);
  assert.equal(readonly.invocation?.model, undefined);
  assert.equal(h.app.config.providers[0]?.model, "fixture");
  await assert.rejects(
    resolveWorkspaces(h.app, [join(h.home, "agent")], "workspace-write"),
  );
});
test("fork has fresh task, terminals and criteria; preserves historical context without action replay", async (t) => {
  const h = await testApplication(undefined, false);
  t.after(() => h.close());
  const project = join(h.home + "-workspace");
  await mkdir(project);
  t.after(() =>
    import("node:fs/promises").then((f) =>
      f.rm(project, { recursive: true, force: true }),
    ),
  );
  const scope = await resolveWorkspaces(h.app, [project], "read-only");
  const s = await h.app.createSession({
    lakeId: scope.lakeId,
    environmentId: scope.environmentId,
    resourceIds: scope.resourceIds,
    objective: "Previous goal",
    invocation: InvocationSchema.parse({
      cwd: project,
      sandboxMode: "read-only",
    }),
  });
  // Prevent background model execution; this test covers durable fork semantics.
  h.app.startRoot = () => {};
  const child = (await dispatchRoute(
    h.app,
    "POST",
    `sessions/${s.id}/fork`,
    new URLSearchParams(),
    {
      requestId: crypto.randomUUID(),
      expectedRevision: s.revision,
      data: { objective: "Next goal" },
    },
  )) as any;
  const snap = (await h.app.data.snapshot(child.id)) as any;
  assert.equal(child.parentSessionId, s.id);
  assert.notEqual(child.rootTaskId, s.rootTaskId);
  assert.deepEqual(snap.actions, []);
  assert.deepEqual(snap.execution_sessions, []);
  assert.equal(snap.tasks[0].objective, "Next goal");
  assert.match(snap.tasks[0].constraints.at(-1), /Previous goal/);
  const old = await h.app.store.get<TaskContract>("tasks", s.rootTaskId);
  assert.equal(old?.revision, 1);
});

test("idle model switch retains the execution policy and never edits another session or provider", async (t) => {
  const h = await testApplication(undefined, false);
  t.after(() => h.close());
  const project = join(h.home + "-workspace");
  await mkdir(project);
  t.after(() =>
    import("node:fs/promises").then((f) =>
      f.rm(project, { recursive: true, force: true }),
    ),
  );
  const scope = await resolveWorkspaces(h.app, [project], "read-only"),
    base = {
      lakeId: scope.lakeId,
      environmentId: scope.environmentId,
      resourceIds: scope.resourceIds,
      objective: "Inspect",
    };
  const s = await h.app.createSession({
      ...base,
      invocation: InvocationSchema.parse({
        sandboxMode: "read-only",
        workspaceRoots: scope.roots,
      }),
    }),
    other = await h.app.createSession(base);
  const next = await h.app.configureModel(
    s.id,
    "fixture",
    "switched-model",
    "low",
  );
  assert.equal(next.invocation?.sandboxMode, "read-only");
  assert.deepEqual(next.invocation?.workspaceRoots, scope.roots);
  assert.equal(next.invocation?.model, "switched-model");
  assert.equal(
    (await h.app.store.get<any>("sessions", other.id)).invocation,
    undefined,
  );
  assert.equal(h.app.config.providers[0]?.model, "fixture");
  const legacy = await h.app.configureModel(
    other.id,
    "fixture",
    "legacy-model",
  );
  assert.equal(legacy.invocation?.sandboxMode, "danger-full-access");
  assert.equal(legacy.invocation?.bypassApprovals, false);
});
