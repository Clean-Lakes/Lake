/**
 * SQLite 打开、迁移与事务。数据库文件是插件私有状态，不进入 session log。
 * @module dsh-plugin-ops-data/lib/db
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';

/** 打开失败（例如文件被更高版本的代码写过）时抛出。 */
export class OpsDataError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'OpsDataError';
    this.code = code;
  }
}

/** 读取 schema 版本。 */
export function readSchemaVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

/**
 * 打开数据库并把 schema 升到当前版本。
 * 比当前版本更高的库直接拒绝，避免旧代码写坏新结构。
 * @param {string} path - 数据库文件的绝对路径。
 * @returns {DatabaseSync} 已迁移的连接。
 */
export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** 顺序执行未应用的迁移；整个过程在一个事务内。 */
export function migrate(db) {
  const current = readSchemaVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new OpsDataError(
      'schema-too-new',
      `运维数据层数据库 schema 版本 ${current} 高于当前支持的 ${SCHEMA_VERSION}；请升级插件而不是用旧代码打开`,
    );
  }
  if (current === SCHEMA_VERSION) return current;
  withTransaction(db, () => {
    for (let version = current; version < SCHEMA_VERSION; version += 1) {
      db.exec(MIGRATIONS[version]);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
  return SCHEMA_VERSION;
}

/** 事务包装：回调抛错则整体回滚，原始错误继续向上抛。 */
export function withTransaction(db, operation) {
  db.exec('BEGIN');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败时保留原始错误：它才是调用方需要看到的根因。
    }
    throw error;
  }
}

/** 把可选参数转成 SQLite 可接受的绑定值（undefined 会直接报错）。 */
export function bindable(value) {
  return value === undefined ? null : value;
}
