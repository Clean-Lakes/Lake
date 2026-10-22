#!/usr/bin/env node
/**
 * 用真实 Harness 的 `@deepseek-ai/dsh-tools` 校验本插件的工具定义：
 * 1. 每个 `output.schema` 必须落在注册表支持的 JSON Schema 子集内；
 * 2. 每次 execute 的返回值必须通过注册表自己的输出校验；
 * 3. `parameters` 必须是对象根且同样落在支持的子集内。
 *
 * 本插件运行时零依赖 Harness 包，所以这个脚本需要显式给出 dsh-tools 的入口路径，
 * 例如从 dsh 源码检出（`packages/tools/lib/index.js`）或解包后的 app.asar。
 *
 * 用法：
 *   node scripts/verify-schemas.mjs --dsh-tools /path/to/@deepseek-ai/dsh-tools/lib/index.js
 * 或：
 *   DSH_TOOLS_ENTRY=/path/to/lib/index.js node scripts/verify-schemas.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');

function parseEntry(argv) {
  const flag = argv.indexOf('--dsh-tools');
  const fromFlag = flag >= 0 ? argv[flag + 1] : undefined;
  const candidate = fromFlag ?? process.env.DSH_TOOLS_ENTRY;
  if (!candidate) {
    console.error('缺少 dsh-tools 入口：用 --dsh-tools <path> 或 DSH_TOOLS_ENTRY 指定。');
    process.exit(2);
  }
  return isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
}

const entry = parseEntry(process.argv.slice(2));
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(entry).href);
const { apply } = await import(pathToFileURL(join(packageRoot, 'lib/index.js')).href);

const dir = mkdtempSync(join(tmpdir(), 'ops-data-verify-'));
const failures = [];
const tools = new Map();
const ctx = {
  effect(callback) {
    return () => callback();
  },
  provide() {
    return () => {};
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  },
  logger: { info() {}, warn() {}, error() {} },
};

try {
  apply(ctx, { databasePath: join(dir, 'ops.db'), maxRows: 20 });

  if (tools.size === 0) failures.push('没有注册任何工具');
  for (const definition of tools.values()) {
    try {
      assertSupportedJsonSchema(definition.output.schema);
    } catch (error) {
      failures.push(`${definition.name}: output.schema 超出支持子集 — ${error.message}`);
      continue;
    }
    if (definition.parameters?.type !== 'object') {
      failures.push(`${definition.name}: parameters 必须是对象根`);
      continue;
    }
    try {
      assertSupportedJsonSchema(definition.parameters);
    } catch (error) {
      failures.push(`${definition.name}: parameters 超出支持子集 — ${error.message}`);
      continue;
    }
    let value;
    try {
      value = await definition.execute({}, {});
    } catch (error) {
      failures.push(`${definition.name}: execute 失败 — ${error.message}`);
      continue;
    }
    const violations = validateJsonSchemaValue(definition.output.schema, value, 'value');
    if (violations.length > 0) failures.push(`${definition.name}: 输出不符合 schema — ${violations.join('; ')}`);
    else console.log(`OK   ${definition.name}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`schema 校验失败 ${failures.length} 项`);
  process.exit(1);
}
console.log(`schema 校验通过：${tools.size} 个工具`);
