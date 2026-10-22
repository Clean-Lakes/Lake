/**
 * 插件入口测试：用假 Context 走一遍加载器会调用的 `apply`，并验证参数校验与清理。
 * @module dsh-plugin-ops-data/test/plugin.test
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply, inject, name } from '../lib/index.js';
import { resolveConfig, resolveDefaultDatabasePath } from '../lib/config.js';

/** 最小可用的 Cordis Context 替身。 */
function createFakeContext() {
  const tools = new Map();
  const services = new Map();
  const effects = [];
  return {
    tools,
    services,
    effects,
    ctx: {
      effect(callback) {
        effects.push(callback);
        return () => {};
      },
      provide(serviceName, value) {
        services.set(serviceName, value);
        return () => services.delete(serviceName);
      },
      tools: {
        register(definition) {
          if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
          tools.set(definition.name, definition);
          return () => tools.delete(definition.name);
        },
      },
      logger: { info() {}, warn() {}, error() {} },
    },
  };
}

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-data-plugin-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('插件元数据与依赖声明符合 Harness 约定', () => {
  assert.equal(name, 'ops-data');
  assert.deepEqual(inject, ['tools']);
});

test('apply 建库、注册 6 个工具并提供 opsData 服务', () => {
  withTempDir((dir) => {
    const fake = createFakeContext();
    apply(fake.ctx, { databasePath: join(dir, 'ops.db'), maxRows: 10 });

    assert.deepEqual([...fake.tools.keys()].sort(), [
      'ops_credentials',
      'ops_environments',
      'ops_hosts',
      'ops_journal',
      'ops_overview',
      'ops_services',
    ]);
    const service = fake.services.get('opsData');
    assert.equal(service.databasePath, join(dir, 'ops.db'));
    assert.equal(service.schemaVersion, 1);
    assert.equal(service.maxRows, 10);

    const overview = fake.tools.get('ops_overview').execute({}, {});
    assert.equal(overview.counts.environments, 0);
    assert.equal(overview.databasePath, join(dir, 'ops.db'));

    // 通过服务写入，再通过工具读出：证明服务与工具共用同一份状态。
    service.store.upsertEnvironment({ name: '生产', kind: 'production' });
    assert.equal(fake.tools.get('ops_environments').execute({}).count, 1);

    // 清理：工具注销、数据库关闭。
    for (const effect of fake.effects) effect()();
    assert.equal(fake.tools.size, 0);
    assert.throws(() => service.store.overview());
  });
});

test('apply 在旧库缺失时不抛错，并把失败暴露给 ops_overview', () => {
  withTempDir((dir) => {
    const fake = createFakeContext();
    apply(fake.ctx, {
      databasePath: join(dir, 'ops.db'),
      legacyImport: { enabled: true, path: join(dir, 'missing.db') },
    });
    const overview = fake.tools.get('ops_overview').execute({}, {});
    assert.equal(overview.lastImport.present, true);
    assert.equal(overview.lastImport.status, 'failed');
    assert.match(overview.lastImport.error, /不存在/);
  });
});

test('参数校验拒绝未知参数、错误类型与非法枚举', () => {
  withTempDir((dir) => {
    const fake = createFakeContext();
    apply(fake.ctx, { databasePath: join(dir, 'ops.db') });
    const hosts = fake.tools.get('ops_hosts');
    assert.throws(() => hosts.execute({ nope: 1 }, {}), /is not a declared parameter/);
    assert.throws(() => hosts.execute({ limit: 'many' }, {}), /limit must be a integer/);
    assert.throws(() => hosts.execute({ status: 'green' }, {}), /status must be one of/);
    assert.throws(() => hosts.execute({ environment: 5 }, {}), /environment must be a string/);
    // 合法的空参数与省略的可选参数都要通过。
    assert.equal(hosts.execute({}, {}).count, 0);
    assert.equal(hosts.execute({ limit: 5, status: 'online' }, {}).count, 0);
  });
});

test('resolveConfig 归一化默认值与非法输入', () => {
  assert.deepEqual(resolveConfig({}), {
    databasePath: null,
    maxRows: 50,
    legacyImport: { enabled: false, path: null },
  });
  assert.equal(resolveConfig({ maxRows: 9999 }).maxRows, 200);
  assert.equal(resolveConfig({ maxRows: 0 }).maxRows, 1);
  assert.equal(resolveConfig({ databasePath: '  /tmp/x.db  ' }).databasePath, '/tmp/x.db');
  assert.throws(() => resolveConfig({ maxRows: 'many' }), /maxRows/);
  assert.throws(() => resolveConfig({ legacyImport: 'nope' }), /legacyImport/);
});

test('默认库路径遵循 DSH_HOME 优先级', () => {
  assert.equal(resolveDefaultDatabasePath({}, '/home/u'), join('/home/u', '.dsh', 'storages', 'ops-data', 'ops.db'));
  assert.equal(
    resolveDefaultDatabasePath({ DSH_HOME: '/custom' }, '/home/u'),
    join('/custom', 'storages', 'ops-data', 'ops.db'),
  );
  // 空白 DSH_HOME 视为未设置，避免把 home 解析到当前目录。
  assert.equal(resolveDefaultDatabasePath({ DSH_HOME: '   ' }, '/home/u'), join('/home/u', '.dsh', 'storages', 'ops-data', 'ops.db'));
});
