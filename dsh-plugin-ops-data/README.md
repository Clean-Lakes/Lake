# LAKE 运维数据层（DSH 插件）

把 LAKE 的运维资产数据层做成 DeepSeek Harness 插件：环境、主机、服务、凭据引用、操作记录，以及它们与工作空间/会话/工作流的关联。Agent 通过 6 个**只读**工具查询这层数据；写入由宿主代码与旧库导入承担。

设计契约见 [docs/spec.md](docs/spec.md)。

## 它做什么、不做什么

- 做：一套 schema 化的 SQLite 资产库、迁移、过滤查询、旧 LAKE 库语义导入、只读 Agent 工具、可供其它插件复用的 `opsData` 服务。
- 不做：SSH 或任何真实运维执行、审批、Web UI、凭据值的读取与存储。

数据层从不保存凭据值：`credential_refs` 只有名称、类型、提供方和不透明 locator。

## 安装

在 Harness 会话中使用 `plugin_manager` 的 `install_bundle`，`target` 传本目录的绝对路径：

```
plugin_manager action=install_bundle target=/Users/<you>/Desktop/Lake/dsh-plugin-ops-data
```

安装后所有会话可见，重启后依然生效。卸载用 `remove_bundle`。安装结果以返回的 `application` 与 `warnings` 为准。

### 为什么本插件不导入任何 `@deepseek-ai/*` 包

profile 安装的 bundle 由 pnpm 以 `link:` 落到 profile 的 `node_modules`，指向本目录；而 dsh 自带包（`dsh-tools` 等）并不在 profile 的 `node_modules` 里，它们由宿主的运行时解析器提供，只覆盖「按 name 装载插件入口」这一步。插件代码里的裸导入因此必然解析失败（本仓库已实测：`failed to import`）。

结论与本仓库的实现约束：

- 插件只使用 Node 标准库（含 `node:sqlite`），工具定义直接是注册表接受的标准 JSON Schema；
- 注册表不会替原始定义校验参数，所以 `lib/tool-defs.js` 自带参数校验并在每次 execute 前执行；
- 不声明 schemastery `Config`：配置由 `lib/config.js` 的 `resolveConfig` 在装载时校验（非法配置会让插件明确失败）。因此 **Settings 的 Config 目录里不会显示本插件的配置 schema**，覆盖配置需要直接写 profile 的补丁行（见下）。

## 配置

在 profile 的 `cordis.patch.yml` 中按 id 覆盖这一行（该文件属于 profile）：

```yaml
- id: ops-data
  name: '@clean-lakes/dsh-plugin-ops-data'
  config:
    databasePath: ''          # 空 = $DSH_HOME/storages/ops-data/ops.db
    maxRows: 50               # 工具默认返回行数，1..200
    legacyImport:
      enabled: false          # 打开后装载时导入一次旧 LAKE 库
      path: ''                # 空 = ~/.lake/lake.db
```

## Agent 工具

| 工具 | 用途 |
|---|---|
| `ops_overview` | 计数、环境摘要、最近导入状态。先用它判断这层有没有数据。 |
| `ops_environments` | 环境列表与主机/服务计数，可按类型与子串过滤。 |
| `ops_hosts` | 主机列表：地址、端口、登录用户、角色、状态、标签、凭据引用名。 |
| `ops_services` | 服务列表：类型、端点、版本、所属主机。 |
| `ops_credentials` | 凭据**引用**清单（名称/类型/提供方/locator），没有值。 |
| `ops_journal` | 操作记录，按时间倒序，支持环境/主机/服务/类别/结果/时间范围过滤。 |

全部只读、并发安全；`limit` 上限 200，并返回精确的 `truncated` 标记。参数越界会以可读错误拒绝，而不是静默忽略。

## 宿主服务

装载时提供 `ctx.opsData`：`databasePath`、`schemaVersion`、`maxRows`、只读查询方法（`overview/environments/hosts/services/credentialRefs/journal/links`）、`importLegacy()`，以及原始 `store`（写入 API 在这里，供宿主代码与后续 UI 使用）。

## 数据位置

默认 `$DSH_HOME/storages/ops-data/ops.db`（默认 `~/.dsh/storages/ops-data/ops.db`），WAL 模式，外键开启。schema 版本存于 `PRAGMA user_version`，当前为 1；打开到更高版本的库会明确拒绝，避免旧代码写坏新结构。

## 从旧 LAKE 库导入

把 `legacyImport.enabled` 设为 `true` 即可。导入：

- 只读旧库，绝不写回，也不读取 vault 或凭据值；
- 映射 `lake → environments`、`resource(host) → hosts`、`resource(k8s/mysql/...) → services`、`journal → operation_records`、`link → links`；
- 只复制白名单字段，`spec` 里除 `ssh.host/port/username` 与顶层 `host/port` 外一律不取；
- 以 `(源路径, 文件 sha256)` 记账，重复导入不产生副本；指纹变化时重跑并收敛；
- 旧库缺失时记录一次失败到 `imports` 表（`ops_overview` 可见），数据层继续可用。

## 开发与验证

```sh
node --test "test/*.test.mjs"        # 29 个用例：仓库、导入、工具、插件入口
node scripts/verify-schemas.mjs --dsh-tools <dsh-tools/lib/index.js>
```

第二个命令用真实 `@deepseek-ai/dsh-tools` 校验每个 `output.schema` 落在注册表支持的子集内、每次 execute 的返回值通过注册表自己的输出校验。入口路径按环境给出，例如 dsh 源码检出的 `packages/tools/lib/index.js`，或解包后的 `app.asar` 内 `node_modules/@deepseek-ai/dsh-tools/lib/index.js`。

全部测试使用临时目录中的合成数据，不接触 `~/.lake` 与 `~/.dsh`。
