/**
 * 只读工具测试：输出形状、过滤、截断标记，以及凭据值不泄漏。
 * @module dsh-plugin-ops-data/test/tools.test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOpsToolDefs } from '../lib/tool-defs.js';
import { createStore } from './helpers.mjs';

const SENTINEL = 'SENTINEL-DO-NOT-LEAK-9f3a';

/** 建一套带凭据与历史的资产。 */
function seed(store) {
  const environment = store.upsertEnvironment({ name: '生产', kind: 'production', region: 'cn-north' });
  store.upsertCredentialRef({
    name: 'prod-ssh',
    kind: 'ssh-key',
    provider: 'file',
    locator: SENTINEL,
    description: '生产密钥引用',
  });
  const host = store.upsertHost({
    environment: environment.id,
    name: 'web-01',
    address: '10.0.0.11',
    role: 'web',
    status: 'online',
    credentialRef: 'prod-ssh',
    tags: ['web'],
  });
  store.upsertHost({ environment: environment.id, name: 'db-01', address: '10.0.0.12', role: 'db' });
  store.upsertService({ environment: environment.id, name: 'orders-db', kind: 'mysql', host: host.name });
  store.appendOperation({
    occurredAt: '2026-10-02T00:00:00.000Z',
    source: 'agent',
    kind: 'change',
    outcome: 'success',
    hostId: host.id,
    summary: '重启 orders 服务',
    detail: { command: 'systemctl restart orders' },
  });
  return { environment, host };
}

function toolsOf(store, maxRows = 50) {
  const defs = createOpsToolDefs({ store, maxRows });
  return new Map(defs.map((definition) => [definition.name, definition]));
}

test('暴露 6 个只读工具且并发安全声明为 true', () => {
  const fixture = createStore();
  try {
    const tools = toolsOf(fixture.store);
    assert.deepEqual([...tools.keys()].sort(), [
      'ops_credentials',
      'ops_environments',
      'ops_hosts',
      'ops_journal',
      'ops_overview',
      'ops_services',
    ]);
    for (const definition of tools.values()) {
      assert.equal(definition.isConcurrencySafe({}), true);
      assert.equal(typeof definition.execute, 'function');
      assert.equal(typeof definition.output.render, 'function');
      assert.equal(definition.output.schema.type, 'object');
    }
  } finally {
    fixture.cleanup();
  }
});

test('空库概览给出计数全 0 与下一步提示', () => {
  const fixture = createStore();
  try {
    const value = toolsOf(fixture.store).get('ops_overview').execute({});
    assert.equal(value.schemaVersion, 1);
    assert.deepEqual(value.counts, {
      environments: 0,
      hosts: 0,
      services: 0,
      credentialRefs: 0,
      operationRecords: 0,
      links: 0,
    });
    assert.equal(value.lastImport.present, false);
    assert.match(value.nextSteps, /empty/);
  } finally {
    fixture.cleanup();
  }
});

test('ops_hosts 返回凭据引用元数据但不泄漏 locator', () => {
  const fixture = createStore();
  try {
    seed(fixture.store);
    const tools = toolsOf(fixture.store);
    const hosts = tools.get('ops_hosts').execute({});
    assert.equal(hosts.count, 2);
    const web = hosts.hosts.find((host) => host.name === 'web-01');
    assert.equal(web.hasCredential, true);
    assert.equal(web.credentialName, 'prod-ssh');
    assert.equal(web.credentialKind, 'ssh-key');
    assert.equal(web.credentialProvider, 'file');
    assert.equal(web.port, '22');

    // 除 ops_credentials 之外，任何工具输出都不能出现 locator 哨兵。
    for (const name of ['ops_overview', 'ops_environments', 'ops_hosts', 'ops_services', 'ops_journal']) {
      const value = tools.get(name).execute({});
      assert.ok(!JSON.stringify(value).includes(SENTINEL), `${name} 泄漏了凭据 locator`);
    }
    const credentials = tools.get('ops_credentials').execute({});
    assert.equal(credentials.count, 1);
    assert.equal(credentials.credentialRefs[0].locator, SENTINEL);
    assert.match(credentials.notice, /references/i);
  } finally {
    fixture.cleanup();
  }
});

test('ops_environments 与 ops_services 支持过滤与计数', () => {
  const fixture = createStore();
  try {
    seed(fixture.store);
    const tools = toolsOf(fixture.store);
    const environments = tools.get('ops_environments').execute({ kind: 'production' });
    assert.equal(environments.count, 1);
    assert.equal(environments.environments[0].hostCount, 2);
    assert.equal(environments.environments[0].serviceCount, 1);
    assert.equal(tools.get('ops_environments').execute({ kind: 'staging' }).count, 0);

    const services = tools.get('ops_services').execute({ kind: 'mysql' });
    assert.equal(services.count, 1);
    assert.equal(services.services[0].environment, '生产');
    assert.equal(services.services[0].host, 'web-01');
    assert.equal(tools.get('ops_services').execute({ kind: 'redis' }).count, 0);
  } finally {
    fixture.cleanup();
  }
});

test('ops_journal 支持时间与结果过滤', () => {
  const fixture = createStore();
  try {
    seed(fixture.store);
    const tools = toolsOf(fixture.store);
    const all = tools.get('ops_journal').execute({});
    assert.equal(all.count, 1);
    assert.equal(all.records[0].kind, 'change');
    assert.deepEqual(all.records[0].detail, { command: 'systemctl restart orders' });
    assert.equal(tools.get('ops_journal').execute({ since: '2026-10-03T00:00:00.000Z' }).count, 0);
    assert.equal(tools.get('ops_journal').execute({ outcome: 'failure' }).count, 0);
    assert.equal(tools.get('ops_journal').execute({ outcome: 'success' }).count, 1);
  } finally {
    fixture.cleanup();
  }
});

test('limit 生效并给出精确截断标记', () => {
  const fixture = createStore();
  try {
    seed(fixture.store);
    const tools = toolsOf(fixture.store, 1);
    const hosts = tools.get('ops_hosts').execute({});
    assert.equal(hosts.count, 1);
    assert.equal(hosts.truncated, true);
    const explicit = tools.get('ops_hosts').execute({ limit: 2 });
    assert.equal(explicit.count, 2);
    assert.equal(explicit.truncated, false);
  } finally {
    fixture.cleanup();
  }
});

test('render 输出为单条文本', () => {
  const fixture = createStore();
  try {
    seed(fixture.store);
    const value = toolsOf(fixture.store).get('ops_hosts').execute({});
    const rendered = toolsOf(fixture.store).get('ops_hosts').output.render({}, value);
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].type, 'text');
    assert.match(rendered[0].text, /2 host/);
  } finally {
    fixture.cleanup();
  }
});

test('无法解析的环境参数给出明确错误', () => {
  const fixture = createStore();
  try {
    seed(fixture.store);
    assert.throws(() => toolsOf(fixture.store).get('ops_hosts').execute({ environment: '不存在' }), (error) => {
      assert.equal(error.code, 'not-found');
      return true;
    });
  } finally {
    fixture.cleanup();
  }
});
