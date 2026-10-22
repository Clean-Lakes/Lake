/**
 * SQLite schema 定义与迁移清单。schema 版本存在 `PRAGMA user_version`。
 * 迁移只追加：已发布的迁移不得修改，否则已升级的库无法复现。
 * @module dsh-plugin-ops-data/lib/schema
 */

/** 当前 schema 版本。 */
export const SCHEMA_VERSION = 1;

/** 按版本顺序排列的迁移；索引 0 对应 user_version 0 → 1。 */
export const MIGRATIONS = [
  `
  CREATE TABLE environments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    region TEXT,
    description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE credential_refs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    provider TEXT NOT NULL,
    locator TEXT,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    rotated_at TEXT
  );

  CREATE TABLE hosts (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    ssh_user TEXT,
    os TEXT,
    role TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    credential_ref TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (environment_id, name)
  );
  CREATE INDEX hosts_environment_idx ON hosts(environment_id, name);
  CREATE INDEX hosts_address_idx ON hosts(address);

  CREATE TABLE services (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    endpoint TEXT,
    version TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (environment_id, name)
  );
  CREATE INDEX services_environment_idx ON services(environment_id, name);
  CREATE INDEX services_host_idx ON services(host_id);

  CREATE TABLE operation_records (
    id TEXT PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    actor TEXT,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
    host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
    service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
    summary TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    outcome TEXT NOT NULL,
    correlation_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX operation_records_time_idx ON operation_records(occurred_at DESC, id);
  CREATE INDEX operation_records_host_idx ON operation_records(host_id, occurred_at DESC);
  CREATE INDEX operation_records_environment_idx ON operation_records(environment_id, occurred_at DESC);

  CREATE TABLE links (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'related',
    created_at TEXT NOT NULL,
    UNIQUE (entity_type, entity_id, subject_type, subject_id, role)
  );
  CREATE INDEX links_subject_idx ON links(subject_type, subject_id);
  CREATE INDEX links_entity_idx ON links(entity_type, entity_id);

  CREATE TABLE imports (
    id TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL,
    counts TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE (source_path, source_fingerprint)
  );
  CREATE INDEX imports_source_idx ON imports(source_path, started_at DESC);
  `,
];
