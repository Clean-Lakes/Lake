import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testApplication } from "../fixtures/application.js";
import { SpecialistScheduler } from "../../src/specialists/scheduler.js";
import { ModelLimiter } from "../../src/agent/model-limiter.js";
import { initialBudget } from "../../src/agent/budget.js";
test("three specialists run, fourth queues; two models run; profiles freeze and root shares budget", async (t) => {
  const h = await testApplication(undefined, false);
  t.after(() => h.close());
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
  h.app.config.profiles.push({
    id: "custom",
    name: "Custom",
    instructions: "original rules",
    extraSkills: [],
    defaultPowers: [],
    maxTurns: 30,
  });
  const session = await h.app.createSession({
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    objective: "Scheduler",
    resourceIds: [resourceId],
  });
  const runs = [];
  for (let i = 0; i < 4; i++)
    runs.push(
      await h.app.specialists.spawn(
        session.rootTaskId,
        {
          objective: "Worker " + i,
          resourceIds: [resourceId],
          stepIds: [],
          profileId: "custom",
        },
        "worker-" + i,
      ),
    );
  h.app.config.profiles[0]!.instructions = "changed rules";
  const fresh = await h.app.specialists.spawn(
    session.rootTaskId,
    {
      objective: "New",
      resourceIds: [resourceId],
      stepIds: [],
      profileId: "custom",
    },
    "fresh",
  );
  assert.equal(runs[0]!.profile.instructions, "original rules");
  assert.equal(fresh.profile.instructions, "changed rules");
  assert.equal(runs[0]!.workOrder.skillSnapshot.length, 6);
  await h.app.specialists.cancel(fresh.id);
  const scheduler = new SpecialistScheduler(
    h.app.store,
    async (_run, signal) => {
      await new Promise<void>((r) =>
        signal.addEventListener("abort", () => r(), { once: true }),
      );
    },
  );
  t.after(async () => {
    scheduler.stop();
    await scheduler.drain();
  });
  await scheduler.schedule();
  assert.equal(scheduler.activeCount, 3);
  assert.equal(
    (await h.app.store.get<any>("specialist_runs", runs[3]!.id)).state.status,
    "queued",
  );
  await h.app.specialists.cancel(runs[3]!.id);
  assert.equal(
    (await h.app.store.get<any>("specialist_runs", runs[3]!.id)).budget.calls,
    0,
  );
  let concurrent = 0,
    peak = 0;
  const releases: Array<() => void> = [];
  const model = new ModelLimiter(2).wrap({
    async *stream() {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise<void>((r) => releases.push(r));
      concurrent--;
      yield {
        type: "complete",
        message: { role: "assistant", content: "ok" },
        usage: null,
      };
    },
  });
  const requests = [0, 1, 2].map(async () => {
    for await (const _ of model.stream({
      messages: [],
      tools: [],
      maxOutputTokens: 1,
      signal: new AbortController().signal,
    })) {
    }
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(concurrent, 2);
  releases.shift()!();
  await new Promise((r) => setTimeout(r, 20));
  while (releases.length) releases.shift()!();
  await Promise.all(requests);
  assert.equal(peak, 2);
  await h.app.budget.update(session.id, 1, 200000, "local-user");
  const reservations = await Promise.allSettled([
    h.app.budget.reserve(session.id, session.id, 100),
    h.app.budget.reserve(session.id, runs[0]!.id, 100),
  ]);
  assert.equal(reservations.filter((r) => r.status === "fulfilled").length, 1);
  const winner = reservations.find((r) => r.status === "fulfilled")!;
  assert(winner.status === "fulfilled");
  await h.app.budget.settle(winner.value, null, "fixture");
  assert.equal(
    (await h.app.store.get<any>("sessions", session.id)).budget.calls,
    1,
  );
});

test("step DAG rejects cycles, competing claims have one owner and completion requires evidence", async (t) => {
  const h = await testApplication(undefined, false);
  t.after(() => h.close());
  const id = randomUUID();
  await h.app.importResources({
    resources: [
      {
        id,
        lakeId: h.lakeId,
        environmentId: h.environmentId,
        kind: "http",
        name: "Fixture",
        endpoint: "http://127.0.0.1:1",
        identity: "fixture",
      },
    ],
  });
  const session = await h.app.createSession({
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    objective: "Steps",
    resourceIds: [id],
  });
  const a = randomUUID(),
    b = randomUUID();
  await assert.rejects(
    h.app.progress.plan(
      session.rootTaskId,
      [
        { id: a, label: "A", dependencies: [b] },
        { id: b, label: "B", dependencies: [a] },
      ],
      "cycle",
    ),
  );
  const steps = await h.app.progress.plan(
    session.rootTaskId,
    [
      { id: a, label: "A", dependencies: [] },
      { id: b, label: "B", dependencies: [a] },
    ],
    "valid",
  );
  const claims = await Promise.allSettled(
    ["worker-a", "worker-b"].map((owner) => h.app.progress.claim(a, owner, 1)),
  );
  assert.equal(claims.filter((r) => r.status === "fulfilled").length, 1);
  const current = await h.app.store.get<any>("task_steps", a);
  await assert.rejects(h.app.progress.completeStep(a, current.assignee, []));
  await assert.rejects(h.app.progress.claim(b, "worker-c", 1));
  assert.equal((await h.app.store.get<any>("task_steps", a)).status, "claimed");
});
