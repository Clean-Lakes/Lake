import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createAgentHost } from "../dist/adapters/agent/host.js";
import { LakeZCodeAgent } from "../dist/adapters/agent/agent.js";
import { saveModelConfig } from "../dist/adapters/config/files.js";
import { FileVault } from "../dist/adapters/vault.js";

async function provider(handler) {
  const server = createServer(handler); server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

test("TypeScript MCP host rejects unauthorized/unknown tools and returns array results", async () => {
  const controller = new AbortController(), calls = [];
  const host = await createAgentHost({ signal: controller.signal, apiKey: Buffer.from("synthetic-fixture-key"), provider: { base_url: "https://example.invalid", wire_api: "anthropic" }, tools: [{ name: "lake_resources", description: "fixture", inputSchema: { type: "object", properties: {} }, call: async args => { calls.push(args); return [{ name: "fixture-host" }]; } }] });
  try {
    const post = (message, token = host.token) => fetch(host.url + "/mcp", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(message) });
    assert.equal((await post({ id: 1, method: "tools/list" }, "invalid")).status, 403);
    const list = await (await post({ id: 2, method: "tools/list" })).json();
    assert.equal(list.result.tools.length, 1);
    const result = await (await post({ id: 3, method: "tools/call", params: { name: "lake_resources", arguments: {} } })).json();
    assert.equal(result.result.isError, false);
    assert.equal(JSON.parse(result.result.content[0].text)[0].name, "fixture-host");
    const duplicate = await (await post({ id: 3, method: "tools/call", params: { name: "lake_resources", arguments: {} } })).json();
    assert.deepEqual(duplicate, result);
    assert.equal((await post({ id: 3, method: "tools/call", params: { name: "lake_resources", arguments: { changed: true } } })).status, 502);
    assert.equal(calls.length, 1);
  } finally { controller.abort(); await host.close(); }
});

test("source-built ZCode executes a model turn through the TypeScript gateway", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "lake-ts-source-agent-"));
  const cliPath = fileURLToPath(new URL("../../../../../../../bin/zcode/zcode.cjs", import.meta.url));
  await access(cliPath);
  const credential = "synthetic-fixture-key", calls = [], failures = [];
  const upstream = await provider(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    calls.push(JSON.parse(body));
    if (request.url !== "/v1/messages") failures.push("provider route changed");
    if (request.headers["x-api-key"] !== credential) failures.push("provider authentication lost");
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    send("message_start", { message: { id: "fixture", type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } } });
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "fixture TypeScript" } });
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
    send("message_stop", {}); response.end();
  });
  try {
    const vault = new FileVault(root);
    await vault.put("model", "fixture", Buffer.from(credential));
    await saveModelConfig(root, { model: "fixture-model", model_provider: "fixture", model_catalog: { "fixture-model": "fixture" }, model_providers: { fixture: { base_url: upstream.url + "/v1", wire_api: "anthropic" } }, context_window: 42000, max_output_tokens: 384 });
    const events = [], agent = new LakeZCodeAgent(root, vault, { cliPath, nodePath: process.execPath });
    const answer = await agent.run({ native_session_id:"fixture", content: "Return fixture text." }, [], AbortSignal.timeout(20000), event => events.push(event));
    await agent.close();
    assert.equal(answer, "fixture TypeScript"); assert.equal(calls.length, 1);
    assert.deepEqual(failures, []);
    assert.equal(calls[0].max_tokens, 384);
    assert(!JSON.stringify(events).includes(credential));
    assert.equal((await readdir(root)).filter(name => name.startsWith(".zcode-turn-")).length, 0);
  } finally { await upstream.close(); await rm(root, { recursive: true, force: true }); }
});
