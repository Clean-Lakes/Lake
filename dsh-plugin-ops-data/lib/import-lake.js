/**
 * 旧 LAKE 库（~/.lake/lake.db）的一次性语义导入。
 *
 * 只读旧库、只复制白名单字段：绝不读取 vault 或任何凭据值，也绝不写回旧库。
 * 幂等性由 (source_path, sha256) 记账保证；重复导入用 upsert / INSERT OR IGNORE 收敛。
 * @module dsh-plugin-ops-data/lib/import-lake
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { epochMsToIso } from './model.js';

/** 旧库默认位置。 */
export const DEFAULT_LEGACY_PATH = join(homedir(), '.lake', 'lake.db');

/** 旧库字段进入 detail 的最大长度，避免把超长原始文本灌进模型上下文。 */
const MAX_LEGACY_DETAIL = 2000;

/** 旧 resource.kind → 新 service.kind。 */
const SERVICE_KIND_MAP = {
  k8s: 'kubernetes',
  mysql: 'mysql',
  postgres: 'postgres',
  starrocks: 'starrocks',
};

/** 旧 journal.risk → 新 operation kind。 */
const OPERATION_KIND_MAP = { none: 'query', read: 'inspect', write: 'change', block: 'other' };

/** 旧 journal.event → 新 outcome。 */
const OPERATION_OUTCOME_MAP = {
  completed: 'success',
  failed: 'failure',
  denied: 'skipped',
  unknown: 'unknown',
};

/** 计算文件 sha256；文件不存在返回 null。 */
export function fingerprintFile(path) {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 旧库表名存在性检查。 */
function tableNames(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return new Set(rows.map((row) => String(row.name)));
}

/** 解析旧 resource.spec；只取白名单字段，绝不整体转发。 */
function parseSpec(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 旧库的标签是 JSON 对象；新模型用字符串数组。对象转 `k=v`，数组原样保留，
 * 再把非空的 `resource.env` 作为 `env=<值>` 追加进去。
 */
function legacyTags(rawTags, env) {
  const tags = [];
  if (typeof rawTags === 'string' && rawTags.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawTags);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) if (typeof entry === 'string' && entry.trim().length > 0) tags.push(entry.trim());
      } else if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed)) tags.push(`${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
      }
    } catch {
      // 旧库标签不是合法 JSON 时忽略，不阻断导入。
    }
  }
  if (typeof env === 'string' && env.trim().length > 0) tags.push(`env=${env.trim()}`);
  return tags;
}

/** 主机地址三元组，仅来自 spec.ssh 或 spec 顶层同名键。 */
function hostFields(spec) {
  const ssh = spec.ssh && typeof spec.ssh === 'object' ? spec.ssh : {};
  const host = ssh.host ?? spec.host;
  const port = ssh.port ?? spec.port;
  const username = ssh.username ?? spec.username;
  return {
    address: typeof host === 'string' && host.trim().length > 0 ? host.trim() : null,
    port: Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) <= 65535 ? Number(port) : 22,
    sshUser: typeof username === 'string' && username.trim().length > 0 ? username.trim() : null,
  };
}

/** 服务 endpoint，仅由 spec.host / spec.port 组装，不接受其它键。 */
function serviceEndpoint(spec) {
  const host = typeof spec.host === 'string' ? spec.host.trim() : '';
  if (host.length === 0) return null;
  const port = Number(spec.port);
  return Number.isInteger(port) && port > 0 ? `${host}:${port}` : host;
}

/** 单行摘要，压成一行并限长。 */
function oneLine(parts) {
  const text = parts.filter((part) => part !== null && part !== undefined && String(part).length > 0).join(' ');
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** 旧 journal.detail 是有界文本，超长截断。 */
function legacyDetail(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length > MAX_LEGACY_DETAIL ? `${value.slice(0, MAX_LEGACY_DETAIL)}…` : value;
}

/**
 * 导入旧 LAKE 库。
 * @param {import('./store.js').OpsStore} store - 目标仓库。
 * @param {{path?: string, dryRun?: boolean, onWarn?: (message: string) => void}} [options]
 * @returns {{status: string, sourcePath: string, fingerprint: string, counts: Record<string, number>}}
 */
export function importLegacyLake(store, options = {}) {
  const sourcePath = options.path ?? DEFAULT_LEGACY_PATH;
  if (!existsSync(sourcePath)) {
    return recordFailure(store, sourcePath, 'missing', `旧 LAKE 库不存在：${sourcePath}`, options);
  }
  const fingerprint = fingerprintFile(sourcePath);
  if (!fingerprint) {
    return recordFailure(store, sourcePath, 'unreadable', `无法读取旧 LAKE 库：${sourcePath}`, options);
  }

  if (options.dryRun !== true) {
    const previous = store.findImport(sourcePath, fingerprint);
    if (previous?.status === 'completed') {
      return { status: 'already-imported', sourcePath, fingerprint, counts: previous.counts };
    }
  }

  const legacy = openLegacy(sourcePath, options.onWarn);
  let collected;
  try {
    collected = collect(legacy);
  } finally {
    legacy.close();
  }

  if (options.dryRun === true) {
    return { status: 'dry-run', sourcePath, fingerprint, counts: collected.summary };
  }

  const importId = store.startImport(sourcePath, fingerprint);
  try {
    store.transact(() => apply(store, collected.rows));
  } catch (error) {
    store.finishImport(importId, 'failed', {}, error instanceof Error ? error.message : String(error));
    throw error;
  }
  const summary = collected.summary;
  store.finishImport(importId, 'completed', summary);
  return { status: 'imported', sourcePath, fingerprint, counts: summary };
}

/**
 * 记录一次无法开始的导入。缺少源文件属于配置问题，不应该让整个数据层失效：
 * 失败会留在 imports 表中，通过 ops_overview 的 lastImport 暴露。
 */
function recordFailure(store, sourcePath, marker, message, options) {
  const result = { status: 'failed', sourcePath, fingerprint: marker, counts: {}, error: message };
  if (options.dryRun === true) return result;
  const id = store.startImport(sourcePath, marker);
  store.finishImport(id, 'failed', {}, message);
  return result;
}

/**
 * 只读打开旧库。WAL 库在只读模式下可能因缺少 -shm 而打不开，此时回退到可写连接；
 * 回退只放宽文件打开方式，本模块仍然只发出 SELECT。
 */
function openLegacy(path, onWarn) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    onWarn?.(`旧库只读打开失败，改用普通连接（仍只执行 SELECT）：${error instanceof Error ? error.message : String(error)}`);
    return new DatabaseSync(path);
  }
}

/** 读取并映射旧库所有行；不做任何写入。 */
function collect(legacy) {
  const tables = tableNames(legacy);
  const rows = {
    environments: [],
    hosts: [],
    services: [],
    operations: [],
    links: [],
    entityIndex: new Map(),
  };
  let skippedResources = 0;

  if (tables.has('lake')) {
    for (const lake of legacy.prepare('SELECT id, name, description, created_at, updated_at FROM lake').all()) {
      rows.environments.push({
        id: `lake:${lake.id}`,
        name: String(lake.name),
        kind: 'other',
        description: typeof lake.description === 'string' ? lake.description : '',
        tags: [],
        createdAt: epochMsToIso(lake.created_at),
      });
    }
  }

  if (tables.has('resource')) {
    const resources = legacy
      .prepare('SELECT id, lake_id, kind, name, spec, execute_authz, env, tags, created_at FROM resource')
      .all();
    for (const resource of resources) {
      const spec = parseSpec(resource.spec);
      const environmentId = `lake:${resource.lake_id}`;
      const legacyId = `lake:${resource.id}`;
      const tags = legacyTags(resource.tags, resource.env);
      if (resource.kind === 'host') {
        const fields = hostFields(spec);
        if (!fields.address) {
          skippedResources += 1;
          continue;
        }
        rows.hosts.push({
          id: legacyId,
          environment: environmentId,
          name: String(resource.name),
          address: fields.address,
          port: fields.port,
          sshUser: fields.sshUser,
          status: 'unknown',
          tags,
          notes: oneLine([
            '由旧 LAKE resource 导入',
            `kind=${resource.kind}`,
            resource.execute_authz === 1 ? '旧库标记 execute_authz=1（本层不构成执行授权）' : null,
          ]),
          createdAt: epochMsToIso(resource.created_at),
        });
        rows.entityIndex.set(resource.id, { entityType: 'host', entityId: legacyId });
      } else {
        const kind = SERVICE_KIND_MAP[resource.kind] ?? 'other';
        rows.services.push({
          id: legacyId,
          environment: environmentId,
          name: String(resource.name),
          kind,
          endpoint: serviceEndpoint(spec),
          tags,
          notes: oneLine(['由旧 LAKE resource 导入', `旧 kind=${resource.kind}`]),
          createdAt: epochMsToIso(resource.created_at),
        });
        rows.entityIndex.set(resource.id, { entityType: 'service', entityId: legacyId });
      }
    }
  }

  if (tables.has('journal')) {
    for (const entry of legacy
      .prepare('SELECT id, ts, run_id, action_id, actor, target_path, tool, risk, event, detail, exit_code, duration_ms FROM journal')
      .all()) {
      const kind = OPERATION_KIND_MAP[entry.risk] ?? 'other';
      const outcome = OPERATION_OUTCOME_MAP[entry.event] ?? 'unknown';
      const detail = legacyDetail(entry.detail);
      rows.operations.push({
        id: `lake:journal:${entry.id}`,
        occurredAt: epochMsToIso(entry.ts),
        actor: typeof entry.actor === 'string' ? `legacy-${entry.actor}` : 'importer',
        source: 'import',
        kind,
        summary: oneLine([entry.tool, entry.event, entry.target_path]),
        detail: {
          legacyJournalId: entry.id,
          legacyActionId: entry.action_id,
          legacyRunId: entry.run_id,
          legacyEvent: entry.event,
          legacyRisk: entry.risk,
          legacyTool: entry.tool,
          targetPath: entry.target_path,
          exitCode: entry.exit_code,
          durationMs: entry.duration_ms,
          legacyDetail: detail,
        },
        outcome,
        createdAt: epochMsToIso(entry.ts),
      });
    }
  }

  if (tables.has('link')) {
    for (const entry of legacy.prepare('SELECT from_id, to_id, type, created_at FROM link').all()) {
      const from = rows.entityIndex.get(entry.from_id);
      const to = rows.entityIndex.get(entry.to_id);
      if (!from || !to) continue;
      rows.links.push({
        entityType: from.entityType,
        entityId: from.entityId,
        subjectType: 'legacy_resource',
        subjectId: String(entry.to_id),
        role: typeof entry.type === 'string' ? entry.type : 'related',
        createdAt: epochMsToIso(entry.created_at),
      });
    }
  }

  const summary = {
    environments: rows.environments.length,
    hosts: rows.hosts.length,
    services: rows.services.length,
    operationRecords: rows.operations.length,
    links: rows.links.length,
    skippedResources,
  };
  return { summary, rows };
}

/** 把映射结果写入仓库；调用方已经开启事务。 */
function apply(store, rows) {
  for (const environment of rows.environments) store.upsertEnvironment(environment);
  for (const host of rows.hosts) store.upsertHost(host);
  for (const service of rows.services) store.upsertService(service);
  for (const operation of rows.operations) store.appendOperation(operation);
  for (const link of rows.links) store.upsertLink(link);
}
