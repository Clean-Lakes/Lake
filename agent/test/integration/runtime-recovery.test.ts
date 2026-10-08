import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { testHome } from "../fixtures/home.js";
import { addSession } from "../fixtures/session.js";
import { startModelFixture } from "../fixtures/model-server.js";
import { ProviderSchema } from "../../src/domain/config.js";
import { ChatModelAdapter } from "../../src/adapters/model/chat-completions.js";
import { AgentRuntime } from "../../src/agent/runtime.js";
import { BudgetService } from "../../src/agent/budget.js";
import { ToolCatalog } from "../../src/agent/tool-catalog.js";
import { ToolExecutor } from "../../src/agent/tool-executor.js";
import { ModelHistory } from "../../src/agent/history.js";
import { toolResult } from "../../src/domain/entities.js";

test("HTTP 429/503 retries are charged and malformed streams execute no tools", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const { session, task } = await addSession(h);
  let finished = false,
    calls = 0;
  const server = await startModelFixture((_b, n) =>
    n < 3
      ? { status: n === 1 ? 429 : 503 }
      : {
          calls: [
            { id: "repeat-provider-id", name: "fixture_done", arguments: "{}" },
          ],
        },
  );
  t.after(() => server.close());
  const provider = ProviderSchema.parse({
    id: "fixture",
    baseUrl: server.baseUrl,
    model: "fixture",
    contextWindowTokens: 32768,
    maxOutputTokens: 512,
    supportsTools: true,
  });
  const catalog = new ToolCatalog();
  catalog.register({
    name: "fixture.done",
    description: "Finish",
    schema: z.object({}).strict(),
    roles: ["coordinator"],
    run: async () => {
      calls++;
      finished = true;
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
        identity: "Fixture",
        baseline: "SRE",
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
  );
  assert.equal((await runtime.run()).status, "ok");
  assert.equal(calls, 1);
  assert.equal(
    (await h.store.get<any>("sessions", session.id)).budget.calls,
    3,
  );
  const partial = await startModelFixture(() => ({
    partial: true,
    calls: [{ id: "bad", name: "fixture_done", arguments: "{}" }],
  }));
  t.after(() => partial.close());
  await assert.rejects(async () => {
    for await (const _ of new ChatModelAdapter(
      { ...provider, baseUrl: partial.baseUrl },
      h.credentials,
    ).stream({
      messages: [],
      tools: [],
      maxOutputTokens: 512,
      signal: new AbortController().signal,
    })) {
    }
  });
  assert.equal(calls, 1);
});

test("pending exchange resumes only missing results and cancellation stops the next tool", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const { session, task } = await addSession(h);
  let executions = 0,
    finished = false;
  const history = new ModelHistory(h.store, session.id, session.id);
  const call = (id: string) => ({
    id,
    type: "function" as const,
    function: { name: "fixture_probe", arguments: "{}" },
  });
  const exchange = await history.commitExchange({
    role: "assistant",
    content: null,
    tool_calls: [call("first"), call("second")],
  });
  await history.settle(exchange.id, {
    role: "tool",
    content: JSON.stringify(toolResult({ alreadyExecuted: true })),
    tool_call_id: "first",
  });
  const catalog = new ToolCatalog();
  catalog.register({
    name: "fixture.probe",
    description: "Probe",
    schema: z.object({}).strict(),
    roles: ["coordinator"],
    run: async () => {
      executions++;
      finished = true;
      return toolResult({ observed: true });
    },
  });
  const provider = ProviderSchema.parse({
    id: "fixture",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture",
    contextWindowTokens: 32768,
    maxOutputTokens: 512,
    supportsTools: true,
  });
  const hooks = {
    context: async () => ({
      identity: "Fixture",
      baseline: "SRE",
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
  };
  const runtime = new AgentRuntime(
    h.store,
    {
      async *stream() {
        throw new Error("Recovery should not call model");
      },
    },
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
  );
  await runtime.run();
  assert.equal(executions, 1);
  assert.equal((await history.messages()).length, 3);
  const next = await history.commitExchange({
    role: "assistant",
    content: null,
    tool_calls: [call("third"), call("fourth")],
  });
  await h.store.transact([
    {
      op: "put",
      table: "tasks",
      value: {
        ...task,
        revision: 2,
        cancelRequestedAt: new Date().toISOString(),
      },
      expectedRevision: 1,
    },
  ]);
  finished = false;
  await assert.rejects(runtime.resume());
  assert.equal(executions, 1);
  assert.equal(
    (await h.store.get<any>("model_exchanges", next.id)).results.length,
    2,
  );
});
