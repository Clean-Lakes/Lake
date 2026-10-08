import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { testHome } from "../fixtures/home.js";
import { addSession } from "../fixtures/session.js";
import { startModelFixture } from "../fixtures/model-server.js";
import { ProviderSchema } from "../../src/domain/config.js";
import { ChatModelAdapter } from "../../src/adapters/model/chat-completions.js";
import { AgentRuntime } from "../../src/agent/runtime.js";
import { ToolCatalog } from "../../src/agent/tool-catalog.js";
import { ToolExecutor } from "../../src/agent/tool-executor.js";
import { BudgetService } from "../../src/agent/budget.js";
import { toolResult } from "../../src/domain/entities.js";
import { ModelHistory } from "../../src/agent/history.js";
test("equivalent probes stop, cancellation prevents the next side effect and no-progress calls are bounded", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const { session, task } = await addSession(h);
  let executed = 0;
  const fixture = await startModelFixture((_b, n) => ({
    calls: [{ id: "provider-" + n, name: "fixture_probe", arguments: "{}" }],
  }));
  t.after(() => fixture.close());
  const provider = ProviderSchema.parse({
    id: "fixture",
    baseUrl: fixture.baseUrl,
    model: "fixture",
    contextWindowTokens: 32768,
    maxOutputTokens: 512,
    supportsTools: true,
  });
  const catalog = new ToolCatalog();
  catalog.register({
    name: "fixture.probe",
    description: "Probe",
    schema: z.object({}).strict(),
    roles: ["coordinator"],
    run: async () => {
      executed++;
      return toolResult({ same: true });
    },
  });
  const hooks = {
    context: async () => ({
      identity: "SRE",
      baseline: "Evidence",
      objective: task.objective,
      constraints: task.constraints,
      shared: {},
      inbox: [],
      skills: [],
      loadedSkills: [],
    }),
    activity: async () => {},
    delta: async () => {},
    isFinished: async () => false,
    checkpoint: async () => {},
  };
  const make = (model = new ChatModelAdapter(provider, h.credentials)) =>
    new AgentRuntime(
      h.store,
      model,
      provider,
      catalog,
      new ToolExecutor(catalog, h.store),
      new BudgetService(h.store),
      {
        sessionId: session.id,
        taskId: task.id,
        actor: session.id,
        role: "coordinator",
        powerBindings: [],
      },
      hooks,
      10,
    );
  assert.equal((await make().run()).status, "waiting");
  assert.equal(executed, 3);
  assert.equal(fixture.attempts, 4);
  const idle = await startModelFixture(() => ({ text: "Still thinking" }));
  t.after(() => idle.close());
  await assert.rejects(
    make(
      new ChatModelAdapter(
        { ...provider, baseUrl: idle.baseUrl },
        h.credentials,
      ),
    ).run(),
    (e: any) => e.code === "no_progress",
  );
  assert.equal(idle.attempts, 5);
  let runtime: AgentRuntime;
  catalog.register({
    name: "fixture.cancel",
    description: "Cancel",
    schema: z.object({}).strict(),
    roles: ["coordinator"],
    run: async () => {
      runtime.interrupt();
      return toolResult({ interrupted: true });
    },
  });
  const cancelling = await startModelFixture(() => ({
    calls: [
      { id: "cancel", name: "fixture_cancel", arguments: "{}" },
      { id: "must-not-run", name: "fixture_probe", arguments: "{}" },
    ],
  }));
  t.after(() => cancelling.close());
  runtime = make(
    new ChatModelAdapter(
      { ...provider, baseUrl: cancelling.baseUrl },
      h.credentials,
    ),
  );
  await assert.rejects(runtime.run(), (e: any) => e.code === "cancelled");
  assert.equal(executed, 3);
});

test("runtime crosses compaction threshold and checkpoints the summary without losing latest rules", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const { session, task } = await addSession(h);
  const history = new ModelHistory(h.store, session.id, session.id),
    old = await history.commitExchange({
      role: "assistant",
      content: "x".repeat(6000),
    });
  await history.finish(old.id);
  let done = false,
    checkpoint: any;
  const fixture = await startModelFixture((body) => {
    if (!body.tools?.length)
      return {
        text: JSON.stringify({
          facts: ["retained fact"],
          unresolvedActions: [],
          evidenceIds: ["proof"],
          userConstraints: ["NO RESTART"],
          decisions: [],
        }),
      };
    assert(JSON.stringify(body.messages).includes("NO RESTART"));
    assert(JSON.stringify(body.messages).includes("frozen skill body"));
    assert(!JSON.stringify(body.messages).includes("x".repeat(500)));
    return { calls: [{ id: "done", name: "fixture_done", arguments: "{}" }] };
  });
  t.after(() => fixture.close());
  const provider = ProviderSchema.parse({
    id: "fixture",
    baseUrl: fixture.baseUrl,
    model: "fixture",
    contextWindowTokens: 8192,
    maxOutputTokens: 256,
    supportsTools: true,
  });
  const catalog = new ToolCatalog();
  catalog.register({
    name: "fixture.done",
    description: "Done",
    schema: z.object({}).strict(),
    roles: ["coordinator"],
    run: async () => {
      done = true;
      return toolResult({ verified: true });
    },
  });
  const runtime = new AgentRuntime(
    h.store,
    new ChatModelAdapter(provider, h.credentials),
    provider,
    catalog,
    new ToolExecutor(catalog, h.store),
    new BudgetService(h.store),
    {
      sessionId: session.id,
      taskId: task.id,
      actor: session.id,
      role: "coordinator",
      powerBindings: [],
    },
    {
      context: async () => ({
        identity: "SRE",
        baseline: "Rules",
        objective: task.objective,
        constraints: ["NO RESTART"],
        shared: { evidence: ["proof"] },
        inbox: ["latest input"],
        skills: [],
        loadedSkills: ["frozen skill body"],
      }),
      activity: async () => {},
      delta: async () => {},
      isFinished: async () => done,
      checkpoint: async (state) => {
        checkpoint = state;
      },
    },
  );
  await runtime.run();
  assert.equal(fixture.attempts, 2);
  assert.equal(checkpoint.retained, 1);
  assert(JSON.parse(checkpoint.summary).facts.includes("retained fact"));
  assert.equal((await h.store.list<any>("model_usage"))[0].kind, "compaction");
});
