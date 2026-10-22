/**
 * 仓库层测试：schema、写入校验、过滤查询、只读工具的凭据投影。
 * @module dsh-plugin-ops-data/test/store.test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OpsDataError, openDatabase, readSchemaVersion } from '../lib/db.js';
import { OpsStore } from '../lib/store.js';
import { createStore } from './helpers.mjs';

/** 建一套最小可用资产。 */
function seed(store) {
  const environment = store.upsertEnvironment({
    name: '生产',
    kind: 'production',
    region: 'cn-north',
    tags: ['prod', 'cn'],
  });
  const credential = store.upsertCredentialRef({
    name: 'prod-web-ssh',
    kind: 'ssh-key',
    provider: 'file',
    locator: 'SENTINEL-LOCATOR-VALUE',
    description: '生产 Web 主机密钥',
  });
  const host = store.upsertHost({
    environment: environment.id,
    name: 'web-01',
    address: '10.0.0.11',
    port: 2222,
    sshUser: 'ops',
    role: 'web',
    status: 'online',
    credentialRef: credential.name,
    tags: ['web'],
  });
  const service = store.upsertService({
    environment: environment.name,
    name: 'orders-db',
    kind: 'mysql',
    host: host.name,
    endpoint: '10.0.0.11:3306',
  });
  return { environment, credential, host, service };
}

test('建库后 schema 版本为 1，重复打开保持幂等', () => {
  const fixture = createStore();
  try {
    assert.equal(readSchemaVersion(fixture.db), 1);
    fixture.db.close();
    const reopened = openDatabase(fixture.path);
    assert.equal(readSchemaVersion(reopened), 1);
    reopened.close();
  } finally {
    fixture.cleanup();
  }
});

test('更高的 schema 版本被拒绝打开', () => {
  const fixture = createStore();
  try {
    fixture.db.exec('PRAGMA user_version = 99');
    fixture.db.close();
    assert.throws(() => openDatabase(fixture.path), (error) => {
      assert.ok(error instanceof OpsDataError);
      assert.equal(error.code, 'schema-too-new');
      return true;
    });
  } finally {
    fixture.cleanup();
  }
});

test('环境、主机、服务、凭据引用可写入并按条件过滤', () => {
  const fixture = createStore();
  try {
    const { environment, credential, host, service } = seed(fixture.store);
    assert.equal(environment.kind, 'production');
    assert.deepEqual(environment.tags, ['prod', 'cn']);
    assert.equal(host.sshUser, 'ops');
    assert.equal(host.credential.name, credential.name);
    assert.equal(host.credential.provider, 'file');
    assert.equal(service.hostName, host.name);

    assert.equal(fixture.store.listEnvironments({ kind: 'production' }).length, 1);
    assert.equal(fixture.store.listEnvironments({ kind: 'staging' }).length, 0);
    assert.equal(fixture.store.listEnvironments({ query: '生' }).length, 1);
    assert.equal(fixture.store.listHosts({ environment: '生产', status: 'online' }).length, 1);
    assert.equal(fixture.store.listHosts({ environment: '生产', status: 'offline' }).length, 0);
    assert.equal(fixture.store.listHosts({ tag: 'web' }).length, 1);
    assert.equal(fixture.store.listHosts({ tag: 'db' }).length, 0);
    assert.equal(fixture.store.listServices({ host: 'web-01', environment: '生产' }).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('凭据引用只保存引用元数据，结构上没有值字段', () => {
  const fixture = createStore();
  try {
    seed(fixture.store);
    const [credential] = fixture.store.listCredentialRefs({});
    assert.deepEqual(Object.keys(credential).sort(), [
      'createdAt',
      'description',
      'id',
      'kind',
      'locator',
      'name',
      'provider',
      'rotatedAt',
      'updatedAt',
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('主机引用未登记的凭据会被拒绝', () => {
  const fixture = createStore();
  try {
    const environment = fixture.store.upsertEnvironment({ name: '测试' });
    assert.throws(
      () => fixture.store.upsertHost({ environment: environment.id, name: 'h1', address: '127.0.0.1', credentialRef: '不存在' }),
      (error) => {
        assert.ok(error instanceof OpsDataError);
        assert.equal(error.code, 'not-found');
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('主机名在多个环境中出现时要求指定环境', () => {
  const fixture = createStore();
  try {
    const left = fixture.store.upsertEnvironment({ name: 'A' });
    const right = fixture.store.upsertEnvironment({ name: 'B' });
    fixture.store.upsertHost({ environment: left.id, name: 'shared', address: '10.0.0.1' });
    fixture.store.upsertHost({ environment: right.id, name: 'shared', address: '10.0.0.2' });
    assert.throws(() => fixture.store.resolveHost('shared'), (error) => error.code === 'ambiguous');
    assert.equal(fixture.store.resolveHost('shared', 'A').address, '10.0.0.1');
  } finally {
    fixture.cleanup();
  }
});

test('操作记录只追加、按时间倒序并支持过滤', () => {
  const fixture = createStore();
  try {
    const { environment, host } = seed(fixture.store);
    fixture.store.appendOperation({
      id: 'op-old',
      occurredAt: '2026-09-01T00:00:00.000Z',
      source: 'import',
      kind: 'inspect',
      outcome: 'success',
      environmentId: environment.id,
      hostId: host.id,
      summary: '检查磁盘',
      detail: { command: 'df -h' },
    });
    fixture.store.appendOperation({
      id: 'op-new',
      occurredAt: '2026-10-01T00:00:00.000Z',
      source: 'agent',
      kind: 'change',
      outcome: 'failure',
      hostId: host.id,
      summary: '重启服务',
    });
    /** 重复 id 不产生副本，保证导入幂等。 */
    fixture.store.appendOperation({ id: 'op-new', occurredAt: '2026-10-01T00:00:00.000Z', summary: '重启服务' });

    const all = fixture.store.queryJournal({});
    assert.deepEqual(
      all.map((record) => record.id),
      ['op-new', 'op-old'],
    );
    assert.deepEqual(all[1].detail, { command: 'df -h' });
    assert.equal(fixture.store.queryJournal({ kind: 'change' }).length, 1);
    assert.equal(fixture.store.queryJournal({ outcome: 'failure' }).length, 1);
    assert.equal(fixture.store.queryJournal({ since: '2026-09-15T00:00:00.000Z' }).length, 1);
    assert.equal(fixture.store.queryJournal({ until: '2026-09-15T00:00:00.000Z' }).length, 1);
    assert.equal(fixture.store.queryJournal({ host: 'web-01' }).length, 2);
    // environment 与 host 是 AND 关系：op-new 没有环境归属，因此只命中 op-old。
    assert.equal(fixture.store.queryJournal({ host: 'web-01', environment: '生产' }).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('环境归档后默认查询不再返回，显式请求才返回', () => {
  const fixture = createStore();
  try {
    const environment = fixture.store.upsertEnvironment({ name: '旧环境' });
    fixture.store.upsertEnvironment({ id: environment.id, name: '旧环境', archived: true });
    assert.equal(fixture.store.listEnvironments({}).length, 0);
    assert.equal(fixture.store.listEnvironments({ includeArchived: true }).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('概览返回计数、环境摘要与导入状态', () => {
  const fixture = createStore();
  try {
    seed(fixture.store);
    const overview = fixture.store.overview();
    assert.equal(overview.schemaVersion, 1);
    assert.equal(overview.databasePath, fixture.path);
    assert.deepEqual(overview.counts, {
      environments: 1,
      hosts: 1,
      services: 1,
      credentialRefs: 1,
      operationRecords: 0,
      links: 0,
    });
    assert.equal(overview.environments[0].hostCount, 1);
    assert.equal(overview.lastImport, null);
  } finally {
    fixture.cleanup();
  }
});

test('未知 limit 与非法枚举被拒绝', () => {
  const fixture = createStore();
  try {
    const store = new OpsStore(fixture.db, { maxRows: 50, path: fixture.path });
    assert.throws(() => store.listEnvironments({ limit: 0 }), TypeError);
    assert.throws(() => store.listEnvironments({ limit: 500 }), TypeError);
    assert.throws(() => store.listEnvironments({ kind: 'nope' }), TypeError);
  } finally {
    fixture.cleanup();
  }
});
