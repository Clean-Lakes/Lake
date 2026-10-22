/**
 * 工具契约：输出 schema、参数片段与记录投影。
 *
 * 这里的 schema 是注册表直接接受的标准 JSON Schema（本插件不使用 `defineTool` 的
 * DSL，原因见 docs/spec.md 的依赖约束）。契约与实现分离，便于对照 docs/spec.md 复核。
 * @module dsh-plugin-ops-data/lib/tool-schemas
 */

import { DEFAULT_ROWS, MAX_ROWS } from './config.js';

/** 字符串属性。 */
export const str = (description) => ({ type: 'string', description });
/** 整数属性。 */
export const int = (description) => ({ type: 'integer', description });
/** 布尔属性。 */
export const bool = (description) => ({ type: 'boolean', description });
/** 字符串数组属性。注意：数组 items 不需要（也不应）声明 required。 */
export const strList = (description) => ({ type: 'array', description, items: { type: 'string' } });
/** 任意 JSON：只用注释描述，不约束形状。 */
export const anyJson = (description) => ({ description });

/** 关闭额外字段的对象 schema；required 为空时不写 required，避免空数组。 */
export function objectSchema(properties, required = Object.keys(properties)) {
  const schema = { type: 'object', additionalProperties: false, properties };
  if (required.length > 0) schema.required = [...required];
  return schema;
}

/** 对象数组属性。 */
export function objList(description, properties) {
  return { type: 'array', description, items: objectSchema(properties) };
}

/** 参数表：默认全部可选，只有显式列出的键才是合法参数。 */
export function params(properties, required = []) {
  return objectSchema(properties, required);
}

/** 可选参数：文本子串过滤。 */
export const queryParam = str('仅保留名称、描述、地址等文本字段包含该子串的记录。');
/** 可选参数：返回行数。 */
export const limitParam = int(`最多返回的行数，范围 1..${MAX_ROWS}；省略时使用插件配置的默认值（默认 ${DEFAULT_ROWS}）。`);
/** 可选参数：包含已归档记录。 */
export const archivedParam = bool('是否包含已归档记录，默认 false。');

/** 概览工具的输出 schema。 */
export const OVERVIEW_SCHEMA = objectSchema({
  schemaVersion: int('运维数据层数据库 schema 版本。'),
  databasePath: str('数据库文件路径；无法确定时为空串。'),
  counts: objectSchema(
    {
      environments: int('环境总数。'),
      hosts: int('主机总数。'),
      services: int('服务总数。'),
      credentialRefs: int('凭据引用总数。'),
      operationRecords: int('操作记录总数。'),
      links: int('关联总数。'),
    },
    ['environments', 'hosts', 'services', 'credentialRefs', 'operationRecords', 'links'],
  ),
  environments: objList('环境摘要，按名称排序，最多 100 条。', {
    id: str('环境 id。'),
    name: str('环境名称。'),
    kind: str('环境类型。'),
    archived: bool('是否已归档。'),
    hostCount: int('该环境下的主机数（含归档）。'),
    serviceCount: int('该环境下的服务数（含归档）。'),
  }),
  lastImport: objectSchema(
    {
      present: bool('是否存在导入记账。'),
      sourcePath: str('导入源文件路径。'),
      status: str('running / completed / failed。'),
      error: str('失败原因；没有则为空串。'),
      startedAt: str('开始时间（ISO 8601）。'),
      finishedAt: str('结束时间（ISO 8601）；未结束为空串。'),
      importedEnvironments: int('导入的环境数。'),
      importedHosts: int('导入的主机数。'),
      importedServices: int('导入的服务数。'),
      importedOperationRecords: int('导入的操作记录数。'),
      importedLinks: int('导入的关联数。'),
    },
    [
      'present',
      'sourcePath',
      'status',
      'error',
      'startedAt',
      'finishedAt',
      'importedEnvironments',
      'importedHosts',
      'importedServices',
      'importedOperationRecords',
      'importedLinks',
    ],
  ),
  nextSteps: str('下一步建议：该先调用哪个工具。'),
});

/** 环境行 schema。 */
export const ENVIRONMENT_ITEM = {
  id: str('环境 id。'),
  name: str('环境名称。'),
  kind: str('production / staging / development / test / other。'),
  region: str('地域；没有则为空串。'),
  description: str('描述；没有则为空串。'),
  tags: strList('标签。'),
  archived: bool('是否已归档。'),
  hostCount: int('主机数（未归档）。'),
  serviceCount: int('服务数（未归档）。'),
};

/** 主机行 schema。 */
export const HOST_ITEM = {
  id: str('主机 id。'),
  environment: str('所属环境名称。'),
  name: str('主机名（环境内唯一）。'),
  address: str('主机名或 IP。'),
  port: str('端口（字符串形式，避免前导零丢失）。'),
  sshUser: str('登录用户；没有则为空串。'),
  os: str('操作系统；没有则为空串。'),
  role: str('角色；没有则为空串。'),
  status: str('online / offline / maintenance / unknown。'),
  tags: strList('标签。'),
  hasCredential: bool('是否登记了凭据引用。'),
  credentialName: str('凭据引用名称，不是凭据值。'),
  credentialKind: str('ssh-key / password / token / api-key / certificate / other。'),
  credentialProvider: str('凭据值的实际所有者：dsh-credentials / file / ssh-agent / external / unknown。'),
};

/** 服务行 schema。 */
export const SERVICE_ITEM = {
  id: str('服务 id。'),
  environment: str('所属环境名称。'),
  host: str('所属主机名称；没有则为空串。'),
  name: str('服务名（环境内唯一）。'),
  kind: str('mysql / postgres / kubernetes / starrocks / redis / web / queue / storage / other。'),
  endpoint: str('端点（不含凭据）；没有则为空串。'),
  version: str('版本；没有则为空串。'),
  tags: strList('标签。'),
  archived: bool('是否已归档。'),
};

/** 凭据引用行 schema；结构上没有任何承载密钥内容的字段。 */
export const CREDENTIAL_ITEM = {
  id: str('凭据引用 id。'),
  name: str('引用名称。'),
  kind: str('ssh-key / password / token / api-key / certificate / other。'),
  provider: str('值的实际所有者：dsh-credentials / file / ssh-agent / external / unknown。'),
  locator: str('不透明定位符（例如凭据键名或文件路径），不是密钥内容。'),
  description: str('描述；没有则为空串。'),
  rotatedAt: str('轮换时间（ISO 8601）；没有则为空串。'),
};

/** 操作记录行 schema。 */
export const OPERATION_ITEM = {
  id: str('操作记录 id。'),
  occurredAt: str('发生时间（ISO 8601）。'),
  actor: str('执行者：会话 id、用户或 legacy-cli / legacy-agent。'),
  source: str('agent / manual / import / system。'),
  kind: str('query / inspect / change / plan / other。'),
  outcome: str('success / failure / unknown / skipped。'),
  summary: str('一行摘要。'),
  environmentId: str('关联环境 id；没有则为空串。'),
  hostId: str('关联主机 id；没有则为空串。'),
  serviceId: str('关联服务 id；没有则为空串。'),
  correlationId: str('trace / session / run 关联标识；没有则为空串。'),
  detail: anyJson('结构化明细；导入的记录含旧库字段。'),
};

/** store 记录 → 输出行。缺省值统一用空串，避免 null 进入模型上下文。 */
export function projectEnvironment(environment) {
  return {
    id: environment.id,
    name: environment.name,
    kind: environment.kind,
    region: environment.region ?? '',
    description: environment.description ?? '',
    tags: environment.tags,
    archived: environment.archived,
    hostCount: environment.hostCount ?? 0,
    serviceCount: environment.serviceCount ?? 0,
  };
}

export function projectHost(host) {
  return {
    id: host.id,
    environment: host.environmentName ?? '',
    name: host.name,
    address: host.address,
    port: String(host.port),
    sshUser: host.sshUser ?? '',
    os: host.os ?? '',
    role: host.role ?? '',
    status: host.status,
    tags: host.tags,
    hasCredential: host.credential !== null,
    credentialName: host.credential?.name ?? '',
    credentialKind: host.credential?.kind ?? '',
    credentialProvider: host.credential?.provider ?? '',
  };
}

export function projectService(service) {
  return {
    id: service.id,
    environment: service.environmentName ?? '',
    host: service.hostName ?? '',
    name: service.name,
    kind: service.kind,
    endpoint: service.endpoint ?? '',
    version: service.version ?? '',
    tags: service.tags,
    archived: service.archived,
  };
}

export function projectCredential(credential) {
  return {
    id: credential.id,
    name: credential.name,
    kind: credential.kind,
    provider: credential.provider,
    locator: credential.locator ?? '',
    description: credential.description ?? '',
    rotatedAt: credential.rotatedAt ?? '',
  };
}

export function projectOperation(operation) {
  return {
    id: operation.id,
    occurredAt: operation.occurredAt,
    actor: operation.actor ?? '',
    source: operation.source,
    kind: operation.kind,
    outcome: operation.outcome,
    summary: operation.summary,
    environmentId: operation.environmentId ?? '',
    hostId: operation.hostId ?? '',
    serviceId: operation.serviceId ?? '',
    correlationId: operation.correlationId ?? '',
    detail: operation.detail,
  };
}
