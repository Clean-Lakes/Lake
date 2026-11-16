#!/usr/bin/env node
// Installed, signed Lake Dev + isolated Home + gated loopback model. Send the
// published texts in the real composer. For specialists POST /route after
// inspecting preparation; POST /first for a short chunk, then /complete.
'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), {spawn} = require('node:child_process');
const texts = {
  setup: '创建首包核对专员，使用水獭头像和 Lake 原生 Agent，只处理本地虚构文字。[RESPONSE_LATENCY:setup]',
  pilot: '验证 Pilot 即时响应，仅使用本地虚构文字。[RESPONSE_LATENCY:pilot]',
  specialist: '请首包核对专员核对本地虚构文字。[RESPONSE_LATENCY:specialist]',
};
const key = 'synthetic-response-latency-key';
const content = m => typeof m.content === 'string' ? m.content : (m.content ?? []).map(p => p.text ?? '').join('');
const tool = (name, args) => ({index: 0, id: 'latency-' + name, type: 'function', function: {name, arguments: JSON.stringify(args)}});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, check, label) { for (const end = Date.now() + 45000; Date.now() < end;) { const value = await read(); if (check(value)) return value; await sleep(50); } throw Error(label); }
let metadata, home, data, origin, controlOrigin, nativePid, projectId, routerSessionId, buildOrigin, api, roleId, timer, stopped = false, ready = false;
const requests = [], metrics = [];
const held = new Set(), routing = new Set();
let writes = Promise.resolve();
const status = () => ({ready, home, data, origin, controlOrigin, nativePid, projectId, routerSessionId, buildOrigin, texts, requests, metrics,
  routing: [...routing].map(entry => ({requestedAt: entry.requestedAt, releasedAt: entry.releasedAt})),
  held: [...held].map(entry => ({kind: entry.kind, firstAt: entry.firstAt, completedAt: entry.completedAt}))});
function save() {
  if (!metadata) return Promise.resolve();
  const json = JSON.stringify(status(), null, 2) + '\n';
  writes = writes.then(async () => { await fs.writeFile(metadata + '.next', json, {mode: 0o600}); await fs.rename(metadata + '.next', metadata); });
  return writes;
}
const chunk = (res, delta, finish = null) => {
  if (!res.destroyed && !res.writableEnded) res.write('data: ' + JSON.stringify({id: 'latency', object: 'chat.completion.chunk', created: 1,
    model: 'fixture', choices: [{index: 0, delta, finish_reason: finish}]}) + '\n\n');
};
function end(res, delta) { chunk(res, delta); chunk(res, {}, delta.tool_calls ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n'); }
const json = (res, status, body) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body)); };
async function model(req, res) {
  if (req.headers.authorization !== 'Bearer ' + key) return json(res, 401, {error: 'fixture credential rejected'});
  const parts = []; let bytes = 0;
  for await (const part of req) { bytes += part.length; if (bytes > 8 * 1024 * 1024) return json(res, 413, {}); parts.push(part); }
  const request = JSON.parse(Buffer.concat(parts).toString()), messages = request.messages ?? [], tools = request.tools ?? [];
  res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'});
  if (tools.some(t => t.function?.name === 'route_work')) {
    const source = messages.findLast(m => m.role === 'user' && content(m).startsWith('[LAKE ADMITTED HUMAN EVENTS'));
    const event = JSON.parse(content(source).split('\n')[1])[0], tag = event.text.match(/\[RESPONSE_LATENCY:(\w+)\]/)?.[1];
    const sourceIndex = messages.indexOf(source);
    if (messages.slice(sourceIndex + 1).some(m => m.role === 'tool')) {
      if (tag === 'specialist') {
        let release; const gate = new Promise(resolve => { release = resolve; });
        const entry = {release, requestedAt: Date.now(), releasedAt: undefined}; routing.add(entry); await save(); await gate;
      }
      end(res, {content: '已安排。'}); return;
    }
    if (tag === 'setup') { end(res, {tool_calls: [tool('manage_specialist', {event_id: event.id, quote: event.text, part_key: 'create', action: 'create',
      role_key: 'response-latency', name: '首包核对专员', duties: '仅核对本地虚构文字', avatar_id: 'otter', execution: {kind: 'native'}})]}); return; }
    if (tag === 'specialist') { end(res, {tool_calls: [tool('route_work', {event_id: event.id, quote: event.text, part_key: 'check', action: 'create',
      role_id: roleId, title: '本地首包核对 [RESPONSE_LATENCY:specialist]', reason: '隔离首包验收，不访问业务资源'})]}); return; }
    if (tag !== 'pilot') throw Error('unexpected local input');
  } else if (!tools.some(t => t.function?.name === 'work_finish')) { end(res, {content: '本地验收。'}); return; }
  else if (messages.findLast(m => m.role === 'user' && content(m).includes('"assignment"')) &&
    messages.slice(messages.findLastIndex(m => m.role === 'user' && content(m).includes('"assignment"')) + 1).some(m => m.role === 'tool')) {
    end(res, {content: '本地核对报告已提交。'}); return;
  }
  const kind = tools.some(t => t.function?.name === 'route_work') ? 'pilot' : 'specialist';
  let first, complete;
  const firstGate = new Promise(resolve => { first = resolve; }), completion = new Promise(resolve => { complete = resolve; });
  const entry = {res, kind, first, complete, firstAt: undefined, completedAt: undefined}; held.add(entry);
  const observation = {kind, requestedAt: Date.now(), firstChunkAt: undefined, finishedAt: undefined}; requests.push(observation); await save();
  await firstGate;
  if (res.destroyed) return;
  entry.firstAt = observation.firstChunkAt = Date.now();
  chunk(res, {reasoning_content: '先核对。'}); chunk(res, {content: kind === 'pilot' ? '收到。' : '已接单。'}); await save();
  await completion;
  entry.completedAt = observation.finishedAt = Date.now();
  end(res, kind === 'pilot' ? {content: '这是本地首包验收结论。'} : {tool_calls: [tool('work_finish', {outcome: 'completed', summary: '本地虚构文字核对完成，未访问业务资源。'})]});
  await save();
}
async function sample() {
  const snapshot = await api(`/api/sessions/${routerSessionId}/snapshot`);
  const workspace = await api(`/api/projects/${projectId}/superagent`);
  roleId = workspace.channels.find(channel => channel.roleName === '首包核对专员')?.roleId ?? roleId;
  for (const request of requests) {
    let metric = metrics.find(value => value.requestedAt === request.requestedAt);
    if (!metric) { metric = {kind: request.kind, requestedAt: request.requestedAt}; metrics.push(metric); }
    const source = metric.sourceMessageId ? snapshot.messages.find(m => m.id === metric.sourceMessageId) : snapshot.messages.findLast(m => m.role === 'user' && m.text.includes(`[RESPONSE_LATENCY:${request.kind}]`));
    if (source) { metric.sourceMessageId = source.id; metric.acceptedAt = Date.parse(source.createdAt); }
    const worker = request.kind === 'specialist' ? workspace.workers.findLast(w => metric.sessionId ? w.sessionId === metric.sessionId : w.task.title.includes('[RESPONSE_LATENCY:specialist]')) : undefined;
    metric.sessionId ??= worker?.sessionId ?? routerSessionId;
    const view = worker ? await api(`/api/sessions/${worker.sessionId}/ai`) : snapshot.ai;
    metric.startedAt ??= view?.turnStartedAt ? Date.parse(view.turnStartedAt) : undefined;
    const marker = request.kind === 'pilot' ? '收到。' : '已接单。';
    if (!metric.observedAt && view?.cards.some(card => card.type === 'message' && card.content.includes(marker) && Date.parse(card.at) >= request.requestedAt - 100)) metric.observedAt = Date.now();
    metric.firstChunkAt = request.firstChunkAt;
    metric.providerStillOpenAtObservation = metric.observedAt ? !request.finishedAt || metric.observedAt < request.finishedAt : undefined;
    metric.firstChunkToViewMs = metric.observedAt && request.firstChunkAt ? metric.observedAt - request.firstChunkAt : undefined;
    metric.acceptToStartMs = metric.startedAt && metric.acceptedAt ? metric.startedAt - metric.acceptedAt : undefined;
  }
  await save(); return workspace;
}
async function main() {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'lake-response-latency-dev-')); await fs.chmod(home, 0o700); data = path.join(home, 'web-data');
  metadata = path.resolve(process.argv[2] ?? path.join(home, 'verification.json'));
  const owned = await fs.open(metadata, 'wx', 0o600); await owned.close();
  const codexHome = path.join(home, 'codex'); await fs.mkdir(codexHome, {mode: 0o700});
  await fs.writeFile(path.join(codexHome, 'config.toml'), '', {mode: 0o600});
  await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({auth_mode: 'chatgpt', tokens: {account_id: 'fixture', access_token: 'synthetic-oauth-' + 'x'.repeat(4096)}}), {mode: 0o600});
  const app = path.join(os.homedir(), 'Applications/Lake Dev.app');
  const build = JSON.parse(await fs.readFile(path.join(app, 'Contents/Resources/build-origin.json'), 'utf8'));
  buildOrigin = Object.fromEntries(['gitHead', 'gitBranch', 'version', 'dirty', 'backendRuntime'].map(k => [k, build[k]]));
  const provider = http.createServer((req, res) => void (async () => {
    const url = new URL(req.url, controlOrigin);
    if (req.headers.origin && req.headers.origin !== controlOrigin || req.headers.host !== new URL(controlOrigin).host) return json(res, 403, {});
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return model(req, res);
    if (url.pathname === '/status' && req.method === 'GET') return json(res, 200, status());
    if (url.pathname === '/route' && req.method === 'POST') { for (const entry of routing) { entry.releasedAt ??= Date.now(); entry.release(); } return json(res, 202, {}); }
    if (url.pathname === '/first' && req.method === 'POST') { for (const entry of held) entry.first(); return json(res, 202, {}); }
    if (url.pathname === '/complete' && req.method === 'POST') { for (const entry of held) { entry.first(); entry.complete(); } return json(res, 202, {}); }
    json(res, 404, {});
  })().catch(() => { if (!res.headersSent) json(res, 500, {error: 'controlled fixture failed'}); else res.end(); console.error('Local fixture failed; no credentials or requests logged.'); }));
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); controlOrigin = 'http://127.0.0.1:' + provider.address().port;
  const log = await fs.open(path.join(home, 'native.log'), 'wx', 0o600), env = {...process.env, CODEX_HOME: codexHome};
  for (const field of ['LAKE_HOME', 'LAKE_WEB_DATA_DIR', 'LAKE_WEB_TOKEN', 'LAKE_DEV_HOME', 'LAKE_DEV_WEB_DATA_DIR', 'LAKE_DEV_WEB_TOKEN']) delete env[field];
  const native = spawn(path.join(app, 'Contents/MacOS/Lake'), ['--lake-home', home, '--lake-data', data], {env, stdio: ['ignore', log.fd, log.fd]}); nativePid = native.pid; await log.close();
  native.once('exit', () => { stopped = true; clearInterval(timer); for (const entry of routing) entry.release(); for (const entry of held) { entry.first(); entry.complete(); } provider.close(); provider.closeAllConnections(); void save(); });
  const runtime = await until(async () => { if (stopped) throw Error('Dev exited'); try { return JSON.parse(await fs.readFile(path.join(data, 'runtime.json'), 'utf8')); } catch { return; } }, r => r?.origin && r?.token, 'Dev did not start');
  const endpoint = new URL(runtime.origin); if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw Error('loopback required'); origin = endpoint.origin;
  api = async (route, method = 'GET', body) => { const response = await fetch(origin + route, {method, headers: {Authorization: 'Bearer ' + runtime.token, 'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)}); if (!response.ok) throw Error('isolated API rejected'); return response.json(); };
  await api('/api/settings/model', 'PUT', {url: controlOrigin + '/v1/chat/completions', name: 'response-latency-fixture', apiKey: key});
  projectId = (await api('/api/projects', 'POST', {name: '即时响应 · 隔离验收'})).id;
  routerSessionId = (await api(`/api/projects/${projectId}/superagent`, 'POST', {})).routerSessionId;
  await api(`/api/sessions/${routerSessionId}/messages`, 'POST', {text: texts.setup, ignoreProjectMemory: true});
  await until(sample, () => !!roleId, 'specialist not created');
  await until(() => api(`/api/sessions/${routerSessionId}/ai`), view => view.status === 'completed', 'setup did not settle');
  ready = true; await save();
  let sampling = false; timer = setInterval(() => { if (sampling || stopped) return; sampling = true; void sample().catch(() => {}).finally(() => { sampling = false; }); }, 25);
  console.log(JSON.stringify({ready, metadata, origin, controlOrigin, nativePid, buildOrigin}));
}
main().catch(() => { console.error(JSON.stringify({error: 'Latency fixture failed', metadata, nativePid})); process.exitCode = 1; });
