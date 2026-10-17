---
goal: Package the LAKE operations data layer as a DeepSeek Harness plugin instead of an Electron client fork
version: 1
date_created: 2026-10-03
last_updated: 2026-10-03
owner: Lake
status: 'In progress'
tags: [feature, plugin, data]
---

# Introduction

用户改变了方向：不再二开 ZCode Electron 客户端，改为把运维数据层做成 Harness 插件，专注于资产数据的建设。原生客户端计划的 TASK-010 不再推进。

## 1. Requirements & Constraints

- **REQ-001**: 插件提供环境、主机、服务、凭据引用、操作记录与关联的数据模型与查询。
- **REQ-002**: Agent 只获得只读工具；不做 SSH 执行、审批与 UI。
- **REQ-003**: 插件自管独立 SQLite，可从旧 `~/.lake/lake.db` 一次性语义导入。
- **REQ-004**: 数据模型重设计为通用运维资产模型，湖语义映射为环境。
- **SEC-001**: 凭据值永不进入本层；旧库只读、只取白名单字段、不读取 vault。
- **CON-001**: 插件放在 Lake 仓库内新目录 `dsh-plugin-ops-data/`，精简重写，不移植旧 TS 数据层。
- **CON-002**: 通过 `plugin_manager install_bundle` 安装到 desktop profile，以返回的 `application`/`warnings` 判定结果。

## 2. Implementation Steps

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 定义数据契约：docs/spec.md（模型、状态所有者、工具契约、导入映射、验收场景）。 | Yes | 2026-10-03 |
| TASK-002 | 实现 SQLite schema/迁移、仓库层、模型校验（schema 版本 1，WAL，外键）。 | Yes | 2026-10-03 |
| TASK-003 | 实现旧 LAKE 库语义导入：白名单映射、sha256 记账幂等、失败可见、旧库只读。 | Yes | 2026-10-03 |
| TASK-004 | 实现 6 个只读工具与 `opsData` Host 服务与配置校验。 | Yes | 2026-10-03 |
| TASK-005 | 本地测试：29 个用例覆盖仓库、导入、工具、参数校验与插件入口。 | Yes | 2026-10-03 |
| TASK-006 | 用真实 `defineTool` 预检工具 schema（暴露 `items.required` 非法用法并修复）。 | Yes | 2026-10-03 |
| TASK-007 | 安装到 desktop profile 并现场验证工具可调用、凭据不泄漏。 | Yes | 2026-10-03 |
| TASK-008 | 因首次安装失败（`failed to import`）改为零 `@deepseek-ai/*` 依赖：标准 JSON Schema 定义 + 自带参数校验 + 自实现 home 解析，去掉 schemastery `Config`。 | Yes | 2026-10-03 |
| TASK-009 | 新增 `scripts/verify-schemas.mjs`，用真实注册表校验输出 schema 子集与输出值；对真实旧库做 dry-run 映射验证。 | Yes | 2026-10-03 |

## 3. Alternatives

- **ALT-001**: 继续推进原生 Electron 客户端（`plan/refactor-native-zcode-client-1.md`）与用户新方向冲突，暂停。
- **ALT-002**: 复用 `packages/lake` 的 TS 数据层会带入 Electron 客户端上下文与 schema 20 迁移链，被否决。
- **ALT-003**: 用 `ctx.storageDomain` 的 KV 域持久化缺少关系查询与事务，被否决。

## 4. Dependencies

- **DEP-001**: Harness 运行时 Node 24.18.1（`node:sqlite` 可用）。
- **DEP-002**: 插件运行时不依赖任何 dsh 自带包（见 TASK-008）；`@deepseek-ai/dsh-tools` 仅在 `scripts/verify-schemas.mjs` 中按显式路径用于校验。
- **DEP-003**: 旧库导入依赖用户自己的 `~/.lake/lake.db`，验证用合成库。

## 5. Files

- **FILE-001**: `dsh-plugin-ops-data/docs/spec.md` — 行为契约。
- **FILE-002**: `dsh-plugin-ops-data/lib/schema.js`、`lib/db.js`、`lib/model.js`、`lib/store.js` — 存储与查询。
- **FILE-003**: `dsh-plugin-ops-data/lib/import-lake.js` — 旧库导入。
- **FILE-004**: `dsh-plugin-ops-data/lib/tool-defs.js`、`lib/index.js` — 工具定义、参数校验与插件入口。
- **FILE-005**: `dsh-plugin-ops-data/package.json`、`cordis.patch.yml`、`locale/`、`icon.svg` — 包清单与展示元数据。
- **FILE-006**: `dsh-plugin-ops-data/scripts/verify-schemas.mjs` — 真实注册表 schema 与输出校验。

## 6. Testing

- **TEST-001**: 仓库层 10 例：schema 幂等、版本过新拒绝、写入校验、过滤、归档、错误。
- **TEST-002**: 导入 5 例：字段映射、旧库字节不变、指纹幂等、指纹变化收敛、缺失文件可见。
- **TEST-003**: 工具 8 例：工具集、空库概览、凭据 locator 不泄漏、过滤、截断标记、render、错误。
- **TEST-004**: 插件入口 6 例：`apply` 用假 Context 注册 6 工具与 `opsData`、清理生效、旧库缺失不阻断、参数校验拒绝未知/错误类型/非法枚举、配置归一化、DSH home 优先级。
- **TEST-005**: `scripts/verify-schemas.mjs`：用真实注册表校验 6 个工具的 `parameters`/`output.schema` 子集与输出值。

## 7. Risks & Assumptions

- **RISK-001**: 已消解——插件不再依赖 dsh 自带包，schema 用标准 JSON Schema，注册表子集由 TEST-005 固化校验。
- **RISK-002**: 旧库 `journal.detail` 是自由文本，导入时截断到 2000 字符；其中若曾写入敏感内容，会随操作记录进入工具输出。
- **RISK-003**: 无 schemastery `Config`，配置错误只能在装载时以异常暴露，Settings 里看不到配置 schema。
- **ASSUMPTION-001**: 运维执行与审批由别的插件或后续版本承担，本层不提供执行授权。

## 8. Related Specifications / Further Reading

[数据契约](../dsh-plugin-ops-data/docs/spec.md)
[插件 README](../dsh-plugin-ops-data/README.md)
[原生客户端计划（已暂停）](refactor-native-zcode-client-1.md)

## Verification record (2026-10-03)

本地：`node --test "test/*.test.mjs"` 29/29 通过（仓库 10、导入 5、工具 8、插件入口 6）。`scripts/verify-schemas.mjs` 用真实 `@deepseek-ai/dsh-tools` 校验 6 个工具的 `parameters`/`output.schema` 落在注册表支持的子集内，且每个 execute 的返回值通过注册表自身的输出校验。

安装：首次 `install_bundle` 以 `application: failed`（`failed to import`）结束。根因是 pnpm 把本地目录以 `link:` 装进 profile 的 `node_modules`，插件代码里的 `@deepseek-ai/*` 裸导入无法解析（dsh 自带包不在 profile 的 `node_modules` 中）。改为零 dsh 包依赖后，`set_bundle` 禁用再启用返回 `application: applied`，Harness 随即把 6 个工具加入 Agent 工具表；现场调用 `ops_overview` 返回空层概览，`~/.dsh/storages/ops-data/ops.db` 建成 `user_version=1`、7 张表。

真实数据：对 `~/.lake/lake.db` 做 dry-run（不写 live 库）得到 1 环境 / 1 主机 / 0 服务 / 1803 操作记录 / 0 关联，`skippedResources=0`；live 层仍为空，等用户决定是否打开 `legacyImport`。

未验证：Settings 中的配置 schema 展示（本插件不声明 schemastery `Config`）；Web UI 面板（v1 范围外）。

结构整理：`lib/tool-defs.js` 拆为契约（`lib/tool-schemas.js`，246 行）与逻辑（342 行），拆分后重新跑 29/29 测试通过。

热更新实测（2026-10-03）：在 `lib/tool-defs.js` 注入一个可观测标记后执行 `set_bundle` 禁用再启用，返回 `application: applied` 但 `ops_overview` 仍输出旧文本，说明**替换已安装包不会重新求值源码，Host 会继续使用已缓存的模块代**。因此：

- 运行中的 Host 目前仍是「零依赖重写后、拆分前」那一代；拆分后的代码在磁盘上并通过测试，重启 Harness 后才会装载。
- 结论：源码改动必须重启 Harness 才生效；`set_bundle` 只用于启用/禁用与新装 bundle 的首次激活。
- 早先「拆分后 applied 即证明实时注册表接受新 schema」的判断是错的，已作废；schema 子集由 `scripts/verify-schemas.mjs` 与实际注册路径（注册时 `assertSupportedJsonSchema`）共同保证。

后续可做：`lib/store.js`（737 行）按聚合拆分为多个模块；`ctx.opsData` 的写入 API 目前直接暴露 `store`，若要做 UI 应换成显式的写方法集合；`legacyImport` 默认关闭，开启方式见 README。

