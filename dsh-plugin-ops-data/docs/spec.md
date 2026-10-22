# LAKE 运维数据层插件 — 契约

状态：v1 已实现（只读 Agent 工具）。本文是该插件的行为契约：状态所有者、数据模型、工具接口、导入语义与验收场景。

## 1. 目标与边界

为 Harness 提供一个**运维资产数据层**：环境、主机、服务、凭据引用、操作记录，以及它们与外部主体（工作空间、会话、工作流）的关联。Agent 通过只读工具查询这层数据来获得运维上下文。

范围内：

- 数据模型、SQLite 存储、迁移与查询。
- 宿主侧 `opsData` 服务，供其它插件与后续 UI 复用。
- 只读 Agent 工具（6 个）。
- 从旧 `~/.lake/lake.db` 的一次性语义导入。

范围外（v1 明确不做）：

- SSH/命令等任何真实运维执行，以及审批管线。
- Web UI 面板。
- 凭据值本身的读取、存储或展示。
- 会话事件：本层数据不进 session log，是插件的私有持久状态。

## 2. 状态所有者

| 状态 | 所有者 | 持久化 |
|---|---|---|
| 环境/主机/服务/凭据引用/操作记录/关联 | 本插件（`ctx.opsData` 门面 + 其后的 `OpsStore`） | `node:sqlite` 单库 |
| 数据库文件位置 | 插件配置 + 自实现的 DSH home 解析 | — |
| Agent 可见的工具 | `ctx.tools` 注册，随插件卸载回收 | — |

默认库路径 `$DSH_HOME/storages/ops-data/ops.db`（默认 `~/.dsh/storages/ops-data/ops.db`）：`config.databasePath` > `$DSH_HOME` > `~/.dsh`。该优先级与 `@deepseek-ai/dsh-home-paths` 的 `dshHomePath` 一致，但**本插件不导入该包**。

### 依赖约束（实测结论）

profile 安装的 bundle 由 pnpm 以 `link:` 落到 profile 的 `node_modules`，指向插件源码目录；dsh 自带包不在 profile 的 `node_modules` 中，宿主的运行时解析器只覆盖「按 name 装载插件入口」。因此：

- 插件代码**不得**裸导入 `@deepseek-ai/*`；实测会以 `failed to import` 装载失败。
- 工具定义直接使用注册表接受的标准 JSON Schema，不再经过 `defineTool` 编译；注册表不校验原始定义的参数，因此 `lib/tool-defs.js` 自带参数校验并在每次 execute 前执行。
- 不声明 schemastery `Config`：配置由 `resolveConfig` 在装载时校验，非法配置让插件明确失败；代价是 Config 目录中不显示本插件的 schema。

不变量：

- **凭据值永不进入本层**。`credential_refs` 只保存名称、类型、提供方与不透明定位符（locator）。
- **操作记录只追加**。不提供更新/删除操作记录的接口。
- 工具是只读的：工具实现只调用 store 的查询方法，不调用写入方法。
- 工具输出只使用空串/空数组表示「没有」，不使用 null，避免模型把 null 当作缺失字段语义。

## 3. 数据模型

标识：新记录用 `<prefix>_<uuid>`；从旧库导入的记录用 `lake:<旧 id>`，便于识别来源且可重复导入而不产生副本。

时间：统一 ISO 8601 UTC 字符串（`2026-10-03T10:00:00.000Z`）。旧库的 epoch 毫秒在导入时转换。

标签：JSON 字符串数组，例如 `["prod","cn-north"]`。旧库的 JSON 对象标签转为 `k=v` 字符串数组。

### environments（环境）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| name | TEXT UNIQUE NOT NULL | 唯一名称 |
| kind | TEXT NOT NULL | `production` / `staging` / `development` / `test` / `other` |
| region | TEXT | 可空 |
| description | TEXT | 默认空串 |
| tags | TEXT NOT NULL | JSON 数组 |
| archived | INTEGER NOT NULL | 0/1 |
| created_at / updated_at | TEXT NOT NULL | |

### hosts（主机）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| environment_id | TEXT NOT NULL | → environments，级联删除 |
| name | TEXT NOT NULL | 环境内唯一 |
| address | TEXT NOT NULL | 主机名或 IP |
| port | INTEGER NOT NULL | 默认 22 |
| ssh_user | TEXT | 登录用户，非凭据 |
| os | TEXT | |
| role | TEXT | 例如 `web` / `db` |
| status | TEXT NOT NULL | `online` / `offline` / `maintenance` / `unknown` |
| credential_ref | TEXT | → credential_refs.name，**只存名称** |
| tags | TEXT NOT NULL | JSON 数组 |
| notes | TEXT | |
| archived | INTEGER NOT NULL | |
| created_at / updated_at | TEXT NOT NULL | |

唯一约束 `(environment_id, name)`。

### services（服务）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| environment_id | TEXT NOT NULL | → environments |
| host_id | TEXT | → hosts，主机删除时置空 |
| name | TEXT NOT NULL | 环境内唯一 |
| kind | TEXT NOT NULL | `mysql` / `postgres` / `kubernetes` / `starrocks` / `redis` / `web` / `queue` / `storage` / `other` |
| endpoint | TEXT | `host:port` 形式，不含凭据 |
| version | TEXT | |
| tags | TEXT NOT NULL | JSON 数组 |
| notes | TEXT | |
| archived | INTEGER NOT NULL | |
| created_at / updated_at | TEXT NOT NULL | |

唯一约束 `(environment_id, name)`。

### credential_refs（凭据引用）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| name | TEXT UNIQUE NOT NULL | 唯一名称 |
| kind | TEXT NOT NULL | `ssh-key` / `password` / `token` / `api-key` / `certificate` / `other` |
| provider | TEXT NOT NULL | 值的实际所有者：`dsh-credentials` / `file` / `ssh-agent` / `external` / `unknown` |
| locator | TEXT | 不透明定位符，例如凭据键名或文件路径；**不是密钥内容** |
| description | TEXT | |
| created_at / updated_at | TEXT NOT NULL | |
| rotated_at | TEXT | |

### operation_records（操作记录）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| occurred_at | TEXT NOT NULL | |
| actor | TEXT | 会话 id / 用户 / `importer` |
| source | TEXT NOT NULL | `agent` / `manual` / `import` / `system` |
| kind | TEXT NOT NULL | `query` / `inspect` / `change` / `plan` / `other` |
| environment_id / host_id / service_id | TEXT | 可空，实体删除时置空 |
| summary | TEXT NOT NULL | 一行摘要 |
| detail | TEXT NOT NULL | JSON 对象 |
| outcome | TEXT NOT NULL | `success` / `failure` / `unknown` / `skipped` |
| correlation_id | TEXT | trace / session / run 关联 |
| created_at | TEXT NOT NULL | |

### links（关联）

把运维实体挂到外部主体上（工作空间、会话、工作流）。

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| entity_type | TEXT NOT NULL | `environment` / `host` / `service` / `credential_ref` |
| entity_id | TEXT NOT NULL | |
| subject_type | TEXT NOT NULL | `workspace` / `session` / `workflow` / `external` |
| subject_id | TEXT NOT NULL | 例如工作空间标识 |
| role | TEXT NOT NULL | `related` / `owner` / `target` |
| created_at | TEXT NOT NULL | |

唯一约束 `(entity_type, entity_id, subject_type, subject_id, role)`。

### imports（导入记账）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| source_path | TEXT NOT NULL | |
| source_fingerprint | TEXT NOT NULL | 源文件 sha256 |
| status | TEXT NOT NULL | `running` / `completed` / `failed` |
| counts | TEXT NOT NULL | JSON 对象 |
| error | TEXT | |
| started_at / finished_at | TEXT | |

唯一约束 `(source_path, source_fingerprint)`。

### 迁移

`PRAGMA user_version` 记录 schema 版本，当前为 `1`。迁移按版本顺序在事务内执行；未知的更高版本拒绝打开（避免旧代码写坏新库）。

## 4. 旧库导入语义

源：`~/.lake/lake.db`（LAKE schema 20 子集）。`config.legacyImport.enabled` 打开，`config.legacyImport.path` 可指定其它路径（空串表示默认路径）。

| 旧表 | 新表 | 映射 |
|---|---|---|
| `lake` | `environments` | id `lake:<旧 id>`，name/description 直取，kind=`other` |
| `resource` (kind=host) | `hosts` | address=`spec.ssh.host`，port=`spec.ssh.port`（默认 22），ssh_user=`spec.ssh.username`，notes 记录旧 kind 与 execute_authz 说明 |
| `resource` (其它 kind) | `services` | kind 直接映射（`k8s`→`kubernetes`），endpoint 仅由 `spec.host`/`spec.port` 组装；**不复制 spec 中的任意值** |
| `resource.tags` | 对应行 tags | JSON 对象转 `k=v` 数组 |
| `journal` | `operation_records` | id `lake:journal:<旧 id>`，ts→ISO，summary=`<tool> <event> <target_path>`，detail 保存旧字段，outcome 由 event 推导 |
| `link` | `links` | entity 为 from_id 对应实体，subject_type=`legacy_resource`，subject_id=to_id，role=type |

规则：

- 只读旧库，绝不写回；不读取 vault 或任何凭据值。
- 幂等：相同 `source_path` + 相同 sha256 指纹只导入一次；指纹变化时重跑，实体用 upsert、操作记录用 `INSERT OR IGNORE` 收敛。
- 单个事务内完成；失败则整体回滚并把 `imports.status` 记为 `failed`。

## 5. 工具契约（只读）

所有工具：

- 只读，`isConcurrencySafe` 为 true。
- `limit` 上限 200，默认取 `config.maxRows`（默认 50）；多取一行探测，得到精确 `truncated`。
- 参数在 execute 前由插件自身校验：未知参数、错误类型、非法枚举都以 `invalid arguments: ...` 拒绝，不静默忽略。
- 输出 schema 显式声明字段，`additionalProperties: false`；**任何字段都不承载凭据值**。
- 输出必须通过注册表自己的输出校验（`validateJsonSchemaValue`），因此输出 schema 与实现必须严格一致。

| 工具 | 参数 | 返回 |
|---|---|---|
| `ops_overview` | 无 | schema 版本、库路径、各表计数、环境摘要（含 host/service 计数）、最近导入状态、可用工具提示 |
| `ops_environments` | `query?` `kind?` `includeArchived?` `limit?` | 环境列表 + 每行 host/service 计数 |
| `ops_hosts` | `environment?` `query?` `tag?` `status?` `includeArchived?` `limit?` | 主机列表；凭据只回 `{name, kind, provider}`，无凭据时为 null |
| `ops_services` | `environment?` `host?` `kind?` `query?` `includeArchived?` `limit?` | 服务列表 + 所属环境/主机名 |
| `ops_credentials` | `query?` `kind?` `limit?` | 凭据**引用**元数据；输出结构中没有值字段 |
| `ops_journal` | `environment?` `host?` `kind?` `outcome?` `since?` `until?` `limit?` | 操作记录，按 `occurred_at` 倒序 |

`environment` / `host` 参数接受 id 或名称，名称在全局唯一（主机名在环境内唯一，因此主机名解析要求同时给出环境）。

## 6. 配置

```yaml
- id: ops-data
  name: '@clean-lakes/dsh-plugin-ops-data'
  config:
    databasePath: ''          # 空 = dshHomePath('storages','ops-data','ops.db')
    maxRows: 50               # 1..200，工具默认返回行数
    legacyImport:
      enabled: false
      path: ''                # 空 = ~/.lake/lake.db
```

## 7. 验收场景与结果（2026-10-03）

| # | 场景 | 结果 |
|---|---|---|
| 1 | 空库启动：schema 建成，`user_version=1`，6 个工具可调用，`ops_overview` 计数全为 0 | 通过（本地测试 + 现场 `ops_overview`） |
| 2 | 写入后 `ops_hosts` 按环境名/标签/状态过滤，凭据只回引用元数据 | 通过 |
| 3 | 凭据 locator 哨兵不出现在 `ops_overview`/`ops_environments`/`ops_hosts`/`ops_services`/`ops_journal`，只在 `ops_credentials` | 通过 |
| 4 | `ops_journal` 时间倒序，`since`/`until`/`outcome`/`kind` 过滤生效 | 通过 |
| 5 | 合成旧库导入的字段映射与计数；重复导入不产生副本；指纹变化时收敛 | 通过 |
| 6 | 导入只读旧库：导入前后文件 sha256 不变 | 通过 |
| 7 | 高于当前 schema 版本的库被拒绝打开并给出明确错误 | 通过 |
| 8 | 工具参数边界：未知参数/错误类型/非法枚举被拒绝 | 通过 |
| 9 | 安装到 desktop profile 后 6 个工具出现在 Agent 工具表并可实际调用 | 通过（`application: applied`，现场调用 `ops_overview` 返回空层概览） |
| 10 | 真实旧库（1803 条 journal）的 dry-run 映射 | 通过：1 环境 / 1 主机 / 0 服务 / 1803 操作记录，live 库未被写入 |
| 11 | 真实 `defineTool` 子集检查与注册表输出校验 | 通过（`scripts/verify-schemas.mjs`） |

本地测试 29/29 通过；`lib/` 中无任何 `@deepseek-ai/*` 导入。

## 8. 已知限制

- 无 UI：数据只能通过工具与宿主服务访问。
- 无写入工具：新增/修改数据目前只能由宿主代码或后续 UI 完成。
- 没有 schemastery `Config`：配置 schema 不出现在 Settings 的 Config 目录，只能按 `id: ops-data` 覆盖补丁行。
- 旧库的 `patrol`、`ops_workflow*`、`memory_*` 等历史表不在导入范围。
- 旧库 `journal` 没有资源外键，导入时 `environment_id`/`host_id` 保持为空，原 `target_path` 保存在 `detail` 中。
- 旧库 `journal.detail` 是自由文本，导入时截断到 2000 字符；若旧库曾把敏感内容写进 detail，它会随操作记录进入工具输出。
- 已导入的旧库数据不会因旧库后续变化而自动同步；需要重新导入时源文件指纹变化即可触发。
