import test from "node:test";
import assert from "node:assert/strict";
import { startModelFixture } from "../fixtures/model-server.js";
import { ChatModelAdapter } from "../../src/adapters/model/chat-completions.js";
import { ProviderSchema } from "../../src/domain/config.js";
test("model HTTP protocol handles UTF-8 and complete structured calls, rejects partial streams", async (t) => {
  const fixture = await startModelFixture(() => ({
    text: "现场正常",
    calls: [
      {
        id: "tool-1",
        name: "fixture_probe",
        arguments: '{"resourceId":"fixture"}',
      },
    ],
  }));
  t.after(() => fixture.close());
  const provider = ProviderSchema.parse({
    id: "fixture",
    baseUrl: fixture.baseUrl,
    model: "fixture",
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    supportsTools: true,
  });
  const model = new ChatModelAdapter(provider, {
    resolve: async () => new Uint8Array(),
  });
  const events = [];
  for await (const event of model.stream({
    messages: [],
    tools: [],
    maxOutputTokens: 4096,
    signal: new AbortController().signal,
  }))
    events.push(event);
  assert.equal(events.find((e) => e.type === "text")?.text, "现场正常");
  const complete = events.find((e) => e.type === "complete");
  assert(complete?.type === "complete");
  assert.equal(
    complete.message.tool_calls?.[0]?.function.name,
    "fixture_probe",
  );
  const broken = await startModelFixture(() => ({
    partial: true,
    calls: [{ id: "x", name: "fixture_probe", arguments: '{"x":' }],
  }));
  t.after(() => broken.close());
  const other = new ChatModelAdapter(
    { ...provider, baseUrl: broken.baseUrl },
    { resolve: async () => new Uint8Array() },
  );
  await assert.rejects(async () => {
    for await (const _ of other.stream({
      messages: [],
      tools: [],
      maxOutputTokens: 10,
      signal: new AbortController().signal,
    })) {
    }
  });
});

test("non-streaming multiple tool calls preserve IDs and unknown usage", async (t) => {
  const fixture = await startModelFixture(() => ({
    text: "Complete",
    calls: [
      { id: "one", name: "fixture_probe", arguments: "{}" },
      { id: "two", name: "fixture_probe", arguments: "{}" },
    ],
  }));
  t.after(() => fixture.close());
  const provider = ProviderSchema.parse({
    id: "fixture",
    baseUrl: fixture.baseUrl,
    model: "fixture",
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    supportsTools: true,
    supportsStreaming: false,
  });
  const events = [];
  for await (const e of new ChatModelAdapter(provider, {
    resolve: async () => new Uint8Array(),
  }).stream({
    messages: [],
    tools: [],
    maxOutputTokens: 100,
    signal: new AbortController().signal,
  }))
    events.push(e);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "complete");
  if (events[0]?.type === "complete")
    assert.deepEqual(
      events[0].message.tool_calls?.map((c) => c.id),
      ["one", "two"],
    );
});

test("DeepSeek reasoning is retained in tool history and never emitted as visible text", async (t) => {
  for (const streaming of [true, false]) {
    const fixture = await startModelFixture((body, attempt) => {
      assert.equal(body.thinking.type, "enabled");
      assert.equal(body.reasoning_effort, "high");
      if (attempt === 2) {
        assert.equal(body.messages[1].reasoning_content, "internal reasoning");
        assert.equal(body.messages[2].tool_call_id, "echo");
      }
      return attempt === 1
        ? {
            text: "Calling echo",
            reasoning: "internal reasoning",
            calls: [{ id: "echo", name: "echo", arguments: "{}" }],
          }
        : { text: "done", reasoning: "final reasoning" };
    });
    t.after(() => fixture.close());
    const provider = ProviderSchema.parse({
      id: "fixture",
      baseUrl: fixture.baseUrl,
      model: "fixture",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      supportsTools: true,
      supportsStreaming: streaming,
      thinking: "enabled",
      reasoningEffort: "high",
    });
    const model = new ChatModelAdapter(provider, {
        resolve: async () => new Uint8Array(),
      }),
      messages: any[] = [{ role: "user", content: "echo" }];
    for (let i = 0; i < 2; i++) {
      const events = [];
      for await (const event of model.stream({
        messages,
        tools: [],
        maxOutputTokens: 100,
        signal: new AbortController().signal,
      }))
        events.push(event);
      assert(
        !events
          .filter((e) => e.type === "text")
          .some((e) => e.type === "text" && e.text.includes("reasoning")),
      );
      const complete = events.find((e) => e.type === "complete");
      assert(complete?.type === "complete");
      messages.push(complete.message);
      if (i === 0)
        messages.push({ role: "tool", tool_call_id: "echo", content: "ok" });
    }
  }
});
