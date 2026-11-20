const {test} = require('node:test');
const assert = require('node:assert/strict');
const {channel} = require('node:diagnostics_channel');
const {mkdtemp, mkdir, writeFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {createServer} = require('node:http');
process.env.LAKE_TS_IMPORT_ONLY = '1';
const {startLakeServer} = require('../../bin/lake-runtime/server.cjs');
const {enableNativeSpecialistFixture} = require('./test-fixtures/native-specialists.cjs');

const content = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, check, label, timeout = 3000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = await read(); if (check(value)) return value; await pause(10);
  }
  assert.fail(label);
}

// The provider intentionally keeps its first, very short output open. Success
// must be observed before release, not after a long tail or an end event.
for (const specialist of [false, true]) test(`${specialist ? 'specialist' : 'Pilot'} publishes a short first packet while the provider is still open`, async t => {
  const home = await mkdtemp(join(tmpdir(), 'lake-response-latency-'));
  const web = join(home, 'web'), codexHome = join(home, 'codex');
  await mkdir(web); await writeFile(join(web, 'index.html'), '<html>isolated latency fixture</html>');
  await mkdir(codexHome); await writeFile(join(codexHome, 'config.toml'), '');
  let release, releaseRoute, routingHeld = false, held = false, workerRequest = false, app, role;
  const gate = new Promise(resolve => { release = resolve; });
  const routeGate = new Promise(resolve => { releaseRoute = resolve; });
  let probes = 0;
  const blockProbe = () => { app.agents.external.status = async () => { probes++; await gate; return []; }; };
  const chunk = (res, delta, finish = null) => res.write('data: ' + JSON.stringify({id: 'latency-fixture', object: 'chat.completion.chunk', created: 1,
    model: 'fixture', choices: [{index: 0, delta, finish_reason: finish}]}) + '\n\n');
  const provider = createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const request = JSON.parse(Buffer.concat(parts).toString());
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    if (specialist && request.tools?.some(tool => tool.function?.name === 'route_work')) {
      const source = request.messages.findLast(message => message.role === 'user' && content(message).startsWith('[LAKE ADMITTED HUMAN EVENTS'));
      const event = JSON.parse(content(source).split('\n')[1])[0];
      if (!request.messages.some(message => message.tool_calls?.some(call => call.function?.name === 'route_work'))) {
        chunk(res, {tool_calls: [{index: 0, id: 'route-latency', type: 'function', function: {name: 'route_work', arguments: JSON.stringify({
          event_id: event.id, quote: event.text, part_key: 'check', action: 'create', role_id: role.id, title: '本地首包验收', reason: '仅虚构数据',
        })}}]});
        chunk(res, {}, 'tool_calls');
      } else { routingHeld = true; await routeGate; chunk(res, {content: '已安排。'}); chunk(res, {}, 'stop'); }
    } else {
      workerRequest = specialist;
      chunk(res, {reasoning_content: '先核对。'});
      chunk(res, {content: '收到。'});
      held = true;
      await gate;
      chunk(res, {content: '本地验收结束。'}); chunk(res, {}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => { releaseRoute(); release(); await app?.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await rm(home, {recursive: true, force: true}); });
  app = await startLakeServer({home, data: join(home, 'data'), staticRoot: web, codexHome, port: 0});
  enableNativeSpecialistFixture(app.superagent);
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(app.origin + path, {method, headers: {Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  await api('/api/settings/model', 'PUT', {url: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`, name: 'fixture', apiKey: 'synthetic-latency-key'});
  // Real OAuth credentials can be much longer than an entire public sentence.
  app.agents.registerSecret('synthetic-oauth-' + 'x'.repeat(4096));
  blockProbe();
  const project = await api('/api/projects', 'POST', {name: 'isolated response latency'});
  const router = (await api(`/api/projects/${project.id}/superagent`, 'POST', {})).routerSessionId;
  role = {id: 'latency-otter', projectId: project.id, roleKey: 'latency', name: '首包核对专员', duties: '仅虚构数据', revision: 1, avatarId: 'otter', execution: {kind: 'native'}};
  if (specialist) {
    app.store.put('superRoles', role.id, role);
    const profile = app.agents.external.registry.get(project.id, 'codex');
    app.store.put('acpProfiles', project.id + ':codex', {...profile, enabled: true});
  }
  const messageRoute = `/api/sessions/${router}/messages`;
  const stages = [];
  const responses = channel('http.server.response.finish');
  const onReceipt = ({request, response}) => {
    if (request.method === 'POST' && request.url === messageRoute && response.statusCode === 202)
      stages.push('receipt');
  };
  responses.subscribe(onReceipt);
  t.after(() => responses.unsubscribe(onReceipt));
  const send = app.agents.send.bind(app.agents);
  app.agents.send = (sessionId, ...args) => {
    if (sessionId === router) stages.push('prepared');
    return send(sessionId, ...args);
  };
  await api(messageRoute, 'POST', {text: '验证本地首包。', ignoreProjectMemory: true});
  if (specialist) {
    await until(() => routingHeld, Boolean, 'Pilot did not receive the routing receipt');
    const workspace = await api(`/api/projects/${project.id}/superagent`);
    const row = workspace.workers.find(worker => worker.roleId === role.id);
    assert.equal(row.activity?.phase, 'queued'); assert.equal(row.activity?.label, '准备处理');
    assert.equal(row.activity?.sourceSessionId, router); assert.equal(workerRequest, false);
    releaseRoute();
  }
  await until(() => held, Boolean, 'provider never received the invocation');
  assert.deepEqual(stages, ['receipt', 'prepared'], 'durable receipt precedes Pilot context preparation');
  let sessionId = router;
  if (specialist) {
    assert.ok(workerRequest);
    sessionId = app.store.list('superWorkers').find(worker => !worker.inline).sessionId;
  }
  const view = await until(() => api(`/api/sessions/${sessionId}/ai`), value => value.cards.some(card => card.type === 'message' && card.content.includes('收到。')),
    'short public text was buffered until finish instead of being published live', 1500);
  assert.equal(view.replyStatus, 'running');
  assert.equal(probes, 0, 'native inference does not wait for optional ACP connection probes');
  assert.ok(view.cards.some(card => card.type === 'thinking' && card.content.includes('先核对。')), 'short reasoning is also delivered live');
  assert.equal(held, true);
  release();
});
