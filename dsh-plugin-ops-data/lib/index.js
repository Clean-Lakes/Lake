/**
 * LAKE 运维数据层插件（Host 侧）。
 *
 * 状态所有者：本插件拥有 SQLite 库、迁移、`opsData` 服务与工具注册。工具只读；
 * 写入只发生在旧库导入与宿主代码调用仓库方法时。
 *
 * 设计约束：本模块及其依赖不导入任何 `@deepseek-ai/*` 包。profile 安装的 bundle
 * 以符号链接落到 profile 的 node_modules，那里并没有 dsh 自带包，裸导入会导致
 * 插件无法装载。代价是参数校验与 DSH home 解析自实现（见 lib/tool-defs.js、lib/config.js）。
 *
 * 行为契约见 docs/spec.md。
 * @module dsh-plugin-ops-data
 */

import { resolveConfig, resolveDefaultDatabasePath } from './config.js';
import { openDatabase } from './db.js';
import { importLegacyLake } from './import-lake.js';
import { SCHEMA_VERSION } from './schema.js';
import { OpsStore } from './store.js';
import { createOpsToolDefs } from './tool-defs.js';

/** 插件名，用于加载器诊断。 */
export const name = 'ops-data';

/** 依赖 Harness 的工具注册表。 */
export const inject = ['tools'];

/**
 * 装载运维数据层。
 *
 * 同步完成建库与迁移：工具注册之后必须立刻可查询，不能留“尚未启动”的窗口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} [config] - 补丁层给出的配置，由 resolveConfig 校验。
 */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config);
  const databasePath = settings.databasePath ?? resolveDefaultDatabasePath();
  const db = openDatabase(databasePath);
  const store = new OpsStore(db, { maxRows: settings.maxRows, path: databasePath });

  let closed = false;
  ctx.effect(() => () => {
    if (closed) return;
    closed = true;
    try {
      store.close();
    } catch (error) {
      ctx.logger.warn('dsh-plugin-ops-data: 关闭数据库失败：%o', error);
    }
  }, 'dsh-plugin-ops-data: close store');

  // 只读门面：其它插件与后续 UI 通过 ctx.opsData 读取；写入 API 显式挂在 store 上。
  ctx.provide('opsData', {
    databasePath,
    schemaVersion: SCHEMA_VERSION,
    maxRows: settings.maxRows,
    store,
    overview: () => store.overview(),
    environments: (options) => store.listEnvironments(options),
    hosts: (options) => store.listHosts(options),
    services: (options) => store.listServices(options),
    credentialRefs: (options) => store.listCredentialRefs(options),
    journal: (options) => store.queryJournal(options),
    links: (options) => store.listLinks(options),
    importLegacy: (options) => importLegacyLake(store, options),
  });

  const disposers = createOpsToolDefs({ store, maxRows: settings.maxRows }).map((definition) =>
    ctx.tools.register(definition),
  );
  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) dispose();
  }, 'dsh-plugin-ops-data: unregister tools');

  if (settings.legacyImport.enabled) {
    // 导入失败不阻断数据层：失败会留在 imports 表中，由 ops_overview 暴露。
    try {
      const result = importLegacyLake(store, {
        path: settings.legacyImport.path ?? undefined,
        onWarn: (message) => ctx.logger.warn('dsh-plugin-ops-data: %s', message),
      });
      ctx.logger.info('dsh-plugin-ops-data: 旧库导入 %s（%o）', result.status, result.counts);
    } catch (error) {
      ctx.logger.error('dsh-plugin-ops-data: 旧库导入失败：%o', error);
    }
  }
}
