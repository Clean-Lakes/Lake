const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, readFile, access } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createServer } = require("node:http");
process.env.LAKE_TS_IMPORT_ONLY = "1";
const { startLakeServer, previewLegacyMigration, rollbackMigration, sessionArchiveName, legacySessionArchiveName } = require("../../bin/lake-runtime/server.cjs");

function isIndependentWorkerRequest(request){return request.tools?.some(tool=>tool.function?.name==='work_finish')&&!request.tools?.some(tool=>tool.function?.name==='route_work');}

async function fixture(t, mode = "text", legacyDev = false) {
  const home = await mkdtemp(join(tmpdir(), "lake-ts-test-"));
  const web = join(home, "web");
  await require("node:fs/promises").mkdir(web);
  await writeFile(join(web, "index.html"), "<html>Lake fixture</html>");
  let calls = 0;
  let failWorkerRequests = false;
  let modelFailure = mode.startsWith('model-error-');
  let backgroundJoinRequested = false;
  let releaseBackgroundChild;
  const backgroundChildGate = new Promise((resolve) => { releaseBackgroundChild = resolve; });
  const requests = [];
  const requestAuthorizations = [];
  const target = join(home, "approved.txt");
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(request);
    requestAuthorizations.push(req.headers.authorization);
    calls++;
    if(modelFailure){
      const error={message:'SYNTHETIC_PROVIDER_REJECTION synthetic-secret-no-real-credential',type:'invalid_request_error',code:'synthetic_rejection'};
      if(mode==='model-error-http'){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error}));}
      else {res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({error})+'\n\ndata: [DONE]\n\n');}
      return;
    }
    // Keep the background child's first resource read pending until the parent
    // asks to join it. This proves work_finish cannot accept a still-live child,
    // independently of machine speed or an arbitrary delay.
    if (mode.startsWith("super-subagent-background") &&
        !request.tools?.some((tool) => ["route_work", "work_finish"].includes(tool.function?.name)) &&
        JSON.stringify(request.messages).includes("LAKE_SUBAGENT_FIXTURE:"))
      await backgroundChildGate;
    if (failWorkerRequests && (isIndependentWorkerRequest(request) && !request.tools?.some(tool=>tool.function?.name==='route_work'))) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "synthetic-current-invocation-failure", type: "authentication_error" } }));
      return;
    }
    const hasResult = request.messages.some((message) => message.role === "tool");
    let tool = mode === "write" && !hasResult;
    let delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: "write-fixture",
              type: "function",
              function: {
                name: "Write",
                arguments: JSON.stringify({ file_path: target, content: "approved" }),
              },
            },
          ],
        }
      : { content: "Lake TS 完成" };
    const nativeMemory = JSON.stringify(request.messages).includes("persistent file-based memory at");
    if (nativeMemory) {
      delta = mode === 'memory-native-nochange' && JSON.stringify(request.messages).includes('You are now acting as the memory extraction subagent')
        ? {content: 'Nothing to save.'} : nativeMemoryReply(request);
      tool = !!delta.tool_calls;
    } else if (mode.startsWith("super")) {
      delta = superReply(request, mode, home);
      tool = !!delta.tool_calls;
      if (mode.startsWith("super-subagent-background") && mode !== "super-subagent-background-stop" &&
          delta.tool_calls?.some((call) => call.function.name === "TaskOutput")) {
        backgroundJoinRequested = true;
        releaseBackgroundChild();
      }
    }
    if (mode === "memory-native-error" && nativeMemory && JSON.stringify(request.messages).includes("You are now acting as the memory extraction subagent")) {
      res.writeHead(401,{"Content-Type":"application/json"});res.end(JSON.stringify({error:{message:"synthetic-memory-provider-failure",type:"authentication_error"}}));return;
    }
    if (request.stream !== true) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({id:"fixture",object:"chat.completion",created:1,model:"fixture",choices:[{index:0,
        message:{role:"assistant",...delta,...(delta.tool_calls?{tool_calls:delta.tool_calls.map(({index,...call})=>call)}:{})},
        finish_reason:tool?"tool_calls":"stop"}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}}));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const echo = mode === 'magpie-secret' ? req.headers.authorization?.replace(/^Bearer /, '') : undefined;
    const deltas = echo ? [{content: 'prefix ' + echo.slice(0, 13)}, {content: echo.slice(13) + ' suffix'}] :
      mode === "secret"
        ? [{ content: "prefix synthetic-secret-" }, { content: "no-real-credential suffix" }]
        : [delta];
    for (const delta of deltas)
      res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\n`,
      );
    res.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const options = { home, data: join(home, "data"), port: 0, staticRoot: web, development: legacyDev };
  if (legacyDev) {
    const fs = require("node:fs/promises");
    await fs.mkdir(options.data, { mode: 0o700 });
    await fs.mkdir(join(home, "secrets"), { mode: 0o700 });
    await writeFile(join(home, "secrets/provider-fixture.key"), "synthetic-secret-no-real-credential", { mode: 0o600 });
    await writeFile(join(options.data, "providers.json"), JSON.stringify({
      version: 1, activeProviderId: "legacy.fixture", activeModelId: "fixture", activeSource: mode === 'legacy-magpie-source' ? 'magpie' : 'native',
      providers: [{
        id: "legacy.fixture", name: "Existing Dev provider", baseURL: `http://127.0.0.1:${provider.address().port}/v1`,
        protocol: "openai", enabled: true, credentialRef: "provider-fixture.key",
        models: [{ id: "fixture", name: "fixture", enabled: true, ...(mode === 'legacy-rich-model-flags' ? {
          supportsVideoInput: true, supportsAudioInput: true, supportsPdfInput: true, supportsNativeWebSearch: true,
          imageInputMode: 'on', imageInputDetected: true, reasoningCapability: {levels: ['low', 'high'], default: 'high', source: 'saved-settings'},
          ignoredPrivateField: 'must-not-import',
        } : {}) }],
      }],
    }), { mode: 0o600 });
    await writeFile(join(options.data, "lake-web.sqlite"), "legacy database sentinel", { mode: 0o600 });
    if (mode === 'legacy-magpie-source') await writeFile(join(home, 'secrets/magpie-agent.json'), JSON.stringify({model: 'legacy-magpie', baseURL: `http://127.0.0.1:${provider.address().port}/v1`, key: 'synthetic-legacy-magpie-key'}), {mode: 0o600});
  }
  let app = await startLakeServer(options);
  t.after(async () => {
    releaseBackgroundChild();
    await app.close();
    await new Promise((resolve) => provider.close(resolve));
  });
  const api = async (path, method = "GET", data, expected = 200) => {
    const response = await fetch(app.origin + path, {
      method,
      headers: {
        Authorization: `Bearer ${app.token}`,
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  if (!legacyDev) await api("/api/settings/model", "PUT", {
    url: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
    name: "fixture",
    apiKey: "synthetic-secret-no-real-credential",
  });
  const project = await api("/api/projects", "POST", { name: "验证项目" });
  const session = await api(`/api/projects/${project.id}/sessions`, "POST", {});
  await api(`/api/sessions/${session.id}/ai/configure`, "POST", { maxSteps: 4 });
  const wait = async (statuses) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const view = await api(`/api/sessions/${session.id}/ai`);
      if (statuses.includes(view.status)) return view;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("timeout " + JSON.stringify(await api(`/api/sessions/${session.id}/ai`)));
  };
  return {
    home,
    target,
    project,
    session,
    api,
    wait,
    requests,
    requestAuthorizations,
    gatewayURL: `http://127.0.0.1:${provider.address().port}/v1`,
    failWorkerRequests() { failWorkerRequests = true; },
    recoverModel() { modelFailure = false; },
    options,
    get app() {
      return app;
    },
    get calls() {
      return calls;
    },
    get backgroundJoinRequested() {
      return backgroundJoinRequested;
    },
    async restart(beforeStart) {
      await app.close();
      if (beforeStart) await beforeStart();
      app = await startLakeServer(options);
    },
  };
}

async function writeMagpie(f, updates = {}) {
  const value = {model: 'magpie-first', baseURL: f.gatewayURL, key: 'synthetic-magpie-private-only', contextWindow: 64000, maxOutput: 2048,
    supportsImageInput: true, reasoningEfforts: ['low', 'high'], catalog: [
      {id: 'magpie-first', name: 'Magpie First', contextWindow: 64000, maxOutput: 2048, supportsImageInput: true, reasoningEfforts: ['low', 'high']},
      {id: 'magpie-second', name: 'Magpie Second', contextWindow: 32000, maxOutput: 4096, reasoningEfforts: ['low', 'high']},
      {id: 'magpie-third', name: 'Magpie Third', contextWindow: 48000, maxOutput: 4096},
    ], ...updates};
  await writeFile(join(f.home, 'secrets/magpie-agent.json'), JSON.stringify(value), {mode: 0o600});
  return value;
}

test('Magpie and native selections coexist, synchronize after file edits and restore the native fallback without copying credentials', async t => {
  const f = await fixture(t), file = join(f.home, 'secrets/magpie-agent.json'), config = await writeMagpie(f);
  const original = await readFile(file), native = (await f.api('/api/bootstrap')).modelSelection;
  let state = await f.api('/api/settings/model/state');
  assert.equal(state.providers.activeProviderId, 'custom'); assert.equal(state.settings.managedBy, undefined);
  assert.equal(state.settings.magpie.name, 'magpie-first'); assert.equal(state.available.entries.length, 4); assert.equal(f.calls, 0);
  assert.deepEqual(state.providers.providers.map(provider => provider.id), ['custom'], 'the managed source is not an editable or duplicated native provider');
  await f.api('/api/settings/model/select', 'POST', {providerId: 'magpie', modelId: 'magpie-second'});
  state = await f.api('/api/settings/model/state');
  assert.equal(state.settings.managedBy, 'magpie'); assert.equal(state.modelSelection.displayName, 'Magpie Second');
  assert.equal(state.available.source, 'magpie'); assert.equal(state.available.activeModelId, 'magpie-second');
  await f.restart(); assert.equal((await f.api('/api/bootstrap')).modelName, 'magpie-second');
  await writeMagpie(f, {model: 'magpie-third'});
  assert.equal((await f.api('/api/settings/model/state')).modelName, 'magpie-third', 'changing the Magpie default invalidates an override scoped to the old default');
  await f.api('/api/settings/model/select', 'POST', {providerId: native.providerId, modelId: native.modelId});
  await writeMagpie(f, {model: 'magpie-second'}); await f.restart();
  assert.equal((await f.api('/api/bootstrap')).modelSelection.providerId, 'custom', 'manual selection survives a new gateway default and restart');
  await f.api('/api/settings/model/select', 'POST', {providerId: 'magpie', modelId: 'magpie-first'});
  await writeFile(file, '{}\n'); state = await f.api('/api/settings/model/state');
  assert.equal(state.settings.magpie, undefined); assert.equal(state.modelSelection.providerId, 'custom');
  await writeMagpie(f); await f.restart(); assert.equal((await f.api('/api/bootstrap')).modelName, 'magpie-first', 'reconnection retains the selected source');
  await f.api('/api/settings/model/select', 'POST', {providerId: 'magpie', modelId: 'absent'}, 400);
  assert.equal((await f.api('/api/bootstrap')).modelName, 'magpie-first');
  assert.deepEqual(await readFile(file), original, 'only the external plugin owns its configuration');
  assert.ok(!JSON.stringify(f.app.store.list('providers')).includes(config.key));
  assert.ok(!JSON.stringify(f.app.store.list('settings')).includes(config.key));
  await assert.rejects(access(join(f.home, 'secrets/model-magpie.json')));
  assert.ok(!JSON.stringify(state).includes('synthetic-'));
});

test('Magpie inference uses its real SDK model, scoped reasoning and output limits and reloads rotated credentials on the next turn', async t => {
  const f = await fixture(t), config = await writeMagpie(f), base = `/api/sessions/${f.session.id}`;
  await f.api('/api/settings/model/select', 'POST', {providerId: 'magpie', modelId: 'magpie-first'});
  const reasoning = await f.api(base + '/ai/reasoning'); assert.deepEqual(reasoning.levels, ['low','high']);
  await f.api(base + '/ai/reasoning', 'POST', {modelId: reasoning.modelId, effort: 'low'});
  await f.api(base + '/messages', 'POST', {text: 'Magpie initial inference', ignoreProjectMemory: true}, 202); await f.wait(['completed']);
  assert.equal(f.requests.at(-1).model, 'magpie-first'); assert.equal(f.requests.at(-1).reasoning_effort, 'low'); assert.equal(f.requests.at(-1).max_tokens, 2048);
  assert.equal(f.requestAuthorizations.at(-1), 'Bearer ' + config.key);
  const oldProvider = f.app.store.modelProvider('magpie');
  const rotated = await writeMagpie(f, {key: 'synthetic-magpie-rotated-private-only'});
  await assert.rejects(f.app.store.modelCredential(oldProvider), /连接已变化/, 'an old endpoint snapshot cannot obtain the replacement credential');
  await f.api(base + '/messages', 'POST', {text: 'Magpie after key rotation', ignoreProjectMemory: true}, 202); await f.wait(['completed']);
  assert.equal(f.requestAuthorizations.at(-1), 'Bearer ' + rotated.key);
  await writeMagpie(f, {model: 'magpie-second', key: rotated.key});
  await f.api(base + '/messages', 'POST', {text: 'Magpie after a new default', ignoreProjectMemory: true}, 202); await f.wait(['completed']);
  assert.equal(f.requests.at(-1).model, 'magpie-second'); assert.equal(f.requests.at(-1).reasoning_effort, undefined, 'reasoning does not cross model identities');
  assert.equal(f.requests.at(-1).max_tokens, 4096);
  await writeFile(join(f.home, 'secrets/magpie-agent.json'), '{}\n');
  await f.api(base + '/messages', 'POST', {text: 'Return to original native configuration', ignoreProjectMemory: true}, 202); await f.wait(['completed']);
  assert.equal(f.requests.at(-1).model, 'fixture'); assert.equal(f.requestAuthorizations.at(-1), 'Bearer synthetic-secret-no-real-credential');
  assert.equal((await f.api(base + '/snapshot')).messages.filter(message => message.role === 'user').length, 4);
});

test('a fresh Magpie source works without a native provider and becomes unavailable after disconnect', async t => {
  const f = await fixture(t); await f.api('/api/settings/providers/custom', 'DELETE'); await writeMagpie(f);
  const state = await f.api('/api/settings/model/state'); assert.equal(state.modelConfigured, true); assert.equal(state.settings.managedBy, 'magpie');
  assert.equal(state.providers.providers.length, 0); assert.equal(state.available.entries.length, 3);
  await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: 'Only the Magpie source is configured', ignoreProjectMemory: true}, 202);
  assert.equal((await f.wait(['completed', 'failed'])).status, 'completed'); assert.equal(f.requests[0].model, 'magpie-first');
  await writeFile(join(f.home, 'secrets/magpie-agent.json'), '{}\n');
  assert.equal((await f.api('/api/bootstrap')).modelConfigured, false);
  await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: 'Must not reuse the disconnected key'}, 409);
  assert.equal(f.calls, 1);
});

test('Magpie never reads an unsafe optional configuration or permits native API writes to the managed provider', async t => {
  const f = await fixture(t), fs = require('node:fs/promises'), file = join(f.home, 'secrets/magpie-agent.json'), config = await writeMagpie(f);
  const original = await readFile(file);
  await f.api('/api/settings/providers/magpie', 'PUT', {apiKey: 'synthetic-replacement'}, 409);
  await f.api('/api/settings/providers/magpie', 'DELETE', undefined, 409);
  await assert.rejects(f.app.store.secret('magpie', 'synthetic-replacement'), /插件管理/);
  assert.deepEqual(await readFile(file), original);
  await fs.chmod(file, 0o644); assert.equal((await f.api('/api/settings/model')).magpie, undefined); assert.equal((await fs.stat(file)).mode & 0o777, 0o644);
  await fs.chmod(file, 0o600); assert.ok((await f.api('/api/settings/model')).magpie);
  const external = join(f.home, 'outside-config.json'); await writeFile(external, original, {mode: 0o600}); await fs.unlink(file); await fs.symlink(external, file);
  assert.equal((await f.api('/api/settings/model')).magpie, undefined); assert.deepEqual(await readFile(external), original);
  await fs.unlink(file); await writeFile(file, JSON.stringify({...config, baseURL: 'http://user:password@127.0.0.1:9/v1'}), {mode: 0o600});
  assert.equal((await f.api('/api/settings/model')).magpie, undefined);
  await writeFile(file, '{'); assert.equal((await f.api('/api/settings/model')).magpie, undefined);
  await writeFile(file, 'x'.repeat(2*1024*1024+1)); assert.equal((await f.api('/api/settings/model')).magpie, undefined);
  assert.equal((await f.api('/api/bootstrap')).modelSelection.providerId, 'custom'); assert.equal(f.calls, 0, 'file synchronization makes no provider requests');
});

test('Magpie imports an exact legacy selection once and never resurrects it over a new TS choice', async t => {
  const f = await fixture(t); await writeMagpie(f); await f.api('/api/settings/model', 'DELETE');
  await writeFile(join(f.options.data, 'magpie-selection.json'), JSON.stringify({defaultModel: 'magpie-first', model: 'magpie-second'}), {mode: 0o600});
  f.app.store.delete('settings', 'magpieSelectionImported'); await f.restart();
  assert.equal((await f.api('/api/bootstrap')).modelName, 'magpie-second');
  await f.api('/api/settings/model/select', 'POST', {providerId: 'magpie', modelId: 'magpie-first'}); await f.restart();
  assert.equal((await f.api('/api/bootstrap')).modelName, 'magpie-first');
  assert.equal(JSON.parse(await readFile(join(f.options.data, 'magpie-selection.json'), 'utf8')).model, 'magpie-second');
});

test('a fresh Dev import preserves an explicit old Magpie source and its exact native fallback', async t => {
  const f = await fixture(t, 'legacy-magpie-source', true), config = join(f.home, 'secrets/magpie-agent.json');
  assert.equal((await f.api('/api/bootstrap')).modelSelection.providerId, 'magpie');
  assert.equal((await f.api('/api/settings/model')).name, 'legacy-magpie');
  await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: 'Use the original selected source', ignoreProjectMemory: true}, 202); await f.wait(['completed']);
  assert.equal(f.requestAuthorizations.at(-1), 'Bearer synthetic-legacy-magpie-key');
  await writeFile(config, '{}\n'); const fallback = await f.api('/api/bootstrap');
  assert.equal(fallback.modelSelection.providerId, 'legacy.fixture'); assert.equal(fallback.modelName, 'fixture');
  await f.restart(); assert.equal((await f.api('/api/bootstrap')).modelSelection.providerId, 'legacy.fixture');
});

test('Magpie credentials split across model chunks stay out of public views and the native session archive', async t => {
  const f = await fixture(t, 'magpie-secret'), config = await writeMagpie(f);
  await f.api('/api/settings/model/select', 'POST', {providerId: 'magpie', modelId: config.model});
  await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: 'Synthetic redaction probe', ignoreProjectMemory: true}, 202);
  const view = await f.wait(['completed']); assert.ok(JSON.stringify(view).includes('[REDACTED]')); assert.ok(!JSON.stringify(view).includes(config.key));
  assert.ok(!JSON.stringify(await f.api(`/api/sessions/${f.session.id}/snapshot`)).includes(config.key));
  for (const name of ['agent-sessions.sqlite', 'agent-sessions.sqlite-wal']) {
    try { assert.ok(!(await readFile(join(f.options.data,name))).includes(Buffer.from(config.key))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
});

function nativeMemoryReply(request) {
  const content = message => typeof message.content === "string" ? message.content : (message.content ?? []).map(part => part.text ?? "").join("");
  const messages = request.messages.map(content);
  const extractionStart = messages.findIndex(value => value.includes("You are now acting as the memory extraction subagent"));
  if (extractionStart < 0) return { content: "已收到限定范围的来源，交由原生记忆提取。" };
  assert.ok(!request.messages.some(message => message.role === 'system' && content(message).includes('Do not call tools in this acknowledgement stage')),
    'foreground acknowledgement instructions must not suppress detached native extraction');
  const root = messages.join("\n").match(/persistent file-based memory at `([^`]+)`/)?.[1];
  assert.ok(root, "real SDK Memory prompt must provide its actual private directory");
  const calls = request.messages.slice(extractionStart).flatMap(message => message.tool_calls ?? []);
  const call = (name, input, id, index=0) => ({ index, id, type: "function", function: { name, arguments: JSON.stringify(input) } });
  if (!calls.some(call => call.function.name === "Read")) return { tool_calls: [
    call("Read", { file_path: join(root, "MEMORY.md") }, "memory-read-index"),
    ...(messages.join("\n").includes("native-method.md") ? [call("Read", {file_path:join(root,"native-method.md")}, "memory-read-method",1)] : []),
  ] };
  if (!calls.some(call => call.function.name === "Write")) {
    const role = messages.join("\n").includes('"kind":"accepted_task"');
    const body = "---\nname: native-method\ndescription: 按证据报告的方法\nmetadata:\n  type: feedback\n---\n" + (role ? "NATIVE_ROLE_MEMORY：子智能体发现由父任务汇合，重新检查当前状态。" : "NATIVE_PROJECT_MEMORY：报告先给结论，再列证据；历史数值需要重新查询。");
    return { tool_calls: [call("Write", {file_path:join(root,"native-method.md"),content:body},"memory-write-fact"),
      call("Write",{file_path:join(root,"MEMORY.md"),content:"- [按证据报告的方法](native-method.md)"},"memory-write-index",1)] };
  }
  return { content: "已按原生文件协议保存知识。" };
}

test('model settings tests call the actual model and never save a test credential or selection', async t => {
  const f = await fixture(t), selection = f.app.store.get('settings', 'modelSelection');
  const provider = f.app.store.list('providers')[0], calls = f.calls;
  assert.equal((await f.api('/api/settings/model/test', 'POST', {url: provider.baseURL, name: 'fixture'})).ok, true);
  assert.equal(f.calls, calls + 1);
  await f.api('/api/settings/model/test', 'POST', {url: 'http://127.0.0.1:1/v1', name: 'fixture', apiKey: 'temporary-test-secret'}, 502);
  assert.deepEqual(f.app.store.get('settings', 'modelSelection'), selection);
  assert.equal(f.app.store.list('providers').length, 1);
  await f.api('/api/settings/model/test', 'GET', undefined, 405);
});

test('presets persist updates and deletion across restart; unknown routes cannot return unrelated success DTOs', async t => {
  const f = await fixture(t);
  const saved = await f.api('/api/ai/presets', 'POST', {title: '证据报告', content: '先给结论，再列证据'});
  await f.restart();
  assert.deepEqual(await f.api('/api/ai/presets'), [saved]);
  const updated = await f.api('/api/ai/presets', 'POST', {...saved, content: '先给结论与时间'});
  assert.deepEqual(await f.api('/api/ai/presets'), [updated]);
  await f.api('/api/ai/presets', 'DELETE', {id: saved.id});
  await f.restart(); assert.deepEqual(await f.api('/api/ai/presets'), []);
  await f.api('/api/ai/presets', 'POST', {title: '', content: 'invalid'}, 400);
  for (const [path, method, data] of [
    [`/api/sessions/${f.session.id}/text-files`, 'POST', {}],
    [`/api/sessions/${f.session.id}/sre/tasks`, 'GET'],
    [`/api/sessions/${f.session.id}/unknown`, 'PATCH', {title: 'must not change'}],
    [`/api/resources/${(await f.api('/api/catalog')).resources[0].id}/unknown`, 'GET'],
  ]) await f.api(path, method, data, 404);
  assert.notEqual((await f.api(`/api/sessions/${f.session.id}`)).title, 'must not change');
  await f.api(`/api/sessions/${f.session.id}/ai/abort`, 'GET', undefined, 405);
  await f.api('/api/settings/providers/missing/test', 'PUT', {}, 405);
  assert.equal(f.app.store.list('providers').length, 1);
});

async function legacyMcpAuthority(f, entries, bindings = []) {
  const fs = require('node:fs/promises'), {DatabaseSync} = require('node:sqlite');
  await fs.mkdir(join(f.home, 'security'), {mode: 0o700});
  await fs.mkdir(join(f.options.data, 'adk'), {mode: 0o700});
  const authority = {storeID: 'a'.repeat(64), recoveryEpoch: 'b'.repeat(64)};
  await writeFile(join(f.home, 'security/control.json'), JSON.stringify({formatVersion: 1, ...authority, storeReady: true,
    gate: 'open', runtimeRoot: await fs.realpath(join(f.options.data, 'adk'))}), {mode: 0o600});
  const path = join(f.options.data, 'adk/sessions.sqlite'), db = new DatabaseSync(path);
  db.exec(`CREATE TABLE security_schema_meta(id INTEGER,schema_version INTEGER,minimum_reader_version INTEGER,store_id TEXT,recovery_epoch TEXT,migration_state TEXT);
    CREATE TABLE security_authority_events(kind TEXT,project_id TEXT,object_id TEXT,store_id TEXT,recovery_epoch TEXT,after_revision INTEGER,result TEXT);
    CREATE TABLE security_mcp_bindings(project_id TEXT,server_id TEXT,store_id TEXT,recovery_epoch TEXT,revision INTEGER,enabled INTEGER,tool_names TEXT);`);
  db.prepare('INSERT INTO security_schema_meta VALUES(1,1,3,?,?,?)').run(authority.storeID, authority.recoveryEpoch, 'ready');
  for (const entry of entries) db.prepare('INSERT INTO security_authority_events VALUES(?,?,?,?,?,?,?)').run('mcp.inheritance', entry.projectId, entry.projectId,
    authority.storeID, entry.epoch ?? authority.recoveryEpoch, entry.revision, JSON.stringify({ProjectID: entry.projectId, Revision: entry.revision, Enabled: entry.enabled}));
  for (const entry of bindings) db.prepare('INSERT INTO security_mcp_bindings VALUES(?,?,?,?,?,?,?)').run(entry.projectId, entry.serverId,
    authority.storeID, entry.epoch ?? authority.recoveryEpoch, entry.revision, entry.enabled ? 1 : 0, JSON.stringify(entry.names ?? []));
  db.close(); await fs.chmod(path, 0o600); f.options.development = true; f.options.importLegacy = true;
  return {path, authority};
}

test('MCP migration restores exact current-epoch choices, explicit denials and latest revisions without contacting services', async t => {
  const f = await fixture(t), mcp = await mcpFixture(t);
  const a = await f.api('/api/settings/mcp', 'POST', {name: 'A', transport: 'http', enabled: true, url: mcp.url});
  const b = await f.api('/api/settings/mcp', 'POST', {name: 'B', transport: 'http', enabled: true, url: mcp.url});
  const stale = await f.api('/api/projects', 'POST', {name: '旧纪元项目'});
  await legacyMcpAuthority(f, [
    {projectId: f.project.id, revision: 1, enabled: false}, {projectId: f.project.id, revision: 2, enabled: true},
    {projectId: stale.id, revision: 9, enabled: true, epoch: 'c'.repeat(64)},
  ], [{projectId: f.project.id, serverId: b.id, revision: 4, enabled: false}]);
  await f.restart();
  const base = `/api/projects/${f.project.id}/security/mcp-inheritance`;
  assert.deepEqual((await f.api(base)).servers.map(row => row.id), [a.id]);
  assert.equal((await f.api(base)).Revision, 2);
  assert.equal((await f.api(`/api/projects/${stale.id}/security/mcp-inheritance`)).Enabled, false);
  await f.api(base, 'PUT', {enabled: false, expectedRevision: 2, actionId: 'new-ts-denial'});
  await f.restart();
  assert.equal((await f.api(base)).Enabled, false, 'saved TS choices win on restart');
  assert.equal(f.app.store.list('legacyMcpChoices').length, 2);
  assert.deepEqual(mcp.requests, [], 'catalog migration never connects to an MCP service');
});

test('stale explicit MCP bindings cannot fall back to inherited access and migrated choices cannot survive a recovery epoch', async t => {
  const f = await fixture(t), mcp = await mcpFixture(t), fs = require('node:fs/promises');
  const a = await f.api('/api/settings/mcp', 'POST', {name: 'A', transport: 'http', enabled: true, url: mcp.url});
  const source = await legacyMcpAuthority(f, [{projectId: f.project.id, revision: 1, enabled: true}],
    [{projectId: f.project.id, serverId: a.id, revision: 5, enabled: true, epoch: 'c'.repeat(64), names: ['fixture']}]);
  await f.restart();
  const base = `/api/projects/${f.project.id}/security/mcp-inheritance`;
  assert.deepEqual((await f.api(base)).servers, []);
  // Simulate an externally completed recovery while the server is stopped.
  await f.restart(async () => {
    const controlPath = join(f.home, 'security/control.json'), control = JSON.parse(await readFile(controlPath, 'utf8'));
    control.recoveryEpoch = 'd'.repeat(64); await writeFile(controlPath, JSON.stringify(control), {mode: 0o600});
    const db = new (require('node:sqlite').DatabaseSync)(source.path); db.prepare('UPDATE security_schema_meta SET recovery_epoch=?').run(control.recoveryEpoch); db.close();
  });
  assert.deepEqual((await f.api(base)).servers, []);
  assert.equal(f.app.store.list('legacyMcpChoices').length, 2);
  assert.deepEqual(mcp.requests, []);
});

test('resource folders preserve nested parents, ordering, archive and restore through restart without deleting resource history', async t => {
  const f = await fixture(t), base = `/api/projects/${f.project.id}/resource-tree`;
  const root = (await f.api(base, 'POST', {operation: 'create', name: '南京'})).nodes.find(node => node.name === '南京');
  const child = (await f.api(base, 'POST', {operation: 'create', parentId: root.id, name: 'K2'})).nodes.find(node => node.name === 'K2');
  const resource = await f.api(`/api/projects/${f.project.id}/resources`, 'POST', {name: '集群入口', kind: 'local', parentId: child.id, settings: {shell: 'zsh'}});
  await f.restart();
  let catalog = await f.api('/api/catalog');
  assert.equal(catalog.resourceTree.find(node => node.resourceId === resource.id).parentId, child.id);
  await f.api(base, 'POST', {operation: 'move', nodeId: root.id, parentId: child.id}, 409);
  const other = await f.api('/api/projects', 'POST', {name: '其他项目'});
  await f.api(`/api/projects/${other.id}/resources`, 'POST', {kind: 'local', parentId: child.id}, 404);
  await f.api(base, 'POST', {operation: 'rename', nodeId: resource.id, name: '准确入口'});
  assert.equal((await f.api(`/api/resources/${resource.id}`)).name, '准确入口');
  await f.api(base, 'POST', {operation: 'delete', nodeId: root.id});
  assert.ok(!(await f.api('/api/catalog')).resources.some(entry => entry.id === resource.id));
  assert.equal(f.app.store.get('resources', resource.id).name, '准确入口', 'soft deletion preserves the canonical resource');
  await f.api(`/api/resources/${resource.id}`, 'GET', undefined, 404);
  await f.restart();
  assert.equal((await f.api('/api/navigation-trash')).items.length, 3);
  await f.api('/api/navigation-trash', 'POST', {kind: 'folder', id: root.id});
  catalog = await f.api('/api/catalog');
  assert.equal(catalog.resourceTree.find(node => node.id === child.id).parentId, root.id);
  assert.equal(catalog.resourceTree.find(node => node.id === resource.id).parentId, child.id);
  await f.api('/api/navigation-delete', 'POST', {kind: 'project', id: f.project.id});
  assert.ok(!(await f.api('/api/catalog')).projects.some(project => project.id === f.project.id));
  await f.api(`/api/projects/${f.project.id}/sessions`, 'POST', {}, 404);
  await f.api('/api/navigation-trash', 'POST', {kind: 'project', id: f.project.id});
  assert.ok((await f.api('/api/catalog')).resources.some(entry => entry.id === resource.id));
});

test('selected resource and extension references persist with exact spans and reject foreign or stale identities before sending', async t => {
  const f = await fixture(t), resource = (await f.api('/api/catalog')).resources[0];
  const message = await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: `检查 ${resource.name}`, resourceIds: [resource.id],
    mentions: [{kind: 'resource', id: resource.id, label: resource.name, start: 3, end: 3 + resource.name.length}]}, 202);
  await f.wait(['completed']);
  const stored = f.app.store.list('messages').find(row => row.role === 'user');
  assert.deepEqual(stored.mentions, [{kind: 'resource', id: resource.id, label: resource.name, start: 3, end: 3 + resource.name.length}]);
  assert.deepEqual(f.app.store.get('messageInputs', stored.id).resourceIds, [resource.id]);
  assert.deepEqual(await f.api(`/api/sessions/${f.session.id}/ai/references`), [resource.id]);
  assert.ok(f.requests.some(request => JSON.stringify(request.messages).includes(resource.id)));
  const other = await f.api('/api/projects', 'POST', {name: '外国项目'}), foreign = (await f.api('/api/catalog')).resources.find(row => row.projectId === other.id);
  const calls = f.calls;
  await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: '检查资源', resourceIds: [foreign.id]}, 403);
  await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: '检查资源', mentions: [{kind: 'resource', id: resource.id, label: resource.name, start: 0, end: 2}]}, 400);
  assert.equal(f.calls, calls);
  await f.restart(); assert.deepEqual(f.app.store.get('messageInputs', stored.id).resourceIds, [resource.id]);
  await f.api(`/api/sessions/${f.session.id}/ai/clearReferences`, 'POST', {});
  assert.deepEqual(await f.api(`/api/sessions/${f.session.id}/ai/references`), []);
  assert.deepEqual(f.app.store.get('messageInputs', stored.id).resourceIds, [resource.id], 'clearing the access cache never rewrites an admitted task source');
});

test('referenced-only execution uses the real admitted user selection and cannot borrow another task selection', {skip: process.platform !== 'darwin'}, async t => {
  const f = await fixture(t, 'super-full-worker'), project = await f.api(`/api/projects/${f.project.id}/superagent`, 'POST', {});
  const resource = (await f.api('/api/catalog')).resources.find(row => row.projectId === f.project.id && row.kind === 'local');
  await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`, 'POST', {blockUnreferencedAssets: true, silentReadFiles: true});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, 'POST', {text: '检查项目文件', resourceIds: [resource.id]}, 202);
  let state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), value => value.workers.some(row => row.assignmentState === 'parked'));
  assert.ok(f.app.store.list('superOperations').some(operation => operation.resourceId === resource.id && operation.status === 'succeeded'));
  const operations = f.app.store.list('superOperations').length;
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, 'POST', {text: '再创建一项检查项目文件的工作'}, 202);
  state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), value => value.workers.length === 2 && value.workers.every(row => row.assignmentState === 'parked'));
  assert.equal(f.app.store.list('superOperations').length, operations, 'a sibling task cannot inherit an earlier user selection');
});

test('editable user queues persist pause, edit and ordering with revision checks and dispatch actual messages once after resume', async t => {
  const f = await fixture(t), base = `/api/sessions/${f.session.id}/message-queue`, messages = `/api/sessions/${f.session.id}/messages`;
  await f.api(base, 'POST', {operation: 'pause', revision: 0});
  const a = await f.api(messages, 'POST', {text: '第一条排队消息', enqueue: true}, 202);
  const b = await f.api(messages, 'POST', {text: '第二条排队消息', enqueue: true}, 202);
  let queue = await f.api(base); assert.equal(queue.items.length, 2); assert.equal(queue.paused, true);
  assert.equal(queue.pushSupported, false);
  assert.equal((await f.api(`/api/sessions/${f.session.id}/snapshot`)).messageQueue.pushSupported, false);
  await f.api(base, 'POST', {operation: 'push', revision: queue.revision, id: a.queuedMessageId}, 501);
  assert.equal((await f.api(base)).items.length, 2, 'an unsupported supplement preserves the exact pending drafts');
  await f.api(base, 'POST', {operation: 'resume', revision: 0}, 409);
  queue = await f.api(base, 'POST', {operation: 'edit', revision: queue.revision, id: a.queuedMessageId, text: '已编辑的第一条消息', resourceIds: [], mentions: []});
  queue = await f.api(base, 'POST', {operation: 'reorder', revision: queue.revision, ids: [b.queuedMessageId, a.queuedMessageId]});
  await f.restart(); queue = await f.api(base); assert.equal(queue.paused, true); assert.equal(f.calls, 0);
  assert.deepEqual((await f.api(`/api/sessions/${f.session.id}/snapshot`)).messageQueue.items.map(item => item.id), [b.queuedMessageId, a.queuedMessageId]);
  await f.api(base, 'POST', {operation: 'resume', revision: queue.revision});
  await until(() => f.api(base), value => value.items.length === 0); await f.wait(['completed']);
  assert.deepEqual(f.app.store.messages(f.session.id).filter(message => message.role === 'user').map(message => message.text), ['第二条排队消息', '已编辑的第一条消息']);
  assert.equal(f.calls, 2); assert.equal(f.app.store.list('messageQueueDispatches').filter(row => row.state === 'accepted').length, 2);
  await f.restart(); assert.equal(f.calls, 2); assert.deepEqual((await f.api(base)).items, []);
});

test('stopping a conversation pauses its unsent queue and an explicit resume is required after the stopped root', async t => {
  const f = await fixture(t, 'write'), base = `/api/sessions/${f.session.id}/message-queue`, messages = `/api/sessions/${f.session.id}/messages`;
  await f.api(messages, 'POST', {text: '等待明确审批的测试写入'}, 202); await f.wait(['waiting_approval']);
  await f.api(messages, 'POST', {text: '停止后仍须保留的下一条', enqueue: true}, 202);
  await f.api(`/api/sessions/${f.session.id}/ai/abort`, 'POST', {});
  let queue = await f.api(base); assert.equal(queue.paused, true); assert.equal(queue.items.length, 1);
  assert.equal(f.calls, 1); await assert.rejects(access(f.target));
  await f.api(base, 'POST', {operation: 'resume', revision: queue.revision});
  await until(() => f.api(base), value => value.items.length === 0); await f.wait(['completed']);
  assert.equal(f.calls, 2); await assert.rejects(access(f.target));
});

test('a fault after message admission never retries an uncertain queue item across restart or resume', async t => {
  const f = await fixture(t), base = `/api/sessions/${f.session.id}/message-queue`;
  const original = f.app.superagent.send.bind(f.app.superagent);
  f.app.superagent.send = async (...args) => { await original(...args); throw new Error('synthetic post-admission process-loss boundary'); };
  await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: '只应接入一次的排队消息', enqueue: true}, 202);
  await until(() => f.api(base), value => value.paused && !!value.lastError); await f.wait(['completed']);
  assert.equal(f.calls, 1); assert.equal(f.app.store.messages(f.session.id).filter(message => message.role === 'user').length, 1);
  await f.restart(); const queue = await f.api(base);
  await f.api(base, 'POST', {operation: 'resume', revision: queue.revision}, 409);
  assert.equal(f.calls, 1); assert.equal(queue.items.length, 1);
  await f.api(base, 'POST', {operation: 'remove', revision: queue.revision, id: queue.items[0].id});
  assert.equal(f.app.store.messages(f.session.id).filter(message => message.role === 'user').length, 1, 'removing an unsent copy never deletes admitted history');
});

test('Plan mode persists and its catalog execution confirms only the exact live frozen original proposal', async t => {
  const f = await fixture(t, 'super-inspect'), project = await f.api(`/api/projects/${f.project.id}/superagent`, 'POST', {});
  const base = `/api/sessions/${project.routerSessionId}/ai`;
  const update = await f.api(base + '/mode', 'POST', {mode: 'plan'}); assert.equal(update.mode, 'plan'); assert.ok(update.cursor > 0);
  await f.restart(); assert.equal((await f.api(`/api/sessions/${project.routerSessionId}/snapshot`)).conversationMode, 'plan');
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, 'POST', {text: '先制定准确计划，再读取项目工作区。'}, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), value => value.channels[0]?.needsConfirmation);
  const worker = state.workers[0], goal = f.app.store.list('superGoals')[0], beforeDeadline = goal.deadlineAt;
  const plans = (await f.api(base + '/plans')).plans; assert.equal(plans.length, 1); assert.ok(plans[0].content.includes(goal.items[0].title));
  assert.equal(f.app.store.list('superOperations').length, 0);
  await f.api(`/api/sessions/${worker.sessionId}/ai/mode`, 'POST', {mode: 'default'}, 409);
  const other = await f.api('/api/projects', 'POST', {name: '无关项目'}), foreign = await f.api(`/api/projects/${other.id}/sessions`, 'POST', {});
  await f.api(`/api/sessions/${foreign.id}/ai/executePlan`, 'POST', {planId: plans[0].id}, 404);
  await f.api(base + '/executePlan', 'POST', {planId: plans[0].id});
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), value => value.workers[0]?.assignmentState === 'parked');
  assert.equal(f.app.store.list('superGoals').length, 1); assert.equal(f.app.store.list('superGoals')[0].deadlineAt, beforeDeadline);
  assert.equal(f.app.store.list('superOperations').length, 1); assert.equal(f.app.store.list('superPlanConfirmations').length, 1);
  assert.equal(f.app.store.list('superPlanConfirmations')[0].sourceKind, 'user_action');
  assert.equal(f.app.store.list('superPlanConfirmations')[0].sourceSessionId, project.routerSessionId);
  await f.api(base + '/executePlan', 'POST', {planId: plans[0].id}, 409);
});

test('a saved Plan cannot restart its cancelled input checkpoint or acquire new execution eligibility after process restart', async t => {
  const f = await fixture(t, 'super-inspect'), project = await f.api(`/api/projects/${f.project.id}/superagent`, 'POST', {}), base = `/api/sessions/${project.routerSessionId}/ai`;
  await f.api(base + '/mode', 'POST', {mode: 'plan'});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, 'POST', {text: '制定计划但暂不批准。'}, 202);
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), value => value.channels[0]?.needsConfirmation);
  const plan = (await f.api(base + '/plans')).plans[0], calls = f.calls;
  await f.restart(); await f.api(base + '/executePlan', 'POST', {planId: plan.id}, 409);
  assert.equal(f.calls, calls); assert.equal(f.app.store.list('superOperations').length, 0); assert.equal(f.app.store.list('superPlanConfirmations').length, 0);
});

test('workflow templates support validated versioned persistence while unsupported execution never reports an empty successful run', async t => {
  const f = await fixture(t), base = `/api/projects/${f.project.id}/workflows`, resource = (await f.api('/api/catalog')).resources[0];
  const input = {name: '只读检查手册', goal: '检查项目运行条件', steps: [{id: 'inspect', role: 'host', task: '查看主机负载', resourceIds: [resource.id]}]};
  const saved = await f.api(base, 'POST', input); assert.equal(saved.version, 1);
  await f.restart(); assert.deepEqual((await f.api(base)).templates, [saved]);
  await f.api(base + '/' + saved.id, 'PUT', {...input, version: 0}, 409);
  const next = await f.api(base + '/' + saved.id, 'PUT', {...input, name: '已修改的手册', version: 1}); assert.equal(next.version, 2);
  const other = await f.api('/api/projects', 'POST', {name: '其他项目'});
  await f.api(`/api/projects/${other.id}/workflows/${saved.id}`, 'DELETE', {version: 2}, 404);
  await f.api(base + '/' + saved.id + '/run', 'POST', {version: 2}, 501);
  assert.equal(f.calls, 0); assert.deepEqual((await f.api(base)).runs, []);
  await f.api(base, 'POST', {...input, name: 'synthetic-secret-no-real-credential'}, 400);
  await f.api(base + '/' + saved.id, 'DELETE', {version: 1}, 409);
  await f.api(base + '/' + saved.id, 'DELETE', {version: 2}); await f.restart();
  assert.deepEqual((await f.api(base)).templates, []); assert.equal(f.app.store.get('archivedWorkflowTemplates', saved.id).version, 2);
});

test('the saved Go workflow catalog migrates without executing it and later edits or deletion are never resurrected', async t => {
  const f = await fixture(t), resource = (await f.api('/api/catalog')).resources[0], {DatabaseSync} = require('node:sqlite'), fs = require('node:fs/promises');
  const path = join(f.options.data, 'lake-web.sqlite'), db = new DatabaseSync(path), at = '2026-11-01T00:00:00Z';
  db.exec('CREATE TABLE workflows(id TEXT,projectId TEXT,name TEXT,goal TEXT,steps TEXT,version INTEGER,createdAt TEXT,updatedAt TEXT);');
  db.prepare('INSERT INTO workflows VALUES(?,?,?,?,?,?,?,?)').run('saved-go-workflow', f.project.id, '原只读手册', '原目标',
    JSON.stringify([{id: 'inspect', role: 'host', task: '查看当前负载', resourceIds: [resource.id]}]), 3, at, at);
  db.close(); await fs.chmod(path, 0o600); const before = await readFile(path);
  f.options.development = true; f.options.importLegacy = true; await f.restart();
  const base = `/api/projects/${f.project.id}/workflows`, saved = (await f.api(base)).templates[0];
  assert.equal(saved.id, 'saved-go-workflow'); assert.equal(saved.version, 3); assert.equal(f.calls, 0);
  await f.api(base + '/' + saved.id, 'PUT', {...saved, name: '新的 TS 选择', version: 3}); await f.restart();
  assert.equal((await f.api(base)).templates[0].name, '新的 TS 选择');
  await f.api(base + '/' + saved.id, 'DELETE', {version: 4}); await f.restart();
  assert.deepEqual((await f.api(base)).templates, []); assert.deepEqual(await readFile(path), before); assert.equal(f.calls, 0);
});

test('Gemini and Ollama catalog and actual SDK model tests reach their correct compatibility endpoints', async t => {
  const f = await fixture(t), requests = [];
  const wire = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({url: req.url, authorization: req.headers.authorization, key: req.headers['x-api-key'], version: req.headers['anthropic-version'], method: req.method});
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(req.method === 'GET' ? {data: [{id: 'fixture', context_window: 64000, effort: {supported_levels: ['low', 'high'], default_level: 'high'}}]} : {id: 'model-test', object: 'chat.completion', created: 1, model: 'fixture', choices: [{index: 0, message: {role: 'assistant', content: 'OK'}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}));
  });
  await new Promise(resolve => wire.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => {wire.closeAllConnections(); wire.close(resolve);}));
  const base = `http://127.0.0.1:${wire.address().port}`;
  for (const [protocol, path, expected] of [['gemini', '/v1beta', '/v1beta/openai'], ['ollama', '', '/v1']]) {
    const provider = await f.api('/api/settings/providers', 'POST', {name: protocol, baseURL: base + path, protocol, apiKey: protocol === 'gemini' ? 'synthetic-provider-key' : '', enabled: true, models: []});
    const result = await f.api(`/api/settings/providers/${provider.savedProviderId}/discover`, 'POST', {}); assert.deepEqual(result.models, ['fixture']);
    assert.deepEqual(result.reasoningCapabilities.fixture, {levels: ['low', 'high'], default: 'high', source: 'provider'}); assert.equal(result.contextLimits.fixture, 64000);
    assert.equal(requests.at(-1).url, expected + '/models');
    await f.api('/api/settings/model/test', 'POST', {url: base + path, name: 'fixture', protocol});
    assert.equal(requests.at(-1).url, expected + '/chat/completions');
  }
  const anthropic = await f.api('/api/settings/providers', 'POST', {name: 'Claude catalog', baseURL: base + '/anthropic/v1', protocol: 'claude', apiKey: 'synthetic-anthropic-key', enabled: true, models: []});
  await f.api(`/api/settings/providers/${anthropic.savedProviderId}/test`, 'POST', {});
  assert.equal(requests.at(-1).key, 'synthetic-anthropic-key'); assert.equal(requests.at(-1).authorization, undefined); assert.equal(requests.at(-1).version, '2023-06-01');
  const before = requests.length; await f.api('/api/settings/model/test', 'POST', {url: base, name: 'fixture', protocol: 'unknown'}, 400); assert.equal(requests.length, before);
});

test('declared reasoning options persist, reach the actual SDK request and cannot cross model identities or frozen Workers', async t => {
  const f = await fixture(t), catalog = await f.api('/api/settings/providers'), provider = catalog.providers[0], base = `/api/sessions/${f.session.id}/ai/reasoning`;
  provider.models[0].reasoningCapability = {levels: ['low', 'high', 'not-a-real-level'], default: 'high', source: 'provider'};
  await f.api(`/api/settings/providers/${provider.id}`, 'PUT', provider);
  let settings = await f.api(base); assert.deepEqual(settings.levels, ['low', 'high']); assert.equal(settings.effort, '');
  await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: 'Default request'}, 202); await f.wait(['completed']);
  assert.equal(f.requests.at(-1).reasoning_effort, undefined, 'default leaves the provider request unchanged');
  await f.api(base, 'POST', {modelId: settings.modelId, effort: 'max'}, 400);
  await f.api(base, 'POST', {modelId: 'stale-model', effort: 'high'}, 409);
  await f.api(base, 'POST', {modelId: settings.modelId, effort: 'high'}); await f.restart();
  assert.equal((await f.api(base)).effort, 'high');
  await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: 'Explicit high request'}, 202); await f.wait(['completed']);
  assert.equal(f.requests.at(-1).reasoning_effort, 'high');
  const frozen = f.app.store.createSession(f.project.id, '冻结任务'); frozen.workspaceRole = 'worker'; f.app.store.put('sessions', frozen.id, frozen);
  await f.api(`/api/sessions/${frozen.id}/ai/reasoning`, 'POST', {modelId: settings.modelId, effort: 'low'}, 409);
  const changed = {...provider, id: undefined}; const saved = await f.api('/api/settings/providers', 'POST', changed);
  await f.api('/api/settings/model/select', 'POST', {providerId: saved.savedProviderId, modelId: provider.models[0].id});
  settings = await f.api(base); assert.equal(settings.effort, '');
  await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: 'New identity default'}, 202); await f.wait(['completed']);
  assert.equal(f.requests.at(-1).reasoning_effort, undefined);
});

test('the existing exact DeepSeek reasoning registry reaches the wire and explicit empty metadata disables the fallback', async t => {
  const f = await fixture(t), provider = (await f.api('/api/settings/providers')).providers[0], base = `/api/sessions/${f.session.id}/ai/reasoning`;
  provider.models[0].name = 'deepseek-flash'; await f.api(`/api/settings/providers/${provider.id}`, 'PUT', provider);
  let settings = await f.api(base); assert.deepEqual(settings.levels, ['none', 'low', 'high', 'max']); assert.equal(settings.source, 'model');
  for (const effort of ['none', 'high']) {
    await f.api(base, 'POST', {modelId: settings.modelId, effort});
    await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: 'Reasoning compatibility check ' + effort}, 202); await f.wait(['completed']);
    assert.deepEqual(f.requests.at(-1).thinking, {type: effort === 'none' ? 'disabled' : 'enabled'});
    assert.equal(f.requests.at(-1).reasoning_effort, effort === 'none' ? undefined : effort);
  }
  provider.models[0].reasoningCapability = {levels: [], source: 'provider'}; await f.api(`/api/settings/providers/${provider.id}`, 'PUT', provider);
  assert.deepEqual((await f.api(base)).levels, []);
  delete provider.models[0].reasoningCapability; provider.models[0].name = 'deepseek-flash-unrelated'; await f.api(`/api/settings/providers/${provider.id}`, 'PUT', provider);
  assert.deepEqual((await f.api(base)).levels, [], 'similar names cannot inherit another model version capability');
});

test('extracting a preset makes a real bounded model request and saves a persistent result with its source', async t => {
  const f = await fixture(t);
  await f.api(`/api/sessions/${f.session.id}/ai/extractPreset`, 'POST', {}, 400);
  await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: '排查时先给结论，再列实际证据。'}, 202); await f.wait(['completed']);
  const calls = f.calls, preset = await f.api(`/api/sessions/${f.session.id}/ai/extractPreset`, 'POST', {});
  assert.equal(f.calls, calls + 1); assert.ok(preset.content); assert.ok(f.app.store.get('presetSources', preset.id).messageIds.length > 0);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /Extract a reusable instruction preset/);
  await f.restart(); assert.ok((await f.api('/api/ai/presets')).some(row => row.id === preset.id && row.content === preset.content));
});

test('a failed preset extraction cannot save an empty or fabricated success', async t => {
  const f = await fixture(t, 'model-error-http');
  await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: '有来源的预设测试'}, 202); await f.wait(['failed']);
  const failure = await f.api(`/api/sessions/${f.session.id}/ai/extractPreset`, 'POST', {}, 502);
  assert.ok(!JSON.stringify(failure).includes('synthetic-secret-no-real-credential'));
  assert.deepEqual(await f.api('/api/ai/presets'), []); assert.equal(f.app.store.list('presetSources').length, 0);
});

test('raw SDK stream error callbacks never print provider-echoed credentials to stderr while the user still receives the failure', async t => {
  const original = console.error, logged = [];
  console.error = (...args) => {logged.push(require('node:util').inspect(args));};
  try {
    for (const mode of ['model-error-http', 'model-error-sse']) {
      const f = await fixture(t, mode);
      await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: '验证错误日志脱敏'}, 202);
      const view = await f.wait(['failed']); await f.app.agents.wait(f.session.id);
      assert.ok(JSON.stringify(view).includes('SYNTHETIC_PROVIDER_REJECTION'));
      assert.ok(!JSON.stringify(view).includes('synthetic-secret-no-real-credential'));
    }
    assert.ok(logged.every(line => !line.includes('synthetic-secret-no-real-credential')), 'console logging is a credential boundary too');
  } finally {console.error = original;}
});

function fullAgentReply(request,mode,home){
 const tools=request.tools??[],router=tools.some(tool=>tool.function.name==='route_work');
 if(router&&mode.includes('worker'))return;
 const content=message=>typeof message.content==='string'?message.content:JSON.stringify(message.content??'');
 const current=request.messages.findLastIndex(message=>message.role==='user'&&content(message).startsWith('[LAKE ADMITTED HUMAN EVENTS'));
 const messages=router?request.messages.slice(Math.max(0,current)):request.messages;
 const calls=messages.flatMap(message=>message.tool_calls??[]),names=calls.map(call=>call.function.name);
 const stamp=router?JSON.parse(content(messages[0]).split('\n')[1])[0].id:'worker';
 const call=(name,input,id=name)=>({tool_calls:[{index:0,id:'full-'+stamp+'-'+id,type:'function',function:{name,arguments:JSON.stringify(input)}}]});
 const result=name=>{const id=calls.findLast(call=>call.function.name===name)?.id;const message=messages.findLast(message=>message.role==='tool'&&message.tool_call_id===id);try{return JSON.parse(content(message));}catch{return content(message??{});}};
 if(mode.includes('child')&&!tools.some(tool=>tool.function.name==='work_finish')){
  if(!names.includes('Bash'))return call('Bash',{command:"printf 'CHILD_NATIVE_SHELL'",description:'Read child execution marker'});
  return {content:'子智能体已实际执行 Shell 检查。'};
 }
 if(mode.includes('followup')&&router){
  const tasks=JSON.parse(content(messages[0]).split('[CURRENT TASK INDEX]\n')[1].split('\n')[0]);
  if(tasks.length&&!names.includes('route_work')){const event=JSON.parse(content(messages[0]).split('\n')[1])[0];return call('route_work',{event_id:event.id,part_key:'continue',action:'followup',task_id:tasks[0].taskId,quote:event.text,reason:'继续原检查'});}
 }
 if(mode.includes('files')){
  if(!names.some(name=>['ToolSearch','LocalToolSearch'].includes(name)))return call(tools.some(t=>t.function.name==='LocalToolSearch')?'LocalToolSearch':'ToolSearch',{query:'select:TodoRead,TodoWrite',max_results:10});
  const workspace=require('node:fs').readFileSync(join(home,'full-workspace.txt'),'utf8');
  if(!names.includes('TodoRead'))return call('TodoRead',{});
  if(!names.includes('TodoWrite'))return call('TodoWrite',{todos:[{content:'读取并编辑实际文件',status:'in_progress',priority:'high'}]});
  if(!names.includes('FindFiles'))return call('FindFiles',{path:workspace,pattern:'*.txt'});
  if(!names.includes('SearchText'))return call('SearchText',{path:workspace,pattern:'ACTUAL_FILE_CONTENT'});
  if(!names.includes('Read'))return call('Read',{file_path:join(workspace,'sample.txt')});
  if(!names.includes('Write'))return call('Write',{file_path:join(workspace,'written.txt'),content:'ACTUAL_WRITTEN_CONTENT'});
  if(!names.includes('Edit'))return call('Edit',{file_path:join(workspace,'sample.txt'),old_string:'ACTUAL_FILE_CONTENT',new_string:'ACTUAL_EDITED_CONTENT'});
 }
 if(mode.includes('skill')&&!names.includes('Skill'))return call('Skill',{skill:'fixture-skill'});
 if(mode.includes('image')&&!names.includes('Read'))return call('Read',{file_path:require('node:fs').readFileSync(join(home,'full-workspace.txt'),'utf8')+'/sample.png'});
 if(mode.includes('question')&&!names.includes('AskUserQuestion'))return call('AskUserQuestion',{questions:[{header:'目标范围',question:'选择测试范围',options:[{label:'A',description:'范围 A'},{label:'B',description:'范围 B'}],multiSelect:false}]});
 if(mode.includes('plan')){
  if(!names.includes('EnterPlanMode'))return call('EnterPlanMode',{});
  if(!names.includes('ExitPlanMode'))return call('ExitPlanMode',{plan:'读取本机测试标记，核对实际输出，然后报告结果。'});
 }
 if(mode.includes('child')&&!names.includes('Agent'))return call('Agent',{subagent_type:'general-purpose',description:'执行独立 Shell 检查',prompt:'请通过 Bash 执行 printf CHILD_NATIVE_SHELL 并报告实际结果。'});
 if(mode.includes('missing-discovery')){
  if(!names.includes('list_assets'))return call('list_assets',{query:'SSH fixture'});
  const asset=result('list_assets').assets.find(asset=>asset.kind==='ssh'),count=names.filter(name=>name==='Bash').length;
  if(!count)return call('Bash',{asset_ref:asset.asset_ref,configuration_revision:asset.configuration_revision,command:'hostname; command -v lake_fixture_absent_program',description:'Discover an optional program'},'missing-program');
  if(count===1&&!mode.includes('only'))return call('Bash',{asset_ref:asset.asset_ref,configuration_revision:asset.configuration_revision,command:'kubectl config current-context',description:'Inspect current fixture context'},'current-query');
  if(!names.includes('work_finish'))return call('work_finish',{summary:'已按真实回执检查程序和当前上下文。',outcome:mode.includes('only')?'partial':'completed'});
  return {content:'检查结束。'};
 }
 if(!['child','files','image'].some(kind=>mode.includes(kind))&&!names.includes('Bash')){
  let command=mode.includes('container')?(mode.includes('docker')?'docker exec fixture-db sh -c \'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -B -e "SELECT 42"\'':'kubectl -n fixture exec fixture-db -- sh -c \'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -B -e "SELECT 42"\''):mode.includes('lookup')?"command -v kubectl && kubectl config current-context && kubectl get pods -A -o wide":mode.includes('danger')?"rm -f ./agent-capability-absent.txt":mode.includes('read-stop')?"printf 'READ_STOP_STARTED'; sleep 5; printf 'READ_STOP_LATE'":mode.includes('stop')?"printf 'started' > interrupted.txt; sleep 30; printf 'LATE_NATIVE_OUTPUT'":mode.includes('protected')?`cat '${home}/secrets/hidden-fixture.txt'`:mode.includes('nonzero')?"printf 'ACTUAL_FAILED_COMMAND' >&2; false":mode.includes('background')?"printf 'BEGIN_BACKGROUND'; sleep 0.15; printf 'ACTUAL_BACKGROUND_SHELL'":"printf 'ACTUAL_NATIVE_SHELL'";
  if(mode.includes('ssh')){
   if(!names.includes('list_assets'))return call('list_assets',{query:'SSH fixture'});
   const asset=result('list_assets').assets.find(asset=>asset.kind==='ssh');
   return call('Bash',{asset_ref:asset.asset_ref,configuration_revision:asset.configuration_revision,command,description:'Inspect the remote environment',...(mode.includes('background')?mode.includes('auto')?{timeout:50}:{run_in_background:true}:{})});
  }
  return call('Bash',{command,description:'Inspect the actual environment',...(mode.includes('background')?mode.includes('auto')?{timeout:50}:{run_in_background:true}:{})});
 }
 if(mode.includes('background')&&!names.includes('TaskOutput'))return call('TaskOutput',{task_id:result('Bash').backgroundTaskId??String(result('Bash')).match(/ID: ([a-zA-Z0-9_-]+)/)?.[1],block:true,timeout:10000});
 if(!names.includes('work_finish'))return call('work_finish',{summary:mode.includes('protected')||mode.includes('nonzero')?'该命令未成功，已保留实际错误。':'已通过真实 Shell 执行获得测试结果。',outcome:mode.includes('protected')||mode.includes('nonzero')||(mode.includes('followup')&&!names.includes('route_work'))?'partial':'completed'});
 return {content:'已按实际执行结果完成。'};
}

function superReply(request, mode, home) {
  if(mode.startsWith("super-full-")){const response=fullAgentReply(request,mode,home);if(response)return response;}
  if (mode === "super-host-retry") return hostRetryReply(request);
  let names = request.messages.flatMap((message) => (message.tool_calls ?? []).map((call) => call.function.name));
  const exposes = (name) => request.tools?.some((tool) => tool.function?.name === name);
  const content = (message) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join("");
  const call = (name, input, id = name) => ({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] });
  const finish = (summary, id) => {
    const schema = request.tools.find((tool) => tool.function.name === "work_finish")?.function.parameters;
    return call("work_finish", { summary, ...(schema?.properties?.outcome ? { outcome: "completed" } : {}) }, id);
  };
  const router = request.tools?.some((tool) => tool.function?.name === "route_work");
  if (router) {
    if (mode === "super-chat") return { content: "我是 Lake Pilot，可以回答问题，并为实际工作安排专员。" };
    const raw = [...request.messages].reverse().filter((message) => message.role === "user").map(content).find((text) => text.startsWith("[LAKE ADMITTED HUMAN EVENTS"));
    if (!raw) return { content: "Missing actual admitted event" };
    const event = JSON.parse(raw.split("\n")[1])[0];
    const currentStart = request.messages.findLastIndex(message => message.role === "user" && content(message) === raw);
    names = request.messages.slice(currentStart).flatMap(message => (message.tool_calls ?? []).map(call => call.function.name));
    if (!names.includes("manage_specialist")) return call("manage_specialist", { event_id: event.id, part_key: "specialist", action: "create", role_key: "project-inspector", name: "项目检查员", duties: "检查当前项目工作区，按实际证据报告", quote: event.text });
    if (mode === "super-meta") return { content: "已创建长期专员，没有创建执行任务。" };
    if (!names.includes("list_specialists")) return call("list_specialists", {});
    const roleId = request.messages.slice(currentStart).filter((message) => message.role === "tool").map(content).join("\n").match(/"id"\s*:\s*"([a-f0-9]{64})"/)?.[1];
    if (!names.includes("route_work")) return call("route_work", { event_id: event.id, part_key: "inspect", action: "create", title: "检查项目工作区", role_id: roleId, quote: event.text, reason: "用户明确要求检查本项目" });
    return { content: "已交给项目检查员处理，执行结果将从原任务回报。" };
  }
  if (mode.startsWith("super-subagent")) return subagentReply(request, mode, home);
  if (exposes("work_begin") && !names.includes("work_begin")) return call("work_begin", { title: "检查项目工作区", items: [{ id: "inspect", title: "读取工作区并按实际结果验收" }] });
  const updates = request.messages.flatMap((message) => (message.tool_calls ?? []).filter((call) => call.function.name === "work_update").map((call) => JSON.parse(call.function.arguments)));
  if (exposes("work_update") && !updates.some((update) => update.status === "running")) return call("work_update", { item_id: "inspect", status: "running" }, "start-inspect");
  if(mode==='super-mysql-read'){
    if(!names.includes('list_assets'))return call('list_assets',{query:'fixture MySQL'});
    const tools=request.messages.filter(m=>m.role==='tool').map(content);
    const catalog=tools.map(value=>{try{return JSON.parse(value);}catch{return {};}}).find(value=>value.assets?.some(a=>a.driver==='mysql'));
    const asset=catalog?.assets.find(a=>a.driver==='mysql');
    if(!asset)return {content:'MySQL fixture asset not available'};
    const pins={asset_ref:asset.asset_ref,configuration_revision:asset.configuration_revision};
    if(!names.includes('list_db_objects'))return call('list_db_objects',{...pins,query_type:'database'});
    if(!names.includes('db_table_ddl'))return call('db_table_ddl',{...pins,db:'fixture_database',table:'sample'});
    if(!names.includes('read_db_table'))return call('read_db_table',{...pins,db:'fixture_database',table:'sample',mode:'count'});
    if(!names.includes('work_finish'))return finish('真实 MySQL 只读事务已读取表结构及行数 42。','finish-mysql');
    return {content:'本次已读取 MySQL 表结构，行数为 42；不声称跨库一致。'};
  }
  if (mode === "super-incomplete-report") return { content: "这次还没连上服务器，暂时查不到 CPU 和内存的实际使用情况。" };
  if(mode==='super-context-recall'){
    const assigned=request.messages.filter(m=>m.role==='user').map(content).filter(value=>value.startsWith('{')).map(value=>{try{return JSON.parse(value);}catch{return {};}}).findLast(value=>value.assignment);
    const followon=assigned.originalRequirement.includes('同步到k2');
    if(followon&&!JSON.stringify(assigned.taskContext).includes('192.0.2.75'))return call('ask_user_question',{questions:[{id:'missing',title:'K2 入口是什么？'}]});
    if(followon&&!names.includes('recall_task_context'))return call('recall_task_context',{query:'K2'},'context-recall');
    if(!names.includes('list_project_files'))return call('list_project_files',{path:'.'},'context-files');
    if(!names.includes('work_finish'))return call('work_finish',{outcome:'partial',summary:followon?'已从先前任务找回 K2 入口 192.0.2.75 和实例 db/mysql141-0。本夹具只读取本地证据，不执行数据库写入。':'已确认 K2 入口 192.0.2.75 和实例 db/mysql141-0。比较尚未完成；保留历史线索。'},'context-result');
    return {content:'上下文检查完成。'};
  }
  if (mode === "super-forged") {
    if (exposes("work_update") && !updates.some((update) => update.status === "completed")) return call("work_update", { item_id: "inspect", status: "completed", evidence_ids: ["invented-success"] }, "forged-acceptance");
    if (!names.includes("work_finish")) return finish("我已经完成并验收了任务。", "forged-finish");
    return { content: "我已经完成并验收了任务。" };
  }
  if (mode === "super-read-recovery") {
    const reads = names.filter((name) => name === "list_project_files").length;
    if (!reads) return call("list_project_files", { path: "missing-diagnostic-path" }, "failed-files");
    if (exposes("work_update") && updates.filter((update) => update.status === "running").length === 1) return call("work_update", { item_id: "inspect", status: "running" }, "retry-inspect");
    if (reads < 2) return call("list_project_files", { path: "." }, "actual-files");
  }
  if (mode === "super-host") {
    const result=(name)=>{const id=request.messages.flatMap(m=>m.tool_calls??[]).filter(c=>c.function.name===name).at(-1)?.id;const m=request.messages.findLast(m=>m.role==='tool'&&m.tool_call_id===id);return m?JSON.parse(content(m)):undefined;};
    if(!names.includes('list_assets'))return call('list_assets',{},'host-catalog');
    const asset=result('list_assets').assets.find(a=>a.kind==='ssh');
    if(!names.includes('inspect_host'))return call('inspect_host',{asset_ref:asset.id,configuration_revision:asset.configuration_revision,metric:'system'},'actual-host');
    if(exposes('work_update')&&!updates.some(u=>u.status==='completed'))return call('work_update',{item_id:'inspect',status:'completed',evidence_ids:['actual-host']},'accept-host');
    if(!names.includes('work_finish'))return finish('已从本次 SSH 固定只读检查取得实际主机指标。');
    return {content:'本次 SSH 读取已经完成。'};
  }
  if (mode.startsWith("super-mcp")) {
    const result = (name) => {
      const id = request.messages.flatMap((message) => message.tool_calls ?? []).filter((tool) => tool.function.name === name).at(-1)?.id;
      const message = request.messages.findLast((message) => message.role === "tool" && message.tool_call_id === id);
      return message ? JSON.parse(content(message)) : undefined;
    };
    if (!names.includes("list_mcp_servers")) return call("list_mcp_servers", {}, "mcp-servers");
    const server = result("list_mcp_servers")?.servers?.[0];
    if (!server) return { content: "当前项目没有可用 MCP 服务。" };
    const pins = { server_id: server.id, configuration_revision: server.configurationRevision, binding_revision: server.bindingRevision };
    if (!names.includes("list_mcp_tools")) return call("list_mcp_tools", pins, "actual-catalog");
    if (!names.includes("call_mcp_tool")) return call("call_mcp_tool", { ...pins, tool: "count_documents", catalog_revision: result("list_mcp_tools").catalogHash, arguments: {} }, "actual-mcp");
    if (exposes("work_update") && !updates.some((update) => update.status === "completed")) return call("work_update", { item_id: "inspect", status: "completed", evidence_ids: ["actual-mcp"] }, "accept-inspect");
    if (!names.includes("work_finish")) return finish("已通过当前项目 MCP 的实际回执取得 42 个测试文档。");
    return { content: "MCP 查询已按真实回执完成。" };
  }
  if(mode==='super-live-report'){
    const reads=names.filter(name=>name==='list_project_files').length;
    if(!reads)return {...call('list_project_files',{path:'.'},'live-read-first'),content:'正在核对当前工作区的文件清单。'};
    if(reads<2)return {...call('list_project_files',{path:'.'},'live-read-second'),content:'已取得文件清单，正在复核检查范围。'};
    if(!names.includes('work_finish'))return finish('已读取并复核本项目文件清单。两次读取均成功；本次检查完成。','live-final');
    return {content:'本次检查结束。'};
  }
  if (!names.includes("list_project_files")) return call("list_project_files", { path: "." }, "actual-files");
  if (mode.includes("write") && !names.includes("Write")) {
    const raw = [...request.messages].reverse().filter((message) => message.role === "user").map(content).find((value) => value.startsWith("{") && value.includes('"assignment"'));
    const assigned = JSON.parse(raw);
    return call("Write", { file_path: join(home, "workspaces", assigned.assignment.projectId, "approved.txt"), content: "approved task output" }, "actual-write");
  }
  if (exposes("work_update") && !updates.some((update) => update.status === "completed")) return call("work_update", { item_id: "inspect", status: "completed", evidence_ids: mode.includes("write") ? ["actual-files", "actual-write"] : ["actual-files"] }, "accept-inspect");
  if (!names.includes("work_finish")) return finish("已读取本项目工作区，并根据本次实际文件清单完成检查。");
  return { content: "本次真实检查已结束。" };
}

// This fixture supplies model protocol only. The parent never touches a
// business resource, so acceptance must come from a real child tool receipt.
function subagentReply(request, mode, home) {
  const content = (message) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join("");
  const calls = request.messages.flatMap((message) => message.tool_calls ?? []);
  const exposes = (name) => request.tools?.some((tool) => tool.function?.name === name);
  const call = (name, input, id) => ({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] });
  if (exposes("work_finish")) {
    const raw = request.messages.filter((message) => message.role === "user").map(content).findLast((value) => value.startsWith("{") && value.includes('"assignment"'));
    assert.ok(raw, "parent Worker must have its host-provided assignment");
    const assigned = JSON.parse(raw);
    const delegated = calls.filter((tool) => tool.function.name === "Agent");
    const wanted = mode === "super-subagent-cap" ? 8 : mode.endsWith("-two") ? 2 : 1;
    if (delegated.length < wanted) {
      const sibling = delegated.length;
      const path = mode === "super-subagent-outside" ? join(home, "outside-task.txt") :
        join(home, "workspaces", assigned.assignment.projectId,
          mode.includes("write") ? "child-output.txt" : sibling ? "child-evidence-b.txt" : "child-evidence-a.txt");
      return call("Agent", {
        description: sibling ? "核对另一份证据" : "读取独立任务证据",
        prompt: `LAKE_SUBAGENT_FIXTURE:${JSON.stringify({ mode, path, sibling })}\nUse only the assigned resource tool and report its actual result.`,
        subagent_type: "general-purpose",
        run_in_background: mode.startsWith("super-subagent-background"),
      }, `delegate-${sibling}`);
    }
    if (mode === "super-subagent-background-early")
      return { content: "父 Worker 提前结束回复，后台子任务仍未交付实际结果。" };
    if (mode.startsWith("super-subagent-background")) {
      const finished = calls.filter((tool) => tool.function.name === "work_finish");
      if (!finished.length)
        return call("work_finish", { summary: "子任务仍在运行，尝试过早结清。", outcome: "completed" }, "premature-child-finish");
      const joined = calls.filter((tool) => tool.function.name === "TaskOutput");
      if (joined.length < wanted) {
        const results = request.messages.filter((message) => message.role === "tool").map(content).filter((value) => value.includes("agentId:"));
        const childId = results[joined.length]?.match(/agentId:\s*([\w-]+)/)?.[1];
        assert.ok(childId, "native Agent background result must supply its actual task identity");
        return call("TaskOutput", { task_id: childId, block: true, timeout: 10000 }, `join-background-child-${joined.length}`);
      }
      if (finished.length < 2)
        return call("work_finish", { summary: "已汇合原生后台子智能体，并取得实际工作区证据。", outcome: "completed" }, "finish-joined-child-work");
      return { content: "原生后台子智能体已汇合，任务依据实际回执结束。" };
    }
    if (!calls.some((tool) => tool.function.name === "work_finish")) {
      const schema = request.tools.find((tool) => tool.function.name === "work_finish").function.parameters;
      return call("work_finish", { summary: "已由当前任务的子智能体读取或写入实际工作区证据。", ...(schema?.properties?.outcome ? { outcome: "completed" } : {}) }, "finish-child-work");
    }
    return { content: "子智能体已回报；未取得实际证据的任务仍应保持未完成。" };
  }
  const raw = request.messages.filter((message) => message.role === "user").map(content).findLast((value) => value.includes("LAKE_SUBAGENT_FIXTURE:"));
  assert.ok(raw, "native child must receive its explicit task prompt");
  const input = JSON.parse(raw.match(/LAKE_SUBAGENT_FIXTURE:(\{[^\n]+\})/)[1]);
  if (["super-subagent-prose", "super-subagent-cap"].includes(mode))
    return { content: "我宣称完成了检查，但没有调用任何实际资源工具。" };
  const tool = mode.includes("write") ? "Write" : "Read";
  if (!calls.some((entry) => entry.function.name === tool))
    return call(tool, { file_path: input.path, ...(tool === "Write" ? { content: "actual child write receipt" } : {}) }, tool === "Read" ? "shared-child-read" : "child-write");
  const actual = request.messages.filter((message) => message.role === "tool").map(content).at(-1);
  return { content: `子智能体实际工具回执：${actual}` };
}

// A protocol fixture, not a language-model evaluation: choose only from the
// latest host-provided context, then let real adapters and receipts decide work.
function hostRetryReply(request) {
  const content = (message) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join("");
  const router = request.tools.some((tool) => tool.function.name === "route_work");
  const boundary = request.messages.findLastIndex((message) => message.role === "user" && (router
    ? content(message).startsWith("[LAKE ADMITTED HUMAN EVENTS")
    : content(message).startsWith("{") && content(message).includes('"assignment"')));
  assert.ok(boundary >= 0, "every turn needs its current host input");
  const messages = request.messages.slice(boundary);
  const calls = messages.flatMap((message) => message.tool_calls ?? []);
  const names = calls.map((tool) => tool.function.name);
  const raw = content(messages[0]);
  const result = (name) => {
    const id = calls.findLast((tool) => tool.function.name === name)?.id;
    const message = messages.findLast((item) => item.role === "tool" && item.tool_call_id === id);
    return message ? JSON.parse(content(message)) : undefined;
  };
  const call = (name, input, id = name) => ({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] });
  if (router) {
    const event = JSON.parse(raw.split("\n")[1])[0];
    const workingSet = JSON.parse(raw.split("[CURRENT CONVERSATION WORKING SET]\n")[1]);
    if (workingSet.focus.length) {
      const focus = workingSet.focus[0];
      if (!names.includes("route_work")) return call("route_work", {
        event_id: event.id, part_key: "retry", action: "followup", task_id: focus.task.id,
        quote: event.text, reason: "继续最近对话中的同一主机检查，重新读取当前连接情况。",
      }, `retry-${event.id}`);
      return { content: "我再检查一下这台服务器。" };
    }
    if (!names.includes("manage_specialist")) return call("manage_specialist", {
      event_id: event.id, part_key: "specialist", action: "create", role_key: "host-inspector",
      name: "服务器检查员", duties: "根据实时主机指标分析服务器状况", quote: event.text,
    });
    if (!names.includes("list_specialists")) return call("list_specialists", {});
    const roleId = JSON.stringify(result("list_specialists")).match(/"id"\s*:\s*"([a-f0-9]{64})"/)?.[1];
    if (!names.includes("route_work")) return call("route_work", {
      event_id: event.id, part_key: "inspect", action: "create", title: "检查 SSH fixture 当前系统指标",
      role_id: roleId, quote: event.text, reason: "用户要求读取这台服务器当前指标。",
    });
    return { content: "我先检查这台服务器。" };
  }
  const assignment = JSON.parse(raw), suffix = assignment.followups.at(-1)?.id ?? "original";
  assert.ok(!request.tools.some((tool) => ["work_begin", "work_update"].includes(tool.function.name)), "ordinary work must not require model-written ledger transitions");
  if (!names.includes("list_assets")) return call("list_assets", {}, `catalog-${suffix}`);
  const asset = result("list_assets").assets.find((item) => item.kind === "ssh");
  if (asset.status !== "available" || !asset.configuration_revision) {
    if (!names.includes("work_finish")) return call("work_finish", { outcome: "partial", summary: "这台服务器的 SSH 连接还不可用，暂时没有查到实时指标。" }, `partial-${suffix}`);
    return { content: "暂时没有查到实时指标。" };
  }
  if (!names.includes("inspect_host")) return call("inspect_host", {
    asset_ref: asset.id, configuration_revision: asset.configuration_revision, metric: "system",
  }, `inspect-${suffix}`);
  if (!names.includes("work_finish")) return call("work_finish", {
    outcome: "completed", summary: "已重新连上服务器，并取得本次系统指标。",
  }, `finish-${suffix}`);
  return { content: "本次检查完成。" };
}

async function until(read, predicate, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for actual host state: " + JSON.stringify(value));
}

async function startSubagentTask(t, mode, memory = false) {
  const f = await fixture(t, mode);
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`, "POST", { maxSteps: 24 });
  if (memory) {
    const scope = f.app.memory.scope("project", f.project.id);
    f.app.memory.setSettings(scope, {useEnabled:true,extractionEnabled:true,expectedRevision:0});
  }
  const workspace = await f.app.store.workspace(f.project.id);
  await writeFile(join(workspace, "child-evidence-a.txt"), "ACTUAL_CHILD_EVIDENCE_A");
  await writeFile(join(workspace, "child-evidence-b.txt"), "ACTUAL_CHILD_EVIDENCE_B");
  await writeFile(join(f.home, "outside-task.txt"), "OUTSIDE_TASK_SENTINEL");
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", {
    text: "请安排项目检查员，按需要创建临时子智能体，核对本项目的实际工作区证据。",
  }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (value) => value.workers.length === 1);
  return { f, project, worker: state.workers[0], workspace };
}

async function settledSubagentTask(f) {
  return until(() => f.api(`/api/projects/${f.project.id}/superagent`), (value) =>
    value.workers.length === 1 && value.workers[0].assignmentState === "parked");
}

function assertNativeRun(run, worker, goal) {
  assert.equal(run.source, "native_subagent");
  assert.equal(run.taskId, goal.id);
  assert.equal(run.workerId, worker.id);
  assert.equal(run.sessionId, worker.sessionId);
  assert.ok(run.childSessionId && run.childSessionId !== worker.sessionId, "child execution needs its own SDK session");
  assert.ok(Array.isArray(run.cards), "child tool details must be retained on its actual run");
}

function childRequests(f) {
  return f.requests.filter((request) => !request.tools?.some((tool) => ["route_work", "work_finish"].includes(tool.function?.name)));
}

function executionRecordBytes(f) {
  return JSON.stringify(f.app.store.db.prepare(
    "SELECT kind,id,value FROM records WHERE kind IN ('views','superOperations','superGoals','superAcceptance') ORDER BY kind,id",
  ).all());
}

async function readExecutionProjections(f, sessionId) {
  const count = f.app.store.view(sessionId).cards.length;
  return [
    (await f.api(`/api/sessions/${sessionId}/snapshot`)).ai,
    await f.api(`/api/sessions/${sessionId}/ai`),
    await f.api(`/api/sessions/${sessionId}/ai?before=${count}`),
    await f.api(`/api/sessions/${sessionId}/ai/snapshot?before=${count}`),
  ];
}

test("pure TS host authenticates, runs native, streams and restores history", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.app.origin + "/api/catalog")).status, 401);
  assert.equal(
    (
      await fetch(f.app.origin + "/api/catalog", {
        headers: { Authorization: `Bearer ${f.app.token}`, Origin: "https://untrusted.invalid" },
      })
    ).status,
    403,
  );
  assert.equal((await f.api("/api/bootstrap")).backendRuntime, "typescript");
  assert.equal((await f.api("/api/bootstrap")).aiRuntime, "typescript");
  assert.equal((await f.api("/api/bootstrap")).memoryEngine, "layered");
  const original = f.app.store.session(f.session.id);
  original.options.agentRuntime = "previous_runtime";
  f.app.store.put("sessions", original.id, original);
  assert.equal((await f.api(`/api/sessions/${f.session.id}/ai/options`)).agentRuntime, "typescript");
  assert.equal(f.app.store.session(f.session.id).options.agentRuntime, "previous_runtime", "presentation must not rewrite stored options or permission inputs");
  await assert.rejects(startLakeServer(f.options), /已有后端/);
  await assert.rejects(
    startLakeServer({ ...f.options, data: join(f.home, "another-data") }),
    /已有后端/,
  );
  await f.api(
    `/api/sessions/${f.session.id}/messages`,
    "POST",
    { text: "Remember exact token LakeHistoryOne" },
    202,
  );
  const view = await f.wait(["completed", "failed"]);
  assert.equal(view.status, "completed", JSON.stringify(view));
  assert.ok(
    view.cards.some((card) => card.type === "message" && card.content.includes("Lake TS 完成")),
  );
  const snapshot = await f.api(`/api/sessions/${f.session.id}/snapshot`);
  assert.equal(snapshot.messages.length, 2);
  assert.ok(
    f.app.store
      .events(f.session.id, 0)
      .some((event) => event.textUpdate?.content.includes("Lake TS 完成")),
    "upstream stream must reach Lake events before the final snapshot",
  );
  const raw = await readFile(join(f.home, "data/lake-typescript.sqlite"));
  assert.ok(!raw.includes(Buffer.from("synthetic-secret-no-real-credential")));
  let legacyBytes;
  await f.restart(async () => {
    const {rename} = require("node:fs/promises");
    await rename(join(f.options.data, sessionArchiveName), join(f.options.data, legacySessionArchiveName));
    legacyBytes = await readFile(join(f.options.data, legacySessionArchiveName));
  });
  assert.deepEqual(await readFile(join(f.options.data, legacySessionArchiveName)), legacyBytes, "archive migration retains the original bytes");
  assert.ok((await readFile(join(f.options.data, sessionArchiveName))).length > 0);
  await f.api(
    `/api/sessions/${f.session.id}/messages`,
    "POST",
    { text: "Use the earlier token" },
    202,
  );
  const second = await f.wait(["completed", "failed"]);
  assert.equal(second.status, "completed", JSON.stringify(second));
  assert.ok(
    JSON.stringify(f.requests.at(-1)).includes("LakeHistoryOne"),
    "canonical Agent SDK history must survive restart",
  );
});

test("Agent SDK Write remains blocked until Lake approval and rejection has no side effect", async (t) => {
  const f = await fixture(t, "write");
  await f.api(
    `/api/sessions/${f.session.id}/messages`,
    "POST",
    { text: "Write the fixture file" },
    202,
  );
  let view = await f.wait(["waiting_approval", "failed", "completed"]);
  assert.equal(view.status, "waiting_approval", JSON.stringify(view));
  await assert.rejects(access(f.target));
  await f.api(`/api/sessions/${f.session.id}/ai/decision`, "POST", {
    id: view.pending.id,
    accept: false,
  });
  view = await f.wait(["completed", "failed"]);
  assert.equal(view.status, "completed", JSON.stringify(view));
  await assert.rejects(access(f.target));
  await f.api(
    `/api/sessions/${f.session.id}/messages`,
    "POST",
    { text: "Now write it after explicit approval" },
    202,
  );
  view = await f.wait(["waiting_approval", "failed", "completed"]);
  // The model fixture treats previous tool messages as completion; use a new session
  // for the independent positive write so a prior rejection cannot become a grant.
  const fresh = await f.api(`/api/projects/${f.project.id}/sessions`, "POST", {});
  await f.api(`/api/sessions/${fresh.id}/messages`, "POST", { text: "Write with approval" }, 202);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    view = await f.api(`/api/sessions/${fresh.id}/ai`);
    if (view.status === "waiting_approval" || view.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(view.status, "waiting_approval", JSON.stringify(view));
  await f.api(`/api/sessions/${fresh.id}/ai/decision`, "POST", {
    id: view.pending.id,
    accept: true,
  });
  while (Date.now() < deadline) {
    view = await f.api(`/api/sessions/${fresh.id}/ai`);
    if (["completed", "failed"].includes(view.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(view.status, "completed", JSON.stringify(view));
  assert.equal(await readFile(f.target, "utf8"), "approved");
});

test("cancelling a pending write cannot dispatch it or trigger another model request", async (t) => {
  const f = await fixture(t, "write");
  await f.api(`/api/sessions/${f.session.id}/messages`, "POST", { text: "Write the file" }, 202);
  const pending = await f.wait(["waiting_approval", "failed", "completed"]);
  assert.equal(pending.status, "waiting_approval", JSON.stringify(pending));
  const calls = f.calls;
  await f.api(`/api/sessions/${f.session.id}/ai/abort`, "POST", {});
  assert.equal((await f.wait(["cancelled"])).status, "cancelled");
  await f.api(
    `/api/sessions/${f.session.id}/ai/decision`,
    "POST",
    { id: pending.pending.id, accept: true },
    409,
  );
  assert.equal(f.calls, calls);
  await assert.rejects(access(f.target));
});

test("credentials split across provider chunks are removed before events and canonical persistence", async (t) => {
  const f = await fixture(t, "secret");
  await f.api(
    `/api/sessions/${f.session.id}/messages`,
    "POST",
    { text: "Render the response" },
    202,
  );
  const view = await f.wait(["completed", "failed"]);
  assert.equal(view.status, "completed", JSON.stringify(view));
  const secret = "synthetic-secret-no-real-credential";
  const canonical = await f.app.agents.sessions.messages({ sessionID: f.session.id });
  assert.ok(JSON.stringify(canonical).includes("[REDACTED]"), "the canonical upstream transcript must contain the safe replacement");
  const artifacts = [
    view,
    f.app.store.events(f.session.id, 0),
    canonical,
  ];
  assert.ok(!JSON.stringify(artifacts).includes(secret));
  assert.ok(JSON.stringify(artifacts).includes("[REDACTED]"));
});

for(const mode of ['model-error-http','model-error-stream'])test(`Pilot retains redacted provider failure and accepts an explicit retry (${mode})`,async(t)=>{
  const f=await fixture(t,mode);
  const project=await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{});
  const session=project.routerSessionId;
  await f.api(`/api/sessions/${session}/messages`,'POST',{text:'仅回复测试文本，不调用工具。'},202);
  const failed=await until(()=>f.api(`/api/sessions/${session}/ai`),view=>view.status==='failed');
  const card=failed.cards.filter(card=>card.type==='error').at(-1);
  assert.match(card.content,/SYNTHETIC_PROVIDER_REJECTION/,JSON.stringify(card));
  assert.ok(!card.content.includes('Turn execution failed'));
  assert.equal(card.data.failure.source,'provider');
  if(mode==='model-error-http')assert.equal(card.data.failure.statusCode,401);
  const input=f.app.store.list('superInputs').find(item=>item.sessionId===session);
  assert.equal(input.disposition,'blocked');assert.equal(input.error,card.content);
  assert.equal(f.app.store.list('superOperations').length,0);
  const canonical=await f.app.agents.sessions.messages({sessionID:session});
  assert.ok(!JSON.stringify([failed,canonical,f.app.store.events(session,0)]).includes('synthetic-secret-no-real-credential'));
  assert.ok(JSON.stringify([failed,canonical]).includes('[REDACTED]'));
  const calls=f.calls;await f.restart();assert.equal(f.calls,calls,'restart cannot retry a failed model or business operation');
  f.recoverModel();
  await f.api(`/api/sessions/${session}/messages`,'POST',{text:'重新测试，仅回复文本。'},202);
  await until(()=>f.api(`/api/sessions/${session}/ai`),view=>view.status==='completed');
  assert.equal(f.app.store.list('superInputs').find(item=>item.id===input.id).disposition,'blocked','a fresh request does not replay the blocked input');
});

test("session tags and icons preserve project scope, revisions, activity and restart state", async (t) => {
  const f = await fixture(t);
  const other = await f.api("/api/projects", "POST", { name: "Other" });
  const create = (project, name) => f.api(`/api/projects/${project}/tags`, "POST", { name, color: "purple" }, 201);
  const tag = await create(f.project.id, "Database");
  const foreign = await create(other.id, "External");
  const path = `/api/sessions/${f.session.id}/presentation`;
  const save = (data, status = 200) => f.api(path, "PUT", data, status);
  const before = (await f.api(`/api/sessions/${f.session.id}/snapshot`)).session;
  await save({ icon: "database", tagIds: [foreign.id], revision: 0 }, 404);
  await save({ icon: "javascript:alert(1)", tagIds: [], revision: 0 }, 400);
  await save({ icon: "database", tagIds: [tag.id, tag.id], revision: 0 }, 400);
  await save({ icon: "database", tagIds: [], revision: "0" }, 400);
  await save({ icon: "database", tagIds: [], revision: -1 }, 400);
  assert.equal(f.app.store.cursor(f.session.id), 0, "rejected edits must not emit events");
  let saved = await save({ icon: "database", tagIds: [tag.id], revision: 0 });
  assert.deepEqual(saved.tags, [tag]);
  assert.equal(saved.icon, "database");
  assert.equal(saved.presentationRevision, 1);
  assert.equal(saved.updatedAt, before.updatedAt);
  assert.equal(saved.status, before.status);
  await save({ icon: "chat", tagIds: [], revision: 0 }, 409);
  await f.restart();
  saved = (await f.api(`/api/sessions/${f.session.id}/snapshot`)).session;
  assert.deepEqual(saved.tags, [tag]);
  assert.equal(saved.presentationRevision, 1);
  const edited = await f.api(`/api/tags/${tag.id}`, "PUT", { name: "Data", color: "blue" });
  assert.deepEqual((await f.api(`/api/sessions/${f.session.id}/snapshot`)).session.tags, [edited]);
  // A model update holding an older session snapshot cannot overwrite metadata.
  f.app.store.put("sessions", before.id, { ...before, options: f.app.store.session(before.id).options });
  assert.equal(f.app.store.session(before.id).icon, "database");
  await f.api(`/api/tags/${tag.id}`, "DELETE");
  saved = (await f.api(`/api/sessions/${f.session.id}/snapshot`)).session;
  assert.deepEqual(saved.tags, []);
  assert.equal(saved.presentationRevision, 1);
  await save({ icon: "chat", tagIds: [tag.id], revision: 1 }, 404);
  await f.api(`/api/projects/${other.id}/tags`, "POST", { name: "External", color: "red" }, 409);
  await f.api(`/api/projects/${other.id}/tags`, "POST", { name: "Invalid", color: "url(evil)" }, 400);
  await f.api(`/api/projects/${other.id}/tags`, "POST", { name: " ".repeat(41) + "x", color: "blue" }, 400);
  assert.equal((await f.api("/api/catalog")).tags.length, 1);
  assert.equal(f.app.store.events(f.session.id, 0).length, 3);
});

test("session pinning and ordering preserve activity, enforce group scope and reject stale concurrent moves", async (t) => {
  const f = await fixture(t);
  const second = await f.api(`/api/projects/${f.project.id}/sessions`, "POST", {});
  const other = await f.api("/api/projects", "POST", { name: "Other" });
  const foreign = await f.api(`/api/projects/${other.id}/sessions`, "POST", {});
  const hidden = await f.api(`/api/projects/${f.project.id}/sessions`, "POST", {});
  f.app.store.put("aiScopes", hidden.id, { scope: "resource-terminal" });
  const move = (sessionId, pinned, beforeId, revision, status = 200) =>
    f.api(`/api/projects/${f.project.id}/session-navigation`, "POST", { sessionId, pinned, beforeId, revision }, status);
  await move(foreign.id, true, null, 0, 404);
  await move(hidden.id, true, null, 0, 404);
  await move(f.session.id, false, foreign.id, 0, 404);
  await move(f.session.id, false, f.session.id, 0, 400);
  await move(f.session.id, "true", null, 0, 400);
  await move(f.session.id, true, null, undefined, 400);
  const before = f.app.store.session(f.session.id);
  let saved = await move(f.session.id, false, second.id, 0);
  assert.equal(saved.navigationPosition, 0);
  assert.equal(f.app.store.session(second.id).navigationPosition, 1);
  assert.equal(saved.updatedAt, before.updatedAt);
  assert.equal(saved.status, before.status);
  await move(second.id, true, null, 0, 409);
  assert.equal(f.app.store.session(second.id).pinned, false);
  saved = await move(f.session.id, true, null, 1);
  assert.equal(saved.navigationRevision, 2);
  await move(second.id, false, f.session.id, 2, 404);
  saved = await move(second.id, true, f.session.id, 2);
  assert.equal(saved.navigationPosition, 0);
  assert.equal(f.app.store.session(f.session.id).navigationPosition, 1);
  await f.restart();
  assert.equal(f.app.store.session(second.id).pinned, true);
  const competing = await Promise.all([f.session.id, second.id].map(async (sessionId) => {
    const response = await fetch(`${f.app.origin}/api/projects/${f.project.id}/session-navigation`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.app.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, pinned: false, beforeId: null, revision: 3 }),
    });
    return { status: response.status, value: await response.json() };
  }));
  assert.deepEqual(competing.map((result) => result.status).sort(), [200, 409]);
  assert.equal(competing.find((result) => result.status === 200).value.navigationRevision, 4);
  const catalog = await f.api("/api/catalog");
  assert.ok(catalog.sessions.filter((s) => s.projectId === f.project.id).every((s) => s.navigationRevision === 4));
  const secondBefore = f.app.store.session(second.id);
  await f.api(`/api/sessions/${f.session.id}`, "DELETE");
  await move(second.id, false, f.session.id, 4, 404);
  assert.equal(f.app.store.session(second.id).navigationRevision, 4);
  assert.equal(f.app.store.session(second.id).pinned, secondBefore.pinned);
});

test("invalid JSON bodies cannot enter persistent navigation mutations", async (t) => {
  const f = await fixture(t);
  for (const body of ["null", "[]", "true", "", "{oops"]) {
    const response = await fetch(`${f.app.origin}/api/projects/${f.project.id}/tags`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.app.token}`, "Content-Type": "application/json" },
      body,
    });
    assert.equal(response.status, 400);
  }
  const response = await fetch(`${f.app.origin}/api/projects/${f.project.id}/tags`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.app.token}`, "Content-Type": "text/plain" },
    body: JSON.stringify({ name: "Wrong content type", color: "blue" }),
  });
  assert.equal(response.status, 415);
  assert.deepEqual((await f.api("/api/catalog")).tags, []);
});

test("explicit TS Dev imports model configuration once without copying credentials or touching the Go database", async (t) => {
  const f = await fixture(t, "text", true);
  const catalogFile = join(f.options.data, "providers.json");
  const oldCatalog = await readFile(catalogFile);
  const legacyKey = join(f.home, "secrets/provider-fixture.key");
  const bootstrap = await f.api("/api/bootstrap");
  assert.equal(bootstrap.backendRuntime, "typescript");
  assert.equal(bootstrap.modelConfigured, true);
  const catalog = await f.api("/api/settings/providers");
  assert.equal(catalog.activeProviderId, "legacy.fixture");
  assert.equal(catalog.providers[0].keyConfigured, true);
  assert.ok(!JSON.stringify(catalog).includes("credentialRef"));
  assert.ok(!JSON.stringify(catalog).includes("synthetic-secret"));
  await assert.rejects(access(join(f.home, "secrets/model-legacy.fixture.json")));
  await f.api(`/api/sessions/${f.session.id}/messages`, "POST", { text: "Use the existing Dev provider" }, 202);
  assert.equal((await f.wait(["completed", "failed"])).status, "completed");
  assert.equal(f.calls, 1);
  assert.deepEqual(await readFile(catalogFile), oldCatalog);
  assert.equal(await readFile(join(f.options.data, "lake-web.sqlite"), "utf8"), "legacy database sentinel");
  await f.api("/api/settings/providers/legacy.fixture", "DELETE");
  await f.restart();
  assert.deepEqual((await f.api("/api/settings/providers")).providers, [], "a deleted TS provider must not be reimported");
  assert.deepEqual(await readFile(catalogFile), oldCatalog);
  assert.equal(await readFile(legacyKey, "utf8"), "synthetic-secret-no-real-credential");
});

test("Dev opt-in never permits the production Home, and daily Dev still requires explicit opt-in", async (t) => {
  const f = await fixture(t);
  const userHome = require("node:os").homedir();
  await assert.rejects(startLakeServer({ ...f.options, home: join(userHome, ".lake"), development: true }), /独立 Home/);
  await assert.rejects(startLakeServer({ ...f.options, home: join(userHome, ".lake-dev"), development: false }), /独立 Home/);
});

test('Dev provider import preserves declared modality and reasoning metadata without probing or importing arbitrary fields', async t => {
  const f = await fixture(t, 'legacy-rich-model-flags', true), model = (await f.api('/api/settings/providers')).providers[0].models[0];
  for (const key of ['supportsVideoInput', 'supportsAudioInput', 'supportsPdfInput', 'supportsNativeWebSearch', 'imageInputDetected']) assert.equal(model[key], true);
  assert.equal(model.imageInputMode, 'on'); assert.deepEqual(model.reasoningCapability, {levels: ['low', 'high'], default: 'high', source: 'saved-settings'});
  assert.equal(model.ignoredPrivateField, undefined); assert.equal(f.calls, 0);
});

test("native Pilot creates a stable specialist and independent Worker, with evidence-backed completion and persistent channels", async (t) => {
  const f = await fixture(t, "super-inspect");
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  const again = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  assert.equal(project.routerSessionId, again.routerSessionId);
  const provider = (await f.api('/api/settings/providers')).providers[0]; provider.models[0].reasoningCapability = {levels: ['low', 'high'], source: 'provider'};
  await f.api(`/api/settings/providers/${provider.id}`, 'PUT', provider);
  const reasoningPath = `/api/sessions/${project.routerSessionId}/ai/reasoning`, reasoning = await f.api(reasoningPath);
  await f.api(reasoningPath, 'POST', {modelId: reasoning.modelId, effort: 'high'});
  const workspace = await f.app.store.workspace(f.project.id);
  await writeFile(join(workspace, "actual-evidence.txt"), "real fixture file");
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "请创建项目检查员，并检查这个项目工作区的实际文件。" }, 202);
  const result = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers.some((worker) => worker.task.state === "completed"));
  assert.equal(result.active, true);
  assert.equal(result.workers.length, 1);
  const worker = result.workers[0];
  assert.equal(worker.task.acceptanceState, "pass");
  assert.notEqual(worker.sessionId, project.routerSessionId);
  assert.equal(f.app.store.session(worker.sessionId).options.reasoningEffort, 'high');
  assert.equal(f.requests.find(isIndependentWorkerRequest).reasoning_effort, 'high', 'the frozen source choice reaches the independent Worker model');
  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].roleId, worker.roleId);
  const snapshot = await f.api(`/api/sessions/${worker.sessionId}/snapshot`);
  assert.equal(snapshot.session.workspaceRole, "worker");
  assert.equal(snapshot.superagent.task.taskId, worker.task.taskId);
  assert.equal(snapshot.superagent.goal.items[0].status, "completed");
  const operations = f.app.store.list("superOperations");
  assert.equal(operations.length, 1);
  assert.equal(operations[0].status, "succeeded");
  assert.ok(JSON.stringify(operations[0].output).includes("actual-evidence.txt"));
  assert.equal(f.app.store.list("superAcceptance").filter((receipt) => receipt.scope === "goal").length, 1);
  const routerRequest = f.requests.find((request) => request.tools?.some((tool) => tool.function.name === "route_work"));
  for(const name of ["Bash","Read","Write","Agent"])assert.ok(routerRequest.tools.some(tool=>tool.function.name===name), "Pilot shares general agent capabilities");
  const channel = await f.api(`/api/sessions/${result.channels[0].sessionId}/channel`);
  assert.ok(channel.entries.some((entry) => entry.message?.author?.workerId === worker.id));
  await f.restart();
  const restored = await f.api(`/api/projects/${f.project.id}/superagent`);
  assert.equal(restored.project.routerSessionId, project.routerSessionId);
  assert.equal(restored.channels[0].id, result.channels[0].id);
  assert.equal(restored.workers[0].task.state, "completed");
  const calls = f.calls;
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(f.calls, calls, "restart must not replay an accepted task");
});

test("native subagent reads real evidence under its original Worker task and preserves run details", async (t) => {
  const { f, project, worker } = await startSubagentTask(t, "super-subagent-read");
  const state = await settledSubagentTask(f);
  const goal = f.app.store.list("superGoals")[0];
  assert.equal(state.workers[0].task.state, "completed", JSON.stringify(state.workers[0]));
  assert.equal(goal.acceptanceState, "pass");
  assert.equal(state.workers.length, 1);
  assert.equal(state.channels.length, 1, "temporary child must not create a permanent specialist channel");
  const routerRequest = f.requests.find((request) => request.tools?.some((tool) => tool.function.name === "route_work"));
  assert.ok(routerRequest.tools.some((tool) => tool.function.name === "Agent"));
  const workerRequest = f.requests.find((request) => isIndependentWorkerRequest(request));
  assert.ok(workerRequest.tools.some((tool) => tool.function.name === "Agent"), "managed Worker should expose the native Agent tool");
  const children = childRequests(f);
  assert.equal(children.length, 2, "a real native child must request a tool and consume its actual result");
  for (const request of children) {
    assert.ok(request.tools.some((tool) => tool.function.name === "Read"));
    assert.ok(!request.tools.some((tool) => ["Agent", "route_work", "manage_specialist", "work_begin", "work_update", "work_finish"].includes(tool.function.name)), "child has business tools without routing or task completion authority");
  }
  const operations = f.app.store.list("superOperations");
  assert.equal(operations.length, 1, "parent delegation itself must not become a business observation");
  assert.equal(operations[0].tool, "Read");
  assert.equal(operations[0].goalId, goal.id);
  assert.equal(operations[0].projectId, f.project.id);
  assert.equal(operations[0].sessionId, worker.sessionId);
  assert.equal(operations[0].status, "succeeded");
  assert.ok(JSON.stringify(operations[0].output).includes("ACTUAL_CHILD_EVIDENCE_A"));
  assert.ok(operations[0].outputHash);
  const view = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  assert.equal(view.agentRuns.length, 1);
  const run = view.agentRuns[0];
  assertNativeRun(run, worker, goal);
  assert.equal(run.status, "completed");
  assert.ok(run.cards.some((card) => card.title === "Read" && card.status === "completed"));
  assert.ok(JSON.stringify(run.cards).includes("ACTUAL_CHILD_EVIDENCE_A"));
  assert.ok(operations[0].callId.startsWith(run.childSessionId + ":"));
  assert.equal(operations[0].agentRunId, run.id);
  assert.equal(operations[0].childSessionId, run.childSessionId);
  assert.equal(operations[0].originalCallId, "shared-child-read");
  const resource = f.app.store.catalog().resources.find((resource) => resource.projectId === f.project.id && resource.kind === "local");
  assert.ok(resource);
  assert.deepEqual(run.resourceIds, [resource.id]);
  const readCard = run.cards.find((card) => card.title === "Read");
  assert.equal(readCard.data.agentRunId, run.id);
  assert.equal(readCard.data.taskId, goal.id);
  assert.equal(readCard.data.resource_id, resource.id);
  assert.equal(readCard.data.operation_id, operations[0].id);
  const child = await f.app.agents.sessions.getSession(run.childSessionId);
  assert.equal(child.parentID, worker.sessionId);
  assert.equal(child.taskType, "subagent_child");
  const reports = f.app.store.messages(project.routerSessionId).filter((message) => message.author?.taskId === goal.id);
  assert.equal(reports.length, 1);
  const calls = f.calls;
  await f.restart();
  const restored = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  assert.deepEqual(restored.agentRuns, view.agentRuns);
  assert.equal((await f.app.agents.sessions.getSession(run.childSessionId)).parentID, worker.sessionId);
  assert.equal(f.calls, calls, "restoring child history must not restart an accepted task");
});

test("legacy parent tool cards recover exact resource ownership in read-only snapshots and paginated AI views", async (t) => {
  const f = await fixture(t, "super-inspect");
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查当前项目工作区。" }, 202);
  const state = await settledSubagentTask(f);
  const worker = state.workers[0], operation = f.app.store.list("superOperations")[0];
  assert.equal(operation.status, "succeeded");
  const old = f.app.store.view(worker.sessionId), card = old.cards.find((card) => card.data?.call_id === operation.callId);
  assert.ok(card);
  card.id = "legacy-parent-display-id";
  card.data = { call_id: operation.callId }; // Legacy cards retained only call identity.
  card.status = "completed";
  old.cards.push({ id: "unrelated-same-tool-name", type: "operation", title: card.title, content: "legacy unbound card", status: "completed" });
  f.app.store.put("views", worker.sessionId, old);
  // Matching call IDs in another task/session or project are not valid sources.
  f.app.store.put("superOperations", "foreign-session-decoy", { ...operation, id: "foreign-session-decoy", sessionId: f.session.id, goalId: "another-task", resourceId: "foreign-resource" });
  f.app.store.put("superOperations", "foreign-project-decoy", { ...operation, id: "foreign-project-decoy", projectId: "another-project", resourceId: "foreign-resource" });
  operation.status = "unknown";
  f.app.store.put("superOperations", operation.id, operation);
  const before = executionRecordBytes(f), calls = f.calls;
  for (const projected of await readExecutionProjections(f, worker.sessionId)) {
    const recovered = projected.cards.find((entry) => entry.id === card.id);
    assert.equal(recovered.data.resource_id, operation.resourceId);
    assert.equal(recovered.data.taskId, operation.goalId);
    assert.equal(recovered.data.operation_id, operation.id);
    assert.equal(recovered.data.attempt_id, operation.attemptId);
    assert.equal(recovered.data.operation_status, "unknown");
    assert.equal(recovered.status, "unknown", "legacy completed presentation cannot downgrade an unknown operation");
    const unrelated = projected.cards.find((entry) => entry.id === "unrelated-same-tool-name");
    assert.equal(unrelated.data?.resource_id, undefined, "tool title alone never supplies resource ownership");
  }
  assert.equal(executionRecordBytes(f), before, "reading history must preserve exact stored views, goals, operations and acceptance bytes");
  assert.equal(f.calls, calls);
  // Ambiguous imported identities remain unbound rather than picking one row.
  f.app.store.put("superOperations", "ambiguous-call-decoy", { ...operation, id: "ambiguous-call-decoy", resourceId: "other-resource" });
  const ambiguousBefore = executionRecordBytes(f);
  const ambiguous = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  assert.equal(ambiguous.cards.find((entry) => entry.id === card.id).data?.resource_id, undefined);
  assert.equal(executionRecordBytes(f), ambiguousBefore);
  assert.equal(f.calls, calls);
});

test("legacy native child cards recover namespaced evidence without changing stored records or mixing another task", async (t) => {
  const { f, worker } = await startSubagentTask(t, "super-subagent-read");
  await settledSubagentTask(f);
  const operation = f.app.store.list("superOperations")[0], old = f.app.store.view(worker.sessionId);
  const run = old.agentRuns[0], card = run.cards.find((entry) => entry.title === "Read");
  assert.ok(card);
  delete card.data; // Older child records can fall back to the actual card ID.
  card.status = "completed";
  run.resourceIds = [];
  const unrelated = structuredClone(run);
  unrelated.id = "unrelated-task-run";
  unrelated.taskId = "another-task";
  unrelated.resourceIds = [];
  old.agentRuns.push(unrelated);
  f.app.store.put("views", worker.sessionId, old);
  f.app.store.put("superOperations", "foreign-child-call-decoy", { ...operation, id: "foreign-child-call-decoy", sessionId: f.session.id, goalId: "another-task", resourceId: "foreign-resource" });
  operation.status = "unknown";
  f.app.store.put("superOperations", operation.id, operation);
  const before = executionRecordBytes(f), calls = f.calls;
  for (const projected of await readExecutionProjections(f, worker.sessionId)) {
    const recoveredRun = projected.agentRuns.find((entry) => entry.id === run.id);
    const recovered = recoveredRun.cards.find((entry) => entry.id === card.id);
    assert.equal(recovered.data.resource_id, operation.resourceId);
    assert.equal(recovered.data.taskId, operation.goalId);
    assert.equal(recovered.data.agentRunId, run.id);
    assert.equal(recovered.data.childSessionId, run.childSessionId);
    assert.equal(recovered.data.operation_id, operation.id);
    assert.equal(recovered.data.attempt_id, operation.attemptId);
    assert.equal(recovered.data.operation_status, "unknown");
    assert.equal(recovered.status, "unknown");
    assert.deepEqual(recoveredRun.resourceIds, [operation.resourceId]);
    const wrongTask = projected.agentRuns.find((entry) => entry.id === unrelated.id);
    assert.equal(wrongTask.cards[0].data?.resource_id, undefined);
    assert.equal(wrongTask.cards[0].data?.operation_id, undefined);
    assert.deepEqual(wrongTask.resourceIds, []);
  }
  assert.equal(executionRecordBytes(f), before, "response-only backfill must not rewrite stored child cards or the original ledger");
  assert.equal(f.calls, calls, "opening old execution details must not call a model");
});

test("native subagent prose and a successful Agent return cannot accept a task without child resource receipts", async (t) => {
  const { f, worker } = await startSubagentTask(t, "super-subagent-prose");
  const state = await settledSubagentTask(f);
  const goal = f.app.store.list("superGoals")[0];
  assert.notEqual(state.workers[0].task.state, "completed");
  assert.notEqual(goal.acceptanceState, "pass");
  assert.equal(f.app.store.list("superOperations").length, 0);
  assert.equal(f.app.store.list("superAcceptance").length, 0);
  assert.ok(childRequests(f).length > 0, "a child actually ran rather than rejecting delegation at the parent");
  const view = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  assert.equal(view.agentRuns.length, 1);
  assertNativeRun(view.agentRuns[0], worker, goal);
  assert.equal(view.agentRuns[0].status, "completed", "a completed child is distinct from accepted business work");
  assert.deepEqual(view.agentRuns[0].resourceIds, []);
});

test("native child Read cannot escape its parent task workspace or use rejected access as acceptance evidence", async (t) => {
  const { f, worker } = await startSubagentTask(t, "super-subagent-outside");
  const state = await settledSubagentTask(f);
  assert.notEqual(state.workers[0].task.state, "completed");
  assert.notEqual(f.app.store.list("superGoals")[0].acceptanceState, "pass");
  assert.equal(f.app.store.list("superOperations").length, 0, "scope rejection occurs before a business operation is dispatched");
  const view = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  assert.equal(view.agentRuns.length, 1);
  assert.ok(view.agentRuns[0].cards.some((card) => card.title === "Read" && card.status === "failed"));
  assert.ok(!JSON.stringify(view).includes("OUTSIDE_TASK_SENTINEL"));
  assert.ok(!JSON.stringify(f.requests).includes("OUTSIDE_TASK_SENTINEL"));
});

test("two native subagents using the same raw tool call ID keep distinct evidence and execution sessions", async (t) => {
  const { f, worker } = await startSubagentTask(t, "super-subagent-two");
  const state = await settledSubagentTask(f);
  assert.equal(state.workers[0].task.state, "completed", JSON.stringify(state.workers[0]));
  const goal = f.app.store.list("superGoals")[0];
  const view = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  assert.equal(view.agentRuns.length, 2);
  view.agentRuns.forEach((run) => assertNativeRun(run, worker, goal));
  assert.equal(new Set(view.agentRuns.map((run) => run.childSessionId)).size, 2);
  const operations = f.app.store.list("superOperations");
  assert.equal(operations.length, 2);
  assert.equal(new Set(operations.map((operation) => operation.id)).size, 2);
  assert.ok(operations.every((operation) => operation.callId.endsWith(":shared-child-read")));
  assert.ok(operations.every((operation) => operation.tool === "Read" && operation.status === "succeeded" && operation.goalId === goal.id));
  assert.ok(JSON.stringify(operations).includes("ACTUAL_CHILD_EVIDENCE_A"));
  assert.ok(JSON.stringify(operations).includes("ACTUAL_CHILD_EVIDENCE_B"));
  for (const run of view.agentRuns) assert.ok(operations.some((operation) => operation.callId.startsWith(run.childSessionId + ":")));
  assert.equal(f.app.store.list("superGoals").length, 1);
});

test("one canonical task cannot create an eighth native child or erase its existing child identities on restart", async (t) => {
  const { f, worker } = await startSubagentTask(t, "super-subagent-cap");
  const state = await settledSubagentTask(f);
  assert.notEqual(state.workers[0].task.state, "completed", "control results and child prose remain insufficient evidence");
  const view = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  assert.equal(view.agentRuns.length, 7);
  assert.equal(new Set(view.agentRuns.map((run) => run.childSessionId)).size, 7);
  const rejected = view.cards.find((card) => card.data?.call_id === "delegate-7");
  assert.ok(rejected && rejected.status === "failed", "the eighth Agent invocation must be rejected at the host boundary");
  assert.equal(childRequests(f).length, 7, "only seven real child models may execute");
  const sdkChildren = (await f.app.agents.sessions.listSessions({})).filter((session) => session.parentID === worker.sessionId);
  assert.equal(sdkChildren.length, 7);
  assert.equal(f.app.store.list("superGoals").length, 1);
  assert.equal(f.app.store.list("superOperations").length, 0);
  const calls = f.calls;
  await f.restart();
  assert.equal(f.calls, calls);
  assert.deepEqual((await f.api(`/api/sessions/${worker.sessionId}/ai`)).agentRuns, view.agentRuns);
});

test("native child Write waits for the parent task approval and records only the approved actual write", async (t) => {
  const { f, worker, workspace } = await startSubagentTask(t, "super-subagent-write");
  const view = await until(() => f.api(`/api/sessions/${worker.sessionId}/ai`), (value) => value.status === "waiting_approval");
  assert.equal(view.pending.call.name, "Write");
  const target = join(workspace, "child-output.txt");
  await assert.rejects(access(target));
  assert.equal(f.app.store.list("superOperations").length, 0, "approval waiting is not a dispatched write");
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: view.pending.id, accept: true });
  const state = await settledSubagentTask(f);
  assert.equal(state.workers[0].task.state, "completed", JSON.stringify(state.workers[0]));
  assert.equal(await readFile(target, "utf8"), "actual child write receipt");
  const operations = f.app.store.list("superOperations");
  assert.equal(operations.length, 1);
  assert.equal(operations[0].tool, "Write");
  assert.equal(operations[0].status, "succeeded");
  const finished = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  assert.equal(finished.agentRuns.length, 1);
  assertNativeRun(finished.agentRuns[0], worker, f.app.store.list("superGoals")[0]);
  assert.ok(operations[0].callId.startsWith(finished.agentRuns[0].childSessionId + ":"));
});

test("rejecting a native child Write cannot create a file or turn child prose into task acceptance", async (t) => {
  const { f, worker, workspace } = await startSubagentTask(t, "super-subagent-write");
  const view = await until(() => f.api(`/api/sessions/${worker.sessionId}/ai`), (value) => value.status === "waiting_approval");
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: view.pending.id, accept: false });
  await settledSubagentTask(f);
  await assert.rejects(access(join(workspace, "child-output.txt")));
  assert.equal(f.app.store.list("superOperations").length, 0);
  assert.equal(f.app.store.list("superAcceptance").length, 0);
  assert.notEqual(f.app.store.list("superGoals")[0].acceptanceState, "pass");
});

test("current Pilot permission changes fence a native child Write after its approval was presented", async (t) => {
  const { f, project, worker, workspace } = await startSubagentTask(t, "super-subagent-write");
  const view = await until(() => f.api(`/api/sessions/${worker.sessionId}/ai`), (value) => value.status === "waiting_approval");
  await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`, "POST", { denyLocalExecution: true });
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: view.pending.id, accept: true });
  await settledSubagentTask(f);
  await assert.rejects(access(join(workspace, "child-output.txt")));
  assert.ok(!f.app.store.list("superOperations").some((operation) => operation.status === "succeeded"));
  assert.equal(f.app.store.list("superAcceptance").length, 0);
});

test("stopping a Worker cancels its native child approval and restart cannot replay either execution", async (t) => {
  const { f, worker, workspace } = await startSubagentTask(t, "super-subagent-write");
  const pending = await until(() => f.api(`/api/sessions/${worker.sessionId}/ai`), (value) => value.status === "waiting_approval");
  assert.equal(pending.pending.call.name, "Write");
  const state = await f.api(`/api/projects/${f.project.id}/superagent`);
  await f.api(`/api/sessions/${state.channels[0].sessionId}/channel`, "POST", { action: "stop" });
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: pending.pending.id, accept: true }, 409);
  const stopped = await f.api(`/api/projects/${f.project.id}/superagent`);
  assert.equal(stopped.workers[0].task.state, "cancelled");
  const view = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  assert.equal(view.agentRuns.length, 1);
  assert.equal(view.agentRuns[0].status, "cancelled");
  assert.ok(view.agentRuns[0].finishedAt);
  await assert.rejects(access(join(workspace, "child-output.txt")));
  assert.equal(f.app.store.list("superOperations").length, 0);
  const calls = f.calls;
  await f.restart();
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: pending.pending.id, accept: true }, 409);
  assert.equal((await f.api(`/api/sessions/${worker.sessionId}/ai`)).agentRuns[0].status, "cancelled");
  assert.equal(f.calls, calls);
  assert.equal(f.app.store.list("superOperations").length, 0);
  await assert.rejects(access(join(workspace, "child-output.txt")));
});

test("native background subagents join through TaskOutput and cannot accept their parent before actual completion", async (t) => {
  const { f, worker } = await startSubagentTask(t, "super-subagent-background");
  const state = await settledSubagentTask(f);
  const view = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  const goal = f.app.store.list("superGoals")[0];
  assert.equal(state.workers[0].task.state, "completed", JSON.stringify(state.workers[0]));
  assert.equal(goal.acceptanceState, "pass");
  assert.equal(f.backgroundJoinRequested, true, "the parent must explicitly join the actual native task");
  assert.equal(view.agentRuns.length, 1);
  assertNativeRun(view.agentRuns[0], worker, goal);
  assert.equal(view.agentRuns[0].status, "completed");
  const operations = f.app.store.list("superOperations");
  assert.equal(operations.length, 1, "Agent, TaskOutput and premature work_finish are not business receipts");
  assert.equal(operations[0].tool, "Read");
  assert.equal(operations[0].status, "succeeded");
  assert.ok(JSON.stringify(operations[0].output).includes("ACTUAL_CHILD_EVIDENCE_A"));
  const premature = view.cards.find((card) => card.data?.call_id === "premature-child-finish");
  assert.ok(premature && premature.status === "failed", "the premature completion must be rejected while the child is still alive");
  const calls = f.calls;
  await f.restart();
  assert.equal(f.calls, calls, "joined child and parent histories must restore without rerunning either model");
  assert.equal((await f.api(`/api/sessions/${worker.sessionId}/ai`)).agentRuns[0].status, "completed");
});

test("a Worker can launch two native background children before joining their distinct actual receipts", async (t) => {
  const { f, worker } = await startSubagentTask(t, "super-subagent-background-two");
  const state = await settledSubagentTask(f);
  assert.equal(state.workers[0].task.state, "completed", JSON.stringify(state.workers[0]));
  assert.equal(f.backgroundJoinRequested, true);
  const view = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  assert.equal(view.agentRuns.length, 2);
  assert.ok(view.agentRuns.every((run) => run.status === "completed"));
  assert.equal(new Set(view.agentRuns.map((run) => run.childSessionId)).size, 2);
  const operations = f.app.store.list("superOperations");
  assert.equal(operations.length, 2);
  assert.ok(operations.every((operation) => operation.tool === "Read" && operation.status === "succeeded"));
  assert.equal(new Set(operations.map((operation) => operation.id)).size, 2);
  assert.ok(JSON.stringify(operations).includes("ACTUAL_CHILD_EVIDENCE_A"));
  assert.ok(JSON.stringify(operations).includes("ACTUAL_CHILD_EVIDENCE_B"));
  const lastParentRequest = f.requests.findLast((request) => isIndependentWorkerRequest(request));
  const parentCalls = lastParentRequest.messages.flatMap((message) => message.tool_calls ?? []);
  const firstJoin = parentCalls.findIndex((tool) => tool.function.name === "TaskOutput");
  assert.equal(parentCalls.slice(0, firstJoin).filter((tool) => tool.function.name === "Agent").length, 2,
    "both independent child models must be launched before the first join");
});

test("an early parent reply cancels and settles native background children without pretending the task completed", async (t) => {
  const { f, worker } = await startSubagentTask(t, "super-subagent-background-early");
  const state = await settledSubagentTask(f);
  assert.notEqual(state.workers[0].task.state, "completed");
  assert.notEqual(f.app.store.list("superGoals")[0].acceptanceState, "pass");
  assert.equal(f.app.store.list("superOperations").length, 0);
  const view = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  assert.equal(view.agentRuns.length, 1);
  assert.equal(view.agentRuns[0].status, "cancelled");
  assert.ok(view.agentRuns[0].finishedAt);
  const calls = f.calls;
  await f.restart();
  assert.equal(f.calls, calls);
  assert.equal((await f.api(`/api/sessions/${worker.sessionId}/ai`)).agentRuns[0].status, "cancelled");
});

test("an explicit Worker stop cancels a waiting TaskOutput and its native background child without restart replay", async (t) => {
  const { f, worker } = await startSubagentTask(t, "super-subagent-background-stop");
  const live = await until(() => f.api(`/api/sessions/${worker.sessionId}/ai`), (view) =>
    view.agentRuns?.some((run) => run.status === "running") &&
    view.cards.some((card) => card.title === "TaskOutput" && card.status === "running"));
  assert.equal(live.agentRuns.length, 1);
  assert.equal(f.app.store.list("superOperations").length, 0);
  const state = await f.api(`/api/projects/${f.project.id}/superagent`);
  await f.api(`/api/sessions/${state.channels[0].sessionId}/channel`, "POST", { action: "stop" });
  const stopped = await f.api(`/api/projects/${f.project.id}/superagent`);
  assert.equal(stopped.workers[0].task.state, "cancelled");
  const view = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  assert.equal(view.agentRuns[0].status, "cancelled");
  assert.ok(view.agentRuns[0].finishedAt);
  assert.equal(f.app.store.list("superOperations").length, 0);
  assert.equal(f.app.store.list("superAcceptance").length, 0);
  const calls = f.calls;
  await f.restart();
  assert.equal(f.calls, calls);
  assert.equal((await f.api(`/api/sessions/${worker.sessionId}/ai`)).agentRuns[0].status, "cancelled");
  assert.equal(f.app.store.list("superOperations").length, 0);
});

test("specialist metadata management creates a channel without a task or Worker execution session", async (t) => {
  const f = await fixture(t, "super-meta");
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "创建项目检查员，先不要分派实际任务。" }, 202);
  const result = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.channels.length === 1);
  await until(() => f.api(`/api/sessions/${project.routerSessionId}/ai`), (view) => view.status === "completed");
  assert.equal(result.workers.length, 0);
  assert.equal(f.app.store.list("superGoals").length, 0);
  const sessions = await f.api("/api/catalog");
  assert.ok(!sessions.sessions.some((session) => session.workspaceRole === "worker"));
  assert.equal((await f.app.agents.sessions.listSessions({})).length, 1);
});

test("stopping a real specialist invalidates its pending Write approval without dispatch or restart replay", async (t) => {
  const f = await fixture(t, "super-write");
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查项目并创建一个结果文件，需要批准后再写入。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers.length === 1 && result.channels[0]?.needsConfirmation);
  const worker = state.workers[0], channel = state.channels[0];
  const pending = (await f.api(`/api/sessions/${worker.sessionId}/ai`)).pending;
  assert.equal(pending.call.name, "Write");
  const target = join(f.home, "workspaces", f.project.id, "approved.txt");
  await assert.rejects(access(target));
  await f.api(`/api/sessions/${channel.sessionId}/channel`, "POST", { action: "stop" });
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: pending.id, accept: true }, 409);
  await assert.rejects(access(target));
  const stopped = await f.api(`/api/projects/${f.project.id}/superagent`);
  assert.equal(stopped.workers[0].task.state, "cancelled");
  const calls = f.calls;
  await f.restart();
  assert.equal((await f.api(`/api/projects/${f.project.id}/superagent`)).workers[0].task.state, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.calls, calls);
  await assert.rejects(access(target));
});

test("a current Pilot permission change fences a previously presented Worker approval", async (t) => {
  const f = await fixture(t, "super-write");
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查项目并生成结果文件。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers.length === 1 && result.channels[0]?.needsConfirmation);
  const worker = state.workers[0];
  const pending = (await f.api(`/api/sessions/${worker.sessionId}/ai`)).pending;
  await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`, "POST", { denyLocalExecution: true });
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: pending.id, accept: true });
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers[0].assignmentState !== "active");
  await assert.rejects(access(join(f.home, "workspaces", f.project.id, "approved.txt")));
  assert.ok(!f.app.store.list("superAcceptance").some((receipt) => receipt.scope === "goal"));
});

test("specialist retirement is scoped, revisioned, idempotent and preserves committed task history", async (t) => {
  const f = await fixture(t, "super-inspect");
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "请检查这个项目工作区。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers.some((worker) => worker.task.state === "completed"));
  const role = state.channels[0], task = state.workers[0];
  const other = await f.api("/api/projects", "POST", { name: "Other project" });
  await f.api(`/api/projects/${other.id}/superagent/specialists/${role.roleId}`, "DELETE", { revision: role.roleRevision }, 404);
  await f.api(`/api/projects/${f.project.id}/superagent/specialists/${role.roleId}`, "DELETE", { revision: role.roleRevision + 1 }, 409);
  for (let retry = 0; retry < 2; retry++) await f.api(`/api/projects/${f.project.id}/superagent/specialists/${role.roleId}`, "DELETE", { revision: role.roleRevision });
  const retired = await f.api(`/api/projects/${f.project.id}/superagent`);
  assert.equal(retired.channels.length, 0);
  assert.equal(retired.workers[0].task.state, "completed");
  assert.equal(retired.workers[0].task.taskId, task.task.taskId);
  assert.ok((await f.api(`/api/sessions/${role.sessionId}/channel`)).entries.length > 0);
});

async function seedLegacyCatalog(f) {
  const { DatabaseSync } = require("node:sqlite");
  const { mkdir, chmod } = require("node:fs/promises");
  const { createHash } = require("node:crypto");
  await mkdir(join(f.options.data, "adk"), { mode: 0o700 });
  await mkdir(join(f.options.data, "ai"), { mode: 0o700 });
  const path = join(f.options.data, "lake-web.sqlite"), runtimePath = join(f.options.data, "adk/sessions.sqlite");
  const web = new DatabaseSync(path);
  web.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,createdAt TEXT);
    CREATE TABLE resources(id TEXT PRIMARY KEY,projectId TEXT,name TEXT,kind TEXT,status TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,projectId TEXT,title TEXT,status TEXT,createdAt TEXT,updatedAt TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,sessionId TEXT,role TEXT,text TEXT,createdAt TEXT,images TEXT,files TEXT);
    INSERT INTO projects VALUES('old-project','已有项目','2026-01-01T00:00:00Z');
    INSERT INTO resources VALUES('old-ssh','old-project','原主机','ssh','available');
    INSERT INTO sessions VALUES('old-router','old-project','Pilot','idle','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z');
    INSERT INTO sessions VALUES('old-channel','old-project','检查员','idle','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z');
    INSERT INTO sessions VALUES('old-worker','old-project','历史检查','completed','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z');
    INSERT INTO messages VALUES('old-message','old-worker','user','原始要求','2026-01-01T00:00:00Z','[]','[]');`);
  web.close();
  const runtime = new DatabaseSync(runtimePath);
  runtime.exec(`CREATE TABLE superagent_projects(project_id TEXT,router_session_id TEXT,version INTEGER);
    CREATE TABLE superagent_roles(id TEXT,project_id TEXT,role_key TEXT,name TEXT,duties TEXT,revision INTEGER,deleted_at TEXT);
    CREATE TABLE superagent_role_channels(id TEXT,project_id TEXT,role_id TEXT,host_session_id TEXT,revision INTEGER,created_at TEXT);
    CREATE TABLE superagent_workers(id TEXT,project_id TEXT,role_id TEXT,session_id TEXT,task_id TEXT,source_event_id TEXT,role_snapshot TEXT,created_at TEXT,revision INTEGER);
    CREATE TABLE native_work_goals(id TEXT,session_id TEXT,data TEXT,status TEXT);
    CREATE TABLE sessions(app_name TEXT,user_id TEXT,id TEXT,state TEXT);
    CREATE TABLE native_history_migrations(session_id TEXT,runtime_session_id TEXT,status TEXT,created_at TEXT);
    CREATE TABLE native_artifacts(session_id TEXT,file_name TEXT,version INTEGER,part BLOB);
    INSERT INTO superagent_projects VALUES('old-project','old-router',1);
    INSERT INTO superagent_roles VALUES('old-role','old-project','inspector','检查员','检查项目',7,NULL);
    INSERT INTO superagent_role_channels VALUES('old-channel-id','old-project','old-role','old-channel',1,'2026-01-01T00:00:00Z');
    INSERT INTO superagent_workers VALUES('old-worker-id','old-project','old-role','old-worker','old-goal','old-event','{"name":"原检查员","revision":6}','2026-01-01T00:00:00Z',1);
    INSERT INTO native_history_migrations VALUES('old-worker','old-adk','complete','2026-01-01T00:00:00Z');`);
  runtime.prepare("INSERT INTO native_work_goals VALUES(?,?,?,?)").run("old-goal", "old-worker", JSON.stringify({ id: "old-goal", sessionId: "old-worker", status: "completed", title: "旧任务", revision: 9, items: [], modelRounds: 4, roundLimit: 500, deadlineAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }), "completed");
  const cards = Array.from({ length: 351 }, (_, index) => ({ id: `old-card-${index}`, type: "message", content: `已提交历史 ${index}`, at: "2026-01-01T00:00:00Z", status: "completed" }));
  cards[0].content += " synthetic-secret-no-real-credential";
  const projection = JSON.stringify({ view: { session: "old-worker", cards }, runtime: { dangerousOldLease: true }, config: { apiKey: "must-not-import" } });
  const hash = createHash("sha256").update(projection).digest("hex");
  runtime.prepare("INSERT INTO sessions VALUES('lake','lake','old-adk',?)").run(JSON.stringify({ lake_context_projection: { version: 2, hash, eventId: "committed-event" } }));
  runtime.prepare("INSERT INTO native_artifacts VALUES('old-adk','lake-context.json',2,?)").run(Buffer.from(JSON.stringify({ text: projection })));
  runtime.prepare("INSERT INTO native_artifacts VALUES('old-adk','lake-context.json',3,?)").run(Buffer.from(JSON.stringify({ text: JSON.stringify({ view: { session: "old-worker", cards: [{ id: "orphan", content: "UNCOMMITTED" }] } }) })));
  runtime.close();
  for (const file of [path, runtimePath]) await chmod(file, 0o600);
  await writeFile(join(f.options.data, "ai/old-worker.json"), JSON.stringify({ runtime: { sessionId: "old-adk" }, view: { session: "old-worker", cards: [{ id: "stale", type: "message", content: "STALE UI CACHE" }] } }), { mode: 0o600 });
  return { path, runtimePath, hash: async (file) => createHash("sha256").update(await readFile(file)).digest("hex") };
}

test("Go Dev catalog migration preserves identity and committed paginated history without executing legacy tasks", async (t) => {
  const f = await fixture(t), source = await seedLegacyCatalog(f);
  const before = await Promise.all([source.hash(source.path), source.hash(source.runtimePath)]);
  f.options.development = true; f.options.importLegacy = true;
  const calls = f.calls;
  await f.restart();
  const state = await f.api("/api/projects/old-project/superagent");
  assert.equal(state.project.routerSessionId, "old-router");
  assert.equal(state.channels[0].roleId, "old-role");
  assert.equal(state.channels[0].roleRevision, 7);
  assert.equal(state.workers[0].id, "old-worker-id");
  assert.equal(state.workers[0].assignmentState, "archived");
  const snapshot = await f.api("/api/sessions/old-worker/snapshot");
  assert.equal(snapshot.session.workspaceRole, "legacy");
  assert.equal(snapshot.ai.cards.length, 300);
  assert.equal(snapshot.ai.totalCards, 351);
  assert.equal(snapshot.ai.cardsOffset, 51);
  assert.equal(snapshot.superagent.task.taskId, "old-goal");
  const earlier = await f.api("/api/sessions/old-worker/ai/snapshot?before=51");
  assert.equal(earlier.cards.length, 51);
  assert.equal(earlier.cards[0].id, "old-card-0");
  assert.ok(!JSON.stringify(earlier).includes("synthetic-secret-no-real-credential"));
  assert.ok(!JSON.stringify(snapshot).includes("UNCOMMITTED"));
  assert.ok(!JSON.stringify(snapshot).includes("STALE UI CACHE"));
  assert.equal(f.app.store.get("legacyLoadedViews", "old-worker").source, "go-adk-committed-projection");
  assert.equal(f.app.store.list("superWorkers").length, 0);
  assert.equal(f.app.store.list("superGoals").length, 0);
  assert.equal(f.app.store.list("superOperations").length, 0);
  const channel = await f.api("/api/sessions/old-channel/channel");
  assert.equal(channel.entries.length, 50);
  const second = await f.api(`/api/sessions/old-channel/channel?cursor=${encodeURIComponent(channel.nextCursor)}`);
  assert.equal(new Set([...channel.entries, ...second.entries].map((entry) => entry.id)).size, 100);
  await f.api("/api/sessions/old-worker/messages", "POST", { text: "重放旧任务" }, 409);
  await f.api("/api/sessions/old-router", "DELETE", undefined, 409);
  await f.restart();
  assert.equal((await f.api("/api/projects/old-project/superagent")).workers.length, 1);
  assert.deepEqual(await Promise.all([source.hash(source.path), source.hash(source.runtimePath)]), before);
  assert.equal(f.calls, calls);
});

test("legacy migration rollback refuses changed user data and removes only unchanged imported records", async (t) => {
  const f = await fixture(t); await seedLegacyCatalog(f);
  const preview = await previewLegacyMigration(f.app.store);
  assert.equal(preview.counts.projects, 1);
  f.options.development = true; f.options.importLegacy = true; await f.restart();
  const batch = f.app.store.get("settings", "legacyCatalogMigration.v1");
  const original = f.app.store.get("projects", "old-project");
  f.app.store.put("projects", "old-project", { ...original, name: "用户的新修改" });
  assert.throws(() => rollbackMigration(f.app.store, batch.id), /已变更/);
  f.app.store.put("projects", "old-project", original);
  await f.api("/api/sessions/old-worker/snapshot");
  assert.equal(rollbackMigration(f.app.store, batch.id).rolledBack, true);
  assert.equal(f.app.store.get("projects", "old-project"), undefined);
  assert.equal(f.app.store.get("views", "old-worker"), undefined);
  assert.equal(f.app.store.get("legacyLoadedViews", "old-worker"), undefined);
  assert.equal(f.app.store.project(f.project.id).id, f.project.id);
});

test("Plan mode confirms its exact plan but never grants mutation tools", async (t) => {
  const f = await fixture(t, "super-inspect"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`, "POST", { conversationMode: "plan" });
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "先制定计划，确认后只读检查。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers.length === 1 && result.channels[0].needsConfirmation);
  const worker = state.workers[0], view = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  assert.equal(view.pending.kind, "work_plan");
  assert.equal(f.app.store.list("superOperations").length, 0);
  const catalog = f.requests.find((request) => request.tools?.some((tool) => tool.function.name === "work_begin")).tools.map((tool) => tool.function.name);
  assert.ok(!catalog.includes("Write") && !catalog.includes("Edit") && catalog.includes("Bash"));
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: view.pending.id, accept: true });
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers[0].task.state === "completed");
  assert.equal(f.app.store.list("superOperations").length, 1);
  assert.equal(f.app.store.list("superOperations")[0].tool, "list_project_files");
});

test("rejecting a Plan confirmation has no resource effects and cannot be approved after restart", async (t) => {
  const f = await fixture(t, "super-inspect"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`, "POST", { conversationMode: "plan" });
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "先提计划。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.channels[0]?.needsConfirmation);
  const worker = state.workers[0], view = await f.api(`/api/sessions/${worker.sessionId}/ai`);
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: view.pending.id, accept: false });
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers[0].assignmentState !== "active");
  assert.equal(f.app.store.list("superOperations").length, 0);
  await f.restart();
  const calls = f.calls;
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: view.pending.id, accept: true }, 409);
  assert.equal(f.calls, calls);
});

test("Worker prose and invented evidence cannot accept or complete a canonical goal", async (t) => {
  const f = await fixture(t, "super-forged"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查项目，必须按实际结果交付。" }, 202);
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers.length === 1 && result.workers[0].assignmentState !== "active" && result.workers[0].assignmentState !== "queued");
  const goal = f.app.store.list("superGoals")[0];
  assert.notEqual(goal.status, "completed");
  assert.notEqual(goal.acceptanceState, "pass");
  assert.equal(f.app.store.list("superAcceptance").length, 0);
  assert.equal(f.app.store.list("superOperations").length, 0);
  const reports = f.app.store.messages(project.routerSessionId).filter((message) => message.author?.taskId === goal.id);
  assert.equal(reports.length, 1);
  assert.match(reports[0].text, /未完成|还没完成/);
});

test("an incomplete Worker reports its current explanation once without claiming task acceptance", async (t) => {
  const f = await fixture(t, "super-incomplete-report"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查服务器的使用情况。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers[0]?.assignmentState === "parked");
  const worker = state.workers[0], goal = f.app.store.list("superGoals")[0];
  const explanation = "这次还没连上服务器，暂时查不到 CPU 和内存的实际使用情况。";
  assert.equal(goal.status, "paused");
  assert.notEqual(goal.acceptanceState, "pass");
  assert.equal(f.app.store.list("superAcceptance").length, 0);
  const reports = () => f.app.store.messages(project.routerSessionId).filter((message) => message.author?.taskId === goal.id);
  assert.equal(reports().length, 1);
  assert.ok(reports()[0].text.includes(explanation));
  assert.match(reports()[0].text, /暂停|未完成|还没完成/);
  assert.ok(!reports()[0].text.includes("尚未取得全部验收证据"));
  const channel = await f.api(`/api/sessions/${state.channels[0].sessionId}/channel`);
  assert.equal(channel.entries.filter((entry) => (entry.message?.text ?? entry.card?.content ?? "").includes(explanation)).length, 1, "channel must not repeat its Worker answer as another report");
  const before = reports().map((message) => ({ id: message.id, text: message.text }));
  f.app.superagent.settled(worker.sessionId);
  assert.deepEqual(reports().map((message) => ({ id: message.id, text: message.text })), before, "duplicate settlement must not replace the invocation report");
  await f.restart();
  assert.deepEqual(reports().map((message) => ({ id: message.id, text: message.text })), before);
  const restored = await f.api(`/api/sessions/${state.channels[0].sessionId}/channel`);
  assert.equal(restored.entries.filter((entry) => (entry.message?.text ?? entry.card?.content ?? "").includes(explanation)).length, 1);
});

test("a resumed Worker failure never republishes the preceding invocation's answer", async (t) => {
  const f = await fixture(t, "super-incomplete-report"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查服务器。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers[0]?.assignmentState === "parked");
  const worker = state.workers[0], goal = f.app.store.list("superGoals")[0];
  const old = f.app.store.messages(project.routerSessionId).filter((message) => message.author?.taskId === goal.id).map((message) => message.id);
  f.failWorkerRequests();
  await f.api(`/api/sessions/${worker.sessionId}/ai/workControl`, "POST", { command: "resume", goalId: goal.id, revision: goal.revision });
  const newer = await until(async () => f.app.store.messages(project.routerSessionId).filter((message) => message.author?.taskId === goal.id && !old.includes(message.id)), (reports) => reports.length > 0);
  assert.equal(newer.length, 1);
  assert.ok(!newer[0].text.includes("这次还没连上服务器"), "previous final cards are historical, not this invocation's response");
  assert.match(newer[0].text, /失败|中断|未完成|还没完成|暂停/);
  assert.notEqual(f.app.store.list("superGoals")[0].status, "completed");
  assert.notEqual(f.app.store.list("superGoals")[0].acceptanceState, "pass");
  assert.equal(f.app.store.list("superOperations").length, 0);
  const calls = f.calls;
  await f.restart();
  assert.equal(f.calls, calls, "restoring the report must not invoke a model or retry work");
  assert.equal(f.app.store.messages(project.routerSessionId).filter((message) => message.author?.taskId === goal.id && !old.includes(message.id)).length, 1);
});

test("a parked waiting_user record and stale view cannot advertise a live confirmation", async (t) => {
  const f = await fixture(t, "super-incomplete-report"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查服务器。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (value) => value.workers[0]?.assignmentState === "parked");
  const worker = state.workers[0], goal = f.app.store.list("superGoals")[0];
  f.app.store.put("superGoals", goal.id, { ...goal, status: "waiting_user" });
  f.app.store.put("views", worker.sessionId, { ...f.app.store.view(worker.sessionId), status: "waiting_input",
    question: { id: "expired-question", questions: [{ id: "old", title: "过期问题" }] },
    pending: { id: "expired-approval", call: { id: "old-call", name: "inspect_host", arguments: "{}" }, kind: "tool" } });
  const current = await f.api(`/api/projects/${f.project.id}/superagent`);
  assert.equal(current.workers[0].task.state, "paused");
  assert.equal(current.channels[0].needsConfirmation, false);
  const channel = await f.api(`/api/sessions/${state.channels[0].sessionId}/channel`);
  assert.equal(channel.active.length, 0, "a stale persisted card cannot revive an actionable interaction");
  const calls = f.calls;
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: "expired-approval", accept: true }, 409);
  assert.equal(f.calls, calls);assert.equal(f.app.store.list("superOperations").length, 0);
});

test("accepted Worker reports survive the closed-goal model fence without inventing a later answer", async (t) => {
  const f = await fixture(t, "super-inspect"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查项目工作区。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers[0]?.assignmentState === "parked" && result.workers[0].task.state === "completed");
  const goal = f.app.store.list("superGoals")[0], reports = f.app.store.messages(project.routerSessionId).filter((message) => message.author?.taskId === goal.id);
  assert.equal(goal.acceptanceState, "pass");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].text, goal.summary);
  assert.ok(!reports[0].text.includes("本次真实检查已结束"), "later model prose cannot replace the accepted work_finish report");
  const channel = await f.api(`/api/sessions/${state.channels[0].sessionId}/channel`);
  assert.equal(channel.entries.filter((entry) => entry.card?.content === "本次真实检查已结束。").length, 0, "the closed-goal model fence prevents a later answer from being generated");
  const channelReports = channel.entries.filter((entry) => entry.message?.author?.taskId === goal.id);
  assert.equal(channelReports.length, 1, "without a later Worker answer, the channel must receive the canonical result exactly once");
  assert.equal(channelReports[0].message.text, goal.summary);
});

test("Pilot object pages enforce current project, revision and hash, including digest revisions", async (t) => {
  const f = await fixture(t, "super-inspect"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查项目工作区。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers[0]?.task.state === "completed");
  const goal = f.app.store.list("superGoals")[0];
  const read = f.app.superagent.profile(project.routerSessionId).tools.find((entry) => entry.metadata.name === "read_super_object").handler;
  const context = { toolCallId: "read-check", abortSignal: new AbortController().signal };
  const page = await read({ kind: "task_digest", id: goal.id, limit: 16384 }, context);
  assert.equal(page.revision, goal.revision);
  assert.ok(Buffer.byteLength(page.content) <= 1536);
  await assert.rejects(async () => read({ kind: "task_digest", id: goal.id, revision: goal.revision + 1 }, context), /revision/);
  await assert.rejects(async () => read({ kind: "task", id: goal.id, expected_hash: "invalid" }, context), /hash/);
  const other = await f.api("/api/projects", "POST", { name: "另一个项目" });
  const otherPilot = await f.api(`/api/projects/${other.id}/superagent`, "POST", {});
  const foreignRead = f.app.superagent.profile(otherPilot.routerSessionId).tools.find((entry) => entry.metadata.name === "read_super_object").handler;
  await assert.rejects(async () => foreignRead({ kind: "task", id: goal.id }, context), /not found in project/);
  assert.ok((await f.api(`/api/sessions/${state.channels[0].sessionId}/channel`)).entries.some((entry) => entry.message?.dispatch?.taskId === goal.id));
});

test("closing the established Home gate fences pending approvals through reopening and restart", async (t) => {
  const f = await fixture(t, "super-write"), fs = require("node:fs/promises");
  await fs.mkdir(join(f.home, "security"), { mode: 0o700 });
  await fs.mkdir(join(f.options.data, "adk"), { mode: 0o700 });
  const control = { formatVersion: 1, storeID: "a".repeat(64), recoveryEpoch: "b".repeat(64), runtimeRoot: await fs.realpath(join(f.options.data, "adk")), gate: "open", storeReady: false };
  const path = join(f.home, "security/control.json");
  await writeFile(path, JSON.stringify(control), { mode: 0o600 });
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查并生成项目文件。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.channels[0]?.needsConfirmation);
  const worker = state.workers[0], pending = (await f.api(`/api/sessions/${worker.sessionId}/ai`)).pending;
  await writeFile(path, JSON.stringify({ ...control, gate: "closed" }), { mode: 0o600 });
  assert.equal((await f.api("/api/bootstrap")).recoveryReadOnly, true);
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: pending.id, accept: true }, 409);
  await writeFile(path, JSON.stringify(control), { mode: 0o600 });
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: pending.id, accept: true }, 409);
  await f.restart();
  assert.equal((await f.api("/api/bootstrap")).recoveryReadOnly, false);
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: pending.id, accept: true }, 409);
  await assert.rejects(access(join(f.home, "workspaces", f.project.id, "approved.txt")));
});

test("migrated project policies cannot be replaced by default Agent SDK allow rules", async (t) => {
  const f = await fixture(t, "super-inspect");
  f.app.store.put("legacyProjectPolicies", f.project.id, { revision: 4, mode: "restricted", readOnly: true });
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查项目。" }, 202);
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers.length === 1 && !["active", "queued"].includes(result.workers[0].assignmentState));
  assert.equal(f.app.store.list("superOperations").length, 0);
  assert.equal(f.app.store.list("superAcceptance").length, 0);
  assert.equal(f.app.store.list("superGoals")[0].acceptanceState, "not_evaluated");
});

test("current read and write switches apply to independent Worker tools and persist", async (t) => {
  const f = await fixture(t, "super-write"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`, "POST", { silentReadFiles: false, silentWriteFiles: true });
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查并生成本项目文件。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.channels[0]?.needsConfirmation);
  const worker = state.workers[0], pending = (await f.api(`/api/sessions/${worker.sessionId}/ai`)).pending;
  assert.equal(pending.call.name, "list_project_files");
  assert.equal(f.app.store.list("superOperations").length, 0);
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: pending.id, accept: true });
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers[0].task.state === "completed");
  assert.equal(await readFile(join(f.home, "workspaces", f.project.id, "approved.txt"), "utf8"), "approved task output");
  assert.equal(f.app.store.list("superOperations").length, 2);
  await f.restart();
  assert.equal((await f.api(`/api/sessions/${project.routerSessionId}/ai/options`)).silentWriteFiles, true);
});

test("a failed proven read obtains a fresh attempt without replaying the failure or resetting the original task", async (t) => {
  const f = await fixture(t, "super-read-recovery"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "检查这个项目，路径不可用时改用现有工作区诊断。" }, 202);
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (result) => result.workers[0]?.task.state === "completed");
  const goals = f.app.store.list("superGoals"), operations = f.app.store.list("superOperations"), attempts = f.app.store.list("superAttempts");
  assert.equal(goals.length, 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].state, "failed");
  assert.equal(attempts[1].retryOf, attempts[0].id);
  assert.equal(attempts[1].state, "succeeded");
  assert.deepEqual(operations.map((operation) => operation.status), ["failed", "succeeded"]);
  assert.equal(goals[0].acceptanceState, "pass");
  assert.equal(goals[0].roundLimit, 500);
  assert.equal(f.app.store.list("superWorkers").length, 1);
});

async function mcpFixture(t) {
  const requests = [], stolen = [];
  const sink = createServer((req, res) => { stolen.push(req.url); res.writeHead(200); res.end(); });
  await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const server = createServer(async (req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { Location: `http://127.0.0.1:${sink.address().port}/stolen` }); res.end(); return; }
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ rpc, credentialMatched: req.headers['x-fixture-key'] === 'synthetic-mcp-token' });
    if (rpc.id === undefined) { res.writeHead(202); res.end(); return; }
    let result;
    if (rpc.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "Lake fixture", version: "1" } };
    else if (rpc.method === "tools/list") result = rpc.params?.cursor ? { tools: [{ name: "second_tool", description: "Second catalog page", inputSchema: { type: "object", properties: {} } }] }
      : { tools: [{ name: "count_documents", description: "Count fixture documents", inputSchema: { type: "object", properties: {} } }], nextCursor: "page-2" };
    else if (rpc.method === "tools/call") result = { content: [{ type: "text", text: "42 fixture documents" }], isError: false };
    else if (rpc.method === "ping") result = {};
    else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } })); return; }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await new Promise((resolve) => sink.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, requests, stolen };
}

test("MCP settings preserve private credentials, page real protocol catalogs, and never call tools during listing", async (t) => {
  const f = await fixture(t), mcp = await mcpFixture(t);
  const server = await f.api("/api/settings/mcp", "POST", { name: "Fixture knowledge", transport: "http", enabled: true, url: mcp.url, headers: { "X-Fixture-Key": "synthetic-mcp-token" }, args: [] });
  assert.equal(server.headersConfigured, true);
  assert.ok(!JSON.stringify(server).includes("synthetic-mcp-token"));
  assert.deepEqual(mcp.requests, []);
  const catalog = await f.api(`/api/settings/mcp/${server.id}/test`, "POST", {});
  assert.deepEqual(catalog.tools.map((tool) => tool.name), ["count_documents", "second_tool"]);
  assert.ok(mcp.requests.every((request) => request.credentialMatched));
  assert.equal(mcp.requests.filter((request) => request.rpc.method === "tools/call").length, 0);
  const { stat } = require("node:fs/promises");
  assert.equal((await stat(join(f.home, "secrets/extensions-typescript.json"))).mode & 0o777, 0o600);
  await f.api(`/api/settings/mcp/${server.id}`, "PUT", { ...server, name: "Renamed service" });
  assert.equal((await f.api("/api/settings/mcp")).servers[0].headersConfigured, true);
  await f.restart();
  assert.equal((await f.api("/api/settings/mcp")).servers[0].id, server.id);
  await f.api(`/api/settings/mcp/${server.id}/test`, "POST", {});
  assert.equal(mcp.requests.filter((request) => request.rpc.method === "tools/call").length, 0);
});

test("MCP JSON import is atomic and authenticated redirects never send custom credentials to another origin", async (t) => {
  const f = await fixture(t), mcp = await mcpFixture(t);
  const imported = await f.api("/api/settings/mcp/import", "POST", { mcpServers: { first: { url: mcp.url, headers: { "X-Fixture-Key": "synthetic-mcp-token" } }, second: { type: "stdio", command: "node", args: ["fixture-only.cjs"], enabled: false } } });
  assert.equal(imported.servers.length, 2);
  assert.deepEqual(mcp.requests, []);
  await f.api("/api/settings/mcp/import", "POST", { mcpServers: { third: { url: mcp.url }, invalid: { command: "node", args: "wrong type" } } }, 400);
  assert.equal((await f.api("/api/settings/mcp")).servers.length, 2);
  const redirect = await f.api("/api/settings/mcp", "POST", { name: "Redirect fixture", transport: "http", enabled: true, url: mcp.url.replace("/mcp", "/redirect"), headers: { "X-Fixture-Key": "synthetic-mcp-token" } });
  await f.api(`/api/settings/mcp/${redirect.id}/test`, "POST", {}, 502);
  assert.deepEqual(mcp.stolen, []);
});

test("legacy MCP credentials remain references in the same Dev Home and are never copied into TS records", async (t) => {
  const f = await fixture(t), fs = require("node:fs/promises");
  await fs.mkdir(join(f.home, "secrets"), { recursive: true, mode: 0o700 });
  const source = JSON.stringify({ version: 1, servers: [{ id: "legacy-service", name: "Legacy fixture", transport: "http", enabled: false, url: "http://127.0.0.1:9/mcp", args: null, headers: { Authorization: "Bearer synthetic-legacy-mcp-key" } }], skillRoots: null, disabledSkills: null });
  await writeFile(join(f.home, "secrets/extensions.json"), source, { mode: 0o600 });
  const before = await f.api("/api/settings/mcp");
  assert.equal(before.servers[0].headersConfigured, true);
  await f.api(`/api/settings/mcp/legacy-service`, "PUT", { ...before.servers[0], name: "Renamed legacy" });
  assert.equal(await readFile(join(f.home, "secrets/extensions.json"), "utf8"), source);
  assert.ok(!(await readFile(join(f.home, "secrets/extensions-typescript.json"), "utf8")).includes("synthetic-legacy-mcp-key"));
  assert.ok(!JSON.stringify(f.app.store.list("settings")).includes("synthetic-legacy-mcp-key"));
});

test("Skills preserve managed editing, enablement, external roots, restart and symlink credential exclusion", async (t) => {
  const f = await fixture(t), fs = require("node:fs/promises");
  await f.api("/api/settings/skills/fixture-skill", "PUT", { create: true, content: "---\nname: fixture-skill\ndescription: Check the fixture workspace\n---\nRead actual results." });
  let catalog = await f.api("/api/settings/skills");
  assert.equal(catalog.skills[0].managed, true);
  await f.api("/api/settings/skills/fixture-skill", "PUT", { enabled: false });
  assert.equal((await f.api("/api/settings/skills")).skills[0].enabled, false);
  const root = join(f.home, "external-skills"); await fs.mkdir(join(root, "external"), { recursive: true });
  await writeFile(join(root, "external/SKILL.md"), "---\ndescription: External reference\n---\nExternal content.");
  await f.api("/api/settings/skills/roots", "POST", { path: root });
  await f.api("/api/settings/skills/external", "PUT", { content: "overwrite imported content" }, 409);
  await fs.mkdir(join(f.home, "secrets/hidden"), { recursive: true, mode: 0o700 });
  await writeFile(join(f.home, "secrets/hidden/SKILL.md"), "sensitive credential sentinel", { mode: 0o600 });
  await fs.symlink(join(f.home, "secrets/hidden"), join(root, "hidden"));
  await f.api("/api/settings/skills/roots", "POST", { path: join(f.home, "secrets") }, 403);
  await f.restart();
  catalog = await f.api("/api/settings/skills");
  assert.deepEqual(catalog.skills.map((skill) => skill.name), ["external", "fixture-skill"]);
  assert.equal(catalog.skills.find((skill) => skill.name === "fixture-skill").enabled, false);
  assert.equal((await f.api("/api/settings/skills/external")).content.includes("External content"), true);
});

test('message unread receipts include Pilot and non-success specialist replies and survive stale reads/restart',async t=>{
 const f=await fixture(t,'super-chat'),project=await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{}),pilot=project.routerSessionId;
 const workspace=()=>f.api(`/api/projects/${f.project.id}/superagent`);
 assert.equal((await workspace()).pilotMessageRead.cursor,'');
 f.app.store.addMessage(pilot,'user','own input does not notify');
 const view=f.app.store.view(pilot);view.cards.push({id:'tool-only',type:'operation',title:'Bash',status:'running',at:new Date().toISOString()});f.app.store.put('views',pilot,view);
 assert.equal((await workspace()).pilotMessageRead.cursor,'');
 f.app.store.addMessage(pilot,'assistant','a useful answer');
 const first=(await f.api(`/api/sessions/${pilot}/snapshot`)).messageRead.cursor;
 assert.equal((await workspace()).pilotMessageRead.cursor,first);
 f.app.store.addMessage(pilot,'assistant','newer reply while old read is in flight');
 const latest=(await workspace()).pilotMessageRead.cursor;assert.ok(latest>first);
 await f.api(`/api/sessions/${pilot}/messages-read`,'PUT',{cursor:'99999999999999999999'},409);
 await f.api(`/api/sessions/${pilot}/messages-read`,'PUT',{cursor:first});
 assert.deepEqual((await workspace()).pilotMessageRead,{cursor:latest,seenCursor:first});
 await f.api(`/api/sessions/${pilot}/messages-read`,'PUT',{cursor:latest});
 await f.api(`/api/sessions/${pilot}/messages-read`,'PUT',{cursor:first});
 assert.equal((await workspace()).pilotMessageRead.seenCursor,latest);
 // Isolated fixture channel, with a failed reply and no accepted task.
 const session=await f.api(`/api/projects/${f.project.id}/sessions`,'POST',{});
 const role={id:'unread-role',projectId:f.project.id,roleKey:'unread',name:'未读验证专员',duties:'fixture',revision:1};
 f.app.store.put('superRoles',role.id,role);
 f.app.store.put('superChannels',role.id,{id:'unread-channel',projectId:f.project.id,roleId:role.id,sessionId:session.id,createdAt:new Date().toISOString(),revision:1});
 f.app.store.addMessage(session.id,'assistant','本次失败，已保留实际输出。');
 const channel=(await workspace()).channels[0];assert.ok(channel.messageRead.cursor);assert.equal(channel.completionCursor,'');
 const page=await f.api(`/api/sessions/${session.id}/channel`);assert.equal(page.channel.messageRead.cursor,channel.messageRead.cursor);
 await f.api(`/api/sessions/${session.id}/messages-read`,'PUT',{cursor:channel.messageRead.cursor});
 await f.restart();
 const restored=await workspace();assert.deepEqual(restored.pilotMessageRead,{cursor:latest,seenCursor:latest});assert.deepEqual(restored.channels[0].messageRead,{cursor:channel.messageRead.cursor,seenCursor:channel.messageRead.cursor});
 assert.equal(f.calls,0,'notification metadata never invokes a model or replays work');
});

test('Mini Box interrupts only its exact live SDK command and rejects stale or foreign handles',{skip:process.platform!=='darwin'},async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-stop');await send();
 const session=project.routerSessionId;
 const running=await until(()=>f.api(`/api/sessions/${session}/snapshot`),s=>s.commandExecutions?.some(command=>command.canStop));
 const command=running.commandExecutions.find(command=>command.canStop);
 assert.equal(command.sessionId,session);assert.ok(command.command);assert.equal(command.status,'running');
 const ledgerBefore=JSON.stringify(f.app.store.list('superOperations'));
 await f.api(`/api/sessions/${f.session.id}/executions/${command.id}/interrupt`,'POST',{generation:command.generation},409);
 await f.api(`/api/sessions/${session}/executions/${command.id}/interrupt`,'POST',{generation:command.generation+1},409);
 assert.equal(JSON.stringify(f.app.store.list('superOperations')),ledgerBefore);
 await f.api(`/api/sessions/${session}/executions/${command.id}/interrupt`,'POST',{generation:command.generation},202);
 await until(()=>f.app.store.get('commandExecutions',command.id),r=>r.status!=='running');
 const stopped=f.app.store.get('commandExecutions',command.id);assert.ok(stopped.stopRequestedAt);assert.equal(stopped.status,'cancelled');
 await f.api(`/api/sessions/${session}/executions/${command.id}/interrupt`,'POST',{generation:command.generation},409);
 const snapshot=await f.api(`/api/sessions/${session}/snapshot`);assert.equal(snapshot.commandExecutions.find(row=>row.id===command.id).canStop,false);
 assert.notEqual(snapshot.superagent.task.acceptanceState,'pass');
 // The stop fence is command + task generation + resource, not command text
 // alone. A separate target must remain available in the same task.
 const original=f.app.store.require('resources',stopped.resourceId),other={...original,id:'independent-local-target'};
 f.app.store.put('resources',other.id,other);
 let dispatched=0;
 const base={run:async()=>{dispatched++;return {status:'completed',exitCode:0,stdout:{text:'independent',bytes:11,truncated:false},stderr:{text:'',bytes:0,truncated:false},startedAt:new Date(),completedAt:new Date(),durationMs:0};}};
 const actor={sessionId:session,taskId:stopped.taskId,workerId:stopped.workerId,generation:stopped.generation,guard(){}};
 const plan=resource=>({resource,command:stopped.command,revision:f.app.execution.revision(resource),resourceRevision:1,readOnly:true,policy:'allow',risk:'readonly'});
 await assert.rejects(()=>f.app.execution.bind(base,actor,plan(original),'stopped-retry').run({}),/用户已终止此命令/);
 assert.equal(dispatched,0);
 assert.equal((await f.app.execution.bind(base,actor,plan(other),'independent-target').run({})).exitCode,0);
 assert.equal(dispatched,1);
});

test("ordinary Pilot conversation completes in one model request without routing or spawning a Worker", async (t) => {
  const f = await fixture(t, "super-chat"), project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "你是谁" }, 202);
  const snapshot = await until(() => f.api(`/api/sessions/${project.routerSessionId}/snapshot`), (value) => value.ai.status === "completed");
  assert.equal(f.calls, 1);
  assert.equal(snapshot.ai.replyStatus, "completed");
  assert.ok(snapshot.ai.turnFinishedAt);
  assert.ok(snapshot.messages.some((message) => message.role === "assistant" && message.text.includes("我是 Lake Pilot")));
  assert.equal(f.app.store.list("superDecisions").length, 0);
  assert.equal(f.app.store.list("superWorkers").length, 0);
  assert.equal(f.app.store.list("superInputs")[0].disposition, "routed");
});

test("independent Worker queries a real project MCP service only after its exact approval and accepts actual receipts", async (t) => {
  const f = await fixture(t, "super-mcp"), mcp = await mcpFixture(t);
  await f.api("/api/settings/mcp", "POST", { name: "Knowledge fixture", transport: "http", enabled: true, url: mcp.url });
  await f.api(`/api/projects/${f.project.id}/security/mcp-inheritance`, "PUT", { actionId: "inherit-fixture", expectedRevision: 0, enabled: true });
  const project = await f.api(`/api/projects/${f.project.id}/superagent`, "POST", {});
  await f.api(`/api/sessions/${project.routerSessionId}/messages`, "POST", { text: "通过项目知识库 MCP 查询文档数量。" }, 202);
  const state = await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (value) => value.channels[0]?.needsConfirmation);
  const worker = state.workers[0], pending = (await f.api(`/api/sessions/${worker.sessionId}/ai`)).pending;
  assert.equal(pending.call.name, "call_mcp_tool");
  assert.equal(mcp.requests.filter((request) => request.rpc.method === "tools/call").length, 0);
  await f.api(`/api/sessions/${worker.sessionId}/ai/decision`, "POST", { id: pending.id, accept: true });
  await until(() => f.api(`/api/projects/${f.project.id}/superagent`), (value) => value.workers[0].task.state === "completed");
  const operations = f.app.store.list("superOperations");
  assert.deepEqual(operations.map((operation) => operation.tool), ["list_mcp_tools", "call_mcp_tool"]);
  assert.ok(operations.every((operation) => operation.status === "succeeded" && operation.mcpServerId && operation.configurationHash && operation.bindingHash));
  assert.equal(mcp.requests.filter((request) => request.rpc.method === "tools/call").length, 1);
  assert.equal(f.app.store.list("superGoals")[0].acceptanceState, "pass");
});

test("explicit MCP service opt-out overrides global inheritance and a stale inheritance edit cannot widen scope", async (t) => {
  const f = await fixture(t), mcp = await mcpFixture(t);
  const server = await f.api("/api/settings/mcp", "POST", { name: "Scoped fixture", transport: "http", enabled: true, url: mcp.url });
  const inheritance = `/api/projects/${f.project.id}/security/mcp-inheritance`, binding = `/api/projects/${f.project.id}/security/mcp-bindings/${server.id}`;
  await f.api(inheritance, "PUT", { actionId: "enable", expectedRevision: 0, enabled: true });
  assert.equal((await f.api(inheritance)).servers.length, 1);
  await f.api(binding, "PUT", { actionId: "opt-out", expectedRevision: 0, enabled: false, toolNames: [] });
  assert.equal((await f.api(inheritance)).servers.length, 0);
  await f.api(inheritance, "PUT", { actionId: "stale", expectedRevision: 0, enabled: true }, 409);
  assert.equal((await f.api(inheritance)).servers.length, 0);
  assert.deepEqual(mcp.requests, []);
  await f.restart();
  assert.equal((await f.api(inheritance)).servers.length, 0);
});

test('persistent PTY preserves shell state, resizes and keeps output without replay after restart', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/bootstrap')).terminalMode, 'pty');
  const resource = (await f.api('/api/catalog')).resources.find(r => r.projectId === f.project.id && r.kind === 'local');
  const {sessionId} = await f.api(`/api/resources/${resource.id}/terminal-context`, 'POST', {});
  const term = await f.api(`/api/sessions/${sessionId}/terminals`, 'POST', {resourceId: resource.id, shell:'bash', interactive:true}, 201);
  const base = `/api/sessions/${sessionId}/terminals/${term.id}`;
  const history = () => f.api(base+'/history');
  await until(history, h => h.terminal.status === 'ready');
  await f.api(base+'/input', 'POST', {data:"test -t 0 && printf 'REAL_TTY\\n'; export LAKE_PTY_FIXTURE=retained; mkdir -p nested; cd nested\r"}, 202);
  await until(history, h => h.output.includes('REAL_TTY') && h.terminal.cwd?.endsWith('/nested') && h.terminal.status === 'ready');
  await f.api(base+'/resize', 'POST', {cols:91,rows:27});
  await f.api(base+'/input','POST',{data:"printf 'STATE_%s\\n' \"$LAKE_PTY_FIXTURE\"; stty size\r"},202);
  await until(history,h=>h.output.includes('STATE_retained') && h.output.includes('27 91'));
  const command = await f.api(base+'/commands','POST',{actor:'user',command:'printf ledger-ready'},202);
  const finished = await until(history,h=>h.entries.some(e=>e.id===command.id&&e.status==='completed'));
  assert.equal(finished.entries.find(e=>e.id===command.id).exitCode,0);
  assert.match(finished.entries.find(e=>e.id===command.id).output,/ledger-ready/);
  const catalog = await f.api('/api/catalog');
  assert.ok(catalog.terminals.some(item=>item.id===term.id));
  assert.ok(!catalog.sessions.some(item=>item.id===sessionId),'resource scope stays out of chat sidebar');
  await f.restart();
  const recovered = await history();
  assert.equal(recovered.terminal.status,'disconnected');
  assert.equal(recovered.terminal.interactive,false);
  assert.match(recovered.output,/STATE_retained/);
  await f.api(base+'/input','POST',{data:'echo must-not-run\r'},409);
});

test('PTY enforces project and human ownership, exact danger confirmation and command interruption', { skip: process.platform !== 'darwin' }, async(t)=>{
  const f=await fixture(t);
  const resource=(await f.api('/api/catalog')).resources.find(r=>r.projectId===f.project.id);
  const term=await f.api(`/api/sessions/${f.session.id}/terminals`,'POST',{resourceId:resource.id,shell:'zsh'},201);
  const base=`/api/sessions/${f.session.id}/terminals/${term.id}`;
  const history=()=>f.api(base+'/history');
  await until(history,h=>h.terminal.status==='ready');
  await f.api(base+'/commands','POST',{actor:'agent',command:'pwd'},403);
  await f.api(base+'/commands','POST',{actor:'user',command:'touch prohibited'},400);
  await f.api(base+'/commands','POST',{actor:'user',command:"sh -c 'rm -f fixture-absent'",confirmed:true},400);
  await f.api(base+'/control','POST',{holder:null});
  await f.api(base+'/input','POST',{data:'pwd\r'},409);
  await f.api(base+'/control','POST',{holder:'user'});
  const other=await f.api(`/api/projects/${f.project.id}/sessions`,'POST',{});
  const otherBase=`/api/sessions/${other.id}/terminals/${term.id}`;
  await f.api(otherBase+'/input','POST',{data:'pwd\r'},403);
  await f.api(otherBase+'/adopt','POST',{accept:true,generation:'stale'},409);
  await f.api(otherBase+'/adopt','POST',{accept:true,generation:term.generation,bind:false});
  const foreign=await f.api('/api/projects','POST',{name:'other project'});
  const foreignSession=await f.api(`/api/projects/${foreign.id}/sessions`,'POST',{});
  await f.api(`/api/sessions/${foreignSession.id}/terminals/${term.id}/history`,'GET',undefined,404);
  const command=await f.api(base+'/commands','POST',{actor:'user',command:'sleep 30'},202);
  await new Promise(resolve=>setTimeout(resolve,150));
  await f.api(base+'/interrupt-command','POST',{generation:'stale',entryId:command.id},409);
  await f.api(base+'/interrupt-command','POST',{generation:term.generation,entryId:command.id},202);
  const stopped=await until(history,h=>h.entries.some(e=>e.id===command.id&&e.status==='completed'));
  assert.equal(stopped.entries.find(e=>e.id===command.id).exitCode,130);
  await f.api(base+'/disconnect','POST',{});
  assert.equal((await history()).terminal.status,'disconnected');
});

test('PTY redacts a credential split across actual output chunks and persists no raw secret', { skip:process.platform!=='darwin' }, async(t)=>{
  const f=await fixture(t);
  const resource=(await f.api('/api/catalog')).resources.find(r=>r.projectId===f.project.id);
  const term=await f.api(`/api/sessions/${f.session.id}/terminals`,'POST',{resourceId:resource.id,shell:'bash'},201);
  const base=`/api/sessions/${f.session.id}/terminals/${term.id}`;
  await until(()=>f.api(base+'/history'),h=>h.terminal.status==='ready');
  // No contiguous key appears in the typed/echoed command. The actual process emits it in two writes.
  await f.api(base+'/input','POST',{data:"printf 'synthetic-secret-'; sleep 0.3; printf 'no-real-credential'; printf '\\nfinished-redaction\\n'\r"},202);
  await new Promise(resolve=>setTimeout(resolve,120));
  const middle=await f.api(base+'/history');
  assert.ok(!middle.output.endsWith('synthetic-secret-'));
  const final=await until(()=>f.api(base+'/history'),h=>h.output.includes('finished-redaction')&&h.terminal.status==='ready');
  assert.ok(!JSON.stringify(final).includes('synthetic-secret-no-real-credential'));
  assert.match(final.output,/\[REDACTED\]/);
  await f.restart();
  const sqlite=new (require('node:sqlite').DatabaseSync)(join(f.options.data,'lake-typescript.sqlite'),{readOnly:true});
  assert.ok(!JSON.stringify(sqlite.prepare("SELECT value FROM records WHERE kind IN ('terminalOutput','terminalEntries')").all()).includes('synthetic-secret-no-real-credential'));
  sqlite.close();
});

test('PTY partial input blocks managed dispatch and output reads do not produce an SSE feedback loop', {skip:process.platform!=='darwin'}, async(t)=>{
 const f=await fixture(t);
 const resource=(await f.api('/api/catalog')).resources.find(r=>r.projectId===f.project.id);
 const term=await f.api(`/api/sessions/${f.session.id}/terminals`,'POST',{resourceId:resource.id,shell:'sh'},201);
 const base=`/api/sessions/${f.session.id}/terminals/${term.id}`;
 const history=()=>f.api(base+'/history');
 await until(history,h=>h.terminal.status==='ready');
 await f.api(base+'/input','POST',{data:'printf incomplete'},202);
 await f.api(base+'/commands','POST',{actor:'user',command:'pwd'},409);
 await f.api(base+'/input','POST',{data:'\u0003'},202);
 await new Promise(resolve=>setTimeout(resolve,100));
 const command=await f.api(base+'/commands','POST',{actor:'user',command:'printf clean-command'},202);
 const done=await until(history,h=>h.entries.some(e=>e.id===command.id&&e.status==='completed'));
 assert.match(done.output,/clean-command/);
 assert.ok(!done.output.includes('__lake_managed=1'),'managed transport command must not be painted');
 await new Promise(resolve=>setTimeout(resolve,80));
 const before=(await f.api(`/api/sessions/${f.session.id}/snapshot`)).cursor;
 await history(); await history();
 assert.equal((await f.api(`/api/sessions/${f.session.id}/snapshot`)).cursor,before);
});

test('legacy unresolved MCP calls outside visible projects still fence a new approved remote call', async(t)=>{
 const f=await fixture(t,'super-mcp'), mcp=await mcpFixture(t);
 await f.api('/api/settings/mcp','POST',{name:'fixture',transport:'http',enabled:true,url:mcp.url});
 await f.api(`/api/projects/${f.project.id}/security/mcp-inheritance`,'PUT',{actionId:'inherit',expectedRevision:0,enabled:true});
 const project=await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{});
 await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'查询项目 MCP 文档数量'},202);
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),value=>value.channels[0]?.needsConfirmation);
 const worker=state.workers[0], pending=(await f.api(`/api/sessions/${worker.sessionId}/ai`)).pending;
 const fs=require('node:fs/promises'), path=join(f.options.data,'adk/sessions.sqlite');
 await fs.mkdir(join(f.options.data,'adk'),{recursive:true,mode:0o700});
 const db=new(require('node:sqlite').DatabaseSync)(path);
 db.exec("CREATE TABLE native_operations(project_id TEXT,tool TEXT,status TEXT,orphan_state TEXT,risk_resolved_at TEXT,closure_state TEXT); INSERT INTO native_operations VALUES('archived-not-imported','call_mcp_tool','unknown','',NULL,NULL)"); db.close(); await fs.chmod(path,0o600);
 await f.api(`/api/sessions/${worker.sessionId}/ai/decision`,'POST',{id:pending.id,accept:true});
 await until(()=>f.api(`/api/sessions/${worker.sessionId}/ai`),view=>!['running','waiting_approval'].includes(view.status));
 assert.equal(mcp.requests.filter(request=>request.rpc.method==='tools/call').length,0);
 assert.equal(f.app.store.list('superOperations').filter(operation=>operation.tool==='call_mcp_tool').length,0);
});

async function sshFixture(t, diagnosticsGate){
 const fs=require('node:fs/promises'),{generateKeyPairSync}=require('node:crypto'),{Server}=require('../../third_party/agent-sdk/node_modules/ssh2'),{spawn}=require('node:child_process');
 const pty=require('../../bin/lake-runtime/native/node-pty'),home=await mkdtemp(join(tmpdir(),'lake-ssh-server-')),clients=new Set();
 let server,port=0,key;const requests=[];let auths=0;
 const password='synthetic-ssh-password-no-real-credential';
 const start=async()=>{
  key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
  server=new Server({hostKeys:[key]},client=>{
   clients.add(client);client.on('error',()=>{});client.once('close',()=>clients.delete(client));
   client.on('authentication',ctx=>{auths++;if(ctx.method==='password'&&ctx.username==='fixture'&&ctx.password===password)ctx.accept();else ctx.reject();});
   client.on('ready',()=>client.on('session',accept=>{
    const session=accept();let dimensions;
    session.on('pty',(accept,reject,info)=>{dimensions=info;accept();});
    session.on('exec',async(accept,reject,info)=>{
     const stream=accept();requests.push({command:info.command,pty:!!dimensions});
     if(dimensions){
      const child=pty.spawn('/bin/sh',['-c',info.command],{cwd:home,env:{HOME:home,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8'},cols:dimensions.cols,rows:dimensions.rows});
      child.onData(data=>{if(!stream.destroyed)stream.write(data);});stream.on('data',data=>child.write(data.toString()));
      child.onExit(event=>{if(!stream.destroyed){stream.exit(event.exitCode);stream.end();}});stream.on('close',()=>{try{child.kill();}catch{}});
      session.on('window-change',(accept,reject,info)=>{try{child.resize(info.cols,info.rows);}catch{}accept?.();});
     }else{
      if(diagnosticsGate)await diagnosticsGate;
      if(stream.destroyed)return;
      const child=spawn('/bin/sh',['-c',info.command],{cwd:home,env:{HOME:home,PATH:join(home,'bin')+':/usr/bin:/bin:/usr/sbin:/sbin'}});
      child.stdout.on('data',data=>stream.write(data));child.stderr.on('data',data=>stream.stderr.write(data));child.on('close',code=>{stream.exit(code??1);stream.end();});stream.on('close',()=>child.kill());
     }
    });
   }));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{port=server.address().port;resolve();});});
 };
 const stop=async()=>{for(const client of clients)client.end();await new Promise(resolve=>server.close(resolve));};
 await start();t.after(stop);
 return {home,get port(){return port;},password,requests,get auths(){return auths;},async rotate(){await stop();await start();}};
}
async function sshResource(f,server){return f.api(`/api/projects/${f.project.id}/resources`,'POST',{kind:'ssh',name:'SSH fixture',ssh:{host:'127.0.0.1',port:server.port,username:'fixture',authMethod:'password',password:server.password,shell:'bash'}});}
async function trustTerminal(f,resource,sessionId=f.session.id){
 const term=await f.api(`/api/sessions/${sessionId}/terminals`,'POST',{resourceId:resource.id,interactive:true},201);
 const base=`/api/sessions/${sessionId}/terminals/${term.id}`;
 const snapshot=await until(()=>f.api(`/api/sessions/${sessionId}/snapshot`),s=>!!s.hostKeyTrust);
 return {term,base,prompt:snapshot.hostKeyTrust,approve:()=>f.api(`/api/sessions/${sessionId}/host-key`,'POST',{id:snapshot.hostKeyTrust.id,accept:true,fingerprint:snapshot.hostKeyTrust.fingerprint})};
}

test('SSH host trust blocks authentication, then opens a real remote PTY with saved private credentials', {skip:process.platform!=='darwin'},async(t)=>{
 const f=await fixture(t),server=await sshFixture(t),resource=await sshResource(f,server);
 assert.ok(!JSON.stringify(resource).includes(server.password));
 const {sessionId}=await f.api(`/api/resources/${resource.id}/terminal-context`,'POST',{});
 const terminal=await trustTerminal(f,resource,sessionId);
 assert.equal(server.auths,0,'host confirmation must precede all authentication');
 assert.equal(terminal.prompt.changed,false);
 await terminal.approve();
 const history=()=>f.api(terminal.base+'/history');await until(history,h=>h.terminal.status==='ready');
 await f.api(terminal.base+'/input','POST',{data:"test -t 0 && printf 'REMOTE_TTY_OK\\n'; export SAVED_SSH_STATE=retained\r"},202);
 await until(history,h=>h.output.includes('REMOTE_TTY_OK')&&h.terminal.status==='ready');
 await f.api(terminal.base+'/input','POST',{data:"printf 'SSH_STATE_%s\\n' \"$SAVED_SSH_STATE\"\r"},202);
 const final=await until(history,h=>h.output.includes('SSH_STATE_retained'));
 assert.ok(!JSON.stringify(final).includes(server.password));assert.ok(server.requests.some(request=>request.pty));
 await f.api(terminal.base+'/disconnect','POST',{});
 await f.restart();
 const reused=await f.api(`/api/sessions/${sessionId}/terminals`,'POST',{resourceId:resource.id},201);
 await until(()=>f.api(`/api/sessions/${sessionId}/terminals/${reused.id}/history`),h=>h.terminal.status==='ready');
 assert.equal((await f.api(`/api/sessions/${sessionId}/snapshot`)).hostKeyTrust,null,'confirmed host pin is reusable after restart');
});

test('SSH key changes prompt before authentication; cancellation and stale fingerprints cannot silently change trust', {skip:process.platform!=='darwin'},async(t)=>{
 const f=await fixture(t),server=await sshFixture(t),resource=await sshResource(f,server);
 let terminal=await trustTerminal(f,resource);await terminal.approve();await until(()=>f.api(terminal.base+'/history'),h=>h.terminal.status==='ready');await f.api(terminal.base+'/disconnect','POST',{});
 const authenticated=server.auths;await server.rotate();terminal=await trustTerminal(f,resource);
 assert.equal(terminal.prompt.changed,true);assert.equal(terminal.prompt.previousFingerprints.length,1);assert.equal(server.auths,authenticated);
 await f.api(`/api/sessions/${f.session.id}/host-key`,'POST',{id:terminal.prompt.id,accept:true,fingerprint:'SHA256:stale'},409);
 await f.api(`/api/sessions/${f.session.id}/host-key`,'POST',{id:terminal.prompt.id,accept:false,fingerprint:terminal.prompt.fingerprint});
 await until(()=>f.api(terminal.base+'/history'),h=>h.terminal.status==='disconnected');assert.equal(server.auths,authenticated);
 terminal=await trustTerminal(f,resource);await terminal.approve();await until(()=>f.api(terminal.base+'/history'),h=>h.terminal.status==='ready');
 assert.ok(server.auths>authenticated);
});

test('independent Worker uses an exact approved SSH diagnostic profile and accepts only its real receipt', {skip:process.platform!=='darwin'},async(t)=>{
 let releaseDiagnostic;const diagnosticsGate=new Promise(resolve=>{releaseDiagnostic=resolve;});t.after(()=>releaseDiagnostic());
 const f=await fixture(t,'super-host'),server=await sshFixture(t,diagnosticsGate),resource=await sshResource(f,server);
 const terminal=await trustTerminal(f,resource);await terminal.approve();await until(()=>f.api(terminal.base+'/history'),h=>h.terminal.status==='ready');await f.api(terminal.base+'/disconnect','POST',{});
 const authenticated=server.auths,project=await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{});
 await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`,'POST',{silentCommands:false});
 await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'读取该 SSH 主机当前系统指标。'},202);
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),value=>value.channels[0]?.needsConfirmation),worker=state.workers[0];
 const channel=await f.api(`/api/sessions/${state.channels[0].sessionId}/channel`);assert.ok(channel.active.some(s=>s.ai.pending?.call.name==='inspect_host'));
 const pending=(await f.api(`/api/sessions/${worker.sessionId}/ai`)).pending;assert.equal(pending.call.name,'inspect_host');assert.equal(server.auths,authenticated);
 assert.equal(worker.activity.phase,'waiting_approval');assert.equal(worker.activity.label,'等待操作确认');
 assert.equal(f.app.agents.currentActivity(worker.sessionId),undefined,'scheduled tools are not executing before approval');
 const originalInput=f.app.store.list('superInputs').find(event=>event.sessionId===project.routerSessionId);
 assert.equal(worker.activity.sourceMessageId,originalInput.messageId);assert.equal(worker.activity.sourceSessionId,project.routerSessionId);
 // A newly routed follow-up has not yet entered this worker. Do not move the
 // current activity to that new bubble until the next invocation receives it.
 const storedWorker=f.app.store.get('superWorkers',worker.id),fakeInput={...originalInput,id:'not-delivered',messageId:'future-message',disposition:'routed'};
 f.app.store.put('superInputs',fakeInput.id,fakeInput);f.app.store.put('superWorkers',worker.id,{...storedWorker,inputEventIds:[...storedWorker.inputEventIds,fakeInput.id]});
 assert.equal((await f.api(`/api/projects/${f.project.id}/superagent`)).workers[0].activity.sourceMessageId,originalInput.messageId);
 f.app.store.put('superInputs',fakeInput.id,{...fakeInput,disposition:'blocked'});
 // Model a settled original invocation: only the blocked follow-up remains.
 // Old blocked inputs must not suppress a later *valid* queued input.
 f.app.store.put('superWorkers',worker.id,{...storedWorker,state:'queued',settledInputIds:storedWorker.invocationInputIds,inputEventIds:[...storedWorker.inputEventIds,fakeInput.id]});
 assert.equal((await f.api(`/api/projects/${f.project.id}/superagent`)).workers[0].activity,undefined,'a queue with only a blocked remaining input is not runnable');
 f.app.store.put('superWorkers',worker.id,storedWorker);f.app.store.delete('superInputs',fakeInput.id);
 await f.api(`/api/sessions/${worker.sessionId}/ai/decision`,'POST',{id:pending.id,accept:true});
 const active=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0].activity?.phase==='tool');
 assert.equal(active.workers[0].activity.toolName,'inspect_host');assert.equal(active.workers[0].activity.label,'正在读取服务器指标');
 assert.equal(active.workers[0].activity.sourceMessageId,originalInput.messageId);
 releaseDiagnostic();
 const completed=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0].task.state==='completed');
 assert.equal(completed.workers[0].activity,undefined);
 assert.equal(completed.channels[0].needsConfirmation,false);
 const operation=f.app.store.list('superOperations').find(o=>o.tool==='inspect_host');assert.equal(operation.status,'succeeded');assert.equal(operation.resourceId,resource.id);assert.equal(operation.output.exitCode,0);assert.ok(operation.output.hostFingerprint);assert.equal(operation.readOnly,true);
});

test('a short retry uses recent dialogue and current SSH capabilities, resumes the same task and accepts only the new host receipt', {skip:process.platform!=='darwin'}, async(t)=>{
 const f=await fixture(t,'super-host-retry'),server=await sshFixture(t),resource=await sshResource(f,server);
 const terminal=await trustTerminal(f,resource);await terminal.approve();await until(()=>f.api(terminal.base+'/history'),h=>h.terminal.status==='ready');await f.api(terminal.base+'/disconnect','POST',{});
 const authenticated=server.auths;
 // Simulate a previously unavailable imported resource. Credentials remain in
 // the private fixture home, and no user server or user task is involved.
 f.app.store.put('resources',resource.id,{...f.app.store.get('resources',resource.id),status:'unavailable'});
 const project=await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{});
 await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`,'POST',{silentCommands:false});
 const original='分析 SSH fixture 服务器的当前系统指标。';
 await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:original},202);
 const first=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.assignmentState==='parked');
 const worker=first.workers[0],goalBefore=structuredClone(f.app.store.list('superGoals')[0]);
 assert.notEqual(goalBefore.status,'completed');assert.notEqual(goalBefore.acceptanceState,'pass');
 assert.equal(first.channels[0].needsConfirmation,false,'an unavailable connection is not an unanswered user interaction');
 assert.equal(first.workers[0].activity,undefined,'a parked task does not pretend to be running');
 assert.equal(f.app.store.list('superAcceptance').length,0);assert.equal(server.auths,authenticated);
 assert.equal(f.app.store.list('superOperations').filter(o=>o.tool==='inspect_host').length,0);
 const oldReport=f.app.store.messages(project.routerSessionId).find(m=>m.author?.taskId===goalBefore.id);
 assert.match(oldReport.text,/SSH 连接还不可用/);
 await until(()=>f.api(`/api/sessions/${project.routerSessionId}/ai`),view=>view.status==='completed');

 // Restoring the current configuration changes its revision; the preceding
 // report remains historical and must not fence this newly authorized retry.
 await f.api(`/api/resources/${resource.id}`,'PATCH',{ssh:{shell:'sh'}});
 const beforeRetry=f.requests.length;
 await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'再试试'},202);
 const pendingState=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.channels[0]?.needsConfirmation);
 assert.equal(pendingState.workers.length,1);assert.equal(pendingState.workers[0].id,worker.id);
 assert.equal(pendingState.workers[0].task.taskId,goalBefore.id);assert.equal(pendingState.workers[0].roleId,worker.roleId);
 const retryEvent=f.app.store.list('superInputs').find(event=>event.payload==='再试试');
 assert.equal(pendingState.workers[0].activity.phase,'waiting_approval');assert.equal(pendingState.workers[0].activity.sourceMessageId,retryEvent.messageId);
 const decisions=f.app.store.list('superDecisions').filter(decision=>decision.eventId===retryEvent.id);
 assert.equal(decisions.length,1);assert.equal(decisions[0].action,'followup');assert.equal(decisions[0].taskId,goalBefore.id);assert.equal(decisions[0].quote,'再试试');
 const textOf=(message)=>typeof message.content==='string'?message.content:(message.content??[]).map(part=>part.text??'').join('');
 const retryRequests=f.requests.slice(beforeRetry);
 const routerRequest=retryRequests.find(request=>request.tools.some(tool=>tool.function.name==='route_work'));
 const raw=routerRequest.messages.filter(m=>m.role==='user').map(textOf).findLast(text=>text.startsWith('[LAKE ADMITTED HUMAN EVENTS'));
 const context=JSON.parse(raw.split('[CURRENT CONVERSATION WORKING SET]\n')[1]);
 assert.equal(context.focus[0].task.id,goalBefore.id);assert.equal(context.focus[0].roleId,worker.roleId);assert.equal(context.focus[0].basis,'recent_dialogue');
 assert.ok(context.dialogue.some(message=>message.role==='user'&&message.text===original));
 assert.ok(context.dialogue.some(message=>message.taskId===goalBefore.id&&message.text.includes('SSH 连接还不可用')&&message.historical));
 assert.ok(context.capabilities.workerTools.includes('inspect_host'));assert.equal(context.capabilities.ssh.adapterRegistered,true);
 assert.equal(context.capabilities.relevantResources.find(item=>item.id===resource.id).configurationStatus,'available');
 const workerRequest=retryRequests.find(request=>isIndependentWorkerRequest(request));
 const assignment=JSON.parse(workerRequest.messages.filter(m=>m.role==='user').map(textOf).findLast(text=>text.startsWith('{')&&text.includes('"assignment"')));
 assert.equal(assignment.assignment.taskId,goalBefore.id);assert.equal(assignment.followups.at(-1).text,'再试试');
 const pending=(await f.api(`/api/sessions/${worker.sessionId}/ai`)).pending;
 assert.equal(pending.call.name,'inspect_host');assert.equal(JSON.parse(pending.call.arguments).asset_ref,resource.id);
 assert.equal(server.auths,authenticated,'the retry still requires its exact real-operation approval');
 await f.api(`/api/sessions/${worker.sessionId}/ai/decision`,'POST',{id:pending.id,accept:true});
 const completed=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0].task.state==='completed');
 assert.equal(completed.channels[0].needsConfirmation,false);assert.equal(f.app.store.list('superGoals').length,1);
 const goal=f.app.store.list('superGoals')[0],operation=f.app.store.list('superOperations').find(o=>o.tool==='inspect_host');
 assert.equal(goal.id,goalBefore.id);assert.equal(goal.executionMode,'host_managed');assert.equal(goal.acceptanceState,'pass');
 assert.equal(goal.deadlineAt,goalBefore.deadlineAt);assert.equal(goal.roundLimit,goalBefore.roundLimit);assert.ok(goal.modelRounds>goalBefore.modelRounds);
 assert.equal(operation.status,'succeeded');assert.equal(operation.resourceId,resource.id);assert.equal(operation.output.exitCode,0);assert.ok(operation.output.hostFingerprint);
 assert.ok(server.auths>authenticated);assert.ok(server.requests.some(request=>!request.pty));
 assert.ok(f.app.store.list('superAcceptance').some(receipt=>receipt.goalId===goal.id&&receipt.operationIds?.includes(operation.id)));
 assert.equal(f.app.store.messages(project.routerSessionId).filter(m=>m.author?.taskId===goal.id&&m.text.includes('已重新连上服务器')).length,1);
});

test('legacy SSH references supplement an already imported v1 catalog without touching source data or replaying work',async(t)=>{
 const f=await fixture(t),source=await seedLegacyCatalog(f),fs=require('node:fs/promises');f.options.development=true;f.options.importLegacy=true;await f.restart();
 const oldBatch=JSON.stringify(f.app.store.get('settings','legacyCatalogMigration.v1'));
 assert.equal((await f.api('/api/resources/old-ssh')).status,'unavailable');
 const privateKey=require('node:crypto').generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
 await fs.mkdir(join(f.home,'secrets'),{mode:0o700,recursive:true});await writeFile(join(f.home,'secrets/ssh-key-fixture'),privateKey,{mode:0o600});
 const db=new(require('node:sqlite').DatabaseSync)(source.path);db.exec('CREATE TABLE resourceConnections(resourceId TEXT,config TEXT)');db.prepare('INSERT INTO resourceConnections VALUES(?,?)').run('old-ssh',JSON.stringify({host:'127.0.0.1',port:22,username:'fixture',authMethod:'key',identityFile:'ssh-key-fixture',shell:'bash'}));db.close();
 const before=await source.hash(source.path),calls=f.calls;await f.restart();
 const resource=await f.api('/api/resources/old-ssh');assert.equal(resource.status,'available');assert.equal(resource.ssh.identityFile,'ssh-key-fixture');
 assert.equal(JSON.stringify(f.app.store.get('settings','legacyCatalogMigration.v1')),oldBatch);assert.equal(await source.hash(source.path),before);assert.equal(f.calls,calls);assert.equal(f.app.store.list('superWorkers').length,0);
 await f.api('/api/resources/old-ssh','PATCH',{name:'Edited SSH'});await f.restart();assert.equal((await f.api('/api/resources/old-ssh')).name,'Edited SSH');
});

test('changing SSH configuration while approval waits invalidates the exact call without authentication', {skip:process.platform!=='darwin'},async(t)=>{
 const f=await fixture(t,'super-host'),server=await sshFixture(t),resource=await sshResource(f,server),project=await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{});
 await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`,'POST',{silentCommands:false});
 await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'读取 SSH 主机指标'},202);
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.channels[0]?.needsConfirmation),worker=state.workers[0],pending=(await f.api(`/api/sessions/${worker.sessionId}/ai`)).pending;
 await f.api(`/api/resources/${resource.id}`,'PATCH',{ssh:{shell:'sh'}});
 await f.api(`/api/sessions/${worker.sessionId}/ai/decision`,'POST',{id:pending.id,accept:true});
 await until(()=>f.api(`/api/sessions/${worker.sessionId}/ai`),s=>!['running','waiting_approval'].includes(s.status));
 assert.equal(server.auths,0);assert.equal(server.requests.length,0);assert.equal(f.app.store.list('superOperations').filter(o=>o.tool==='inspect_host').length,0);
});

test('an explicit project host deny cannot be replaced by SDK readonly defaults', {skip:process.platform!=='darwin'},async(t)=>{
 const f=await fixture(t,'super-host'),server=await sshFixture(t),resource=await sshResource(f,server);
 f.app.store.put('legacyProjectPolicies',f.project.id,{data:{SchemaVersion:1,Revision:1,Confirmed:true,Mode:'legacy',ProjectID:f.project.id,ResourceIDs:[resource.id],Rules:[{Capability:'command.diagnostics',Effect:'deny'},{Capability:'resource.resolve',Effect:'allow'}]}});
 const project=await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{});await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'读取主机'},202);
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.assignmentState==='parked');
 assert.equal(server.auths,0);assert.equal(server.requests.length,0);assert.equal(state.channels[0].needsConfirmation,false);
 assert.equal(f.app.store.list('superOperations').filter(o=>o.tool==='inspect_host').length,0);
});

test('SSH authentication failure is distinct from availability and never exposes the saved password', {skip:process.platform!=='darwin'},async(t)=>{
 const f=await fixture(t),server=await sshFixture(t),resource=await sshResource(f,server);
 await f.api(`/api/resources/${resource.id}`,'PATCH',{ssh:{password:'synthetic-wrong-ssh-password'}});
 const terminal=await trustTerminal(f,resource);await terminal.approve();const history=await until(()=>f.api(terminal.base+'/history'),h=>h.terminal.status==='disconnected');
 assert.match(history.output,/身份认证失败/);assert.ok(!JSON.stringify(history).includes('synthetic-wrong-ssh-password'));assert.equal(server.requests.length,0);
});

test('native Memory extracts after real user input, publishes scoped files, recalls across sessions and honors forget',async t=>{
 const f=await fixture(t,'memory-native');
 const catalog=await f.api(`/api/memory?projectId=${f.project.id}`),scope=catalog.scopes.find(scope=>scope.kind==='project');
 assert.equal(catalog.engine,'typescript');
 await f.api(`/api/memory/scopes/${scope.key}/settings?projectId=${f.project.id}`,'PATCH',{useEnabled:true,extractionEnabled:true,expectedRevision:0});
 await f.api(`/api/sessions/${f.session.id}/messages`,'POST',{text:'以后报告先给结论，然后给实际证据。'},202);await f.wait(['completed']);
 await until(async()=>!f.app.agents.foregroundBusy(),Boolean);await f.app.memory.wait();
 let view=await f.api(`/api/memory/scopes/${scope.key}?projectId=${f.project.id}`);
 assert.equal(view.jobs[0].state,'completed',JSON.stringify(view.jobs));assert.equal(view.items.length,1,JSON.stringify(view));
 assert.equal(view.jobs[0].outcome, 'published'); assert.equal(view.jobs[0].noteCount, 1); assert.equal(view.jobs[0].publishedRevision, 1);
 assert.match(view.items[0].body,/NATIVE_PROJECT_MEMORY/);assert.equal(view.items[0].sources[0].kind,'user');
 assert.ok(f.requests.some(request=>JSON.stringify(request.messages).includes('You are now acting as the memory extraction subagent')));
 assert.ok(f.requests.some(request => JSON.stringify(request.messages).includes('[LAKE MEMORY CAPTURE]')), 'a natural request to remember uses scoped background capture instead of ordinary project file writes');
 const learnedCalls=f.calls;
 const next=await f.api(`/api/projects/${f.project.id}/sessions`,'POST',{});
 await f.api(`/api/sessions/${next.id}/messages`,'POST',{text:'再做一个新的检查任务。'},202);await until(()=>f.api(`/api/sessions/${next.id}/ai`),view=>view.status==='completed');
 const request=f.requests.slice(learnedCalls).find(request=>JSON.stringify(request.messages).includes('LAKE SCOPED LONG-TERM KNOWLEDGE'));
 assert.ok(request);assert.match(JSON.stringify(request.messages),/NATIVE_PROJECT_MEMORY/);
 // Disable capture before deletion, so no new source can write it back.
 await f.api(`/api/memory/scopes/${scope.key}/settings?projectId=${f.project.id}`,'PATCH',{useEnabled:true,extractionEnabled:false,expectedRevision:view.settings.revision});
 await f.app.memory.wait();view=await f.api(`/api/memory/scopes/${scope.key}?projectId=${f.project.id}`);
 await f.api(`/api/memory/scopes/${scope.key}/entries/${view.items[0].id}?projectId=${f.project.id}`,'DELETE',{expectedRevision:view.items[0].revision});
 const baseline=f.calls;await f.api(`/api/sessions/${next.id}/messages`,'POST',{text:'再次检查当前状态。'},202);await until(()=>f.api(`/api/sessions/${next.id}/ai`),view=>view.status==='failed');
 const fresh=await f.api(`/api/projects/${f.project.id}/sessions`,'POST',{});await f.api(`/api/sessions/${fresh.id}/messages`,'POST',{text:'在新的任务中检查当前状态。'},202);await until(()=>f.api(`/api/sessions/${fresh.id}/ai`),view=>view.status==='completed');
 assert.ok(f.requests.slice(baseline).every(request=>!JSON.stringify(request.messages).includes('NATIVE_PROJECT_MEMORY')),'withdrawn knowledge never entered canonical model history');
 assert.deepEqual(await require('node:fs/promises').readdir(join(f.options.data,'memory/staging')),[]);
});

test('native Memory records a legitimate no-change extraction without claiming a published note', async t => {
  const f = await fixture(t, 'memory-native-nochange');
  const catalog = await f.api(`/api/memory?projectId=${f.project.id}`), scope = catalog.scopes.find(scope => scope.kind === 'project');
  await f.api(`/api/memory/scopes/${scope.key}/settings?projectId=${f.project.id}`, 'PATCH', {useEnabled: true, extractionEnabled: true, expectedRevision: 0});
  await f.api(`/api/sessions/${f.session.id}/messages`, 'POST', {text: '这次仅查看临时输出，不包含新的长期偏好。'}, 202);
  await f.wait(['completed']); await until(async () => !f.app.agents.foregroundBusy(), Boolean); await f.app.memory.wait();
  const view = await f.api(`/api/memory/scopes/${scope.key}?projectId=${f.project.id}`);
  assert.equal(view.jobs[0].state, 'completed'); assert.equal(view.jobs[0].outcome, 'unchanged');
  assert.equal(view.jobs[0].publishedRevision, 0); assert.equal(view.jobs[0].noteCount, 0); assert.deepEqual(view.items, []);
});

test('native child evidence flows into stable role Memory and a new Worker reads it without sharing execution history',async t=>{
 const {f,project,worker}=await startSubagentTask(t,'super-subagent-read',true);
 await settledSubagentTask(f);await until(async()=>!f.app.agents.foregroundBusy(),Boolean);await f.app.memory.wait();
 const scope=f.app.memory.scope('role',f.project.id,worker.roleId),view=f.app.memory.view(scope);
 assert.equal(view.items.length,1,JSON.stringify(view.jobs));assert.match(view.items[0].body,/NATIVE_ROLE_MEMORY/);
 assert.equal(view.items[0].sources[0].taskId,worker.task.taskId);
 assert.ok(f.requests.some(request=>JSON.stringify(request.messages).includes('You are now acting as the memory extraction subagent')&&JSON.stringify(request.messages).includes('ACTUAL_CHILD_EVIDENCE_A')));
 assert.equal(f.app.store.list('memoryScopes').filter(scope=>scope.kind==='role').length,1,'temporary child has no independent long-term scope');
 const offset=f.requests.length;
 await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'请新建另一次检查任务，重新读取本项目实际证据。'},202);
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),value=>value.workers.length===2&&value.workers.every(worker=>worker.assignmentState==='parked'));
 assert.notEqual(state.workers[0].sessionId,state.workers[1].sessionId);assert.equal(state.workers[0].roleId,state.workers[1].roleId);
 const newWorker=f.requests.slice(offset).find(request=>isIndependentWorkerRequest(request));
 assert.match(JSON.stringify(newWorker.messages),/NATIVE_ROLE_MEMORY/);
 assert.ok(!JSON.stringify(newWorker.messages).includes('shared-child-read'),'new task starts without previous task tool history');
 const router=f.requests.slice(offset).find(request=>request.tools?.some(tool=>tool.function.name==='route_work'));
 assert.doesNotMatch(JSON.stringify(router.messages),/NATIVE_ROLE_MEMORY/,'Pilot has no automatic role-private knowledge');
});

test('single-message ignore prevents native Memory reads and source capture; explicit global notes do not auto-share to Workers',async t=>{
 const f=await fixture(t,'memory-native'),scope=f.app.memory.scope('project',f.project.id);
 f.app.memory.setSettings(scope,{useEnabled:true,extractionEnabled:true,expectedRevision:0});
 await f.app.memory.remember(scope,{title:'Only scoped knowledge',body:'MANUAL_PRIVATE_MEMORY',expectedRevision:0});
 await f.api(`/api/sessions/${f.session.id}/messages`,'POST',{text:'本轮请只检查，不使用或积累记忆。',ignoreProjectMemory:true},202);await f.wait(['completed']);await f.app.memory.wait();
 assert.ok(f.requests.every(request=>!JSON.stringify(request.messages).includes('MANUAL_PRIVATE_MEMORY')));assert.equal(f.app.store.list('memoryJobs').length,0);
 const other=await f.api('/api/projects','POST',{name:'different-project'});
 await f.api(`/api/memory/scopes/${scope.key}?projectId=${other.id}`,'GET',undefined,404);
 await f.restart();assert.equal(f.app.memory.view(f.app.memory.scope('project',f.project.id)).items[0].body,'MANUAL_PRIVATE_MEMORY');
});

test('native background extraction failure cannot be reported as a published success or retried at restart',async t=>{
 const f=await fixture(t,'memory-native-error'),scope=f.app.memory.scope('project',f.project.id);
 f.app.memory.setSettings(scope,{useEnabled:true,extractionEnabled:true,expectedRevision:0});
 await f.api(`/api/sessions/${f.session.id}/messages`,'POST',{text:'以后请先给结论再给依据。'},202);await f.wait(['completed']);await f.app.memory.wait();
 const view=f.app.memory.view(scope);assert.equal(view.items.length,0);assert.equal(view.jobs[0].state,'failed');assert.equal(view.jobs[0].nativeExtraction,undefined);
 assert.ok(view.jobs[0].modelAttempts>=2);assert.equal(view.jobs[0].unknownUsage,true);
 const calls=f.calls;await f.restart();assert.equal(f.calls,calls);assert.equal(f.app.memory.view(f.app.memory.scope('project',f.project.id)).jobs[0].state,'failed');
});

test('Pilot stop endpoint cancels a real SDK Worker awaiting approval after its Router reply has ended',async t=>{
 const f=await fixture(t,'super-write'),project=await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{});
 await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'检查项目并准备写入一个结果文件。'},202);
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers.length===1&&s.channels[0]?.needsConfirmation);
 const worker=state.workers[0],pending=(await f.api(`/api/sessions/${worker.sessionId}/ai`)).pending;
 await until(()=>f.api(`/api/sessions/${project.routerSessionId}/ai`),v=>v.status==='completed');
 const stopped=await f.api(`/api/projects/${f.project.id}/superagent/stop`,'POST',{routerSessionId:project.routerSessionId});assert.equal(stopped.tasks,1);
 await f.api(`/api/sessions/${worker.sessionId}/ai/decision`,'POST',{id:pending.id,accept:true},409);
 await assert.rejects(access(join(f.home,'workspaces',f.project.id,'approved.txt')));
 assert.equal((await f.api(`/api/projects/${f.project.id}/superagent`)).workers[0].assignmentState,'stopped');
});

test('native Worker executes scoped MySQL metadata and table count with actual protocol receipts',async t=>{
 const {mysqlServer}=require('./mysql-fixture.cjs');
 const wire=await mysqlServer(t,(connection,sql)=>{
  if(sql.startsWith('SHOW CREATE'))connection.writeTextResult([{Table:'sample',DDL:'CREATE TABLE `sample` (`id` int)'}],[{name:'Table'},{name:'DDL'}]);
  else if(sql.includes('COUNT(*)'))connection.writeTextResult([{row_count:'42'}],[{name:'row_count'}]);
  else connection.writeTextResult([{name:'fixture_database'}],[{name:'name'}]);
 });
 const f=await fixture(t,'super-mysql-read');
 const asset=await f.api(`/api/projects/${f.project.id}/resources`,'POST',{name:'fixture MySQL',kind:'database',settings:{driver:'mysql',host:'127.0.0.1',port:wire.port,username:'fixture',password:'private-fixture-mysql',tls:false,sslmode:'disable',database:''}});
 assert.doesNotMatch(JSON.stringify(asset),/private-fixture-mysql/);
 const project=await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{});
 await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`,'POST',{silentReadSQL:true,maxSteps:30});
 await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'读取 fixture MySQL 的表结构和行数，不修改数据库。'},202);
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 const operations=f.app.store.list('superOperations').filter(o=>o.goalId===state.workers[0].task.taskId);
 for(const name of ['list_db_objects','db_table_ddl','read_db_table'])assert.ok(operations.some(o=>o.tool===name&&o.status==='succeeded'&&o.databaseConfigurationHash));
 assert.ok(wire.queries.includes('START TRANSACTION READ ONLY')&&wire.queries.filter(sql=>sql==='ROLLBACK').length===3);
 assert.doesNotMatch(JSON.stringify(f.requests)+JSON.stringify(operations),/private-fixture-mysql/);
 assert.equal(state.workers[0].task.acceptanceState,'pass');
 const receipt=operations.find(o=>o.tool==='read_db_table');
 assert.doesNotThrow(()=>f.app.superagent.ledger.revalidate(receipt));
 await writeFile(join(f.home,'secrets',asset.settings.credentialRef),JSON.stringify({password:'rotated-private-fixture-mysql'}),{mode:0o600});
 assert.throws(()=>f.app.superagent.ledger.revalidate(receipt),/MySQL|数据库/);
});

test('changing saved MySQL credentials invalidates an already displayed Worker approval before any database I/O',async t=>{
 const {mysqlServer}=require('./mysql-fixture.cjs'),wire=await mysqlServer(t),f=await fixture(t,'super-mysql-read');
 const asset=await f.api(`/api/projects/${f.project.id}/resources`,'POST',{name:'fixture MySQL',kind:'database',settings:{driver:'mysql',host:'127.0.0.1',port:wire.port,username:'fixture',password:'original-private-mysql',tls:false}});
 const project=await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{});
 await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`,'POST',{silentReadSQL:false,maxSteps:30});
 await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'读取 fixture MySQL 元数据。'},202);
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.channels[0]?.needsConfirmation),worker=state.workers[0];
 const pending=(await f.api(`/api/sessions/${worker.sessionId}/ai`)).pending;
 await f.api(`/api/resources/${asset.id}`,'PATCH',{settings:{password:'updated-private-mysql'}});
 await f.api(`/api/sessions/${worker.sessionId}/ai/decision`,'POST',{id:pending.id,accept:true});
 const after=await until(()=>f.api(`/api/sessions/${worker.sessionId}/ai`),s=>s.cards.some(card=>card.id==='list_db_objects'&&card.status==='failed'));
 assert.match(after.cards.find(card=>card.id==='list_db_objects').content,/配置或凭据版本已变化/);
 await f.api(`/api/projects/${f.project.id}/superagent/stop`,'POST',{routerSessionId:project.routerSessionId});
 assert.equal(wire.queries.length,0);
 assert.equal(f.app.store.list('superOperations').filter(o=>o.goalId===worker.task.taskId&&o.tool==='list_db_objects'&&o.status==='succeeded').length,0);
 assert.doesNotMatch(JSON.stringify(f.requests),/original-private-mysql|updated-private-mysql/);
});

async function fullAgentTask(t,mode){
 const f=await fixture(t,mode),project=await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{});
 await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`,'POST',{silentCommands:true,maxSteps:30});
 return {f,project,send:()=>f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'请自主执行本次测试检查并核对实际结果。'},202)};
}
test('Pilot directly executes native Bash with its own canonical task and no specialist role', {skip:process.platform!=='darwin'},async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-shell');await send();
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 assert.equal(state.channels.length,0);assert.equal(state.workers[0].roleName,'Pilot');
 const operation=f.app.store.list('superOperations').find(o=>o.tool==='Bash');assert.equal(operation.status,'succeeded');assert.match(operation.output.stdout,/ACTUAL_NATIVE_SHELL/);assert.ok(operation.commandExecutionId);
 assert.equal(state.workers[0].task.acceptanceState,'pass');assert.ok(f.requests[0].tools.some(tool=>tool.function.name==='Bash'));
});
test('native Bash background work is joined before Pilot task acceptance',{skip:process.platform!=='darwin'},async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-background');await send();
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 const op=f.app.store.list('superOperations').find(o=>o.tool==='Bash');assert.equal(op.status,'succeeded');assert.equal(op.output.status,'completed');assert.match(op.output.stdout.text,/ACTUAL_BACKGROUND_SHELL/);
 assert.ok(f.requests.some(request=>request.messages.some(message=>message.tool_calls?.some(call=>call.function.name==='TaskOutput'))));assert.equal(state.workers[0].task.acceptanceState,'pass');
});
test('Pilot can create a native general-purpose subagent with the same Bash execution capability',{skip:process.platform!=='darwin'},async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-child');await send();
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 const operation=f.app.store.list('superOperations').find(o=>o.tool==='Bash');assert.equal(operation.status,'succeeded');assert.ok(operation.agentRunId&&operation.childSessionId);assert.match(operation.output.stdout,/CHILD_NATIVE_SHELL/);
 assert.equal(state.workers[0].task.acceptanceState,'pass');
});
test('local Bash cannot read private Lake data even through a valid read command',{skip:process.platform!=='darwin'},async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-protected');await require('node:fs/promises').mkdir(join(f.home,'secrets'),{recursive:true,mode:0o700});await writeFile(join(f.home,'secrets/hidden-fixture.txt'),'NEVER_MODEL_PRIVATE_SENTINEL',{mode:0o600});await send();
 await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.assignmentState==='parked');
 const op=f.app.store.list('superOperations').find(o=>o.tool==='Bash');assert.equal(op.status,'failed');assert.doesNotMatch(JSON.stringify(f.requests)+JSON.stringify(op),/NEVER_MODEL_PRIVATE_SENTINEL/);
});
test('a Worker uses saved SSH credentials for general Bash commands beyond fixed diagnostics',{skip:process.platform!=='darwin'},async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-worker-ssh'),server=await sshFixture(t),resource=await sshResource(f,server);
 await send();
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers.length===1),worker=state.workers[0];
 const trust=await until(()=>f.api(`/api/sessions/${worker.sessionId}/snapshot`),s=>!!s.hostKeyTrust);
 assert.equal(server.auths,0);await f.api(`/api/sessions/${worker.sessionId}/host-key`,'POST',{id:trust.hostKeyTrust.id,accept:true,fingerprint:trust.hostKeyTrust.fingerprint});
 const done=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 const operation=f.app.store.list('superOperations').find(o=>o.tool==='Bash');assert.equal(operation.resourceId,resource.id);assert.match(operation.output.stdout,/ACTUAL_NATIVE_SHELL/);assert.equal(done.workers[0].task.acceptanceState,'pass');assert.ok(server.requests.some(request=>request.command.includes('ACTUAL_NATIVE_SHELL')&&!request.pty));
 assert.doesNotMatch(JSON.stringify(f.requests)+JSON.stringify(operation),new RegExp(server.password));
});

test('native AskUserQuestion uses Lake answers and resumes the exact Pilot task',async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-question');await send();
 const view=await until(()=>f.api(`/api/sessions/${project.routerSessionId}/ai`),v=>!!v.question);
 const task=(await f.api(`/api/projects/${f.project.id}/superagent`)).workers[0].task;
 await f.api(`/api/sessions/${project.routerSessionId}/ai/answer`,'POST',{id:view.question.id,answers:{q0:['A']}});
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 assert.equal(state.workers[0].task.taskId,task.taskId);assert.ok(f.requests.some(request=>JSON.stringify(request.messages).includes('选择测试范围')));
});
test('native planning blocks mutations until its actual approval without granting new permissions',{skip:process.platform!=='darwin'},async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-plan');await send();
 const view=await until(()=>f.api(`/api/sessions/${project.routerSessionId}/ai`),v=>v.pending?.call.name==='ExitPlanMode');
 assert.equal(f.app.store.list('commandExecutions').length,0);
 await f.api(`/api/sessions/${project.routerSessionId}/ai/decision`,'POST',{id:view.pending.id,accept:true});
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 assert.equal(f.app.store.require('agentPlans',state.workers[0].task.taskId).approved,true);
 assert.equal(f.app.store.list('commandExecutions').length,1);
});
test('exact Pilot task snapshots preserve independent historical evidence across direct tasks',{skip:process.platform!=='darwin'},async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-shell');await send();
 let state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');const first=state.workers[0];
 await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'请执行另一个新的测试检查。'},202);
 state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers.length===2&&s.workers.every(w=>w.task.state==='completed'));
 const snapshot=await f.api(`/api/sessions/${project.routerSessionId}/snapshot?taskId=${first.task.taskId}`);
 assert.equal(snapshot.superagent.task.taskId,first.task.taskId);
 assert.ok(snapshot.ai.cards.some(card=>card.title==='Bash'));
 assert.ok(snapshot.ai.cards.filter(card=>card.data?.operation_id).every(card=>card.data.taskId===first.task.taskId));
 const other=await f.api('/api/projects','POST',{name:'other project'}),session=await f.api(`/api/projects/${other.id}/sessions`,'POST',{});
 await f.api(`/api/sessions/${session.id}/snapshot?taskId=${first.task.taskId}`,'GET',undefined,404);
});

test('dangerous native Bash still asks despite ordinary command auto-approval',async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-danger');await send();
 const view=await until(()=>f.api(`/api/sessions/${project.routerSessionId}/ai`),v=>v.pending?.call.name==='Bash');
 assert.equal(f.app.store.list('commandExecutions').length,0);
 await f.api(`/api/sessions/${project.routerSessionId}/ai/decision`,'POST',{id:view.pending.id,accept:false});
 await until(()=>f.api(`/api/sessions/${project.routerSessionId}/ai`),v=>!v.running);
 assert.equal(f.app.store.list('commandExecutions').length,0);
 assert.ok(f.app.store.list('superGoals').every(goal=>goal.acceptanceState!=='pass'));
});
test('native mode refresh retains the private-data sandbox after plan approval',{skip:process.platform!=='darwin'},async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-plan-protected');
 await require('node:fs/promises').mkdir(join(f.home,'secrets'),{recursive:true});await writeFile(join(f.home,'secrets/hidden-fixture.txt'),'PRIVATE_AFTER_MODE_SWITCH');await send();
 const view=await until(()=>f.api(`/api/sessions/${project.routerSessionId}/ai`),v=>v.pending?.call.name==='ExitPlanMode');
 await f.api(`/api/sessions/${project.routerSessionId}/ai/decision`,'POST',{id:view.pending.id,accept:true});
 await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.assignmentState==='parked');
 const op=f.app.store.list('superOperations').find(o=>o.tool==='Bash');assert.equal(op.status,'failed');assert.doesNotMatch(JSON.stringify(f.requests)+JSON.stringify(op),/PRIVATE_AFTER_MODE_SWITCH/);
});
test('native file tools use the project workspace and task Todo state stays independent',async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-files'),workspace=await f.app.store.workspace(f.project.id);
 await writeFile(join(f.home,'full-workspace.txt'),workspace);await writeFile(join(workspace,'sample.txt'),'ACTUAL_FILE_CONTENT');
 await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`,'POST',{silentWriteFiles:true,maxSteps:30});await send();
 await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 assert.equal(await readFile(join(workspace,'sample.txt'),'utf8'),'ACTUAL_EDITED_CONTENT');assert.equal(await readFile(join(workspace,'written.txt'),'utf8'),'ACTUAL_WRITTEN_CONTENT');
 const ops=f.app.store.list('superOperations');for(const tool of ['FindFiles','SearchText','Read','Write','Edit'])assert.equal(ops.find(o=>o.tool===tool)?.status,'succeeded',tool+JSON.stringify(f.app.store.view(project.routerSessionId).cards.map(c=>({title:c.title,content:c.content}))));
 assert.equal(ops.some(o=>o.tool==='TodoWrite'),false);assert.equal(f.app.store.list('agentTodos').length,1);
 await writeFile(join(workspace,'sample.txt'),'ACTUAL_FILE_CONTENT');await send();
 await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers.length===2&&s.workers.every(w=>w.task.state==='completed'));
 assert.equal(f.app.store.list('agentTodos').length,2);
 const reads=f.requests.flatMap(r=>r.messages.filter(m=>m.role==='tool'&&m.tool_call_id.endsWith('-TodoRead')));assert.ok(reads.length);assert.ok(reads.every(m=>JSON.parse(m.content).todos.length===0));
});
test('native Skill loads the actual current project skill rather than a parallel registry',{skip:process.platform!=='darwin'},async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-skill');
 await f.api('/api/settings/skills/fixture-skill','PUT',{create:true,content:'---\nname: fixture-skill\ndescription: Check actual project evidence\n---\nSKILL_REAL_MANAGED_CONTENT'});await send();
 await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 assert.ok(f.requests.some(r=>JSON.stringify(r.messages).includes('SKILL_REAL_MANAGED_CONTENT')));
 assert.equal(f.app.store.list('superOperations').find(o=>o.tool==='load_skill')?.status,'succeeded');
});
test('native Read projects real image bytes for an image-capable model',async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-image'),workspace=await f.app.store.workspace(f.project.id);
 await writeFile(join(f.home,'full-workspace.txt'),workspace);await writeFile(join(workspace,'sample.png'),await readFile(join(__dirname,'../../third_party/agent-sdk/public/logo/icons/16x16.png')));
 const selected={provider:f.app.store.list('providers')[0]};await f.api('/api/settings/model','PUT',{url:selected.provider.baseURL,name:'fixture',supportsImageInput:true});await send();
 await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 assert.equal(f.app.store.list('superOperations').find(o=>o.tool==='Read')?.output.type,'image',JSON.stringify(f.app.store.view(project.routerSessionId).cards));assert.ok(f.requests.some(r=>JSON.stringify(r.messages).includes('data:image/png;base64,')));
});
test('continuing a direct Pilot task preserves its goal, deadline and cumulative rounds',{skip:process.platform!=='darwin'},async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-followup');await send();
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.assignmentState==='parked'),original=f.app.store.require('superGoals',state.workers[0].task.taskId);
 assert.ok(original.modelRounds>=2);await send();
 const done=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 const goal=f.app.store.require('superGoals',original.id);assert.equal(done.workers.length,1);assert.equal(goal.deadlineAt,original.deadlineAt);assert.equal(goal.roundLimit,original.roundLimit);assert.ok(goal.modelRounds>original.modelRounds);
});
test('stopping a native mutating command preserves unknown effects and cancels the actual process',{skip:process.platform!=='darwin'},async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-stop');await send();
 await until(async()=>f.app.store.list('commandExecutions'),rows=>rows.some(r=>r.status==='running'));
 await f.api(`/api/projects/${f.project.id}/superagent/stop`,'POST',{routerSessionId:project.routerSessionId});
 await until(()=>f.api(`/api/sessions/${project.routerSessionId}/ai`),s=>!s.running);
 const op=f.app.store.list('superOperations').find(o=>o.tool==='Bash');assert.equal(op.status,'unknown');assert.equal(f.app.store.list('commandExecutions')[0].status,'cancelled');assert.notEqual(f.app.store.require('superGoals',op.goalId).acceptanceState,'pass');
});
test('capability inventory distinguishes connected tools from optional services and unsupported native search',async t=>{
 const f=await fixture(t),catalog=await f.api('/api/agent-capabilities');
 for(const name of ['Bash','Read','Glob','Grep','TodoWrite','AskUserQuestion','EnterPlanMode','Agent'])assert.equal(catalog.tools.find(t=>t.name===name)?.status,'connected',name);
 assert.equal(catalog.tools.find(t=>t.name==='WebSearch')?.status,'model_dependent');assert.ok(catalog.tools.some(t=>t.status==='requires_host_service'));
 const selected={provider:f.app.store.list('providers')[0]};await f.api('/api/settings/model','PUT',{url:selected.provider.baseURL,name:'fixture',supportsNativeWebSearch:true});
 assert.equal((await f.api('/api/agent-capabilities')).tools.find(t=>t.name==='WebSearch')?.status,'model_dependent','the pinned provider encoder only supports Anthropic native search');
});

test('a changed SSH resource invalidates an approved general command before authentication',async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-worker-ssh'),server=await sshFixture(t),resource=await sshResource(f,server);
 await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`,'POST',{silentCommands:false,maxSteps:30});await send();
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.channels[0]?.needsConfirmation),sessionId=state.workers[0].sessionId,pending=(await f.api(`/api/sessions/${sessionId}/ai`)).pending;
 assert.equal(pending.call.name,'Bash');await f.api(`/api/resources/${resource.id}`,'PATCH',{ssh:{shell:'sh'}});
 await f.api(`/api/sessions/${sessionId}/ai/decision`,'POST',{id:pending.id,accept:true});
 await until(()=>f.api(`/api/sessions/${sessionId}/ai`),s=>!s.running);
 assert.equal(server.auths,0);assert.equal(server.requests.length,0);assert.equal(f.app.store.list('commandExecutions').length,0);
 assert.notEqual(f.app.store.list('superGoals')[0].acceptanceState,'pass');
});
test('SSH background Bash joins its actual remote exit result',{skip:process.platform!=='darwin'},async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-worker-ssh-background'),server=await sshFixture(t);await sshResource(f,server);await send();
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers.length===1),sessionId=state.workers[0].sessionId;
 const trust=await until(()=>f.api(`/api/sessions/${sessionId}/snapshot`),s=>!!s.hostKeyTrust);await f.api(`/api/sessions/${sessionId}/host-key`,'POST',{id:trust.hostKeyTrust.id,accept:true,fingerprint:trust.hostKeyTrust.fingerprint});
 await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 const operation=f.app.store.list('superOperations').find(o=>o.tool==='Bash');assert.equal(operation.status,'succeeded');assert.match(operation.output.stdout.text,/ACTUAL_BACKGROUND_SHELL/);assert.equal(f.app.store.list('commandExecutions')[0].status,'completed');
});

test('a mutating command with a nonzero exit retains its possible partial effects as unknown',{skip:process.platform!=='darwin'},async t=>{
 const {f,project,send}=await fullAgentTask(t,'super-full-pilot-nonzero');await send();
 await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.assignmentState==='parked');
 const operation=f.app.store.list('superOperations').find(o=>o.tool==='Bash');
 assert.equal(operation.status,'unknown');assert.equal(operation.output.exitCode,1);
 assert.equal(f.app.store.list('commandExecutions').length,1);assert.notEqual(f.app.store.require('superGoals',operation.goalId).acceptanceState,'pass');
});

for(const remote of [false,true])test(`native Bash foreground timeout promotes ${remote?'SSH':'local'} execution without killing or redispatching`,{skip:process.platform!=='darwin'},async t=>{
 const {f,project,send}=await fullAgentTask(t,remote?'super-full-worker-ssh-background-auto':'super-full-pilot-background-auto');
 const wire=remote?await sshFixture(t):undefined;if(wire)await sshResource(f,wire);await send();
 if(remote){const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers.length===1),session=state.workers[0].sessionId;const trust=await until(()=>f.api(`/api/sessions/${session}/snapshot`),s=>!!s.hostKeyTrust);await f.api(`/api/sessions/${session}/host-key`,'POST',{id:trust.hostKeyTrust.id,accept:true,fingerprint:trust.hostKeyTrust.fingerprint});}
 await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 const op=f.app.store.list('superOperations').find(o=>o.tool==='Bash');assert.equal(op.status,'succeeded');assert.match(op.output.stdout.text,/ACTUAL_BACKGROUND_SHELL/);assert.equal(f.app.store.list('commandExecutions').length,1);
 if(wire)assert.equal(wire.requests.length,1);
});

async function lookupCommandTask(t,automatic,mode='super-full-worker-ssh-lookup'){
 const f=await fixture(t,mode),project=await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{}),wire=await sshFixture(t),fs=require('node:fs/promises');
 await fs.mkdir(join(wire.home,'bin'),{mode:0o700});
 await writeFile(join(wire.home,'bin/kubectl'),'#!/bin/sh\nif [ "$1" = "-n" ]; then shift 2; fi\nif [ "$1" = "exec" ]; then shift 2; [ "$1" = "--" ] && shift; exec "$@"; fi\ncase "$*" in\n "config current-context") printf "FIXTURE_CONTEXT\\n";;\n "get pods -A -o wide") printf "FIXTURE_POD_READY\\n";;\n *) exit 64;;\nesac\n',{mode:0o700});
 await writeFile(join(wire.home,'bin/docker'),'#!/bin/sh\n[ "$1" = "exec" ] || exit 64\nshift 2\nexec "$@"\n',{mode:0o700});
 await writeFile(join(wire.home,'bin/mysql'),'#!/bin/sh\nprintf "ACTUAL_CONTAINER_QUERY_42\\n"\n',{mode:0o700});
 await sshResource(f,wire);await f.api(`/api/sessions/${project.routerSessionId}/ai/configure`,'POST',{...(automatic===undefined?{}:{silentCommands:automatic}),maxSteps:30});
 await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'检查实际执行和当前权限。'},202);
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers.length===1);
 return {f,project,wire,worker:state.workers[0]};
}

test('a specialist inherits Pilot command auto-approval for actual SSH program discovery',async t=>{
 const {f,project,wire,worker}=await lookupCommandTask(t,true),session=worker.sessionId;
 const snapshot=await until(()=>f.api(`/api/sessions/${session}/snapshot`),s=>!!s.hostKeyTrust||s.ai?.pending?.call.name==='Bash');
 assert.ok(snapshot.hostKeyTrust,'lookup must reach host trust rather than an unnecessary Bash confirmation');
 assert.equal(snapshot.ai?.pending,undefined);assert.equal(wire.auths,0);
 await f.api(`/api/sessions/${session}/host-key`,'POST',{id:snapshot.hostKeyTrust.id,accept:true,fingerprint:snapshot.hostKeyTrust.fingerprint});
 await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 const op=f.app.store.list('superOperations').find(o=>o.tool==='Bash');assert.equal(op.status,'succeeded');assert.match(op.output.stdout,/FIXTURE_CONTEXT/);assert.match(op.output.stdout,/FIXTURE_POD_READY/);assert.equal(wire.requests.length,1);assert.equal(op.readOnly,false,'CLI discovery is not an unrestricted readonly proof');
});

test('a missing optional program cannot lock the next ordinary SSH command or accept stale failure evidence',async t=>{
 const {f,wire,worker}=await lookupCommandTask(t,true,'super-full-worker-ssh-missing-discovery'),session=worker.sessionId;
 const snapshot=await until(()=>f.api(`/api/sessions/${session}/snapshot`),s=>!!s.hostKeyTrust);
 await f.api(`/api/sessions/${session}/host-key`,'POST',{id:snapshot.hostKeyTrust.id,accept:true,fingerprint:snapshot.hostKeyTrust.fingerprint});
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 const ops=f.app.store.list('superOperations').filter(o=>o.tool==='Bash').sort((a,b)=>a.at.localeCompare(b.at));
 assert.equal(ops.length,2);assert.equal(ops[0].status,'failed');assert.equal(ops[0].readOnly,true);assert.equal(ops[0].output.exitCode,1);
 assert.equal(ops[1].status,'succeeded');assert.equal(ops[1].readOnly,false);assert.match(ops[1].output.stdout,/FIXTURE_CONTEXT/);
 assert.equal(wire.requests.length,2);assert.equal(state.workers[0].task.acceptanceState,'pass');
 const receipts=f.app.store.list('superAcceptance');assert.ok(receipts.every(r=>!r.evidenceIds?.includes(ops[0].id)));
});

test('startup verifies an exact legacy discovery from the real SDK archive without changing its original rows or dispatching again',async t=>{
 const {f,wire,worker}=await lookupCommandTask(t,true,'super-full-worker-ssh-missing-discovery-only'),session=worker.sessionId;
 const snapshot=await until(()=>f.api(`/api/sessions/${session}/snapshot`),s=>!!s.hostKeyTrust);
 await f.api(`/api/sessions/${session}/host-key`,'POST',{id:snapshot.hostKeyTrust.id,accept:true,fingerprint:snapshot.hostKeyTrust.fingerprint});
 await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.assignmentState==='parked');
 const crypto=require('node:crypto'),canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v)??'null',digest=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex');
 const op=f.app.store.list('superOperations').find(o=>o.tool==='Bash'),execution=f.app.store.require('commandExecutions',op.commandExecutionId);
 // Seed the exact legacy host representation; the input/result source remains
 // the actual SDK/SSH fixture call, not a model-supplied reconciliation claim.
 op.status='unknown';op.readOnly=false;execution.readOnly=false;execution.commandHash=digest('hostname; command -v lake_fixture_absent_program');
 f.app.store.put('superOperations',op.id,op);f.app.store.put('commandExecutions',execution.id,execution);
 const before=['superOperations','commandExecutions','superGoals','superAttempts','superAcceptance'].map(kind=>f.app.store.list(kind));
 const calls=f.calls;await f.restart();
 assert.equal(wire.requests.length,1);assert.equal(f.calls,calls);
 assert.deepEqual(['superOperations','commandExecutions','superGoals','superAttempts','superAcceptance'].map(kind=>f.app.store.list(kind)),before);
 const receipt=f.app.store.require('commandReadReconciliations',op.id);assert.equal(receipt.effects,'none');assert.equal(receipt.operationHash,digest(op));assert.ok(receipt.sourcePartId);assert.ok(receipt.sourceMessageId);
 await f.restart();assert.equal(f.app.store.list('commandReadReconciliations').length,1);assert.equal(wire.requests.length,1);
});

test('stopping an actual SDK SSH read reports stopped after settlement and projects cancelled command cards without rewriting evidence',async t=>{
 const {f,wire,worker}=await lookupCommandTask(t,true,'super-full-worker-ssh-read-stop'),session=worker.sessionId;
 const snapshot=await until(()=>f.api(`/api/sessions/${session}/snapshot`),s=>!!s.hostKeyTrust);
 await f.api(`/api/sessions/${session}/host-key`,'POST',{id:snapshot.hostKeyTrust.id,accept:true,fingerprint:snapshot.hostKeyTrust.fingerprint});
 await until(async()=>({executions:f.app.store.list('commandExecutions'),requests:wire.requests.length}),v=>v.requests===1&&v.executions.some(e=>e.status==='running'));
 const goal=f.app.store.require('superGoals',worker.task.taskId);
 await f.api(`/api/sessions/${session}/ai/workControl`,'POST',{goalId:goal.id,command:'cancel',revision:goal.revision});
 const final=f.app.store.require('superGoals',goal.id),op=f.app.store.list('superOperations').find(o=>o.goalId===goal.id&&o.tool==='Bash');
 assert.equal(final.status,'cancelled');assert.equal(op.status,'failed');assert.equal(op.readOnly,true);assert.equal(op.output.status,'cancelled');
 const raw=JSON.stringify(op),view=await f.api(`/api/sessions/${session}/snapshot`),card=view.ai.cards.find(c=>c.title==='Bash');
 assert.equal(card.status,'cancelled');assert.equal(card.data.operation_status,'failed');assert.equal(JSON.stringify(f.app.store.require('superOperations',op.id)),raw);
 const state=await f.api(`/api/projects/${f.project.id}/superagent`),router=state.project.routerSessionId;
 const reports=f.app.store.messages(router).filter(m=>m.author?.taskId===goal.id);assert.equal(reports.length,1);assert.equal(reports[0].text,'已停止这次工作。');
 const channel=state.channels[0],page=await f.api(`/api/sessions/${channel.sessionId}/channel`);
 assert.equal(page.entries.filter(e=>e.message?.author?.taskId===goal.id).length,1);assert.ok(!JSON.stringify(page).includes('有一项操作的结果还需核实'));
 // Reproduce an old outbox's premature host notice. Only read projections may
 // correct it; the old message and original operation remain byte-identical.
 for(const target of [router,channel.sessionId]){
  const saved=f.app.store.messages(target).find(m=>m.author?.taskId===goal.id);saved.text='有一项操作的结果还需核实，暂时不能重复该操作。';f.app.store.put('messages',saved.id,saved);
 }
 const history=f.app.store.messages(channel.sessionId).find(m=>m.author?.taskId===goal.id),historyBytes=JSON.stringify(history);
 assert.equal((await f.api(`/api/sessions/${channel.sessionId}/channel`)).entries.find(e=>e.message?.author?.taskId===goal.id).message.text,'已停止这次工作。');
 assert.equal((await f.api(`/api/sessions/${router}/snapshot`)).messages.find(m=>m.author?.taskId===goal.id).text,'已停止这次工作。');
 assert.equal(JSON.stringify(f.app.store.require('messages',history.id)),historyBytes);
 const calls=f.calls;await f.restart();assert.equal(f.calls,calls);assert.equal(wire.requests.length,1);
 assert.equal((await f.api(`/api/sessions/${session}/snapshot`)).ai.cards.find(c=>c.title==='Bash').status,'cancelled');
});

test('the same program discovery still asks when Pilot command auto-approval is off',async t=>{
 const {f,wire,worker}=await lookupCommandTask(t,false),session=worker.sessionId;
 const view=await until(()=>f.api(`/api/sessions/${session}/ai`),v=>v.pending?.call.name==='Bash');
 assert.equal(view.pending.risk,'medium');assert.equal(wire.auths,0);assert.equal(wire.requests.length,0);
 await f.api(`/api/sessions/${session}/ai/decision`,'POST',{id:view.pending.id,accept:false});
 await until(()=>f.api(`/api/sessions/${session}/ai`),v=>!v.running);assert.equal(wire.requests.length,0);
});

for(const variant of ['default','container-kube','container-docker'])test(`Pilot ordinary command permission is honored for ${variant}`,async t=>{
 const {f,project,wire,worker}=await lookupCommandTask(t,variant==='default'?undefined:true,'super-full-worker-ssh-'+(variant==='default'?'lookup':variant)),session=worker.sessionId;
 if(variant==='default')assert.equal(f.app.store.session(project.routerSessionId).options.silentCommands,undefined,'leave the stored option absent as in an untouched preferences popup');
 const snapshot=await until(()=>f.api(`/api/sessions/${session}/snapshot`),s=>!!s.hostKeyTrust||s.ai?.pending?.call.name==='Bash');
 assert.ok(snapshot.hostKeyTrust,'ordinary execution must not require a redundant command confirmation');
 await f.api(`/api/sessions/${session}/host-key`,'POST',{id:snapshot.hostKeyTrust.id,accept:true,fingerprint:snapshot.hostKeyTrust.fingerprint});
 await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed');
 const op=f.app.store.list('superOperations').find(o=>o.tool==='Bash');assert.equal(op.status,'succeeded');assert.equal(op.readOnly,false);
 if(variant!=='default')assert.match(op.output.stdout,/ACTUAL_CONTAINER_QUERY_42/);
 assert.equal(wire.requests.length,1);
});

test('specialist SDK progress settles into one canonical summary while the inspector retains every step',async t=>{
 const f=await fixture(t,'super-live-report'),project=await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{});
 await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'检查当前项目文件清单并给出总结。'},202);
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.task.state==='completed'&&s.workers[0].assignmentState==='parked');
 const worker=state.workers[0],channelPath=`/api/sessions/${state.channels[0].sessionId}/channel`;
 const source=await f.api(`/api/sessions/${worker.sessionId}/snapshot`),original=JSON.stringify(source.ai.cards);
 assert.ok(source.ai.cards.some(c=>c.content?.includes('正在核对当前工作区')));
 assert.ok(source.ai.cards.some(c=>c.content?.includes('已取得文件清单')));
 assert.equal(source.ai.cards.filter(c=>c.type==='operation'&&c.title==='list_project_files').length,2);
 const channel=await f.api(channelPath),replies=channel.entries.filter(e=>e.reply);
 assert.equal(replies.length,1);assert.equal(replies[0].reply.state,'settled');
 assert.equal(replies[0].message.text,worker.task.summary);
 assert.equal(replies[0].message.author.rootTurnId,source.ai.rootTurnId);
 assert.equal(replies[0].sourceSessionId,worker.sessionId);assert.equal(replies[0].taskId,worker.task.taskId);
 assert.ok(!channel.entries.some(e=>(e.card?.content??'').includes('正在核对当前工作区')));
 assert.equal(JSON.stringify((await f.api(`/api/sessions/${worker.sessionId}/snapshot`)).ai.cards),original);
 const calls=f.calls;
 await f.restart();
 const restored=await f.api(channelPath);
 assert.deepEqual(restored.entries.filter(e=>e.reply),replies);
 assert.equal(f.calls,calls,'reading restored summaries must never invoke a model or replay operations');
});

test('compacting a pre-metadata channel report preserves its exact sibling findings without rewriting history',async t=>{
 const f=await fixture(t,'super-incomplete-report'),project=await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{});
 await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'检查服务器并保留实际发现。'},202);
 const state=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers[0]?.assignmentState==='parked');
 const channelId=state.channels[0].sessionId,worker=state.workers[0];
 const saved=f.app.store.messages(channelId).find(m=>m.author?.taskId===worker.task.taskId);
 const legacy={...saved,text:'这次检查还没完成，已暂停。',author:{...saved.author}};
 delete legacy.author.rootTurnId;f.app.store.put('messages',legacy.id,legacy);
 const before=JSON.stringify(f.app.store.get('messages',legacy.id)),calls=f.calls;
 const page=await f.api(`/api/sessions/${channelId}/channel`);
 assert.equal(page.replyPresentation,'invocation');
 const replies=page.entries.filter(e=>e.reply);
 assert.equal(replies.length,1);assert.match(replies[0].message.text,/暂时查不到 CPU 和内存/);
 assert.equal(replies[0].message.id,saved.id);
 assert.equal(JSON.stringify(f.app.store.get('messages',legacy.id)),before);
 assert.equal(f.calls,calls);
});

test('a real SDK specialist receives prior task clues for a short follow-on request and recalls them before asking',async t=>{
 const f=await fixture(t,'super-context-recall'),project=await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{});
 await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'比较两端数据库，K2 入口是 192.0.2.75，实例 db/mysql141-0。'},202);
 const first=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers.length===1&&s.workers[0].assignmentState==='parked');
 const old=first.workers[0],oldGoal=f.app.superagent.ledger.get(old.task.taskId),receipts=JSON.stringify(f.app.store.list('superOperations').filter(op=>op.goalId===old.task.taskId));
 await f.api(`/api/sessions/${project.routerSessionId}/messages`,'POST',{text:'同步到k2'},202);
 const after=await until(()=>f.api(`/api/projects/${f.project.id}/superagent`),s=>s.workers.length===2&&s.workers.every(w=>w.assignmentState==='parked'));
 const current=after.workers.find(w=>w.id!==old.id);
 assert.notEqual(current.sessionId,old.sessionId);assert.notEqual(current.task.taskId,old.task.taskId);
 assert.match(current.task.summary,/找回 K2 入口 192\.0\.2\.75/);
 const snapshot=await f.api(`/api/sessions/${current.sessionId}/snapshot`);
 assert.ok(snapshot.ai.cards.some(c=>c.title==='recall_task_context'));
 assert.ok(!snapshot.ai.cards.some(c=>['ask_user_question','AskUserQuestion'].includes(c.title)));
 assert.notEqual(current.task.acceptanceState,'pass');assert.notEqual(current.task.state,'completed');
 assert.deepEqual(f.app.superagent.ledger.get(old.task.taskId),oldGoal);
 assert.equal(JSON.stringify(f.app.store.list('superOperations').filter(op=>op.goalId===old.task.taskId)),receipts);
 const workerRequests=f.requests.filter(isIndependentWorkerRequest).filter(r=>JSON.stringify(r.messages).includes('同步到k2'));
 assert.ok(workerRequests.some(r=>JSON.stringify(r.messages).includes('taskContext')&&JSON.stringify(r.messages).includes('db/mysql141-0')));
});
