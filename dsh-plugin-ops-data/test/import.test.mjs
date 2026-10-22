/**
 * 旧库导入测试：字段映射、幂等、只读旧库、失败可见。
 * @module dsh-plugin-ops-data/test/import.test
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { importLegacyLake } from '../lib/import-lake.js';
import { createStore } from './helpers.mjs';

const LEGACY_TS = 1790682997638;

/** 建一个与真实旧库同结构的合成库。 */
function buildLegacy(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE lake (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE resource (
      id TEXT PRIMARY KEY,
      lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      spec TEXT NOT NULL,
      execute_authz INTEGER NOT NULL DEFAULT 0,
      env TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (lake_id, name)
    );
    CREATE TABLE journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      run_id TEXT,
      action_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      target_path TEXT NOT NULL,
      tool TEXT NOT NULL,
      risk TEXT NOT NULL,
      event TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      exit_code INTEGER,
      duration_ms INTEGER
    );
    CREATE TABLE link (
      from_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id, type)
    );
  `);
  db.prepare('INSERT INTO lake VALUES (?, ?, ?, ?, ?)').run('L1', '测试湖', '导入用湖', LEGACY_TS, LEGACY_TS);
  const insertResource = db.prepare('INSERT INTO resource VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insertResource.run(
    'R1',
    'L1',
    'host',
    'web-01',
    JSON.stringify({ ssh: { host: '10.0.0.11', port: 2222, username: 'ops' } }),
    1,
    'prod',
    JSON.stringify({ team: 'web' }),
    LEGACY_TS,
    LEGACY_TS,
  );
  insertResource.run(
    'R2',
    'L1',
    'k8s',
    'cluster-a',
    JSON.stringify({ host: '10.0.0.20', port: 6443 }),
    0,
    '',
    '{}',
    LEGACY_TS,
    LEGACY_TS,
  );
  const insertJournal = db.prepare('INSERT INTO journal (ts, run_id, action_id, actor, target_path, tool, risk, event, detail, exit_code, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insertJournal.run(LEGACY_TS, 'run-1', 'act-1', 'agent', 'ssh://web-01', 'lake_ssh', 'write', 'completed', '{"command":"uptime"}', 0, 120);
  insertJournal.run(LEGACY_TS + 1000, 'run-2', 'act-2', 'cli', 'ssh://web-01', 'lake_ssh_read', 'read', 'failed', '', 1, 30);
  db.prepare('INSERT INTO link VALUES (?, ?, ?, ?)').run('R1', 'R2', 'connects_to', LEGACY_TS);
  db.close();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function withLegacy(run) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-data-legacy-'));
  const legacyPath = join(dir, 'lake.db');
  buildLegacy(legacyPath);
  try {
    return run({ legacyPath, dir, before: sha256(legacyPath) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('导入映射环境、主机、服务、操作记录与关联', () => {
  withLegacy(({ legacyPath, before }) => {
    const fixture = createStore();
    try {
      const result = importLegacyLake(fixture.store, { path: legacyPath });
      assert.equal(result.status, 'imported');
      assert.deepEqual(result.counts, {
        environments: 1,
        hosts: 1,
        services: 1,
        operationRecords: 2,
        links: 1,
        skippedResources: 0,
      });

      const [environment] = fixture.store.listEnvironments({});
      assert.equal(environment.id, 'lake:L1');
      assert.equal(environment.name, '测试湖');
      assert.equal(environment.kind, 'other');
      assert.equal(environment.description, '导入用湖');
      assert.equal(environment.hostCount, 1);
      assert.equal(environment.serviceCount, 1);

      const [host] = fixture.store.listHosts({});
      assert.equal(host.id, 'lake:R1');
      assert.equal(host.name, 'web-01');
      assert.equal(host.address, '10.0.0.11');
      assert.equal(host.port, 2222);
      assert.equal(host.sshUser, 'ops');
      assert.equal(host.environmentName, '测试湖');
      assert.equal(host.credential, null);
      assert.deepEqual(host.tags, ['team=web', 'env=prod']);
      assert.match(host.notes, /execute_authz=1/);

      const [service] = fixture.store.listServices({});
      assert.equal(service.kind, 'kubernetes');
      assert.equal(service.endpoint, '10.0.0.20:6443');

      const records = fixture.store.queryJournal({});
      assert.equal(records.length, 2);
      // 倒序：较新的 read/failed 在前。
      assert.equal(records[0].id, `lake:journal:2`);
      assert.equal(records[0].kind, 'inspect');
      assert.equal(records[0].outcome, 'failure');
      assert.equal(records[0].actor, 'legacy-cli');
      assert.equal(records[1].kind, 'change');
      assert.equal(records[1].outcome, 'success');
      assert.equal(records[1].detail.legacyDetail, '{"command":"uptime"}');
      assert.equal(records[1].detail.targetPath, 'ssh://web-01');
      assert.equal(records[1].occurredAt, new Date(LEGACY_TS).toISOString());

      const [link] = fixture.store.listLinks({});
      assert.equal(link.entityType, 'host');
      assert.equal(link.entityId, 'lake:R1');
      assert.equal(link.subjectType, 'legacy_resource');
      assert.equal(link.subjectId, 'R2');
      assert.equal(link.role, 'connects_to');

      // 旧库必须保持字节级不变。
      assert.equal(sha256(legacyPath), before);
    } finally {
      fixture.cleanup();
    }
  });
});

test('相同指纹重复导入不产生副本', () => {
  withLegacy(({ legacyPath }) => {
    const fixture = createStore();
    try {
      importLegacyLake(fixture.store, { path: legacyPath });
      const second = importLegacyLake(fixture.store, { path: legacyPath });
      assert.equal(second.status, 'already-imported');
      assert.equal(fixture.store.overview().counts.operationRecords, 2);
      assert.equal(fixture.store.overview().counts.hosts, 1);
    } finally {
      fixture.cleanup();
    }
  });
});

test('源指纹变化时重跑，实体 upsert、记录不重复', () => {
  withLegacy(({ legacyPath }) => {
    const fixture = createStore();
    try {
      importLegacyLake(fixture.store, { path: legacyPath });
      const db = new DatabaseSync(legacyPath);
      db.prepare('UPDATE resource SET name = ? WHERE id = ?').run('web-01-renamed', 'R1');
      db.close();
      const second = importLegacyLake(fixture.store, { path: legacyPath });
      assert.equal(second.status, 'imported');
      assert.equal(fixture.store.overview().counts.hosts, 1);
      assert.equal(fixture.store.overview().counts.operationRecords, 2);
      const [host] = fixture.store.listHosts({});
      assert.equal(host.name, 'web-01-renamed');
    } finally {
      fixture.cleanup();
    }
  });
});

test('旧库缺失时记录失败并保持数据层可用', () => {
  const fixture = createStore();
  try {
    const result = importLegacyLake(fixture.store, { path: '/nonexistent/lake.db' });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /不存在/);
    const overview = fixture.store.overview();
    assert.equal(overview.lastImport.status, 'failed');
    assert.equal(overview.lastImport.sourcePath, '/nonexistent/lake.db');
    assert.equal(overview.counts.environments, 0);
  } finally {
    fixture.cleanup();
  }
});

test('dry-run 只统计不写入', () => {
  withLegacy(({ legacyPath }) => {
    const fixture = createStore();
    try {
      const result = importLegacyLake(fixture.store, { path: legacyPath, dryRun: true });
      assert.equal(result.status, 'dry-run');
      assert.equal(result.counts.hosts, 1);
      assert.equal(fixture.store.overview().counts.environments, 0);
      assert.equal(fixture.store.overview().lastImport, null);
    } finally {
      fixture.cleanup();
    }
  });
});
