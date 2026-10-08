import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { testHome } from "../fixtures/home.js";
import { addSession } from "../fixtures/session.js";
import { startModelFixture } from "../fixtures/model-server.js";
import { ProviderSchema } from "../../src/domain/config.js";
import { ChatModelAdapter } from "../../src/adapters/model/chat-completions.js";
import { ToolCatalog } from "../../src/agent/tool-catalog.js";
import { ToolExecutor } from "../../src/agent/tool-executor.js";
import { AgentRuntime } from "../../src/agent/runtime.js";
import { BudgetService } from "../../src/agent/budget.js";
import { toolResult } from "../../src/domain/entities.js";
import { ModelHistory } from "../../src/agent/history.js";
test("self-written runtime completes tools and preserves paired history without credentials", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const { session, task } = await addSession(h);
  let executed = 0,
    finished = false;
  const fixture = await startModelFixture((body, attempt) => ({
    calls: [
      {
        id: "call-" + attempt,
        name: attempt === 1 ? "fixture_probe" : "fixture_deliver",
        arguments: "{}",
      },
    ],
  }));
  t.after(() => fixture.close());
  const catalog = new ToolCatalog();
  catalog.register({
    name: "fixture.probe",
    description: "Fixture observation",
    schema: z.object({}).strict(),
    roles: ["coordinator"],
    run: async () => {
      executed++;
      return toolResult({ observed: true });
    },
  });
  catalog.register({
    name: "fixture.deliver",
    description: "Fixture delivery",
    schema: z.object({}).strict(),
    roles: ["coordinator"],
    run: async () => {
      finished = true;
      return toolResult({ verified: true });
    },
  });
  const provider = ProviderSchema.parse({
    id: "fixture",
    baseUrl: fixture.baseUrl,
    model: "fixture",
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    supportsTools: true,
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
        identity: "Fixture",
        baseline: "Collect evidence",
        objective: task.objective,
        constraints: task.constraints,
        shared: {},
        inbox: [],
        skills: [],
        loadedSkills: [],
      }),
      activity: async () => {},
      delta: async () => {},
      isFinished: async () => finished,
      checkpoint: async () => {},
    },
    5,
  );
  const result = await runtime.run();
  assert.equal(result.status, "ok");
  assert.equal(executed, 1);
  const messages = await new ModelHistory(
    h.store,
    session.id,
    session.id,
  ).messages();
  assert.equal(messages.length, 4);
  assert.equal(messages[1]?.tool_call_id, messages[0]?.tool_calls?.[0]?.id);
  assert.equal(
    (await h.store.get<any>("sessions", session.id)).budget.calls,
    2,
  );
});
