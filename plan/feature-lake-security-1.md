---
goal: 基于 Lake 现有 ADK 调用链实现目标解析、安全决策与执行保护三层 Lake Security
version: 1
date_created: 2026-10-30
last_updated: 2026-10-30
owner: Lake
status: Planned
tags: [feature, architecture, security, authorization, migration, adk]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

本计划实施[Lake Security v1 详细设计](../docs/design/lake-security-v1.md)。代码分析基线为 `a60c8ad4f428b46d8fe6ce9a7fa165658dbe87c4`；执行每阶段前从最新 `origin/develop` 创建工作分支，并检查下列函数是否变化。当前所有任务均未开始，本文完成不表示安全模块已经交付。

目标是拆开“当前目标”和“授权边界”，复用现有原生审批、操作账本和 ADK continuation，将主会话、子任务、Pilot、终端、MCP、workflow、schedule 和后台恢复接入相同安全内核。以下八阶段建议各作为一个 PR；不以此计划授权合并、安装生产或发布。

## 1. Requirements & Constraints

- **REQ-001**: `CurrentTarget`、`pendingResolution` 与 `ExecutionBoundary` 独立建模；普通目录导航不生成新硬限制；旧硬边界迁移不自动扩大。
- **REQ-002**: 项目保存策略；会话保存目标和确认偏好；任务保存有限读取授权；单次审批绑定确切操作。切换目标不能签发授权。
- **REQ-003**: 目标解析采用后端稳定 ID 和项目归属校验；支持实际连接地址匹配、多候选消歧、真实选择答案恢复和“继续”继承。
- **REQ-004**: 每个运行时工具登记能力；未知工具、无法归属的数据访问和不支持的操作在 enforced 模式 fail closed。
- **REQ-005**: 新项目采用 restricted；legacy 保留旧有效默认；compatible 的 opaque 操作只能单次审批。任务临时授权仅含可证明的结构化读取。
- **REQ-006**: 单次审批保留 15 分钟 TTL 和原 ADK 状态机；任务授权可选 30 分钟/4 小时、默认上限 4 小时；完成/取消/撤销/到期后禁止新派发。
- **REQ-007**: 调度授权必须指定绝对到期时间和正整数剩余触发次数；本次 occurrence 原子扣减一次。无有效授权的定时运行显示 `authorization_required`。
- **SEC-001**: 模型、工具输出、记忆、技能和前端提交的 `approved`/actor/Permit 字段不能授予权限；只有已认证用户授权动作能够签发授权。
- **SEC-002**: 明确 deny、项目上限、父限制、Plan/Pilot 角色和本机禁令优先于 task grant 和单次审批。
- **SEC-003**: 描述绑定精确资源、连接版本、规范化参数、预览、目标/策略/授权 revision 和终端 generation；变化后旧审批失效。
- **SEC-004**: 派发登记、单次审批消费、授权使用记录和审计使用同一 ADK SQLite 事务；unknown 不自动重放，也不阻止无关已授权读取。
- **SEC-005**: 资源 Web SQLite、ADK SQLite 和定时 JSON 文件通过 coordinator 的版本协议协调；changing 状态与中断迁移禁止派发。
- **SEC-006**: 凭据只在适配器按 reference 读取；不输出模型 key、私钥、密码，不在 SDK state/events、审计或测试日志保存秘密。
- **SEC-007**: 不把 Go 层审批当 OS/远程 Shell 沙箱；无法证明副作用的操作按 opaque 处理，restricted 拒绝。
- **CON-001**: 不增加第二套模型循环、审批账本或操作账本；领域包不得依赖 AI/Web；不得使用 SDK internal API。
- **CON-002**: 每阶段遵守 CONTRIBUTING 与开发流程：独立分支 PR 到 develop，记录实际 SHA 和本地验证，明确授权后才合并；不触发未请求的 CI 或生产操作。
- **CON-003**: macOS 集成使用签名脚本和 Lake Dev/隔离 Home；不复制正式版 secrets，不启动第二后端争用同一 Home。
- **GUD-001**: 前端遵守共享 AppSelect/Glyph/主题和圆角；浅深色、窄窗口、键盘及运行中撤销均须真实验证。
- **PAT-001**: 所有领域判定采用显式快照和显式时间；I/O、事务、审批等待放应用协调层；等待期间不持 barrier 锁。

## 2. Implementation Steps

任务表的“否 / 未开始”是实际状态。任务按编号顺序执行，除非表中依赖明确允许独立执行；每阶段依赖前一阶段退出条件。新路径均标为“新增”，不能误当作已有接口。

### Implementation Phase 1

- **GOAL-001**: 建立兼容基础、入口清单和单 Home 协调器所有权，作为后续可支持的最低回退版本。

依赖：无。退出条件：工具/派发入口全部登记；一个 Home 只能有一个权威 coordinator；未来 schema 和中断迁移拒绝启动执行；不改变现有有效权限。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | 在新增 `docs/security/tool-entrypoints.md` 逐项列出 `Engine.invoke` 的全部早期分支、`invokeSessionTool`、`Server.bridge`、`Server.terminalRoute`、`Serve`、`executeSchedule` 和实际 I/O 适配器；记录工具名、actor 来源、目标种类、当前权限/审批/账本路径。用运行时工具目录快照核对条数相等。依赖：无。 | 否 | 未开始 |
| TASK-002 | 新增 `internal/security/schema.go` 的 schema/minimum-reader 版本与纯校验函数；在 `internal/ai/adk_session.go:adkStore` 和 `internal/web/server.go:New` 执行 reader guard。未完成迁移、未来 schema 返回明确错误，不开始派发；无新 schema 的旧 Home 保持原行为。新增 schema 测试。依赖：TASK-001。 | 否 | 未开始 |
| TASK-003 | 新增 `internal/ai/security_coordinator.go`，按 Home 注入唯一 coordinator；修改 `internal/ai/stdio.go:Serve` 和 Web 初始化共享所有权，第二进程使用相同 Home 时拒绝，子 Engine 复用父实例。新增两个 Engine/两个进程/不同 Home 隔离测试，不自行杀进程。依赖：TASK-002。 | 否 | 未开始 |
| TASK-004 | 在新增 `docs/validation/lake-security-v1.md` 记录兼容基础 SHA、reader guard 行为和入口清单计数；运行现有权限/终端/ADK 恢复回归及 runtime boundary 检查，记录最低支持回退版本。依赖：TASK-003。 | 否 | 未开始 |

### Implementation Phase 2

- **GOAL-002**: 拆分目标意图和硬边界，消除新会话被历史空目录导航锁住的状态耦合。

依赖：GOAL-001。退出条件：真实选择、唯一地址、目录候选、待消歧和继承行为可单测；目标切换不修改授权；旧范围仍严格受限。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-005 | 新增 `internal/security/target.go` 的 CurrentTarget、TargetResolution、ExecutionBoundary、来源枚举和 revision；在 `internal/ai/types.go:Config` 增加仅后端可写的安全上下文，保留旧 targetScope 兼容投影。新增克隆/不可变快照测试。依赖：TASK-004。 | 否 | 未开始 |
| TASK-006 | 新增 `internal/web/target_resolution.go:ResolveTarget`；提取 `directoryTurnScope`、`questionTargetScope` 中的目录和选择逻辑，按真实 host/port/account/protocol 查唯一目标；仅用户真实选择/显式无歧义标识可直接切换。模型候选需确认；待解决切换禁止旧目标回退。新增 `internal/web/target_resolution_test.go`。依赖：TASK-005。 | 否 | 未开始 |
| TASK-007 | 修改 `internal/web/agent.go:runTurn`、`internal/ai/directory_targets.go:enforceTargetScope`，新模式仅由 ExecutionBoundary 限制执行，普通目录用于发现；将旧 TargetScope 投影成独立 legacy_scope 边界。每操作捕获目标 revision；纯目标修改不修改权限配置。依赖：TASK-006。 | 否 | 未开始 |
| TASK-008 | 扩展 `internal/web/directory_targets_test.go`、`resource_selection_scope_test.go` 和 `internal/ai/directory_targets_test.go`：覆盖空目录→明确 B、硬边界拒绝 B、继续、同地址多账号、否定/引用文本、目录改名/增员、目标并发切换。断言拒绝时派发计数为 0。依赖：TASK-007。 | 否 | 未开始 |

### Implementation Phase 3

- **GOAL-003**: 交付封闭能力注册表和无 I/O 的确定性判定内核，先以 shadow 对照现有结果。

依赖：GOAL-002。退出条件：所有工具存在注册项；相同输入判定稳定；deny 无法被授权覆盖；shadow 不放宽现有执行。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-009 | 新增 `internal/security/types.go`、`reason.go`、`canonical.go`，定义设计第 6/7 节的 PreparedOperation、Decision、身份与原因码；规范化 JSON 固定集合排序和 null 语义，秘密只保留后端 reference revision。编写等价输入/参数变化/秘密参数拒绝测试。依赖：TASK-008。 | 否 | 未开始 |
| TASK-010 | 新增 `internal/security/capability.go`，按 TASK-001 清单登记全部工具、能力、目标类型、证明等级与预览器标识；新增 catalog 完整性测试。复用 `ToolRisk`、`CommandPolicy`、`readonlySQL`/`redisReadOnly` 的分类证据；未注册不再默认为 readonly。依赖：TASK-009。 | 否 | 未开始 |
| TASK-011 | 新增 `internal/security/evaluator.go:Evaluate`，实现硬限制→能力 deny→精确资源规则→allow/可授权 ask→单次审批的固定顺序；实现 restricted/compatible/legacy 三种类型化策略和任务读取能力白名单。测试所有规则冲突、过期、角色交集与 opaque 模式差异。依赖：TASK-010。 | 否 | 未开始 |
| TASK-012 | 新增 `internal/ai/security_adapter.go:PrepareOperation`，一次生成可信策略/连接快照，替换 `Engine.invoke` 对同一 policy 的重复分析；shadow 仅输出脱敏差异，不使用新 allow 放行。为 Web 与 standalone 分别适配旧有效默认值，不更改旧开关。依赖：TASK-011。 | 否 | 未开始 |
| TASK-013 | 新增 `internal/security/evaluator_test.go` 中固定 benchmark fixture：100 资源、20 规则、20 grant、并发 8；记录 Evaluate p95 与纯准备基线，目标分别小于 1ms、相对旧准备/登记 p95 增量不超过 10ms（排除模型/网络）。同时验证领域包无 AI/Web import。依赖：TASK-012。 | 否 | 未开始 |

### Implementation Phase 4

- **GOAL-004**: 持久化安全状态，接入现有审批和派发事务，验证撤销竞态和双库中断恢复。

依赖：GOAL-003。退出条件：在同一 ADK 事务中消费审批并登记操作；撤销先提交则零派发；资源 changing 时拒绝；原 unknown 恢复保持。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-014 | 新增 `internal/ai/security_store.go` 及测试，实现设计第 8 节的全部 security 表、唯一约束、CAS、不可变审计与显式绝对时间；扩展 `adkStore` 迁移，增加原生审批/操作的描述 hash 和决策关联列，不改 SDK 内部表。依赖：TASK-013。 | 否 | 未开始 |
| TASK-015 | 在 `security_coordinator.go` 实现资源 changing→Web 更新→ready 协议、短时 barrier 和固定锁顺序；新增 `internal/web/security_catalog.go`，让 `EditTerminalResource`、`CreateResource`、资源导入/删除、MCP 配置变更均经 coordinator，名称变化不提升连接 revision。对每个提交断点注入失败并测试重启关闭派发。依赖：TASK-014。 | 否 | 未开始 |
| TASK-016 | 修改 `internal/ai/adk_approval.go:waitNativeApproval`、`decideNativeApproval`、`claimNativeApprovals`，扩展绑定描述与 revision，保留 15 分钟 TTL、ADK confirmation 和状态机；旧无新描述 pending 失效，重复确认幂等。扩展 `adk_parallel_approval_test.go`。依赖：TASK-015。 | 否 | 未开始 |
| TASK-017 | 实现 `security_coordinator.go:AcquirePermit`，修改 `adk_operations.go:dispatchNativeOperation`，事务中复核当前策略/grant/task、消费单次审批、登记授权使用及原生操作和审计。Permit 不可序列化/伪造/重用。保留现有重复粒度和 finish unknown 语义。依赖：TASK-016。 | 否 | 未开始 |
| TASK-018 | 新增 `internal/ai/security_dispatch_test.go`：用可控 barrier 覆盖撤销/取消与提交的两种先后、审批后改参数/连接、两个并发消费者、登记后崩溃、unknown 对账与无关读取。校验事务回滚不消耗授权且不发生 I/O。依赖：TASK-017。 | 否 | 未开始 |

### Implementation Phase 5

- **GOAL-005**: 所有实际执行入口接入统一 Permit，覆盖终端、MCP、派生任务、工作流与调度。

依赖：GOAL-004。退出条件：入口清单中没有无 Permit 的 agent 派发；同请求/上下文的决策一致，子角色只能更严格；人工手动入口单独鉴权。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-019 | 修改 `internal/ai/tools.go:Engine.invoke` 和 `internal/web/agent.go:bridge` 的全部早期/常规分支，使资源、附件、记忆、项目控制均通过 Prepare/AcquirePermit；将 `approved bool` 从可放行依据降为兼容字段，最终移除。实际 I/O 适配器改为接收内部 Permit/冻结描述。依赖：TASK-018。 | 否 | 未开始 |
| TASK-020 | 修改 `internal/web/terminal_access.go:ResolveTerminalAccess`、`terminal.go` 的 Execute/Input/Interrupt/Close、`server.go:terminalRoute` 和 `manual_terminal.go`，区分可信人工来源与 agent；保留 owner/generation/上下文与单写者检查，建连后原命令重审，拒绝受限模式任意交互输入。新增 `internal/web/security_terminal_test.go`。依赖：TASK-019。 | 否 | 未开始 |
| TASK-021 | 修改 `internal/ai/session_tools.go:invokeSessionTool` 与 `internal/web/extensions.go:extensionBridge`；新增固定 MCP capability binding，校验 server/tool/参数资源映射/config/catalog revision；stdio 服从本机禁令，未知工具注解不能授予 readonly，opaque 仅 compatible 单次审批。新增 `internal/ai/security_mcp_test.go`。依赖：TASK-020。 | 否 | 未开始 |
| TASK-022 | 修改 `internal/ai/agent_scope.go:scopedChildConfig`、`adk_sre_roles.go:ExecuteSRERole`、`adk_observation_roles.go:runInvestigations`，传递可信 task/父授权身份并每次取父最新交集。新增 `internal/ai/security_children_test.go` 覆盖父撤销、子授权扩大、readonly 角色和相同请求入口等价性。依赖：TASK-021。 | 否 | 未开始 |
| TASK-023 | 修改 `internal/web/tool_bridge.go:checkToolWorkflowScope`、`workflows.go:startWorkflow/executeWorkflowRun`，为每次运行绑定独立 taskID、冻结版本、精确目标与有效授权；新增 workflow occurrence 唯一关联。修改外部 watch、work wait、work goal 恢复路径以原 taskID 复核 TTL。新增 `internal/web/security_workflow_test.go`。依赖：TASK-022。 | 否 | 未开始 |
| TASK-024 | 修改 `internal/web/schedules.go:writeSchedules/executeSchedule` 与 `schedule_routes.go:scheduleRoute`，对 JSON 更新执行 changing/原子替换/ready；以 scheduleID/revision/dueAt 幂等登记 occurrence、扣减次数、签发 task grant，幂等补建 Web workflow run。新增 `internal/web/security_schedule_test.go`，覆盖崩溃、重复 tick、修改/取消和无授权待处理。依赖：TASK-023。 | 否 | 未开始 |
| TASK-025 | 按 TASK-001 完成 I/O 清单复查：文件路径/symlink/hash、DB 分类/服务端权限、网络地址/重定向、SSH host trust、credential reference 隔离；无法保证的适配器显式 opaque。新增 `internal/ai/security_adapters_test.go`，假适配器证明拒绝零派发；新增 `scripts/check_security_boundary.py` 作为补充静态门禁，不能用文本扫描代替运行测试。依赖：TASK-024。 | 否 | 未开始 |

### Implementation Phase 6

- **GOAL-006**: 提供可理解的目标、任务授权与单次审批交互，支持即时撤销和旧客户端保护。

依赖：GOAL-005。退出条件：设置/授权只由真实用户动作签发；CAS、幂等、项目归属可测试；UI 明确区分选择与授权，并收到实时失效状态。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-026 | 新增 `internal/web/security_routes.go`，实现设计第 12 节六个路由，接入 `Server.protect`/归属/CAS/actionID；限制任务授权到固定读取能力、30 分钟/4 小时和项目上限；schedule 更新必须显式提供到期/次数。新增路由拒绝、跨项目、重复提交及旧 aiOptions 覆盖保护测试。依赖：TASK-025。 | 否 | 未开始 |
| TASK-027 | 修改 `web-agent/shared/contracts.ts` 与 Web snapshot/SSE 投影，增加四种安全 View 和 revision；过滤秘密与不可见目标，不把 backend Permit/原始配置发到前端。SSE 丢事件后从 snapshot 恢复；扩展协议序列化测试。依赖：TASK-026。 | 否 | 未开始 |
| TASK-028 | 新增 `web-agent/web/src/SecuritySettings.tsx`、`TaskGrantCard.tsx`、`TargetResolutionCard.tsx`，修改 `PermissionSettings.tsx`、`AIPanel.tsx`、`approvalPresentation.ts`；项目默认、当前目标、任务时限/撤销、确切动作预览分别显示。deny 无批准按钮，失效审批不可点击；复用共享控件和圆角。依赖：TASK-027。 | 否 | 未开始 |
| TASK-029 | 新增 `web-agent/web/test/securityPresentation.test.ts`，验证原因码对应文案/动作、expiry/revoke、旧客户端版本错误与目标消歧；在 Lake Dev 验证深浅色、窄窗口、键盘焦点及运行中撤销，无需依赖会话停止才能生效。记录截图与 SHA。依赖：TASK-028。 | 否 | 未开始 |

### Implementation Phase 7

- **GOAL-007**: 完成可重入迁移、配对备份、故障恢复和受控启用，保持存量限制不扩大。

依赖：GOAL-006。退出条件：Web/standalone 默认差异保留；旧范围不变成无限制；中断迁移和不兼容回退不派发；备份恢复不重放不明副作用。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-030 | 新增 `internal/ai/security_migration.go`，将七项有效 Permissions、来源、旧 TargetScope、Plan/角色约束映射 legacy 策略和 legacy_scope；空/待澄清范围保持未解决硬限制。迁移事务可重入，旧 pending 失效、原 unknown 保留、task expiry 不刷新。新增默认差异与迁移前后决策等价 fixture。依赖：TASK-029。 | 否 | 未开始 |
| TASK-031 | 新增 `internal/web/security_backup.go` 与 `internal/ai/security_recovery.go`，暂停新派发后为 ADK/Web 库制作配对一致快照及 JSON/config manifest；复用 `storage.Store.Backup`，Web 使用 SQLite 一致快照并 quick_check。恢复前保留新增操作证据，恢复后先核对 changing/config revision/unknown，再开放执行。新增逐断点故障测试。依赖：TASK-030。 | 否 | 未开始 |
| TASK-032 | 新增安全迁移管理入口 `internal/web/security_migration_routes.go` 并在 `cmd/lake/main.go` 现有命令结构接入管理子命令；支持 status/shadow/enforce/verify-backup，拒绝环境变量绕过、无清库指令。enforce 只在全部入口注册覆盖和数据一致校验通过后生效；记录迁移 actor/actionID。依赖：TASK-031。 | 否 | 未开始 |
| TASK-033 | 新增 `internal/ai/security_rollback_test.go`：兼容基础版本识别新 schema、未知 schema 拒绝、无法等价映射 deny/grant 时拒绝 legacy 降级；允许关闭新 UI 而不关闭安全内核。更新验证文档的支持回退 SHA、恢复步骤及旧历史程序不受 reader guard 保护的限制。依赖：TASK-032。 | 否 | 未开始 |

### Implementation Phase 8

- **GOAL-008**: 完成隔离 Dev 验收、性能与秘密检查，收口旧授权路径并形成可集成的证据。

依赖：GOAL-007。退出条件：设计第 14 节全场景通过；没有旧逻辑独立放行；本地检查和 Dev 验证绑定实际 SHA；未解决关键缺陷为零。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-034 | 在 `internal/ai/permissions.go`、`tools.go`、`session_tools.go` 与 Web configure/bridge 移除已替代的授权分支，保留确认偏好兼容投影；`nativePolicyHash` 兼容读取不得作为第二个放行来源。更新入口清单证明所有 agent I/O 必经 Permit；旧客户端不能写新权威状态。依赖：TASK-033。 | 否 | 未开始 |
| TASK-035 | 运行本计划 Testing 节对应的 Go/race/vet、静态 boundary 与前端检查；补齐竞态、秘密哨兵、双库恢复、调度去重和所有入口矩阵测试。出现失败先修复再重跑相关检查；记录命令/结果/实际 SHA，不把无自动 CI 视为通过。依赖：TASK-034。 | 否 | 未开始 |
| TASK-036 | 使用签名 `scripts/build_lake_desktop.sh --dev --install` 和独立验收 Home 做真实交互：截图的空目录切换、继续、多资源、审批后变更、即时撤销、子任务、MCP、schedule 和重启恢复。使用专用测试凭据与假目标；不复制正式秘密、不重启 Lake.app。记录平台/路径/SHA/截图。依赖：TASK-035。 | 否 | 未开始 |
| TASK-037 | 更新 `docs/validation/lake-security-v1.md`、新增 `docs/security/user-guide.md`，记录最终覆盖计数、性能样本、支持回退版本、限制与未验证项；将每个任务按真实完成情况更新状态，整理 PR 到 develop，等待对应明确合并授权。依赖：TASK-036。 | 否 | 未开始 |

## 3. Alternatives

- **ALT-001**: 在 prompt 中要求模型先确认目标/权限。拒绝：内容来源无法构成授权，无法覆盖非模型入口、并发撤销和恢复。
- **ALT-002**: 继续把目录、引用列表和当前目标都写入 TargetScope。拒绝：会延续空目录锁定与切目标即改权限的状态耦合。
- **ALT-003**: 新建独立安全服务或引入通用策略引擎。v1 不采用：当前固定能力规则可由纯 Go evaluator 表达；新增远程故障域和 DSL 迁移成本没有必要。
- **ALT-004**: 为 Security 新建审批/执行循环与独立操作数据库。拒绝：会破坏现有 ADK confirmation、事务消费和 unknown 恢复的一致边界。
- **ALT-005**: 为所有命令增加一次模型安全评审即可标成只读。拒绝：无法证明 Shell 二次访问与副作用；v1 使用 structured/opaque 分级及真实服务端权限。
- **ALT-006**: 全部存量项目立即套用 restricted。拒绝：旧 Web/standalone 默认不同，静默更改会破坏兼容；保留 legacy 后显式迁移。

## 4. Dependencies

- **DEP-001**: 详细设计第 4–7 节的状态、判定顺序和类型契约是所有阶段的接口依据；若改变必须先同步设计并重验影响用例。
- **DEP-002**: official ADK public toolconfirmation、现有 nativeApproval/nativeOperation/nativeEvidence 与 `internal/agent/storage`；不升级 SDK 作为本项目隐含依赖。
- **DEP-003**: Web 资源/连接 store、ADK store 和 schedule JSON 的单 Home 所有权；TASK-003/TASK-015 未完成前不得宣称撤销与派发一致。
- **DEP-004**: 使用仓库 `go.mod`、`web-agent/package.json`、锁文件固定的 Go/Node/pnpm 工具链和持久签名身份；缺失时按 CONTRIBUTING 配置，不绕过签名。
- **DEP-005**: 集成 fixture 必须包含独立 SSH/DB/Kubernetes/MCP 测试目标；无法获得某真实目标时标注该适配器未验收，使用假适配器不能冒充真实联调通过。

## 5. Files

以下为按职责分组的改动清单；带“新增”的文件当前不存在。TASK-001 产出的实际 I/O 清单是 TASK-025 的补充输入，发现额外入口必须补注册与测试，不能忽略。

- **FILE-001**: 新增 `internal/security/{schema,target,types,reason,canonical,capability,evaluator}.go` 及对应测试：无 I/O 领域模型、规则和摘要。
- **FILE-002**: 新增 `internal/ai/security_{coordinator,adapter,store,migration,recovery}.go` 及专用 dispatch/children/MCP/adapters/rollback 测试：应用协调与事务集成。
- **FILE-003**: 修改 `internal/ai/{types,permissions,tools,directory_targets,session_tools,stdio,adk_session,adk_approval,adk_operations}.go`：现有入口和权威账本复用。
- **FILE-004**: 修改 `internal/ai/{agent_scope,adk_sre_roles,adk_observation_roles,external_watch,external_watch_scheduler,adk_work_wait,work_goal}.go`：派生任务、角色与后台授权继承。
- **FILE-005**: 新增 `internal/web/{target_resolution,security_catalog,security_routes,security_backup,security_migration_routes}.go` 及对应测试：Web 适配、用户动作和恢复。
- **FILE-006**: 修改 `internal/web/{agent,store,server,directory_targets,resource_edit,resource_import,resource_tree,extensions,terminal_access,terminal,manual_terminal,tool_bridge,workflows,schedules,schedule_routes}.go`：资源、终端、工作流和 JSON 配置的一致性边界；修改 `cmd/lake/main.go` 接入管理命令。
- **FILE-007**: 修改 `web-agent/shared/contracts.ts`、`web-agent/web/src/{PermissionSettings,AIPanel}.tsx`、`approvalPresentation.ts`，新增 SecuritySettings/TaskGrantCard/TargetResolutionCard 组件与 `web-agent/web/test/securityPresentation.test.ts`。
- **FILE-008**: 新增 `docs/security/{tool-entrypoints,user-guide}.md`、`docs/validation/lake-security-v1.md` 和 `scripts/check_security_boundary.py`，更新本文任务状态、设计和最终证据。

## 6. Testing

- **TEST-001**: 领域单元测试覆盖显式时间/规则冲突/deny 优先/未知工具/稳定摘要/任务读取白名单，使用表驱动 fixture；每种拒绝均验证不能得到 Permit。
- **TEST-002**: 目标测试覆盖设计第 4 节的选择优先级、待消歧禁止旧目标回退、地址字段而非名称匹配、引用/否定文本、目录导航与硬边界分离及旧状态迁移。
- **TEST-003**: 审批与派发测试使用可控事务 barrier 验证撤销两种时序、审批重复提交和并发消费、参数/连接/终端变化、取消、事务回滚；断言假适配器调用次数。
- **TEST-004**: 入口矩阵为 main/stdio/Pilot/child/workflow/schedule/MCP/terminal 各运行 allow/ask/deny/expired/revoked 用例；相同上下文应一致，角色变窄应更严格。手动用户终端来源另测，模型伪造 actor 必须拒绝。
- **TEST-005**: 重启/故障注入覆盖 changing 协议每个断点、ADK/Web 配对快照、JSON 原子替换、occurrence 只扣一次、unknown 不重放、原 task TTL 不刷新与不兼容回退关闭执行。
- **TEST-006**: 生成不对应真实凭据的随机秘密哨兵，注入模型配置、工具错误和连接配置；检查捕获的 SDK events/state、应用日志、审计和前端快照不含哨兵。测试失败信息也不得输出真实秘密。
- **TEST-007**: 执行 `go test ./internal/security ./internal/ai ./internal/web ./internal/agent/storage`、`go test -race ./internal/security ./internal/ai ./internal/web ./internal/agent/storage`、`go vet ./internal/security ./internal/ai ./internal/web ./internal/agent/storage`，以及 `python3 scripts/check_adk_runtime_boundary.py`、新增的 `python3 scripts/check_security_boundary.py`。涉及命令/启动路径时补 `go test ./cmd/lake`。新包在实际创建后才执行对应命令。
- **TEST-008**: 执行 `pnpm --dir web-agent check`、`pnpm --dir web-agent test:frontend`、`pnpm --dir web-agent build:web`；Lake Dev 真实验证浅/深色、窄窗、键盘、实时失效和截图场景，记录实际 SHA 和独立 Home。
- **TEST-009**: 对 TASK-013 固定 fixture 保存平台、样本与 p95，纯 Evaluate 小于 1ms，本地准备/登记 p95 相对旧实现增量不超过 10ms。指标超标阻止性能验收，不通过删校验来达标。
- **TEST-010**: 本次文档交付仅检查 Markdown/frontmatter、计划声明 ID 唯一与引用闭合、源码/文档链接存在、任务依赖闭合及 `git diff --check`；本次不运行应用测试、不构建安装，也不声称上述未来测试已通过。

## 7. Risks & Assumptions

- **RISK-001**: 原权限开关存在 Web/standalone 默认差异且已影响生产行为；用 legacy 有效快照和等价判定 fixture 控制迁移，不静默统一默认值。
- **RISK-002**: 任何漏过 coordinator 的资源/MCP/定时配置更新都会造成过期授权；入口清单、注册完整性与逐断点测试是 enforced 的前置门槛。
- **RISK-003**: 两个 SQLite 和 JSON 无法构成单一 ACID 事务；通过 changing fail closed、CAS、单写者和幂等 occurrence 缩小风险，发生不一致先阻止该资源/运行并对账。
- **RISK-004**: 任意 SSH Shell、DB 高权限账号或远程 MCP 可以访问超出 Lake 可观测范围的资源；restricted 拒绝 opaque，compatible 呈现真实执行域，后续 OS/远端沙箱需独立设计。
- **RISK-005**: 撤销不能撤回已经登记并发送到外部的副作用；按提交线性化点说明时序，尽力取消并保留 unknown，不承诺 exactly-once。
- **RISK-006**: 旧二进制可能完全忽略新 schema；仅支持 GOAL-001 产出的兼容基础版及更新版本回退，不假定历史版本具备 reader guard。
- **RISK-007**: 全入口覆盖面大，八阶段可能需要按实际 diff 再拆 PR；拆分不得跳过退出门槛，未完成入口继续旧保护且不能标记新模式全覆盖。
- **RISK-008**: 审计与决策表增长、锁顺序错误会增加延迟或死锁；采用分页、短事务、固定锁序和性能/race 检查，v1 不自动删除操作账本。
- **ASSUMPTION-001**: 当前目标为单用户桌面/本机服务安全边界；如要开放多用户远程访问，必须另行设计认证、租户隔离和管理角色。
- **ASSUMPTION-002**: 用户修改策略和签发授权通过已认证应用入口；操作系统账户/后端进程本身未被攻陷，不将私有 SQLite 当抗恶意本机管理员的边界。
- **ASSUMPTION-003**: 本轮仅批准设计与计划编写，尚未开始功能实施；合并本设计 PR 也不自动授权之后的功能 PR 合并或生产发布。

## 8. Related Specifications / Further Reading

- [Lake Security v1 详细设计](../docs/design/lake-security-v1.md)
- [贡献规范](../CONTRIBUTING.md)
- [开发与发布流程](../docs/development-workflow.md)
- [ADK runtime 与恢复](../docs/experiments/adk-runtime.md)
- [前端 UI 规范](../docs/ui-guidelines.md)
- [已有会话权限计划](feature-session-permissions-1.md)
- [已有目录目标解析计划](feature-directory-target-resolution-1.md)
