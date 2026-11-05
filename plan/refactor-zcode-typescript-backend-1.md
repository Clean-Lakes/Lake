---
goal: 使用 ZCode v3.17.2 TypeScript 后端替换 Lake Go Agent 与 HTTP 后端，保留 Lake UI
version: 1
date_created: 2026-11-05
last_updated: 2026-11-05
owner: Lake
status: In progress
tags: [refactor, zcode, typescript, backend]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

用户于 2026-11-05 明确要求直接使用 ZCode v3.17.2 源码，后端语言改为 TypeScript，保留 Lake UI，并确认**全部既有功能保留后进行完整切换**。随后用户明确要求 TS/ZCode Dev 覆盖现有 Dev，新增显式 Dev 预览打包和安装入口；完整迁移、正式版及普通默认入口的等价门槛保持。取消本分支最初的 Go/stdio 桥接试验。目标由 ZCode 拥有 Agent 循环、上下文、工具和执行适配器；Lake TS 宿主提供产品接口、资产目录、安全交互、配置和 UI 投影。Swift 保留平台外壳与签名启动入口。

## 1. Requirements & Constraints

- **REQ-001**: 固定 `runtime/zcode/upstream.json` 中的版本、标签提交与源码归档 SHA-256；下载到忽略的 `third_party/zcode`，不导入上游 Git 历史。
- **REQ-002**: `runtime/zcode/server.ts`、`agent.ts`、`store.ts` 实现 TS 后端；生产入口不启动 Go 服务或把模型调用转回 Go。
- **REQ-003**: 保留 React 页面与 `/api`、SSE、运行发现协议；原生健康检查明确识别 `typescript`。
- **REQ-004**: 上游 UI、贡献者名单、头像及致谢展示不进入 Lake 发行物；保留完整版权、LICENSE、NOTICE 和第三方归属，另记 Lake 的修改。
- **REQ-005**: `runtime/zcode/api-inventory.json` 覆盖当前 Lake UI 全部 API 操作；`parity.json` 中每个操作及领域取得等价验收之前，禁止普通默认/正式版后端切换。候选经 `scripts/build_lake.sh --ts-candidate` 输出到 `bin/lake-ts`；用户已另行明确授权用 `scripts/build_lake_desktop.sh --dev --ts-candidate --install` 覆盖 Dev，不将其计为完整验收。
- **SEC-001**: 凭据仅存当前 Home 的私有 secrets 文件；不得记录 API Key，不读取 Keychain、不使用正式 Home 联调。
- **SEC-002**: HTTP 仅监听 loopback，Bearer/cookie 鉴权、Origin 校验和静态路径约束；每个 Home 一个宿主。
- **SEC-003**: 审批使用 ZCode PermissionBroker，取消必须中止 Agent 与执行器；历史任务不自动重派。Items、Security、Memory 的数据职责保持独立。
- **CON-001**: macOS 用户入口只经 `scripts/build_lake.sh` 构建并持久签名；桌面安装只用 `--dev --install`。不合并或发布。
- **CON-002**: 历史 Go 数据保留，TS 新数据独立命名空间；未迁移的旧运行账本不冒充 ZCode 可恢复任务。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 固定源码与纯 TS 运行内核。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 核对 release、下载归档、记录 `runtime/zcode/upstream.json`；保留上游许可。 | ✅ | 2026-11-05 |
| TASK-002 | 删除本分支 Go 桥接修改；实现 `runtime/zcode/agent.ts`，通过公开 AgentRuntime 与 Node adapters 完成候选的文本模型、Write 工具、审批、取消与重启历史；其余能力按全量矩阵另行验收。 | ✅ | 2026-11-05 |
| TASK-003 | 实现 `runtime/zcode/store.ts`、`server.ts`：Lake 产品数据、配置、会话、SSE、鉴权、生命周期及静态页面。依赖 TASK-002。 | | |

### Implementation Phase 2

- **GOAL-002**: 签名打包与真实 Dev 验证。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 更新 `runtime/zcode/build.mjs` 与 `scripts/build_lake.sh --ts-candidate`；随候选提供 Node SEA、React 和许可；运行无需源码或 Go。默认入口、桌面构建与健康检查仅在全量验收后单独切换。候选部分不依赖 TASK-003 的全量完成。 | ✅ | 2026-11-05 |
| TASK-005 | 添加真实模型 HTTP 夹具与工具副作用回归，验证审批接受/拒绝、取消、重连、重启、秘密与数据隔离；运行前端、签名包和 Lake Dev 验证。依赖 TASK-004。 | | |
| TASK-006 | 更新开发说明、架构方向和验收记录；记录 SHA、平台缺口和未迁移功能，经普通 PR 到 develop。依赖 TASK-005。 | | |
| TASK-007 | `runtime/zcode/inventory.mjs` 从当前 API AST 固定操作清单；`parity.json`、`scripts/check_zcode_parity.py` 区分候选测试与完整等价证据。同步 develop@16ef7075 后当前为 118 项操作、20 个领域（含会话导航/标签），均未完成完整等价验收；默认检查失败，候选不能自动切换。 | ✅ | 2026-11-05 |
| TASK-022 | `runtime/zcode/navigation.ts` 移植会话置顶/排序、图标、项目标签及乐观版本/事务/事件合同；验证跨项目、并发、重启及会话活动不变。仅候选层完成，完整 UI/Dev 与历史数据验收仍属 TASK-021。 | ✅ | 2026-11-05 |
| TASK-023 | 按用户新增的明确要求增加 `--dev --ts-candidate --install`：签名 SEA 和资源随包、原生运行类型校验/停止/重连、同 Dev 凭据引用、旧数据快照与保留；覆盖安装并启动现有 Dev，记录真实 TS bootstrap 和原生窗口。仅 Dev 预览授权，不计全量验收。 | | |

### Implementation Phase 3

- **GOAL-003**: 保留全部既有能力后切换；以下任务均依赖 TASK-007，以现有 Go 行为、前端 contracts 和相关设计规格为对照，而非只实现同名 URL。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-008 | 在 `runtime/zcode/migration.ts` 实现 `previewLegacyMigration`、`applyLegacyMigration`、`rollbackMigration`：从只读旧 SQLite/JSON 形成带摘要的显式迁移批次，保留 ID、审批、操作、unknown 与来源；凭据仅在当前 Dev/隔离 Home 内按原引用转换，不自动重派任务。验证迁移前后行数、引用与回退。 | | |
| TASK-009 | 在 `runtime/zcode/resources.ts` 实现 `editResourceTree`、`previewResourceImport`、`commitResourceImport`，覆盖资源/目录、批量导入、HexHub、归档恢复及版本变化；对照 `internal/web/resource*.go`，保持项目范围、稳定身份与连接引用。 | | |
| TASK-010 | 在 `runtime/zcode/terminals.ts` 实现 `openTerminal`、`adoptTerminal`、`writeTerminal`、`interruptCommand`，保持本机/SSH/容器 PTY、host-key 审批、generation、控制权、历史与 WS。对照 `internal/web/terminal*.go` 验证连接重建、旧 generation 拒绝与未知结果不重放。 | | |
| TASK-011 | 在 `runtime/zcode/service-tools.ts` 实现 `createServiceToolCatalog`、`executeServiceTool`，移植数据库、Redis、Docker、Kubernetes、APISIX 与指标资源能力；沿原分类器与 schema 解析目标，不将不可用远端替换成本机。 | | |
| TASK-012 | 在 `runtime/zcode/security.ts` 实现 `prepareOperation`、`claimApproval`、`dispatchOperation`、`revokeExecution`，逐项保留 `internal/security`、`internal/ai/security_*.go` 的范围、版本、单次批准、连接变化、撤销、租约与 unknown 对账；不能用上游通用 allow 取代 Lake Security。 | | |
| TASK-013 | 在 `runtime/zcode/tasks.ts` 实现 `createGoal`、`beginAttempt`、`recordEvidence`、`acceptGoal`、`recoverGoal`；移植 WorkGoal/操作/验收账本与恢复，保持原任务唯一完成权威，候选 UI 投影不能自行关闭任务。依赖 TASK-012。 | | |
| TASK-014 | 在 `runtime/zcode/pilot.ts` 实现 `routeUserInput`、`dispatchWorker`、`manageSpecialist`、`readSpecialistChannel`；对照 `internal/ai/superagent_*.go` 与 `internal/web/superagent_*.go`，保留 Pilot、长期专员、连续频道、跨任务证据和补充输入边界。依赖 TASK-013。 | | |
| TASK-015 | 在 `runtime/zcode/providers.ts` 实现 `resolveModel`、`probeModel`、`discoverModels`；完整迁移现有协议、推理档位、容量、图像输入输出、模型同步与辅助调用，使用 ZCode Provider/Model 映射并保留当前 Home 私有凭据。 | | |
| TASK-016 | 在 `runtime/zcode/conversation.ts` 实现 `stageAttachment`、`sendMessage`、`admitSupplement`、`compactConversation`、`rollbackConversation`；保留图片/文本附件、资源引用、消息队列、顺序、Plan 模式、撤销与流式游标，验证 caret 锚点不会进入草稿、剪贴板和发出文本。 | | |
| TASK-017 | 在 `runtime/zcode/extensions.ts` 实现 `resolveProjectMcp`、`resolveSkills`、`testMcp`，移植 MCP stdio/HTTP/SSE/OAuth、项目继承、动态目录与 Skills；按当前资产/任务范围重验，凭据不进入事件和模型参数。依赖 TASK-012。 | | |
| TASK-018 | 在 `runtime/zcode/workflows.ts`、`schedules.ts` 实现 `runSavedWorkflow`、`scheduleTask`、`deliverExternalEvent`；保留工作流版本、日程时区、幂等、取消、外部订阅、守候与验收，对照现有 SRE/任务规范。依赖 TASK-013、TASK-014。 | | |
| TASK-019 | 在 `runtime/zcode/memory.ts` 实现 `captureMemorySource`、`readScopedMemory`、`forgetMemory`，沿 bearqy 当前文件记忆主计划及实际仍有效链路移植同意、来源、水位、前台优先、角色/项目范围、撤回与遗忘；不复活已退役 V2 自动提取。依赖 TASK-012、TASK-013。 | | |
| TASK-020 | 在 `runtime/zcode/cli.ts` 实现现有 CLI/stdio/Magpie 合同；迁移 macOS/Windows 启动、发现、签名、安装与更新资源。先做独立平台候选，保留双环境隔离，不提前修改默认安装入口。 | | |
| TASK-021 | 对 TASK-008 至 TASK-020 的最终集成 SHA 执行行为对照、数据/恢复/权限、macOS/Windows 与 Lake Dev light/dark/窄窗验收；更新每个 API 和领域的真实等价证据。只有矩阵全部 verified 且检查通过，才单独修改默认构建、原生健康协议与 Dev 包进行切换；合并和发布仍需用户授权。 | | |

## 3. Alternatives

- **ALT-001**: Go 宿主调用 ZCode sidecar：用户已明确要求 TS 后端，取消。
- **ALT-002**: 换成上游 UI：不符合沿用 Lake UI 的要求。

## 4. Dependencies

- **DEP-001**: ZCode v3.17.2、Node 24.14.0、上游 pnpm 锁文件。
- **DEP-002**: Lake React 既有 contracts 与原生桌面壳、持久签名身份。

## 5. Files

- **FILE-001**: `runtime/zcode/`：TS 产品宿主、上游清单与源码构建。
- **FILE-002**: `scripts/build_lake.sh`、`scripts/build_lake_desktop.sh`、`scripts/run_lake_dev.sh`：构建与运行。
- **FILE-003**: `client/macos/Sources/LakeDesktop/Backend.swift`、`SuperagentConnection.swift`：健康、发现与退出。
- **FILE-004**: `web-agent/web/src/api.ts`、开发规范与验收记录：契约与说明。

## 6. Testing

- **TEST-001**: TS 宿主在随机隔离 Home、端口 0 启动，未鉴权与跨源请求拒绝；重复 Home 启动拒绝。
- **TEST-002**: 本地 HTTP 模型夹具经过真实 ZCode AgentRuntime，产生 Lake 会话、流式事件与工具结果；禁止模拟替代 runtime。
- **TEST-003**: 写入批准前无副作用；拒绝不写；取消后无后续模型调用；重启不重放历史操作。
- **TEST-004**: 类型检查、前端相关测试与构建；签名后运行 `--version`、隔离后端及 Lake Dev 视觉检查。

## 7. Risks & Assumptions

- **RISK-001**: 旧 Lake 任务/安全账本与 ZCode 会话不可直接互换，必须保留来源与明确兼容范围。
- **RISK-002**: Node 原生模块与资源需随目标平台验证，macOS 结果不作为 Windows 验收。
- **ASSUMPTION-001**: 此分支只交付 Dev，生产安装、发布和 PR 合并另需明确授权。

## 8. Related Specifications / Further Reading

[发布源码](https://github.com/zai-org/ZCode/releases/tag/v3.17.2) · [贡献规范](../CONTRIBUTING.md) · [模块职责](../agent.md)
