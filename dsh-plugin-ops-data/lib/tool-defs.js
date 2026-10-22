/**
 * 只读 Agent 工具定义。
 *
 * 本文件不依赖 Harness 包：产出的是注册表直接接受的 ToolDefinition
 * （`parameters` 与 `output.schema` 都是标准 JSON Schema）。代价是注册表不会替
 * 原始定义校验参数，因此这里自带校验器并在每次 execute 前强制执行。
 * 契约（schema 与投影）在 lib/tool-schemas.js。
 * @module dsh-plugin-ops-data/lib/tool-defs
 */

import { MAX_ROWS } from './config.js';
import {
  CREDENTIAL_ITEM,
  ENVIRONMENT_ITEM,
  HOST_ITEM,
  OPERATION_ITEM,
  OVERVIEW_SCHEMA,
  SERVICE_ITEM,
  archivedParam,
  bool,
  int,
  limitParam,
  objList,
  objectSchema,
  params,
  projectCredential,
  projectEnvironment,
  projectHost,
  projectOperation,
  projectService,
  queryParam,
  str,
} from './tool-schemas.js';

/**
 * 校验模型给出的参数。
 *
 * 只实现本插件用到的子集：object / array / string / integer / boolean、
 * `required`、`enum`、`additionalProperties: false`，以及无 type 的任意 JSON。
 * @param {object} schema - 标准 JSON Schema。
 * @param {unknown} value - 待校验的值。
 * @param {string} path - 诊断路径。
 * @param {string[]} violations - 收集到的违规描述。
 */
function validateValue(schema, value, path, violations) {
  if (schema === null || typeof schema !== 'object') return;
  const label = path.length === 0 ? 'arguments' : path;
  const type = schema.type;
  if (type === undefined) return;
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      violations.push(`${label} must be an object`);
      return;
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`${path.length === 0 ? '' : `${path}.`}${key} is required`);
    }
    const properties = schema.properties ?? {};
    for (const [key, entry] of Object.entries(value)) {
      const propertySchema = properties[key];
      const childPath = path.length === 0 ? key : `${path}.${key}`;
      if (propertySchema === undefined) {
        if (schema.additionalProperties === false) violations.push(`${childPath} is not a declared parameter`);
        continue;
      }
      validateValue(propertySchema, entry, childPath, violations);
    }
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`${label} must be an array`);
      return;
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => validateValue(schema.items, entry, `${path}[${index}]`, violations));
    }
    return;
  }
  const matches =
    (type === 'string' && typeof value === 'string') ||
    (type === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
    (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (type === 'boolean' && typeof value === 'boolean');
  if (!matches) violations.push(`${label} must be a ${type}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${label} must be one of ${schema.enum.join(' / ')}`);
  }
}

/**
 * 校验参数，失败时抛出可读错误。
 * @param {object} definition - 工具定义。
 * @param {unknown} args - 模型给出的参数。
 * @returns {object} 归一后的参数（空参数归一为 `{}`）。
 */
export function validateArguments(definition, args) {
  const candidate = args === undefined || args === null ? {} : args;
  const violations = [];
  validateValue(definition.parameters, candidate, '', violations);
  if (violations.length > 0) throw new TypeError(`invalid arguments: ${violations.join('; ')}`);
  return candidate;
}

/**
 * 查询并给出精确的截断标记：多取一行探测，再裁掉。
 * @param {(limit: number) => any[]} run - 执行查询的函数。
 * @param {number} limit - 期望行数。
 * @returns {{rows: any[], truncated: boolean}}
 */
function probe(run, limit) {
  const effective = Math.min(MAX_ROWS, Math.max(1, limit));
  const rows = run(effective < MAX_ROWS ? effective + 1 : effective);
  return { rows: rows.slice(0, effective), truncated: rows.length > effective };
}

/**
 * 构造只读工具定义，并统一包上参数校验。
 * @param {{store: import('./store.js').OpsStore, maxRows: number}} context
 * @returns {object[]} Harness 注册表可直接接受的工具定义。
 */
export function createOpsToolDefs({ store, maxRows }) {
  const definitions = [
    {
      name: 'ops_overview',
      description:
        'Summarize the LAKE operations data layer: database schema version, record counts, environments with host/service counts, and the last legacy import. Call this first to see whether operations data exists at all, then narrow down with ops_environments, ops_hosts, ops_services, ops_credentials or ops_journal. This layer stores asset metadata only: it holds references to credentials, never their values, and it neither records execution nor grants any authorization.',
      parameters: params({}, []),
      output: {
        schema: OVERVIEW_SCHEMA,
        render: (_args, value) => [
          {
            type: 'text',
            text: `Ops data: ${value.counts.environments} environments, ${value.counts.hosts} hosts, ${value.counts.services} services, ${value.counts.credentialRefs} credential references, ${value.counts.operationRecords} operation records. ${value.nextSteps}`,
          },
        ],
      },
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'Ops data overview' }),
      execute: () => {
        const overview = store.overview();
        const last = overview.lastImport;
        return {
          schemaVersion: overview.schemaVersion,
          databasePath: overview.databasePath ?? '',
          counts: overview.counts,
          environments: overview.environments.map((environment) => ({
            id: environment.id,
            name: environment.name,
            kind: environment.kind,
            archived: environment.archived,
            hostCount: environment.hostCount,
            serviceCount: environment.serviceCount,
          })),
          lastImport: {
            present: last !== null,
            sourcePath: last?.sourcePath ?? '',
            status: last?.status ?? '',
            error: last?.error ?? '',
            startedAt: last?.startedAt ?? '',
            finishedAt: last?.finishedAt ?? '',
            importedEnvironments: Number(last?.counts?.environments ?? 0),
            importedHosts: Number(last?.counts?.hosts ?? 0),
            importedServices: Number(last?.counts?.services ?? 0),
            importedOperationRecords: Number(last?.counts?.operationRecords ?? 0),
            importedLinks: Number(last?.counts?.links ?? 0),
          },
          nextSteps:
            overview.counts.environments === 0 && overview.counts.hosts === 0
              ? 'The layer is empty: ask the user for assets, or enable config.legacyImport to bring in an existing LAKE database.'
              : 'Filter with ops_environments / ops_hosts / ops_services, check credential references with ops_credentials, and read history with ops_journal before changing anything.',
        };
      },
    },
    {
      name: 'ops_environments',
      description:
        'List operations environments (production, staging, development, test, other) with their region, tags and host/service counts. Environments group hosts and services and are the natural scope for a production change. Filter by a name/description/region substring or by kind. Read-only.',
      parameters: params({
        query: queryParam,
        kind: { type: 'string', enum: ['production', 'staging', 'development', 'test', 'other'], description: '仅保留该类型的环境。' },
        includeArchived: archivedParam,
        limit: limitParam,
      }),
      output: {
        schema: objectSchema({
          environments: objList('命中的环境，按名称排序。', ENVIRONMENT_ITEM),
          count: int('返回条数。'),
          truncated: bool('是否因为 limit 而截断。'),
        }),
        render: (_args, value) => [
          { type: 'text', text: `Matched ${value.count} environment(s)${value.truncated ? ' (truncated)' : ''}.` },
        ],
      },
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'List ops environments' }),
      execute: (args) => {
        const { rows, truncated } = probe((limit) => store.listEnvironments({ ...args, limit }), args.limit ?? maxRows);
        return { environments: rows.map(projectEnvironment), count: rows.length, truncated };
      },
    },
    {
      name: 'ops_hosts',
      description:
        'List operations hosts with their environment, address, port, login user, role, status, tags and the name of the credential reference they use. Filter by environment (id or name), a substring of name/address/role/notes, a tag substring, or status. This tool never returns credential values or private keys; resolve a credential through its declared provider when you actually need it. Read-only.',
      parameters: params({
        environment: str('环境 id 或名称。'),
        query: queryParam,
        tag: str('标签子串。'),
        status: { type: 'string', enum: ['online', 'offline', 'maintenance', 'unknown'], description: '仅保留该状态的主机。' },
        includeArchived: archivedParam,
        limit: limitParam,
      }),
      output: {
        schema: objectSchema({
          hosts: objList('命中的主机，按环境名、主机名排序。', HOST_ITEM),
          count: int('返回条数。'),
          truncated: bool('是否因为 limit 而截断。'),
        }),
        render: (_args, value) => [
          { type: 'text', text: `Matched ${value.count} host(s)${value.truncated ? ' (truncated)' : ''}.` },
        ],
      },
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'List ops hosts' }),
      execute: (args) => {
        const { rows, truncated } = probe((limit) => store.listHosts({ ...args, limit }), args.limit ?? maxRows);
        return { hosts: rows.map(projectHost), count: rows.length, truncated };
      },
    },
    {
      name: 'ops_services',
      description:
        'List operations services (databases, caches, kubernetes clusters, object storage, ...) with their environment, optional owning host, endpoint and version. Filter by environment, host (id, or a name together with its environment), kind, or a name/endpoint/version substring. Read-only.',
      parameters: params({
        environment: str('环境 id 或名称。'),
        host: str('主机 id，或与 environment 一起给出的主机名。'),
        kind: {
          type: 'string',
          enum: ['mysql', 'postgres', 'kubernetes', 'starrocks', 'redis', 'web', 'queue', 'storage', 'other'],
          description: '仅保留该类型的服务。',
        },
        query: queryParam,
        includeArchived: archivedParam,
        limit: limitParam,
      }),
      output: {
        schema: objectSchema({
          services: objList('命中的服务，按环境名、服务名排序。', SERVICE_ITEM),
          count: int('返回条数。'),
          truncated: bool('是否因为 limit 而截断。'),
        }),
        render: (_args, value) => [
          { type: 'text', text: `Matched ${value.count} service(s)${value.truncated ? ' (truncated)' : ''}.` },
        ],
      },
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'List ops services' }),
      execute: (args) => {
        const { rows, truncated } = probe((limit) => store.listServices({ ...args, limit }), args.limit ?? maxRows);
        return { services: rows.map(projectService), count: rows.length, truncated };
      },
    },
    {
      name: 'ops_credentials',
      description:
        'List credential references: name, kind, provider and an opaque locator. This is an inventory of where credentials live, not the credentials themselves — no secret value, private key or token is ever stored or returned by this data layer. Use it to learn which credential name a host expects, then resolve the value through the declared provider outside this tool. Read-only.',
      parameters: params({
        query: queryParam,
        kind: {
          type: 'string',
          enum: ['ssh-key', 'password', 'token', 'api-key', 'certificate', 'other'],
          description: '仅保留该类型的引用。',
        },
        limit: limitParam,
      }),
      output: {
        schema: objectSchema({
          credentialRefs: objList('命中的凭据引用，按名称排序。', CREDENTIAL_ITEM),
          count: int('返回条数。'),
          truncated: bool('是否因为 limit 而截断。'),
          notice: str('关于“这里只有引用、没有凭据值”的说明。'),
        }),
        render: (_args, value) => [
          {
            type: 'text',
            text: `Matched ${value.count} credential reference(s)${value.truncated ? ' (truncated)' : ''}; no secret values exist in this layer.`,
          },
        ],
      },
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'List credential references' }),
      execute: (args) => {
        const { rows, truncated } = probe((limit) => store.listCredentialRefs({ ...args, limit }), args.limit ?? maxRows);
        return {
          credentialRefs: rows.map(projectCredential),
          count: rows.length,
          truncated,
          notice: 'Only references are stored here; resolve the value through the declared provider.',
        };
      },
    },
    {
      name: 'ops_journal',
      description:
        'Query operation records newest first: who did what, on which environment/host/service, with which outcome, and a structured detail object. Use it to reconstruct what already happened to an asset before changing it, and remember that a completed operation is evidence that must not be replayed automatically. Filter by environment, host, service, kind, outcome, and an occurred_at range in ISO 8601. Read-only.',
      parameters: params({
        environment: str('环境 id 或名称。'),
        host: str('主机 id，或与 environment 一起给出的主机名。'),
        service: str('服务 id 或名称。'),
        kind: { type: 'string', enum: ['query', 'inspect', 'change', 'plan', 'other'], description: '仅保留该类别的记录。' },
        outcome: { type: 'string', enum: ['success', 'failure', 'unknown', 'skipped'], description: '仅保留该结果的记录。' },
        since: str('起始时间（含），ISO 8601，例如 2026-10-01T00:00:00Z。'),
        until: str('结束时间（含），ISO 8601。'),
        limit: limitParam,
      }),
      output: {
        schema: objectSchema({
          records: objList('命中的操作记录，按发生时间倒序。', OPERATION_ITEM),
          count: int('返回条数。'),
          truncated: bool('是否因为 limit 而截断。'),
        }),
        render: (_args, value) => [
          { type: 'text', text: `Matched ${value.count} operation record(s)${value.truncated ? ' (truncated)' : ''}.` },
        ],
      },
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'Query operations journal' }),
      execute: (args) => {
        const { rows, truncated } = probe((limit) => store.queryJournal({ ...args, limit }), args.limit ?? maxRows);
        return { records: rows.map(projectOperation), count: rows.length, truncated };
      },
    },
  ];

  // 参数校验统一包裹：注册表不会替原始定义校验参数，缺了这步就没有输入边界。
  for (const definition of definitions) {
    const run = definition.execute;
    definition.execute = (args, exec) => run(validateArguments(definition, args), exec);
  }
  return definitions;
}
