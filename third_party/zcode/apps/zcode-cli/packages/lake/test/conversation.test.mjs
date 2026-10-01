import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { LakeApplication } from "../dist/app/runtime.js";
import { LakeDatabase, newID } from "../dist/adapters/storage/database.js";
import { LakeData } from "../dist/adapters/storage/data.js";
import { FileVault } from "../dist/adapters/vault.js";
import { LakeZCodeAgent } from "../dist/adapters/agent/agent.js";
import { saveModelConfig } from "../dist/adapters/config/files.js";

test("source ZCode → TypeScript tool → approval → fixture host check → history and journal", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "lake-ts-conversation-"));
  const data = new LakeData(await LakeDatabase.open(root)), vault = new FileVault(root);
  const cliPath = fileURLToPath(new URL("../../../../../../../bin/zcode/zcode.cjs", import.meta.url));
  const calls = [], requests = [], failures = [], events = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); requests.push(payload);
    if (!payload.tools?.some(tool => tool.name === "mcp__lake__lake_ssh_read")) failures.push("Lake tool missing from native model request");
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    send("message_start", { message: { id: `fixture-${requests.length}`, type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } } });
    if (requests.length === 1) {
      send("content_block_start", { index: 0, content_block: { type: "tool_use", id: "fixture-call", name: "mcp__lake__lake_ssh_read", input: {} } });
      send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ resource: "测试主机", check: "uptime" }) } });
    } else {
      if (!JSON.stringify(payload.messages).includes("fixture uptime")) failures.push("approved result missing from next model input");
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "fixture checked" } });
    }
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: requests.length === 1 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
    send("message_stop", {}); response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let runtime;
  try {
    await data.request("lake.add", { name: "测试湖" });
    await data.request("res.add", { lake: "测试湖", name: "测试主机", spec: { ssh: { host: "example.invalid", port: 22, username: "fixture" } }, credential_ref: "file:ssh/fixture-only" });
    await data.request("res.authorize", { resource: "测试湖/测试主机", allow: true });
    await data.request("permissions.set", { key: "ssh-read", enabled: false });
    await vault.put("model", "fixture", Buffer.from("synthetic-fixture-key"));
    await saveModelConfig(root, { model: "fixture-model", model_provider: "fixture", model_catalog: { "fixture-model": "fixture" }, model_providers: { fixture: { base_url: `http://127.0.0.1:${server.address().port}/v1`, wire_api: "anthropic" } } });
    const conversation = await data.request("conversation.create", { lake: "测试湖" });
    runtime = new LakeApplication({ data, id: newID, options: { root }, settings: { request: async () => null }, agent: new LakeZCodeAgent(root, vault, { cliPath, nodePath: process.execPath }), execution: { request: async (method, params) => { calls.push({ method, params }); return { status: "completed", stdout: "fixture uptime", stderr: "", exit_code: 0, duration_ms: 1 }; }, close: async () => {} }, emit: event => {
      events.push(event);
      if (event.type === "approval") void runtime.dispatch({ method: "approval.respond", params: { id: event.id, approved: true } });
    } });
    const result = await runtime.dispatch({ method: "conversation.ask", id: "fixture-turn", params: { id: conversation.id, prompt: "检查测试主机的 uptime" } });
    assert.equal(result.answer, "fixture checked"); assert.deepEqual(failures, []);
    assert.equal(calls.length, 1); assert.equal(calls[0].params.command, "uptime");
    assert.equal(events.filter(event => event.type === "approval").length, 1);
    const history = await data.request("conversation.show", { id: conversation.id });
    assert.equal(history.turns.length, 1); assert.equal(history.turns[0].answer, "fixture checked");
    assert(history.events.some(event => event.kind === "tool_finished"));
    assert.deepEqual((await data.request("journal.list", { run_id: "fixture-turn" })).reverse().map(row => row.event), ["requested", "proposed", "approved", "started", "completed"]);
  } finally {
    if (runtime) await runtime.close(); else data.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
