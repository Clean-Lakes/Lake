/**
 * 插件配置：纯函数实现，不依赖 Harness 包，便于本地测试与安装。
 *
 * 本插件刻意不导入 `@deepseek-ai/*`：profile 安装的包以符号链接进入
 * profile 的 node_modules，而 dsh 自带包并不在其中，裸导入会解析失败。
 * 因此配置校验（而不是 schemastery schema）与 DSH home 解析都在这里自实现。
 * @module dsh-plugin-ops-data/lib/config
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** 工具默认返回行数的下限与上限。 */
export const MIN_ROWS = 1;
export const MAX_ROWS = 200;
export const DEFAULT_ROWS = 50;

/** 默认数据库在 DSH home 下的相对路径。 */
export const DATABASE_SEGMENTS = ['storages', 'ops-data', 'ops.db'];

/**
 * 解析默认数据库路径，优先级与 `@deepseek-ai/dsh-home-paths` 的 `dshHomePath` 一致：
 * 显式配置（调用方处理）> `$DSH_HOME` > `~/.dsh`。
 * @param {NodeJS.ProcessEnv} [env] - 环境变量表。
 * @param {string} [home] - 操作系统 home。
 * @returns {string} 绝对路径。
 */
export function resolveDefaultDatabasePath(env = process.env, home = homedir()) {
  const configured = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0 ? env.DSH_HOME.trim() : null;
  return join(configured ?? join(home, '.dsh'), ...DATABASE_SEGMENTS);
}

/** 默认配置。 */
export const DEFAULT_CONFIG = {
  databasePath: '',
  maxRows: DEFAULT_ROWS,
  legacyImport: { enabled: false, path: '' },
};

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 归一化配置：空串表示“使用默认位置”，maxRows 夹在合法区间内。
 * 非法类型直接抛错，避免静默使用错误配置。
 * @param {object} [raw] - 配置（通常来自 profile 的补丁层）。
 * @returns {{databasePath: string|null, maxRows: number, legacyImport: {enabled: boolean, path: string|null}}}
 */
export function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object') throw new TypeError('运维数据层配置必须是对象');
  const databasePath = trimmed(raw.databasePath);
  const legacy = raw.legacyImport ?? {};
  if (legacy === null || typeof legacy !== 'object') throw new TypeError('legacyImport 必须是对象');
  const legacyPath = trimmed(legacy.path);
  const numeric =
    raw.maxRows === undefined || raw.maxRows === null || raw.maxRows === '' ? DEFAULT_ROWS : Number(raw.maxRows);
  if (!Number.isFinite(numeric)) throw new TypeError('maxRows 必须是数字');
  return {
    databasePath: databasePath.length > 0 ? databasePath : null,
    maxRows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.trunc(numeric))),
    legacyImport: {
      enabled: legacy.enabled === true,
      path: legacyPath.length > 0 ? legacyPath : null,
    },
  };
}
