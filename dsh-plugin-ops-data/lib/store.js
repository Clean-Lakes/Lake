/**
 * 运维资产仓库。所有 SQL 只在这里出现：写入方法供导入与宿主代码使用，
 * Agent 工具只调用本文件的查询方法。
 * @module dsh-plugin-ops-data/lib/store
 */

import { OpsDataError, bindable, withTransaction } from './db.js';
import {
  CREDENTIAL_KINDS,
  CREDENTIAL_PROVIDERS,
  ENVIRONMENT_KINDS,
  HOST_STATUSES,
  LINK_ENTITY_TYPES,
  LINK_ROLES,
  LINK_SUBJECT_TYPES,
  OPERATION_KINDS,
  OPERATION_OUTCOMES,
  OPERATION_SOURCES,
  SERVICE_KINDS,
  assertIsoTimestamp,
  booleanValue,
  newId,
  normalizeJsonObject,
  normalizeTags,
  nowIso,
  oneOf,
  optionalText,
  parseJsonObject,
  parseTags,
  positiveInteger,
  requireText,
} from './model.js';
import { SCHEMA_VERSION } from './schema.js';

/** LIKE 搜索：转义通配符，让用户输入的 % 和 _ 按字面匹配。 */
function likePattern(query) {
  const escaped = query.replace(/[\\%_]/g, (character) => `\\${character}`);
  return `%${escaped}%`;
}

function mapEnvironment(row, extra = {}) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    region: row.region ?? null,
    description: row.description ?? '',
    tags: parseTags(row.tags),
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  };
}

function mapHost(row) {
  return {
    id: row.id,
    environmentId: row.environment_id,
    environmentName: row.environment_name ?? null,
    name: row.name,
    address: row.address,
    port: row.port,
    sshUser: row.ssh_user ?? null,
    os: row.os ?? null,
    role: row.role ?? null,
    status: row.status,
    credential: row.credential_ref ? { name: row.credential_ref, kind: row.credential_kind ?? null, provider: row.credential_provider ?? null } : null,
    tags: parseTags(row.tags),
    notes: row.notes ?? null,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapService(row) {
  return {
    id: row.id,
    environmentId: row.environment_id,
    environmentName: row.environment_name ?? null,
    hostId: row.host_id ?? null,
    hostName: row.host_name ?? null,
    name: row.name,
    kind: row.kind,
    endpoint: row.endpoint ?? null,
    version: row.version ?? null,
    tags: parseTags(row.tags),
    notes: row.notes ?? null,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 凭据引用映射：结构上不存在任何承载密钥内容的字段。 */
function mapCredentialRef(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    provider: row.provider,
    locator: row.locator ?? null,
    description: row.description ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rotatedAt: row.rotated_at ?? null,
  };
}

function mapOperation(row) {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actor: row.actor ?? null,
    source: row.source,
    kind: row.kind,
    environmentId: row.environment_id ?? null,
    hostId: row.host_id ?? null,
    serviceId: row.service_id ?? null,
    summary: row.summary,
    detail: parseJsonObject(row.detail),
    outcome: row.outcome,
    correlationId: row.correlation_id ?? null,
  };
}

function mapLink(row) {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    role: row.role,
    createdAt: row.created_at,
  };
}

/** 运维资产仓库。 */
export class OpsStore {
  /**
   * @param {import('node:sqlite').DatabaseSync} db - 已迁移的连接。
   * @param {{maxRows: number}} options - 查询默认行数。
   */
  constructor(db, options = {}) {
    this.db = db;
    this.maxRows = options.maxRows ?? 50;
    this.cachedPath = options.path ?? null;
  }

  /** 归一化 limit：默认取配置值，上限 200。 */
  limitOf(value) {
    return positiveInteger(value, 'limit', { min: 1, max: 200, fallback: this.maxRows });
  }

  offsetOf(value) {
    return value === undefined || value === null || value === '' ? 0 : positiveInteger(value, 'offset', { min: 0, max: 1_000_000, fallback: 0 });
  }

  /** 概览：计数、环境摘要、最近导入。所有工具调用的入口，让模型先建立整体认识。 */
  overview() {
    const count = (table) => Number(this.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total);
    const environments = this.db
      .prepare(
        `SELECT e.id, e.name, e.kind, e.archived,
                (SELECT COUNT(*) FROM hosts h WHERE h.environment_id = e.id) AS host_count,
                (SELECT COUNT(*) FROM services s WHERE s.environment_id = e.id) AS service_count
         FROM environments e ORDER BY e.name LIMIT 100`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        archived: row.archived === 1,
        hostCount: Number(row.host_count),
        serviceCount: Number(row.service_count),
      }));
    const lastImport = this.db.prepare('SELECT * FROM imports ORDER BY started_at DESC LIMIT 1').get();
    return {
      schemaVersion: SCHEMA_VERSION,
      databasePath: this.cachedPath,
      counts: {
        environments: count('environments'),
        hosts: count('hosts'),
        services: count('services'),
        credentialRefs: count('credential_refs'),
        operationRecords: count('operation_records'),
        links: count('links'),
      },
      environments,
      lastImport: lastImport
        ? {
            sourcePath: lastImport.source_path,
            status: lastImport.status,
            counts: parseJsonObject(lastImport.counts),
            error: lastImport.error ?? null,
            startedAt: lastImport.started_at,
            finishedAt: lastImport.finished_at ?? null,
          }
        : null,
    };
  }

  /** 按 id 或名称解析环境。 */
  resolveEnvironment(ref) {
    const text = requireText(ref, 'environment');
    const row = this.db
      .prepare('SELECT * FROM environments WHERE id = ? OR name = ? ORDER BY id = ? DESC LIMIT 1')
      .get(text, text, text);
    if (!row) throw new OpsDataError('not-found', `找不到环境 ${JSON.stringify(text)}`);
    return mapEnvironment(row);
  }

  listEnvironments({ query, kind, includeArchived, limit, offset } = {}) {
    const conditions = [];
    const params = [];
    if (query !== undefined && query !== null && String(query).trim().length > 0) {
      conditions.push("(e.name LIKE ? ESCAPE '\\' OR e.description LIKE ? ESCAPE '\\' OR e.region LIKE ? ESCAPE '\\')");
      const pattern = likePattern(String(query).trim());
      params.push(pattern, pattern, pattern);
    }
    if (kind) {
      conditions.push('e.kind = ?');
      params.push(oneOf(kind, ENVIRONMENT_KINDS, 'kind'));
    }
    if (!booleanValue(includeArchived, 'includeArchived', false)) conditions.push('e.archived = 0');
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT e.*,
                (SELECT COUNT(*) FROM hosts h WHERE h.environment_id = e.id AND h.archived = 0) AS host_count,
                (SELECT COUNT(*) FROM services s WHERE s.environment_id = e.id AND s.archived = 0) AS service_count
         FROM environments e ${where} ORDER BY e.name LIMIT ? OFFSET ?`,
      )
      .all(...params, this.limitOf(limit), this.offsetOf(offset));
    return rows.map((row) => mapEnvironment(row, { hostCount: Number(row.host_count), serviceCount: Number(row.service_count) }));
  }

  /** 写入环境；同名视为同一条记录，保证导入可重复执行。 */
  upsertEnvironment(input = {}) {
    const name = requireText(input.name, 'name');
    const existing =
      (input.id ? this.db.prepare('SELECT id FROM environments WHERE id = ?').get(input.id) : undefined) ??
      this.db.prepare('SELECT id FROM environments WHERE name = ?').get(name);
    const now = nowIso();
    const record = {
      id: existing?.id ?? optionalText(input.id, 'id') ?? newId('env'),
      name,
      kind: oneOf(input.kind, ENVIRONMENT_KINDS, 'kind', 'other'),
      region: optionalText(input.region, 'region'),
      description: optionalText(input.description, 'description') ?? '',
      tags: normalizeTags(input.tags),
      archived: booleanValue(input.archived, 'archived', false) ? 1 : 0,
      createdAt: optionalText(input.createdAt, 'createdAt') ?? now,
      updatedAt: now,
    };
    if (existing) {
      this.db
        .prepare(
          `UPDATE environments SET name = ?, kind = ?, region = ?, description = ?, tags = ?, archived = ?, updated_at = ? WHERE id = ?`,
        )
        .run(record.name, record.kind, bindable(record.region), record.description, record.tags, record.archived, record.updatedAt, record.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO environments (id, name, kind, region, description, tags, archived, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(record.id, record.name, record.kind, bindable(record.region), record.description, record.tags, record.archived, record.createdAt, record.updatedAt);
    }
    return this.resolveEnvironment(record.id);
  }

  /** 按 id 或（环境 + 名称）解析主机。 */
  resolveHost(ref, environmentRef) {
    const text = requireText(ref, 'host');
    if (environmentRef) {
      const environment = this.resolveEnvironment(environmentRef);
      const row = this.db
        .prepare('SELECT * FROM hosts WHERE environment_id = ? AND (id = ? OR name = ?) LIMIT 1')
        .get(environment.id, text, text);
      if (!row) throw new OpsDataError('not-found', `环境 ${environment.name} 下找不到主机 ${JSON.stringify(text)}`);
      return this.hostView(row);
    }
    const rows = this.db.prepare('SELECT * FROM hosts WHERE id = ? OR name = ? LIMIT 2').all(text, text);
    if (rows.length === 0) throw new OpsDataError('not-found', `找不到主机 ${JSON.stringify(text)}`);
    if (rows.length > 1) {
      throw new OpsDataError('ambiguous', `主机名 ${JSON.stringify(text)} 在多个环境中存在，请同时给出 environment`);
    }
    return this.hostView(rows[0]);
  }

  /** 单行主机补齐环境名与凭据引用元数据。 */
  hostView(row) {
    const joined = this.db
      .prepare(
        `SELECT h.*, e.name AS environment_name, c.kind AS credential_kind, c.provider AS credential_provider
         FROM hosts h
         LEFT JOIN environments e ON e.id = h.environment_id
         LEFT JOIN credential_refs c ON c.name = h.credential_ref
         WHERE h.id = ?`,
      )
      .get(row.id);
    return mapHost(joined);
  }

  listHosts({ environment, query, tag, status, includeArchived, limit, offset } = {}) {
    const conditions = [];
    const params = [];
    if (environment) {
      conditions.push('h.environment_id = ?');
      params.push(this.resolveEnvironment(environment).id);
    }
    if (query !== undefined && query !== null && String(query).trim().length > 0) {
      conditions.push("(h.name LIKE ? ESCAPE '\\' OR h.address LIKE ? ESCAPE '\\' OR h.role LIKE ? ESCAPE '\\' OR h.notes LIKE ? ESCAPE '\\')");
      const pattern = likePattern(String(query).trim());
      params.push(pattern, pattern, pattern, pattern);
    }
    if (tag) {
      conditions.push("h.tags LIKE ? ESCAPE '\\'");
      params.push(`%${String(tag).trim().replace(/[\\%_]/g, (character) => `\\${character}`)}%`);
    }
    if (status) {
      conditions.push('h.status = ?');
      params.push(oneOf(status, HOST_STATUSES, 'status'));
    }
    if (!booleanValue(includeArchived, 'includeArchived', false)) conditions.push('h.archived = 0');
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT h.*, e.name AS environment_name, c.kind AS credential_kind, c.provider AS credential_provider
         FROM hosts h
         LEFT JOIN environments e ON e.id = h.environment_id
         LEFT JOIN credential_refs c ON c.name = h.credential_ref
         ${where} ORDER BY e.name, h.name LIMIT ? OFFSET ?`,
      )
      .all(...params, this.limitOf(limit), this.offsetOf(offset))
      .map(mapHost);
  }

  upsertHost(input = {}) {
    const environment = this.resolveEnvironment(input.environment ?? input.environmentId);
    const name = requireText(input.name, 'name');
    const existing =
      (input.id ? this.db.prepare('SELECT id FROM hosts WHERE id = ?').get(input.id) : undefined) ??
      this.db.prepare('SELECT id FROM hosts WHERE environment_id = ? AND name = ?').get(environment.id, name);
    const now = nowIso();
    const record = {
      id: existing?.id ?? optionalText(input.id, 'id') ?? newId('host'),
      environmentId: environment.id,
      name,
      address: requireText(input.address, 'address'),
      port: positiveInteger(input.port, 'port', { min: 1, max: 65535, fallback: 22 }),
      sshUser: optionalText(input.sshUser, 'sshUser'),
      os: optionalText(input.os, 'os'),
      role: optionalText(input.role, 'role'),
      status: oneOf(input.status, HOST_STATUSES, 'status', 'unknown'),
      credentialRef: optionalText(input.credentialRef, 'credentialRef'),
      tags: normalizeTags(input.tags),
      notes: optionalText(input.notes, 'notes'),
      archived: booleanValue(input.archived, 'archived', false) ? 1 : 0,
      createdAt: optionalText(input.createdAt, 'createdAt') ?? now,
      updatedAt: now,
    };
    if (record.credentialRef) {
      const known = this.db.prepare('SELECT name FROM credential_refs WHERE name = ?').get(record.credentialRef);
      if (!known) throw new OpsDataError('not-found', `主机引用的凭据 ${JSON.stringify(record.credentialRef)} 尚未登记`);
    }
    if (existing) {
      this.db
        .prepare(
          `UPDATE hosts SET environment_id = ?, name = ?, address = ?, port = ?, ssh_user = ?, os = ?, role = ?, status = ?,
                            credential_ref = ?, tags = ?, notes = ?, archived = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          record.environmentId,
          record.name,
          record.address,
          record.port,
          bindable(record.sshUser),
          bindable(record.os),
          bindable(record.role),
          record.status,
          bindable(record.credentialRef),
          record.tags,
          bindable(record.notes),
          record.archived,
          record.updatedAt,
          record.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO hosts (id, environment_id, name, address, port, ssh_user, os, role, status, credential_ref, tags, notes, archived, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.environmentId,
          record.name,
          record.address,
          record.port,
          bindable(record.sshUser),
          bindable(record.os),
          bindable(record.role),
          record.status,
          bindable(record.credentialRef),
          record.tags,
          bindable(record.notes),
          record.archived,
          record.createdAt,
          record.updatedAt,
        );
    }
    return this.hostView({ id: record.id });
  }

  listServices({ environment, host, kind, query, includeArchived, limit, offset } = {}) {
    const conditions = [];
    const params = [];
    if (environment) {
      conditions.push('s.environment_id = ?');
      params.push(this.resolveEnvironment(environment).id);
    }
    if (host) {
      conditions.push('s.host_id = ?');
      params.push(this.resolveHost(host, environment).id);
    }
    if (kind) {
      conditions.push('s.kind = ?');
      params.push(oneOf(kind, SERVICE_KINDS, 'kind'));
    }
    if (query !== undefined && query !== null && String(query).trim().length > 0) {
      conditions.push("(s.name LIKE ? ESCAPE '\\' OR s.endpoint LIKE ? ESCAPE '\\' OR s.version LIKE ? ESCAPE '\\')");
      const pattern = likePattern(String(query).trim());
      params.push(pattern, pattern, pattern);
    }
    if (!booleanValue(includeArchived, 'includeArchived', false)) conditions.push('s.archived = 0');
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT s.*, e.name AS environment_name, h.name AS host_name
         FROM services s
         LEFT JOIN environments e ON e.id = s.environment_id
         LEFT JOIN hosts h ON h.id = s.host_id
         ${where} ORDER BY e.name, s.name LIMIT ? OFFSET ?`,
      )
      .all(...params, this.limitOf(limit), this.offsetOf(offset))
      .map(mapService);
  }

  upsertService(input = {}) {
    const environment = this.resolveEnvironment(input.environment ?? input.environmentId);
    const name = requireText(input.name, 'name');
    const existing =
      (input.id ? this.db.prepare('SELECT id FROM services WHERE id = ?').get(input.id) : undefined) ??
      this.db.prepare('SELECT id FROM services WHERE environment_id = ? AND name = ?').get(environment.id, name);
    const now = nowIso();
    const hostId = input.host ? this.resolveHost(input.host, environment.name).id : optionalText(input.hostId, 'hostId');
    const record = {
      id: existing?.id ?? optionalText(input.id, 'id') ?? newId('svc'),
      environmentId: environment.id,
      hostId,
      name,
      kind: oneOf(input.kind, SERVICE_KINDS, 'kind', 'other'),
      endpoint: optionalText(input.endpoint, 'endpoint'),
      version: optionalText(input.version, 'version'),
      tags: normalizeTags(input.tags),
      notes: optionalText(input.notes, 'notes'),
      archived: booleanValue(input.archived, 'archived', false) ? 1 : 0,
      createdAt: optionalText(input.createdAt, 'createdAt') ?? now,
      updatedAt: now,
    };
    if (existing) {
      this.db
        .prepare(
          `UPDATE services SET environment_id = ?, host_id = ?, name = ?, kind = ?, endpoint = ?, version = ?, tags = ?, notes = ?, archived = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          record.environmentId,
          bindable(record.hostId),
          record.name,
          record.kind,
          bindable(record.endpoint),
          bindable(record.version),
          record.tags,
          bindable(record.notes),
          record.archived,
          record.updatedAt,
          record.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO services (id, environment_id, host_id, name, kind, endpoint, version, tags, notes, archived, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.environmentId,
          bindable(record.hostId),
          record.name,
          record.kind,
          bindable(record.endpoint),
          bindable(record.version),
          record.tags,
          bindable(record.notes),
          record.archived,
          record.createdAt,
          record.updatedAt,
        );
    }
    return mapService(
      this.db
        .prepare(
          `SELECT s.*, e.name AS environment_name, h.name AS host_name FROM services s
           LEFT JOIN environments e ON e.id = s.environment_id
           LEFT JOIN hosts h ON h.id = s.host_id WHERE s.id = ?`,
        )
        .get(record.id),
    );
  }

  listCredentialRefs({ query, kind, limit, offset } = {}) {
    const conditions = [];
    const params = [];
    if (query !== undefined && query !== null && String(query).trim().length > 0) {
      conditions.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR locator LIKE ? ESCAPE '\\')");
      const pattern = likePattern(String(query).trim());
      params.push(pattern, pattern, pattern);
    }
    if (kind) {
      conditions.push('kind = ?');
      params.push(oneOf(kind, CREDENTIAL_KINDS, 'kind'));
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM credential_refs ${where} ORDER BY name LIMIT ? OFFSET ?`)
      .all(...params, this.limitOf(limit), this.offsetOf(offset))
      .map(mapCredentialRef);
  }

  upsertCredentialRef(input = {}) {
    const name = requireText(input.name, 'name');
    const existing =
      (input.id ? this.db.prepare('SELECT id FROM credential_refs WHERE id = ?').get(input.id) : undefined) ??
      this.db.prepare('SELECT id FROM credential_refs WHERE name = ?').get(name);
    const now = nowIso();
    const record = {
      id: existing?.id ?? optionalText(input.id, 'id') ?? newId('cred'),
      name,
      kind: oneOf(input.kind, CREDENTIAL_KINDS, 'kind', 'other'),
      provider: oneOf(input.provider, CREDENTIAL_PROVIDERS, 'provider', 'unknown'),
      locator: optionalText(input.locator, 'locator'),
      description: optionalText(input.description, 'description'),
      rotatedAt: input.rotatedAt ? assertIsoTimestamp(input.rotatedAt, 'rotatedAt') : null,
      createdAt: optionalText(input.createdAt, 'createdAt') ?? now,
      updatedAt: now,
    };
    if (existing) {
      this.db
        .prepare(
          `UPDATE credential_refs SET name = ?, kind = ?, provider = ?, locator = ?, description = ?, rotated_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(record.name, record.kind, record.provider, bindable(record.locator), bindable(record.description), bindable(record.rotatedAt), record.updatedAt, record.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO credential_refs (id, name, kind, provider, locator, description, created_at, updated_at, rotated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(record.id, record.name, record.kind, record.provider, bindable(record.locator), bindable(record.description), record.createdAt, record.updatedAt, bindable(record.rotatedAt));
    }
    return mapCredentialRef(this.db.prepare('SELECT * FROM credential_refs WHERE id = ?').get(record.id));
  }

  queryJournal({ environment, host, service, kind, outcome, since, until, limit, offset } = {}) {
    const conditions = [];
    const params = [];
    if (environment) {
      conditions.push('environment_id = ?');
      params.push(this.resolveEnvironment(environment).id);
    }
    if (host) {
      conditions.push('host_id = ?');
      params.push(this.resolveHost(host, environment).id);
    }
    if (service) {
      const serviceId = this.db.prepare('SELECT id FROM services WHERE id = ? OR name = ? LIMIT 1').get(String(service), String(service));
      if (!serviceId) throw new OpsDataError('not-found', `找不到服务 ${JSON.stringify(String(service))}`);
      conditions.push('service_id = ?');
      params.push(serviceId.id);
    }
    if (kind) {
      conditions.push('kind = ?');
      params.push(oneOf(kind, OPERATION_KINDS, 'kind'));
    }
    if (outcome) {
      conditions.push('outcome = ?');
      params.push(oneOf(outcome, OPERATION_OUTCOMES, 'outcome'));
    }
    if (since) {
      conditions.push('occurred_at >= ?');
      params.push(assertIsoTimestamp(since, 'since'));
    }
    if (until) {
      conditions.push('occurred_at <= ?');
      params.push(assertIsoTimestamp(until, 'until'));
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM operation_records ${where} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, this.limitOf(limit), this.offsetOf(offset))
      .map(mapOperation);
  }

  /** 追加操作记录。重复 id 直接跳过，保证导入幂等。 */
  appendOperation(input = {}) {
    const record = {
      id: optionalText(input.id, 'id') ?? newId('op'),
      occurredAt: input.occurredAt ? assertIsoTimestamp(input.occurredAt, 'occurredAt') : nowIso(),
      actor: optionalText(input.actor, 'actor'),
      source: oneOf(input.source, OPERATION_SOURCES, 'source', 'agent'),
      kind: oneOf(input.kind, OPERATION_KINDS, 'kind', 'other'),
      environmentId: optionalText(input.environmentId, 'environmentId'),
      hostId: optionalText(input.hostId, 'hostId'),
      serviceId: optionalText(input.serviceId, 'serviceId'),
      summary: requireText(input.summary, 'summary'),
      detail: normalizeJsonObject(input.detail),
      outcome: oneOf(input.outcome, OPERATION_OUTCOMES, 'outcome', 'unknown'),
      correlationId: optionalText(input.correlationId, 'correlationId'),
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO operation_records
           (id, occurred_at, actor, source, kind, environment_id, host_id, service_id, summary, detail, outcome, correlation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.occurredAt,
        bindable(record.actor),
        record.source,
        record.kind,
        bindable(record.environmentId),
        bindable(record.hostId),
        bindable(record.serviceId),
        record.summary,
        record.detail,
        record.outcome,
        bindable(record.correlationId),
        record.createdAt,
      );
    return record.id;
  }

  listLinks({ subjectType, subjectId, entityType, entityId, limit, offset } = {}) {
    const conditions = [];
    const params = [];
    if (subjectType) {
      conditions.push('subject_type = ?');
      params.push(oneOf(subjectType, LINK_SUBJECT_TYPES, 'subjectType'));
    }
    if (subjectId) {
      conditions.push('subject_id = ?');
      params.push(requireText(subjectId, 'subjectId'));
    }
    if (entityType) {
      conditions.push('entity_type = ?');
      params.push(oneOf(entityType, LINK_ENTITY_TYPES, 'entityType'));
    }
    if (entityId) {
      conditions.push('entity_id = ?');
      params.push(requireText(entityId, 'entityId'));
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM links ${where} ORDER BY created_at, id LIMIT ? OFFSET ?`)
      .all(...params, this.limitOf(limit), this.offsetOf(offset))
      .map(mapLink);
  }

  upsertLink(input = {}) {
    const record = {
      id: optionalText(input.id, 'id') ?? newId('link'),
      entityType: oneOf(input.entityType, LINK_ENTITY_TYPES, 'entityType'),
      entityId: requireText(input.entityId, 'entityId'),
      subjectType: oneOf(input.subjectType, LINK_SUBJECT_TYPES, 'subjectType'),
      subjectId: requireText(input.subjectId, 'subjectId'),
      role: oneOf(input.role, LINK_ROLES, 'role', 'related'),
      createdAt: optionalText(input.createdAt, 'createdAt') ?? nowIso(),
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO links (id, entity_type, entity_id, subject_type, subject_id, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.entityType, record.entityId, record.subjectType, record.subjectId, record.role, record.createdAt);
    const row = this.db
      .prepare('SELECT * FROM links WHERE entity_type = ? AND entity_id = ? AND subject_type = ? AND subject_id = ? AND role = ?')
      .get(record.entityType, record.entityId, record.subjectType, record.subjectId, record.role);
    return mapLink(row);
  }

  /** 查询某次导入的记账。 */
  findImport(sourcePath, fingerprint) {
    const row = this.db.prepare('SELECT * FROM imports WHERE source_path = ? AND source_fingerprint = ?').get(sourcePath, fingerprint);
    return row ? { id: row.id, status: row.status, counts: parseJsonObject(row.counts), error: row.error ?? null } : null;
  }

  startImport(sourcePath, fingerprint) {
    const id = newId('import');
    this.db
      .prepare('INSERT INTO imports (id, source_path, source_fingerprint, status, counts, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, sourcePath, fingerprint, 'running', '{}', nowIso());
    return id;
  }

  finishImport(id, status, counts, error = null) {
    this.db
      .prepare('UPDATE imports SET status = ?, counts = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(status, JSON.stringify(counts ?? {}), bindable(error), nowIso(), id);
  }

  /** 在单个事务内执行导入写入，失败整体回滚。 */
  transact(operation) {
    return withTransaction(this.db, operation);
  }

  close() {
    this.db.close();
  }
}
