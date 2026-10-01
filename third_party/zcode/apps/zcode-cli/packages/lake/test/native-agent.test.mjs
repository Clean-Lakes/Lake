import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { FileVault } from "../dist/adapters/vault.js";
import { LakeZCodeAgent } from "../dist/adapters/agent/agent.js";
import { NativeInteractions } from "../dist/adapters/agent/interactions.js";
import { atomicFile, saveModelConfig } from "../dist/adapters/config/files.js";

test("native reverse RPC reannouncement, scope, option values and cancellation", async () => {
  const events = [], controller = new AbortController(), host = new NativeInteractions("turn", event => events.push(event), controller.signal);
  const params = { requestId: "question", sessionId: "native", questions: [{ question: "Which?", header: "Choice", options: [{ label: "First", value: "one" }] }] };
  const first = host.request("interaction/requestUserInput", params), second = host.request("interaction/requestUserInput", params);
  assert.equal(events.length, 1);
  await assert.rejects(host.request("interaction/requestUserInput", { ...params, sessionId: "other" }), /冲突/);
  assert.throws(() => host.respond("question", { run_id: "other", answers: { q0: "First" } }), /当前运行/);
  assert(host.respond("question", { run_id: "turn", answers: { q0: "First" } }));
  assert.deepEqual(await first, { action: "accept", content: { answers: { "Which?": "one" } } }); assert.deepEqual(await second, await first);
  assert.equal(host.respond("question", { answers: { q0: "First" } }), false);
  const pending = host.request("interaction/requestPermission", { requestId: "permission", toolName: "Bash", input: { command: "echo fixture" } });
  controller.abort(); assert.deepEqual(await pending, { decision: "deny", reason: "任务已取消" });
});

test("native Bash and AskUserQuestion are available; native history survives cold resume", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "lake-native-agent-")), vault = new FileVault(root), requests = [], events = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); requests.push(payload);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    const index = requests.length;
    send("message_start", { message: { id: `native-${index}`, type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    if (index <= 2) {
      const name = index === 1 ? "Bash" : "AskUserQuestion", input = index === 1 ? { command: "printf native-fixture-marker", description: "Print fixture" } : { questions: [{ question: "Continue?", header: "Next", options: [{ label: "Continue", description: "Proceed" }, { label: "Stop", description: "End" }], multiSelect: false }] };
      send("content_block_start", { index: 0, content_block: { type: "tool_use", id: `native-call-${index}`, name, input: {} } });
      send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
    } else {
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: index === 3 ? "first-native-answer" : "resumed-native-answer" } });
    }
    send("content_block_stop", { index: 0 }); send("message_delta", { delta: { stop_reason: index <= 2 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }); send("message_stop", {}); response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let agent;
  try {
    await vault.put("model", "fixture", Buffer.from("synthetic-native-key"));
    await saveModelConfig(root, { model: "fixture-model", model_provider: "fixture", model_catalog: { "fixture-model": "fixture" }, model_providers: { fixture: { base_url: `http://127.0.0.1:${server.address().port}`, wire_api: "anthropic" } } });
    const nativeProfiles = join(root, "zcode-runtime", "storage", "agents");
    const unmanagedProfile = "---\nname: native_fixture\ndescription: Independent native fixture\n---\nUse native tools.\n";
    await atomicFile(join(nativeProfiles, "native_fixture.md"), unmanagedProfile);
    const profile = { name: "legacy_fixture", description: "Imported fixture", instruction: "Use native tools.", enabled: true };
    await atomicFile(join(root, "settings.json"), JSON.stringify({ specialists: [profile] }));
    agent = new LakeZCodeAgent(root, vault, { cliPath: fileURLToPath(new URL("../../../../../../../bin/zcode/zcode.cjs", import.meta.url)), nodePath: process.execPath });
    const emit = event => { events.push(event); if (event.type === "approval") void agent.respond(event.approval_id, { approved: true }); if (event.type === "question") void agent.respond(event.question.id, { run_id: "first", answers: { q0: "Continue" } }); };
    assert.equal(await agent.run({ native_session_id: "fixture-owner", run_id: "first", content: "First fixture prompt" }, [], new AbortController().signal, emit), "first-native-answer");
    assert.match(await readFile(join(nativeProfiles, "lake-legacy_fixture.md"), "utf8"), /name: "legacy_fixture"/);
    assert(events.some(event=>event.type === "token" && event.text));
    const nativeNames = requests[0].tools.map(tool => tool.name);
    for (const name of ["Bash", "Read", "Write", "Edit", "Agent", "Skill", "AskUserQuestion"]) assert(nativeNames.includes(name), `${name} missing`);
    assert(JSON.stringify(requests[1].messages).includes("native-fixture-marker")); assert(JSON.stringify(requests[2].messages).includes("Continue"));
    assert.equal(events.filter(event => event.type === "question").length, 1);
    assert.equal(await agent.run({ native_session_id: "fixture-owner", run_id: "second", content: "Second fixture prompt", history: [{ prompt: "must-not-reimport", answer: "duplicated" }] }, [], new AbortController().signal, emit), "resumed-native-answer");
    const resumed = JSON.stringify(requests.find(request=>JSON.stringify(request.messages).includes("Second fixture prompt"))?.messages);
    assert(resumed.includes("First fixture prompt")); assert(resumed.includes("first-native-answer")); assert(resumed.includes("Second fixture prompt")); assert(!resumed.includes("must-not-reimport"));
    await atomicFile(join(root, "settings.json"), JSON.stringify({ specialists: [{ ...profile, enabled: false }] }));
    await agent.run({native_session_id:"fixture-owner",run_id:"report",content:"Report fixture prompt",review_only:true},[{name:"lake_conversation_history",description:"History",inputSchema:{type:"object",properties:{}},execute:async()=>({turns:[]})}],new AbortController().signal,emit);
    await assert.rejects(readFile(join(nativeProfiles, "lake-legacy_fixture.md"), "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(join(nativeProfiles, "native_fixture.md"), "utf8"), unmanagedProfile);
    const report=requests.find(request=>JSON.stringify(request.messages).includes("Report fixture prompt"));assert(report);assert.deepEqual(report.tools.map(tool=>tool.name),["mcp__lake__lake_conversation_history"]);
    await agent.close();
    await atomicFile(join(root, "settings.json"), JSON.stringify({ specialists: [] }));
    agent=new LakeZCodeAgent(root,vault,{cliPath:fileURLToPath(new URL("../../../../../../../bin/zcode/zcode.cjs",import.meta.url)),nodePath:process.execPath});
    await agent.run({native_session_id:"fixture-owner",run_id:"cold",content:"Cold fixture resume"},[],new AbortController().signal,emit);
    const cold=JSON.stringify(requests.find(request=>JSON.stringify(request.messages).includes("Cold fixture resume"))?.messages);assert(cold.includes("First fixture prompt"));assert(cold.includes("Second fixture prompt"));
  } finally { await agent?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test("cancelling native startup closes an unresponsive protocol without admitting a turn",{timeout:5000},async()=>{
 const root=await mkdtemp(join(tmpdir(),"lake-native-cancel-")),vault=new FileVault(root);const {writeFile,copyFile}=await import("node:fs/promises");
 const cli=join(root,"unresponsive.cjs");await writeFile(cli,"setInterval(()=>{},1000)");await copyFile(fileURLToPath(new URL("../../../../../../../bin/zcode/builtin.json",import.meta.url)),join(root,"builtin.json"));
 await vault.put("model","fixture",Buffer.from("synthetic-cancel-key"));await saveModelConfig(root,{model:"fixture-model",model_provider:"fixture",model_catalog:{"fixture-model":"fixture"},model_providers:{fixture:{base_url:"https://example.invalid",wire_api:"anthropic"}}});
 const agent=new LakeZCodeAgent(root,vault,{cliPath:cli,nodePath:process.execPath}),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),100),start=Date.now();
 try{await assert.rejects(agent.run({native_session_id:"fixture",run_id:"cancel",content:"fixture"},[],controller.signal,()=>{}));assert(Date.now()-start<2500);}finally{clearTimeout(timer);await agent.close();await rm(root,{recursive:true,force:true});}
});
