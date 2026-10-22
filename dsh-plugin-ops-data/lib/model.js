/**
 * 记录规范化与校验。所有写入路径都必须经过这里，保证库里只有规范形状的数据。
 * @module dsh-plugin-ops-data/lib/model
 */

import { randomUUID } from 'node:crypto';

/** 环境类型。 */
export const ENVIRONMENT_KINDS = ['production', 'staging', 'development', 'test', 'other'];

/** 主机状态。 */
export const HOST_STATUSES = ['online', 'offline', 'maintenance', 'unknown'];

/** 服务类型。 */
export const SERVICE_KINDS = [
  'mysql',
  'postgres',
  'kubernetes',
  'starrocks',
  'redis',
  'web',
  'queue',
  'storage',
  'other',
];

/** 凭据引用类型。 */
export const CREDENTIAL_KINDS = ['ssh-key', 'password', 'token', 'api-key', 'certificate', 'other'];

/** 凭据值的实际所有者。本层从不保存值本身。 */
export const CREDENTIAL_PROVIDERS = ['dsh-credentials', 'file', 'ssh-agent', 'external', 'unknown'];

/** 操作记录来源。 */
export const OPERATION_SOURCES = ['agent', 'manual', 'import', 'system'];

/** 操作记录类别。 */
export const OPERATION_KINDS = ['query', 'inspect', 'change', 'plan', 'other'];

/** 操作结果。 */
export const OPERATION_OUTCOMES = ['success', 'failure', 'unknown', 'skipped'];

/** 关联实体类型。 */
export const LINK_ENTITY_TYPES = ['environment', 'host', 'service', 'credential_ref'];

/** 关联外部主体类型。 */
export const LINK_SUBJECT_TYPES = ['workspace', 'session', 'workflow', 'external', 'legacy_resource'];

/** 关联角色。 */
export const LINK_ROLES = ['related', 'owner', 'target', 'depends_on', 'part_of', 'connects_to'];

/** 当前时间，ISO 8601 UTC。 */
export function nowIso() {
  return new Date().toISOString();
}

/** 生成带前缀的稳定标识。 */
export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

/** 旧库的 epoch 毫秒转 ISO；非法值回落到当前时间。 */
export function epochMsToIso(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return nowIso();
  return new Date(numeric).toISOString();
}

/** 必填文本，去除首尾空白后不能为空。 */
export function requireText(value, field) {
  if (typeof value !== 'string') throw new TypeError(`${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TypeError(`${field} 不能为空`);
  return trimmed;
}

/** 可选文本：null/undefined/空串统一归一为 null。 */
export function optionalText(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TypeError(`${field} 必须是字符串或空`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** 枚举校验，未提供时返回默认值。 */
export function oneOf(value, allowed, field, fallback) {
  if (value === null || value === undefined || value === '') {
    if (fallback === undefined) throw new TypeError(`${field} 必填`);
    return fallback;
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`${field} 只能是 ${allowed.join(' / ')}，实际为 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 正整数校验（用于端口、limit 等）。 */
export function positiveInteger(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === null || value === undefined || value === '') {
    if (fallback === undefined) throw new TypeError(`${field} 必填`);
    return fallback;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new TypeError(`${field} 必须是 ${min}..${max} 的整数，实际为 ${JSON.stringify(value)}`);
  }
  return numeric;
}

/** 布尔校验，接受 true/false 与 "true"/"false"/1/0。 */
export function booleanValue(value, field, fallback = false) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw new TypeError(`${field} 必须是布尔值`);
}

/** ISO 时间戳校验。 */
export function assertIsoTimestamp(value, field) {
  const text = requireText(value, field);
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new TypeError(`${field} 必须是 ISO 8601 时间，实际为 ${JSON.stringify(value)}`);
  return new Date(parsed).toISOString();
}

/**
 * 标签归一化为 JSON 数组文本。接受数组、JSON 数组文本，或旧库的 JSON 对象
 * （对象转为 `k=v` 字符串数组）。
 */
export function normalizeTags(value) {
  if (value === null || value === undefined || value === '') return '[]';
  let parsed = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return '[]';
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // 逗号分隔的普通字符串也接受，便于手写配置。
      parsed = trimmed.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    }
  }
  if (Array.isArray(parsed)) {
    const entries = parsed
      .map((entry) => (typeof entry === 'string' ? entry.trim() : String(entry ?? '').trim()))
      .filter((entry) => entry.length > 0);
    return JSON.stringify([...new Set(entries)]);
  }
  if (parsed && typeof parsed === 'object') {
    const entries = Object.entries(parsed)
      .map(([key, entry]) => `${key}=${typeof entry === 'object' ? JSON.stringify(entry) : String(entry)}`)
      .sort((left, right) => left.localeCompare(right));
    return JSON.stringify(entries);
  }
  throw new TypeError('tags 必须是数组、JSON 数组文本或 JSON 对象文本');
}

/** 读取标签为字符串数组；库中脏值时返回空数组，绝不让查询因一行数据失败。 */
export function parseTags(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
    return [];
  } catch {
    return [];
  }
}

/** JSON 对象列归一化；非对象值包一层 raw 字段，避免丢失但也不污染结构。 */
export function normalizeJsonObject(value) {
  if (value === null || value === undefined || value === '') return '{}';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return '{}';
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed && typeof parsed === 'object' ? parsed : { raw: parsed });
    } catch {
      return JSON.stringify({ raw: trimmed });
    }
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return JSON.stringify({ raw: value });
}

/** 读取 JSON 对象列；脏值回落到空对象。 */
export function parseJsonObject(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
