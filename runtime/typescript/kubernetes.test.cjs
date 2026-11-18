const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
process.env.LAKE_TS_IMPORT_ONLY = '1';
const { startLakeServer } = require('../../bin/lake-runtime/server.cjs');

async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'lake-kubernetes-'))), web = join(home, 'web');
  await fs.mkdir(web); await fs.writeFile(join(web, 'index.html'), '<html>fixture</html>');
  const app = await startLakeServer({ home, data: join(home, 'data'), staticRoot: web, port: 0 });
  const project = app.store.createProject('isolated Kubernetes');
  t.after(async () => { await app.close(); await fs.rm(home, { recursive: true, force: true }); });
  const path = '/api/projects/' + project.id + '/resources';
  const api = async (url, method = 'GET', body, status = 200) => {
    const response = await fetch(app.origin + url, { method, headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  return { app, home, project, path, api };
}
async function server(t, handler, tls) {
  const s = tls ? https.createServer(tls, handler) : http.createServer(handler);
  await new Promise(ok => s.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise(ok => { s.closeAllConnections(); s.close(ok); }));
  return (tls ? 'https' : 'http') + '://127.0.0.1:' + s.address().port;
}
const settings = (endpoint, extra = {}) => ({ authMethod: 'token', endpoint, requestTimeout: 2, tlsMode: 'config', ...extra });
const input = (value, name = 'cluster') => ({ kind: 'kubernetes', name, settings: value });
const version = response => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ gitVersion: 'v1.17.4' })); };
const files = async home => (await fs.readdir(join(home, 'secrets')).catch(() => [])).filter(n => n.startsWith('service-'));
const kube = (endpoint, extra = {}) => ({ apiVersion: 'v1', kind: 'Config', 'current-context': 'main', clusters: [{ name: 'cluster', cluster: { server: endpoint } }], contexts: [{ name: 'main', context: { cluster: 'cluster', user: 'reader', namespace: 'observed' } }], users: [{ name: 'reader', user: { token: 'synthetic-embedded-token' } }], ...extra });
const legacy = f => ({ projectId: f.project.id, revision: 1, mode: 'legacy', readOnly: true, data: { SchemaVersion: 1, Revision: 1, Confirmed: true, Mode: 'legacy', ProjectID: f.project.id, StoreID: 'a'.repeat(64), RecoveryEpoch: 'b'.repeat(64), ResourceIDs: [], Rules: ['resource.manage', 'resource.resolve', 'cluster.read', 'db.read', 'network.fetch'].map(Capability => ({ Capability, Effect: 'allow', ResourceIDs: null, Limits: {} })) } });

test('confirmed legacy connection management works without changing historical policy or granting execution to new resource IDs', async t => {
  const f = await fixture(t), policy = legacy(f), before = JSON.stringify(policy);
  f.app.store.put('legacyProjectPolicies', f.project.id, policy);
  let hits = 0; const endpoint = await server(t, (_req, res) => { hits++; version(res); });
  const resource = await f.api(f.path, 'POST', input(settings(endpoint, { token: 'synthetic-managed-token' })));
  assert.equal(hits, 0, 'saving must not connect');
  assert.equal(resource.kind, 'kubernetes'); assert.equal(resource.settings.namespace, 'default');
  const result = await f.api(f.path + '/test', 'POST', { ...input({ namespace: 'default' }), resourceId: resource.id, revision: 1 });
  assert.equal(result.version, 'v1.17.4'); assert.equal(hits, 1);
  const renamed = await f.api('/api/resources/' + resource.id, 'PATCH', { name: 'renamed cluster' });
  assert.equal(renamed.settings.credentialRef, resource.settings.credentialRef);
  assert.equal(JSON.stringify(f.app.store.get('legacyProjectPolicies', f.project.id)), before);
  assert.equal(policy.data.ResourceIDs.includes(resource.id), false);
});

test('unsupported, malformed, ask, deny and scoped legacy policies reject management before networking or secret creation', async t => {
  const cases = [
    [p => p.data.Confirmed = false, 409], [p => p.data.Mode = 'restricted', 409],
    [p => p.data.Revision = 2, 409], [p => p.data.StoreID = '', 409],
    [p => p.data.ProjectID = 'foreign-project', 409],
    [p => p.data.Rules[0].Effect = 'deny', 403], [p => p.data.Rules[0].Effect = 'ask', 403],
    [p => p.data.Rules[0].ResourceIDs = ['a-different-resource'], 403],
    [p => p.data.Rules[0].Limits.MaxRows = 1, 409],
    [p => p.data.Rules[0].Limits.unsupported = true, 409],
    [p => p.data.Rules.push({ Capability: 'resource.manage', Effect: 'deny' }), 403],
  ];
  for (const [index, [mutate, status]] of cases.entries()) await t.test(String(index), async t => {
    const f = await fixture(t), policy = legacy(f); mutate(policy); f.app.store.put('legacyProjectPolicies', f.project.id, policy);
    let hits = 0; const endpoint = await server(t, (_req, res) => { hits++; version(res); });
    await f.api(f.path, 'POST', input(settings(endpoint, { token: 'synthetic-not-saved' })), status);
    assert.equal(hits, 0); assert.deepEqual(await files(f.home), []);
  });
});

test('scoped deny and unsupported cluster limits still block explicit probes', async t => {
  const f = await fixture(t), endpoint = await server(t, (_req, res) => version(res));
  const resource = await f.api(f.path, 'POST', input(settings(endpoint)));
  const policy = legacy(f); policy.data.ResourceIDs = [resource.id];
  policy.data.Rules.push({ Capability: 'cluster.read', ResourceIDs: [resource.id], Effect: 'deny' });
  f.app.store.put('legacyProjectPolicies', f.project.id, policy);
  await f.api(f.path + '/test', 'POST', input(settings(endpoint)), 409);
  await f.api(f.path + '/test', 'POST', { ...input({}), resourceId: resource.id, revision: 1 }, 403);
  policy.data.Rules.pop(); policy.data.Rules.find(r => r.Capability === 'cluster.read').Limits.Namespaces = ['allowed-only'];
  f.app.store.put('legacyProjectPolicies', f.project.id, policy);
  await f.api(f.path + '/test', 'POST', { ...input({}), resourceId: resource.id, revision: 1 }, 409);
});

test('policy changes during a probe discard the result even when the replacement policy still allows it', async t => {
  const f = await fixture(t), policy = legacy(f); f.app.store.put('legacyProjectPolicies', f.project.id, policy);
  const endpoint = await server(t, (_req, res) => {
    f.app.store.put('legacyProjectPolicies', f.project.id, { ...policy, revision: 2, data: { ...policy.data, Revision: 2 } }); version(res);
  });
  await f.api(f.path + '/test', 'POST', input(settings(endpoint)), 409);
});

test('token CRUD is private, test-only networking preserves revisions and credentials, and cross-project probes are rejected', async t => {
  const f = await fixture(t); let hits = 0;
  const endpoint = await server(t, (req, res) => { hits++; assert.equal(req.url, '/prefix/version'); assert.equal(req.headers.authorization, 'Bearer synthetic-kube-token'); version(res); });
  const folder = await f.api('/api/projects/' + f.project.id + '/resource-tree', 'POST', { operation: 'create', name: 'site' });
  const parentId = folder.nodes.find(n => n.name === 'site').id;
  const resource = await f.api(f.path, 'POST', { ...input(settings(endpoint + '/prefix', { token: 'synthetic-kube-token', namespace: 'production' })), parentId });
  assert.equal(hits, 0); assert.equal(resource.configurationRevision, 1);
  assert.ok(!JSON.stringify(resource).includes('synthetic-kube-token'));
  const path = join(f.home, 'secrets', resource.settings.credentialRef);
  assert.equal((await fs.stat(path)).mode & 0o077, 0);
  const result = await f.api(f.path + '/test', 'POST', { ...input({}), resourceId: resource.id, revision: 1 });
  assert.equal(result.version, 'v1.17.4'); assert.equal(result.namespace, 'production');
  const changed = await f.api('/api/resources/' + resource.id, 'PATCH', { name: 'renamed', settings: { namespace: 'observed' } });
  assert.equal(changed.configurationRevision, 2); assert.equal(changed.settings.credentialRef, resource.settings.credentialRef);
  await f.api(f.path + '/test', 'POST', { ...input({}), resourceId: resource.id, revision: 1 }, 409);
  const other = f.app.store.createProject('foreign');
  await f.api('/api/projects/' + other.id + '/resources/test', 'POST', { ...input({}), resourceId: resource.id, revision: 2 }, 404);
  await f.api(f.path, 'POST', input(settings(endpoint, { credentialRef: resource.settings.credentialRef })), 400);
  assert.equal(hits, 1);
});

test('embedded JSON/YAML kubeconfig resolves context and namespace; metadata edits retain its private credential', async t => {
  const f = await fixture(t); let hits = 0;
  const endpoint = await server(t, (req, res) => { hits++; assert.equal(req.headers.authorization, 'Bearer synthetic-embedded-token'); version(res); });
  const doc = kube(endpoint), raw = JSON.stringify(doc);
  const resource = await f.api(f.path, 'POST', input({ authMethod: 'kubeconfig', kubeconfig: raw, requestTimeout: 3, tlsMode: 'verify' }));
  assert.equal(resource.settings.endpoint, endpoint); assert.equal(resource.settings.context, 'main'); assert.equal(resource.settings.namespace, 'observed');
  assert.ok(!JSON.stringify(resource).includes('synthetic-embedded-token')); assert.ok(!JSON.stringify(resource).includes('kubeconfig":'));
  const before = await files(f.home);
  await f.api(f.path + '/test', 'POST', { ...input({}), resourceId: resource.id, revision: 1 });
  const changed = await f.api('/api/resources/' + resource.id, 'PATCH', { name: 'same login', settings: { namespace: 'overridden' } });
  assert.equal(changed.settings.credentialRef, resource.settings.credentialRef); assert.deepEqual(await files(f.home), before); assert.equal(hits, 1);
  const yaml = `apiVersion: v1\nkind: Config\ncurrent-context: main\nclusters:\n- name: cluster\n  cluster:\n    server: ${endpoint}\ncontexts:\n- name: main\n  context:\n    cluster: cluster\n    user: reader\nusers:\n- name: reader\n  user:\n    token: synthetic-embedded-token\n`;
  const result = await f.api(f.path + '/test', 'POST', input({ authMethod: 'kubeconfig', kubeconfig: yaml }));
  assert.equal(result.version, 'v1.17.4'); assert.deepEqual(await files(f.home), before);
});

test('unsafe kubeconfig forms and complex YAML fail without executing plugins, reading files, leaking input or saving secrets', async t => {
  const f = await fixture(t), canary = join(f.home, 'plugin-must-not-run');
  const changed = mutate => { const doc = kube('http://127.0.0.1:1'); mutate(doc); return JSON.stringify(doc); };
  const raws = [
    changed(d => d.users[0].user.exec = { command: 'touch', args: [canary] }),
    changed(d => d.users[0].user['auth-provider'] = {}),
    changed(d => d.users[0].user.tokenFile = '/private/do-not-read'),
    changed(d => d.clusters[0].cluster['certificate-authority'] = '/private/do-not-read'),
    changed(d => d.users[0].user['client-key'] = '/private/do-not-read'),
    changed(d => d.clusters[0].cluster['proxy-url'] = 'http://127.0.0.1:1'),
    changed(d => d.users[0].user.as = 'administrator'),
    changed(d => d.contexts.push(d.contexts[0])),
    changed(d => d['current-context'] = 'missing'),
    changed(d => d.contexts[0].context.cluster = 'missing'),
    changed(d => d.users[0].user.token = 'invalid token'),
    changed(d => d.clusters[0].cluster['certificate-authority-data'] = 'not-base64-secret'),
    'kind: Config\nkind: Config\n', 'kind: Config\n---\nkind: Config\n',
    'kind: Config\ncontexts: &ctx []\nclusters: *ctx\n',
    'kind: Config\nextra: ' + '['.repeat(70) + '0' + ']'.repeat(70),
    'kind: Config\nextra: ' + 's'.repeat(1024 * 1024),
  ];
  for (const raw of raws) {
    const result = await f.api(f.path, 'POST', input({ authMethod: 'kubeconfig', kubeconfig: raw }), 400);
    assert.ok(!JSON.stringify(result).includes('synthetic-embedded-token')); assert.ok(!JSON.stringify(result).includes('not-base64-secret'));
  }
  assert.equal(await fs.stat(canary).then(() => true, () => false), false); assert.deepEqual(await files(f.home), []);
});

test('redirects, API errors, malformed responses and oversized replies never become connection success', async t => {
  const f = await fixture(t); let redirected = 0;
  const destination = await server(t, (_req, res) => { redirected++; version(res); });
  const cases = [
    [302, 'application/json', '{}', 502, { Location: destination + '/version' }],
    [401, 'application/json', '{}', 401], [403, 'application/json', '{}', 403], [404, 'application/json', '{}', 502],
    [200, 'text/html', '<html>dashboard</html>', 502], [200, 'application/json', '{', 502],
    [200, 'application/json', '{"gitVersion":"dashboard"}', 502],
    [200, 'application/json', ' '.repeat(65537), 502],
  ];
  for (const [status, contentType, body, expected, headers = {}] of cases) {
    const endpoint = await server(t, (_req, res) => { res.writeHead(status, { 'Content-Type': contentType, ...headers }); res.end(body); });
    await f.api(f.path + '/test', 'POST', input(settings(endpoint, { token: 'synthetic-no-redirect' })), expected);
  }
  assert.equal(redirected, 0); assert.deepEqual(await files(f.home), []);
});

test('request deadlines and client cancellation stop actual pending Kubernetes I/O', async t => {
  const f = await fixture(t); let closed = 0, started;
  const requested = new Promise(ok => { started = ok; });
  const endpoint = await server(t, (_req, res) => { res.on('close', () => closed++); started(); });
  await f.api(f.path + '/test', 'POST', input(settings(endpoint, { requestTimeout: 1 })), 408);
  const cancel = new AbortController();
  const pending = fetch(f.app.origin + f.path + '/test', { method: 'POST', signal: cancel.signal, headers: { Authorization: 'Bearer ' + f.app.token, 'Content-Type': 'application/json' }, body: JSON.stringify(input(settings(endpoint))) });
  await requested; setTimeout(() => cancel.abort(), 30);
  await assert.rejects(pending, /abort/i);
  const deadline = Date.now() + 2000; while (closed < 2 && Date.now() < deadline) await new Promise(ok => setTimeout(ok, 20));
  assert.equal(closed, 2); assert.deepEqual(await files(f.home), []);
});

test('embedded CA, TLS server name and client certificate authenticate without relaxing verification', async t => {
  const f = await fixture(t), keyPath = join(f.home, 'fixture.key'), certPath = join(f.home, 'fixture.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=kube.fixture.invalid', '-addext', 'subjectAltName=DNS:kube.fixture.invalid', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore', timeout: 15000 });
  const key = await fs.readFile(keyPath), cert = await fs.readFile(certPath); let hits = 0;
  const endpoint = await server(t, (req, res) => { hits++; assert.equal(req.socket.authorized, true); version(res); }, { key, cert, ca: cert, requestCert: true, rejectUnauthorized: true });
  const doc = kube(endpoint); doc.clusters[0].cluster['certificate-authority-data'] = cert.toString('base64'); doc.clusters[0].cluster['tls-server-name'] = 'kube.fixture.invalid';
  doc.users[0].user = { 'client-certificate-data': cert.toString('base64'), 'client-key-data': key.toString('base64') };
  const value = { authMethod: 'kubeconfig', kubeconfig: JSON.stringify(doc), tlsMode: 'verify' };
  assert.equal((await f.api(f.path + '/test', 'POST', input(value))).version, 'v1.17.4');
  delete doc.clusters[0].cluster['tls-server-name'];
  await f.api(f.path + '/test', 'POST', input({ ...value, kubeconfig: JSON.stringify(doc) }), 400);
  doc.clusters[0].cluster['insecure-skip-tls-verify'] = true;
  await f.api(f.path + '/test', 'POST', input({ ...value, kubeconfig: JSON.stringify(doc) }), 400);
  assert.equal(hits, 1); assert.deepEqual(await files(f.home), []);
});

test('legacy service configuration and metric probing share the validated management adapter', async t => {
  const f = await fixture(t), policy = legacy(f), snapshot = JSON.stringify(policy); f.app.store.put('legacyProjectPolicies', f.project.id, policy);
  const endpoint = await server(t, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({status: 'success', data: {resultType: 'scalar', result: [1, '1']}})); });
  const resource = await f.api(f.path, 'POST', {kind: 'victoriametrics', name: 'legacy metric', settings: {endpoint, authMethod: 'none'}});
  const result = await f.api(f.path + '/test', 'POST', {kind: 'victoriametrics', resourceId: resource.id, revision: 1, settings: {}});
  assert.equal(result.protocol, 'victoriametrics');
  await f.api(f.path, 'POST', {kind: 'database', name: 'mysql configuration', settings: {driver: 'mysql', host: '127.0.0.1', username: 'reader', password: 'synthetic-database', tls: false}});
  await f.api(f.path, 'POST', {kind: 'redis', name: 'redis configuration', settings: {host: '127.0.0.1', password: 'synthetic-cache', tls: false}});
  assert.equal(JSON.stringify(f.app.store.get('legacyProjectPolicies', f.project.id)), snapshot);
});
