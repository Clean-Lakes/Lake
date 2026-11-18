const test = require('node:test');
const assert = require('node:assert/strict');
const { request } = require('node:http');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
process.env.LAKE_TS_IMPORT_ONLY = '1';
const { startLakeServer } = require('../../bin/lake-runtime/server.cjs');

const settings = '/api/settings/event-sources';
const list = '/api/settings/gateway/connections';
const alertAt = '2026-11-18T09:30:00.123456789+08:00';
const fixturePayload = {
  version: '1',
  receiver: 'Lake receiver',
  groupKey: '{}:{service="checkout"}',
  orgId: 1,
  status: 'firing',
  title: '支付 API 通知',
  truncatedAlerts: 1,
  alerts: [
    {status: 'firing', fingerprint: '123abc', startsAt: alertAt, endsAt: '0001-01-01T00:00:00Z',
      labels: {alertname: 'PaymentLatency', service: 'checkout'}, annotations: {summary: 'P95 超过基线'}, values: {B: 1.8}},
    {status: 'resolved', fingerprint: '456def', startsAt: alertAt, endsAt: '2026-11-18T09:35:00+08:00',
      labels: {alertname: 'PaymentErrors'}, annotations: {summary: '错误率恢复'}},
  ],
};

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'lake-events-http-'));
  const web = join(home, 'web');
  await mkdir(web);
  await writeFile(join(web, 'index.html'), '<html>event receiver fixture</html>');
  const start = () => startLakeServer({home, data: join(home, 'data'), port: 0, staticRoot: web});
  let app = await start();
  t.after(async () => {
    await app.close();
    await rm(home, {recursive: true, force: true});
  });
  const api = async (path, {method = 'GET', data, token = app.token, status = 200} = {}) => {
    const response = await fetch(new URL(path, app.origin), {
      method,
      headers: {
        ...(token && {Authorization: 'Bearer ' + token}),
        ...(data !== undefined && {'Content-Type': 'application/json; charset=utf-8'}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    assert.equal(response.status, status, method + ' ' + new URL(path, app.origin).pathname);
    return response.json();
  };
  const createProject = name => api('/api/projects', {method: 'POST', data: {name}});
  const createSource = (project, name) =>
    api(settings, {method: 'POST', data: {name, projectId: project.id}, status: 201});
  const project = await createProject('Grafana 接入测试');
  const {source, token} = await createSource(project, '支付告警');
  const oldPath = new URL(source.webhookUrl).pathname;
  return {
    get app() { return app; },
    restart: async () => { await app.close(); app = await start(); },
    api, project, source, token, oldPath, createProject, createSource,
    receive: (data, status = 200, credential = token) =>
      api(oldPath, {method: 'POST', data, token: credential, status}),
    deliveries: query => api(`${settings}/${source.id}/deliveries${query ?? ''}`),
    delivery: id => api(`${settings}/${source.id}/deliveries/${id}`),
    update: (data, status = 200) =>
      api(`${settings}/${source.id}`, {method: 'PATCH', data, status}),
  };
}

test('Grafana batches, recoveries and repeat deliveries persist across restart without creating work', async t => {
  const f = await fixture(t);
  const workKinds = ['superInputs', 'messages', 'superWorkers', 'superGoals', 'superOperations'];
  const before = workKinds.map(kind => f.app.store.list(kind).length);
  const first = await f.receive(fixturePayload);
  const second = await f.receive(fixturePayload);
  const resolved = {...fixturePayload, status: 'resolved', title: '支付 API 恢复通知',
    alerts: [fixturePayload.alerts[1]], truncatedAlerts: 0};
  const third = await f.receive(resolved);
  assert.notEqual(first.id, second.id, 'each authenticated delivery is preserved');
  const page = await f.deliveries('?limit=2');
  assert.deepEqual(page.deliveries.map(row => [row.id, row.status, row.alertCount, row.truncatedAlerts]),
    [[third.id, 'resolved', 1, 0], [second.id, 'firing', 2, 1]]);
  assert.equal(page.deliveries[0].receivedAt, third.receivedAt);
  assert.ok(!('payload' in page.deliveries[0]));
  const older = await f.deliveries('?limit=2&cursor=' + page.nextCursor);
  assert.deepEqual(older.deliveries.map(row => row.id), [first.id]);
  assert.equal(older.nextCursor, undefined);
  assert.deepEqual((await f.delivery(first.id)).payload, fixturePayload);
  assert.deepEqual((await f.delivery(third.id)).payload, resolved);
  assert.deepEqual(workKinds.map(kind => f.app.store.list(kind).length), before);

  await f.restart();
  assert.deepEqual((await f.delivery(first.id)).payload, fixturePayload);
  const catalog = await f.api(list);
  assert.equal(catalog.eventSources[0].projectId, f.project.id);
  assert.equal(catalog.eventSources[0].lastReceivedAt, third.receivedAt);
  assert.equal(catalog.eventSources[0].webhookUrl, f.app.origin + f.oldPath);
  await f.receive(resolved);
});

test('source credentials are write-only, scoped and revocable during receipt', async t => {
  const f = await fixture(t);
  const {source: other, token: otherToken} = await f.createSource(await f.createProject('另一项目'), '其他告警');
  assert.equal((await f.api(list)).eventSources.length, 2);
  assert.ok(!JSON.stringify(await f.api(list)).includes(f.token), 'the settings catalog excludes credentials');
  const stored = f.app.store.get('eventSources', f.source.id);
  assert.ok(!JSON.stringify(stored).includes(f.token), 'storage contains no plaintext credential');
  assert.match(stored.credentialHash, /^[a-f0-9]{64}$/);
  await f.receive(fixturePayload, 401, otherToken);
  await f.receive(fixturePayload, 401, f.app.token);
  await f.api(f.oldPath, {method: 'POST', data: fixturePayload, token: null, status: 401});
  await f.api(`${settings}/${f.source.id}/deliveries`, {token: f.token, status: 401});
  const mcp = await f.api('/api/settings/gateway/tokens', {method: 'POST', data: {name: 'Legacy test'}, status: 201});
  await f.receive(fixturePayload, 401, mcp.token);
  await f.api('/api/gateway/specialists', {token: f.token, status: 401});
  const echoed = {...fixturePayload, title: '凭据不应入库 ' + f.token,
    alerts: [{...fixturePayload.alerts[0], annotations: {summary: f.token}}]};
  const receipt = await f.receive(echoed);
  assert.ok(!JSON.stringify(await f.delivery(receipt.id)).includes(f.token), 'credentials echoed in JSON are scrubbed');
  await f.api(`${settings}/${other.id}/deliveries/${receipt.id}`, {status: 404});
  await f.api(`${settings}/${other.id}/deliveries?cursor=${receipt.id}`, {status: 400});

  let admitted;
  const started = new Promise(resolve => { admitted = resolve; });
  const get = f.app.store.get.bind(f.app.store);
  f.app.store.get = (kind, id) => {
    const row = get(kind, id);
    if (kind === 'eventSources' && id === f.source.id) admitted();
    return row;
  };
  let callback;
  const status = new Promise((resolve, reject) => {
    callback = request(f.source.webhookUrl, {method: 'POST', headers: {
      Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json',
    }}, response => { response.resume(); resolve(response.statusCode); });
    callback.on('error', reject);
    callback.write('{');
  });
  try {
    await started;
    const {source: disabled} = await f.update({expectedRevision: f.source.revision, enabled: false});
    callback.end(JSON.stringify(fixturePayload).slice(1));
    assert.equal(await status, 403);
    assert.equal((await f.deliveries()).deliveries.length, 1);
    await f.receive(fixturePayload, 403);
    await f.update({expectedRevision: f.source.revision, enabled: true}, 409);
    await f.update({expectedRevision: disabled.revision, enabled: true, projectId: other.projectId}, 400);
    const {source: enabled} = await f.update({expectedRevision: disabled.revision, enabled: true});
    const rotated = await f.update({expectedRevision: enabled.revision, rotateCredential: true});
    assert.ok(rotated.token && rotated.token !== f.token, 'rotation issues a distinct credential');
    await f.receive(fixturePayload, 401);
    await f.receive(fixturePayload, 200, rotated.token);
  } finally {
    callback.destroy();
    f.app.store.get = get;
  }
});

test('malformed payloads and failed writes never produce a successful receipt', async t => {
  const f = await fixture(t);
  await f.api(f.oldPath, {token: f.token, status: 405});
  await f.receive({...fixturePayload, version: '4'}, 400);
  await f.receive({...fixturePayload, alerts: []}, 400);
  await f.receive({...fixturePayload, alerts: [{status: 'unknown'}]}, 400);
  await f.receive({...fixturePayload, truncatedAlerts: -1}, 400);
  await f.receive({...fixturePayload, title: 'x'.repeat(1024 * 1024)}, 413);
  const invalid = await fetch(f.source.webhookUrl, {
    method: 'POST', headers: {Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json'}, body: '{',
  });
  assert.equal(invalid.status, 400);
  await invalid.body.cancel();
  const chunked = new Promise((resolve, reject) => {
    const client = request(f.source.webhookUrl, {method: 'POST', headers: {
      Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json',
    }}, response => { response.resume(); resolve(response.statusCode); });
    client.on('error', reject);
    client.write(Buffer.alloc(512 * 1024, 32));
    client.end(Buffer.alloc(512 * 1024 + 1, 32));
  });
  assert.equal(await chunked, 413);

  f.app.store.db.exec(`CREATE TEMP TRIGGER fail_delivery BEFORE INSERT ON event_deliveries
    BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`);
  await f.receive(fixturePayload, 500);
  assert.deepEqual((await f.deliveries()).deliveries, []);
  f.app.store.db.exec('DROP TRIGGER fail_delivery');
  const receipt = await f.receive(fixturePayload);
  assert.equal((await f.deliveries()).deliveries[0].id, receipt.id);
});
