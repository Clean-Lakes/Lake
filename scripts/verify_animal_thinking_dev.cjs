#!/usr/bin/env node
/* Installed Lake Dev, real Pilot/Worker flow, disposable data, local model only.
 *
 * node scripts/verify_animal_thinking_dev.cjs [new-metadata-file]
 * The script prints a private metadata path after eight specialists and two
 * held Workers (otter/owl) are ready. Read controlOrigin from that file:
 *   GET  /status
 *   POST /dispatch?animal=bee       start another Worker after releasing a slot
 *   POST /stream?animal=otter       send body text; leave the response open
 *   POST /complete?animal=otter     send work_finish and end the response
 *   POST /release-all              complete all dispatched Workers
 *   POST /finish                   complete Workers, then close this fixture
 * Each project runs at most two Workers. /dispatch returns 409 while both slots
 * are occupied; complete one Worker (or /release-all), wait, then retry dispatch.
 * No app is stopped by this script. The isolated native PID is in metadata;
 * quit that Lake Dev window when finished. Its private evidence directory stays.
 */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {spawn} = require('node:child_process');

const animals = [
  {id: 'otter', name: '水獭'}, {id: 'beaver', name: '河狸'},
  {id: 'owl', name: '猫头鹰'}, {id: 'fox', name: '狐狸'},
  {id: 'turtle', name: '乌龟'}, {id: 'bee', name: '蜜蜂'},
  {id: 'woodpecker', name: '啄木鸟'}, {id: 'pufferfish', name: '河豚'},
];
const initialAnimals = ['otter', 'owl'];
const setupText = '创建八位思考动画验收专员，头像分别使用 otter、beaver、owl、fox、turtle、bee、woodpecker、pufferfish；全部使用原生 Agent 和当前本地验证模型。只进行隔离界面验收，不连接业务资源。';
const modelKey = 'synthetic-animal-thinking-dev-key';
const slots = new Map(animals.map(animal => [animal.id, {
  ...animal, roleName: `${animal.name}动画验收专员`, roleId: null,
  channelId: null, channelSessionId: null, worker: null,
  dispatched: false, dispatching: false, requested: 'held',
  requests: 0, textSent: false, finishSent: false, responses: new Set(),
}]));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const content = message => typeof message?.content === 'string' ? message.content :
  (Array.isArray(message?.content) ? message.content.map(part => part.text ?? '').join('') : '');
const marker = animal => `[LAKE_ANIMAL_THINKING:${animal}]`;
const json = (res, status, value) => {
  res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(value));
};
const tool = (name, args, index = 0) => ({
  index, id: `animal-fixture-${name}-${index}`, type: 'function',
  function: {name, arguments: JSON.stringify(args)},
});
async function until(read, predicate, label, milliseconds = 45000) {
  for (const end = Date.now() + milliseconds; Date.now() < end;) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(150);
  }
  throw new Error(label); // Never include an API body or model input in errors.
}

let home, data, metadata, metadataHandle, origin, controlOrigin, nativePid;
let projectId, routerSessionId, buildOrigin, provider, api, refreshTimer;
let stage = 'initializing', ready = false, finishing = false, requestCount = 0;
let metadataWrites = Promise.resolve(), dispatchQueue = Promise.resolve();

function status() {
  return {
    ready, stage, home, data, origin, nativePid, projectId, routerSessionId,
    controlOrigin, buildOrigin, model: 'deterministic loopback fixture', requestCount,
    animals: [...slots.values()].map(slot => ({
      animal: slot.id, roleName: slot.roleName, roleId: slot.roleId,
      avatarId: slot.id, channelId: slot.channelId, channelSessionId: slot.channelSessionId,
      dispatched: slot.dispatched, dispatching: slot.dispatching,
      requested: slot.requested, modelRequests: slot.requests,
      openResponses: slot.responses.size, textSent: slot.textSent,
      finishSent: slot.finishSent, worker: slot.worker,
    })),
  };
}
function saveMetadata() {
  if (!metadataHandle) return Promise.resolve();
  const payload = JSON.stringify(status(), null, 2) + '\n';
  metadataWrites = metadataWrites.then(async () => {
    await metadataHandle.truncate(0);
    await metadataHandle.write(payload, 0, 'utf8');
    await metadataHandle.sync();
  });
  return metadataWrites;
}
function backgroundSave() {
  void saveMetadata().catch(() => {
    console.error('Fixture metadata update failed; no request contents were logged.');
  });
}
function chunk(res, delta, finish = null) {
  if (res.destroyed || res.writableEnded) return false;
  res.write('data: ' + JSON.stringify({
    id: 'animal-thinking-fixture', object: 'chat.completion.chunk', created: 1,
    model: 'animal-thinking-fixture', choices: [{index: 0, delta, finish_reason: finish}],
  }) + '\n\n');
  return true;
}
function startStream(res) {
  res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'});
  res.flushHeaders();
}
function finishStream(res, delta) {
  if (!chunk(res, {role: 'assistant', ...delta})) return;
  chunk(res, {}, delta.tool_calls ? 'tool_calls' : 'stop');
  res.end('data: [DONE]\n\n');
}
function release(slot) {
  for (const response of slot.responses) {
    if (slot.requested === 'stream' && !response.textSent) {
      // safeModel.streamText (runtime/typescript/agent.ts) retains at least the
      // last 79 characters until text_end/finish to redact split credentials.
      // Send 200+ synthetic characters so public prose reaches the real Worker
      // card while this model response remains open for transition inspection.
      response.textSent = chunk(response.res, {
        role: 'assistant', content: [
          `${marker(slot.id)} ${slot.name}的隔离动画验收正文已开始输出。`,
          '这是一段完全虚构的本地验收文字，用于观察思考气泡如何交接给正在生成的正文。当前页面应保留这位专员的名称和本次任务归属，正文出现后，边框上的小动物停止显示，另一位仍在思考的专员继续保持自己的动作。',
          '本段文字不表示执行过任何业务检查，也不包含服务器状态、凭据或真实用户资料。可以切换明暗主题、调整窗口宽度并查看正文排版，确认长句换行不会遮挡名称、任务入口或者其他专员的回复。',
          '当前模型响应仍然保持打开，便于检查正在输出时的界面状态。只有收到本地验收控制端的完成指令后，这次演示才会提交结束报告。视觉验收结论由检查者记录，此处不预先宣称功能通过。',
        ].join('\n\n'),
      });
      slot.textSent ||= response.textSent;
    }
    if (slot.requested === 'complete') {
      slot.finishSent ||= !response.res.destroyed && !response.res.writableEnded;
      finishStream(response.res, {tool_calls: [tool('work_finish', {
        summary: `${slot.name}的隔离动画演示已结束；未访问业务资源。视觉验收结果由检查者记录。`,
        outcome: 'completed',
      })]});
    }
  }
  backgroundSave();
}
function holdWorker(res, slot) {
  const response = {res, textSent: false};
  slot.requests++;
  slot.responses.add(response);
  // Comments keep the transport alive without creating any assistant content.
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': held for local visual inspection\n\n');
  }, 15000);
  res.once('close', () => {
    clearInterval(heartbeat);
    slot.responses.delete(response);
    backgroundSave();
  });
  release(slot);
}
function workerSlot(messages) {
  // The TS runtime supplies a structured assignment. Prefer its actual part to
  // the original user text or recalled history, which can mention other tasks.
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user') continue;
    try {
      const assignment = JSON.parse(content(message));
      if (typeof assignment.assignedDeliverable !== 'string') continue;
      const id = assignment.assignedDeliverable.match(/\[LAKE_ANIMAL_THINKING:([a-z]+)\]/)?.[1];
      const slot = slots.get(id);
      if (slot && assignment.assignment?.roleId === slot.roleId) return slot;
    } catch { /* Non-assignment user messages are expected. */ }
  }
  throw new Error('worker-assignment-unrecognized');
}
function routerDelta(messages) {
  const start = messages.findLastIndex(message => message.role === 'user' &&
    content(message).startsWith('[LAKE ADMITTED HUMAN EVENTS'));
  if (start < 0) return {content: '隔离验证状态已更新。'};
  const events = JSON.parse(content(messages[start]).split('\n')[1]);
  const calls = messages.slice(start + 1).flatMap(message => message.tool_calls ?? []);
  const called = new Set(calls.flatMap(call => {
    try { return [JSON.parse(call.function.arguments).event_id]; } catch { return []; }
  }));
  const pending = events.filter(event => !called.has(event.id));
  const outgoing = [];
  for (const event of pending) {
    if (event.text === setupText) {
      for (const slot of slots.values()) outgoing.push(tool('manage_specialist', {
        event_id: event.id, part_key: 'setup-' + slot.id, action: 'create',
        role_key: 'thinking-animation-' + slot.id, name: slot.roleName,
        duties: '仅参与本地隔离的思考动画界面验收，不连接业务资源。',
        avatar_id: slot.id, execution: {kind: 'native'}, quote: event.text,
      }, outgoing.length));
    } else {
      const id = event.text?.match(/\[LAKE_ANIMAL_THINKING:([a-z]+)\]/)?.[1];
      const slot = slots.get(id);
      if (!slot?.roleId) continue;
      outgoing.push(tool('route_work', {
        event_id: event.id, part_key: 'animation-' + slot.id, action: 'create',
        role_id: slot.roleId, title: `${slot.name} · 28px 思考动画验收 ${marker(slot.id)}`,
        quote: event.text, reason: '用户请求本地隔离的真实思考与正文切换演示',
      }, outgoing.length));
    }
  }
  return outgoing.length ? {tool_calls: outgoing} : {content: '隔离验证安排已记录。'};
}
async function modelRequest(req, res) {
  if (req.headers.authorization !== 'Bearer ' + modelKey) return json(res, 401, {error: 'unauthorized'});
  const chunks = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 8 * 1024 * 1024) return json(res, 413, {error: 'request too large'});
    chunks.push(part);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const tools = Array.isArray(request.tools) ? request.tools : [];
  requestCount++;
  const router = tools.some(tool => tool.function?.name === 'route_work');
  const worker = !router && tools.some(tool => tool.function?.name === 'work_finish');
  const slot = worker ? workerSlot(messages) : null;
  startStream(res);
  if (router) finishStream(res, routerDelta(messages));
  else if (worker) {
    const finished = messages.some(message => message.tool_calls?.some(call => call.function?.name === 'work_finish'));
    if (finished) finishStream(res, {content: '隔离演示已结束。'});
    else holdWorker(res, slot);
  } else finishStream(res, {content: '本地隔离动画验证。'});
}
async function refreshWorkspace() {
  const workspace = await api(`/api/projects/${projectId}/superagent`);
  for (const slot of slots.values()) {
    const channel = workspace.channels?.find(row => row.avatarId === slot.id && row.roleName === slot.roleName);
    if (channel) {
      slot.roleId = channel.roleId;
      slot.channelId = channel.id;
      slot.channelSessionId = channel.sessionId;
    }
    const worker = workspace.workers?.find(row => row.roleId === slot.roleId && row.task?.title?.includes(marker(slot.id)));
    if (worker) slot.worker = {
      id: worker.id, sessionId: worker.sessionId, taskId: worker.task.taskId,
      roleId: worker.roleId, state: worker.task.state, assignmentState: worker.assignmentState,
      activityPhase: worker.activity?.phase ?? null,
    };
  }
  return workspace;
}
async function dispatch(animal) {
  const slot = slots.get(animal);
  if (slot.dispatched) return;
  slot.dispatching = true;
  try {
    await api(`/api/sessions/${routerSessionId}/messages`, 'POST', {
      text: `请${slot.name}动画验收专员演示真实思考、首段正文与完成状态，只验证本地界面。${marker(slot.id)}`,
    });
    await until(async () => { await refreshWorkspace(); return slot; },
      value => !!value.worker && value.requests > 0, 'worker-start-timeout');
    slot.dispatched = true;
  } finally {
    slot.dispatching = false;
    await saveMetadata();
  }
}
async function completeAll() {
  for (const slot of slots.values()) if (slot.worker || slot.dispatching) {
    slot.requested = 'complete'; release(slot);
  }
  await saveMetadata();
}
async function finish() {
  finishing = true; stage = 'finishing';
  await dispatchQueue;
  await completeAll();
  await until(async () => { await refreshWorkspace(); return [...slots.values()]; },
    values => values.every(slot => !slot.worker || ['completed', 'failed', 'cancelled'].includes(slot.worker.state)),
    'worker-finish-timeout');
  clearInterval(refreshTimer);
  ready = false; stage = 'finished';
  await saveMetadata();
  await metadataHandle.close();
  metadataHandle = null;
  provider.close();
  provider.closeIdleConnections();
  console.log(JSON.stringify({finished: true, metadata, nativePid, note: 'Isolated Lake Dev remains open.'}));
}
async function handle(req, res) {
  const url = new URL(req.url, controlOrigin);
  // No CORS is granted. Reject browser-originated mutations from other sites.
  if (req.headers.origin && req.headers.origin !== controlOrigin) return json(res, 403, {error: 'origin denied'});
  if (req.headers.host !== new URL(controlOrigin).host) return json(res, 403, {error: 'host denied'});
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return modelRequest(req, res);
  if (url.pathname === '/status' && req.method === 'GET') return json(res, 200, status());
  if (req.method !== 'POST') return json(res, 405, {error: 'POST required'});
  if (!ready || finishing) return json(res, 409, {error: 'fixture not ready for controls'});
  if (url.pathname === '/finish') {
    json(res, 202, {finishing: true});
    void finish().catch(() => {
      finishing = false; stage = 'finish-failed';
      backgroundSave();
      console.error('Fixture completion timed out; use /status to inspect task states.');
    });
    return;
  }
  if (url.pathname === '/release-all') { await completeAll(); return json(res, 200, status()); }
  const slot = slots.get(url.searchParams.get('animal'));
  if (!slot) return json(res, 400, {error: 'unknown animal', animals: [...slots.keys()]});
  if (url.pathname === '/dispatch') {
    if (slot.dispatched || slot.dispatching) return json(res, 200, status());
    await refreshWorkspace();
    // Recheck after I/O: another control request may have reserved this animal.
    if (slot.dispatched || slot.dispatching) return json(res, 200, status());
    const occupied = [...slots.values()].filter(other => other.dispatching ||
      other.worker?.assignmentState === 'active' &&
      !['completed', 'failed', 'cancelled'].includes(other.worker.state));
    if (occupied.length >= 2) return json(res, 409, {
      error: 'release required',
      message: 'This project already has two active Workers. Complete one with /complete?animal=NAME (or /release-all), wait for it to finish, then retry /dispatch.',
      activeAnimals: occupied.map(other => other.id),
    });
    // Reserve before queueing, so duplicate control calls cannot create tasks.
    slot.dispatching = true;
    dispatchQueue = dispatchQueue.then(() => dispatch(slot.id)).catch(() => {
      stage = 'dispatch-failed'; backgroundSave();
      console.error('Fixture dispatch failed; use /status to inspect the exact worker IDs.');
    });
    return json(res, 202, {animal: slot.id, dispatching: true});
  }
  if (!['/stream', '/complete'].includes(url.pathname)) return json(res, 404, {error: 'unknown control'});
  if (!slot.worker && !slot.dispatching) return json(res, 409, {error: 'dispatch this animal first'});
  if (url.pathname === '/stream' && slot.requested === 'complete') return json(res, 409, {error: 'worker already released'});
  slot.requested = url.pathname === '/stream' ? 'stream' : 'complete';
  release(slot);
  await saveMetadata();
  json(res, 200, status());
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('macos-required');
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'lake-animal-thinking-dev-'));
  await fs.chmod(home, 0o700);
  data = path.join(home, 'web data');
  metadata = process.argv[2] ? path.resolve(process.argv[2]) : path.join(home, 'verification.json');
  // Refuse replacement or symlink following. Runtime token is never copied here.
  metadataHandle = await fs.open(metadata, 'wx', 0o600);
  await saveMetadata();
  const app = path.join(os.homedir(), 'Applications', 'Lake Dev.app');
  const build = JSON.parse(await fs.readFile(path.join(app, 'Contents/Resources/build-origin.json'), 'utf8'));
  buildOrigin = Object.fromEntries(['schemaVersion', 'gitHead', 'gitBranch', 'sourceRoot', 'version',
    'dirty', 'backendRuntime', 'backendSHA256', 'uiSourceSHA256'].filter(key => Object.hasOwn(build, key)).map(key => [key, build[key]]));
  provider = http.createServer((req, res) => void handle(req, res).catch(() => {
    if (!res.destroyed) {
      if (res.headersSent) res.end(); else json(res, 500, {error: 'local fixture failed'});
    }
    console.error('Local fixture request failed; request contents were not logged.');
  }));
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  controlOrigin = 'http://127.0.0.1:' + provider.address().port;
  stage = 'starting-isolated-dev';
  const log = await fs.open(path.join(home, 'native.log'), 'wx', 0o600);
  const env = {...process.env};
  for (const key of ['LAKE_HOME', 'LAKE_WEB_DATA_DIR', 'LAKE_WEB_TOKEN', 'LAKE_DEV_HOME', 'LAKE_DEV_WEB_DATA_DIR', 'LAKE_DEV_WEB_TOKEN']) delete env[key];
  const native = spawn(path.join(app, 'Contents/MacOS/Lake'), ['--lake-home', home, '--lake-data', data],
    {stdio: ['ignore', log.fd, log.fd], env});
  let nativeExited = false;
  native.once('error', () => { nativeExited = true; });
  native.once('exit', () => { nativeExited = true; });
  await log.close();
  nativePid = native.pid;
  native.unref();
  await saveMetadata();
  const runtime = await until(async () => {
    if (nativeExited) throw new Error('native-app-exited');
    try { return JSON.parse(await fs.readFile(path.join(data, 'runtime.json'), 'utf8')); } catch { return null; }
  }, value => value?.origin && typeof value.token === 'string', 'runtime-start-timeout', 60000);
  const runtimeURL = new URL(runtime.origin);
  if (runtimeURL.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(runtimeURL.hostname) ||
      runtimeURL.username || runtimeURL.password || runtimeURL.pathname !== '/' || runtimeURL.search || runtimeURL.hash) throw new Error('invalid-loopback-runtime');
  origin = runtimeURL.origin;
  api = async (route, method = 'GET', body) => {
    const response = await fetch(origin + route, {method, signal: AbortSignal.timeout(15000),
      headers: {Authorization: 'Bearer ' + runtime.token, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      body: body === undefined ? undefined : JSON.stringify(body)});
    if (!response.ok) throw new Error('lake-api-request-failed');
    return response.json();
  };
  stage = 'configuring-local-model';
  await api('/api/settings/model', 'PUT', {url: controlOrigin + '/v1/chat/completions', name: 'animal-thinking-fixture', apiKey: modelKey});
  const project = await api('/api/projects', 'POST', {name: '28px 动物思考动画 · 隔离验收'});
  projectId = project.id;
  const pilot = await api(`/api/projects/${projectId}/superagent`, 'POST', {});
  routerSessionId = pilot.routerSessionId;
  stage = 'creating-eight-specialists';
  await api(`/api/sessions/${routerSessionId}/messages`, 'POST', {text: setupText});
  await until(refreshWorkspace, () => [...slots.values()].every(slot => slot.roleId && slot.channelSessionId), 'specialist-setup-timeout');
  await until(() => api(`/api/sessions/${routerSessionId}/snapshot`), value => value.ai?.status === 'completed', 'pilot-setup-timeout');
  stage = 'starting-two-workers';
  for (const animal of initialAnimals) await dispatch(animal);
  ready = true; stage = 'ready';
  await saveMetadata();
  refreshTimer = setInterval(() => {
    void refreshWorkspace().then(saveMetadata).catch(() => {
      stage = 'runtime-unavailable'; backgroundSave();
    });
  }, 2000);
  console.log(JSON.stringify({ready: true, metadata, ...status()}));
}

main().catch(async () => {
  console.error(JSON.stringify({error: 'Isolated animation fixture initialization failed', stage, metadata, home, nativePid}));
  ready = false; stage = 'initialization-failed';
  await completeAll().catch(() => {});
  await metadataHandle?.close().catch(() => {});
  metadataHandle = null;
  provider?.close();
  provider?.closeAllConnections();
  process.exitCode = 1;
});
