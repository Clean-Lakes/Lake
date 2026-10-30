---
goal: 以明确任务身份、授权来源和恢复门禁实现 Lake Security 三层架构
version: 2
date_created: 2026-10-30
last_updated: 2026-10-30
owner: Lake
status: Planned
tags: [feature, architecture, security, authorization, migration, adk]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

本计划对应 [Lake Security v1 详细设计（修订 2）](../docs/design/lake-security-v1.md)，代码基线为 `9d1c4c65f8419ae2cf306b19fd16318fdc04a771`。保持文件名以延续原 PR 和文档链接；frontmatter 的 version 表示计划修订号。全部功能任务尚未开始，文档完成不表示模块已经实现。

修订后先建立权威存储、恢复门禁和普通会话的 `SecurityTask`，再实现策略与派发。旧范围按来源迁移；项目直接允许与临时授权是不同授权来源；恢复备份会使旧授权失效并要求重新确认策略。保留目标解析、安全决策、执行保护三层，以及现有 ADK 原生审批、操作账本和 continuation。

八阶段包含 40 项任务，建议按阶段提交可评审 PR。执行每阶段前以最新 `origin/develop` 为基础核对接口变化；本计划不授权功能 PR 合并、生产安装或发布。

## 1. Requirements & Constraints

- **REQ-001**: `CurrentTarget`、`pendingResolution` 和 `ExecutionBoundary` 独立建模；目录导航不创建硬边界，目标修改不签发授权。
- **REQ-002**: 服务端 `SecurityTask` 与 RootTurnID、WorkGoal、SRE task 和 workflow run 显式映射。新普通消息默认原子结束旧 conversation 任务、停止其未派发调用并使旧 grant 失效，再创建新任务；只有可信继续/恢复动作，或真实用户消息 trim 后完整等于“继续”/“继续检查”的命令，并携带已校验 taskID/expectedRevision/sourceMessageID，才续同任务；额外内容、引用或模型文本不算续接。
- **REQ-003**: SecurityTask 状态为 active/idle/waiting/paused/completed/cancelled/expired。一轮输出完成进入 idle；conversation 的显式结束/新任务替换、workflow/SRE 的可信运行账本终态、取消或创建后 24 小时绝对寿命到期使安全任务进入终态，模型完成文本不算终态事件。暂停/停止本轮进入 paused，保留 grant 的原 TTL 但不派发，恢复时重验授权；结束/取消/过期才使关联 grant 失效；重启后的未终结任务进入 paused，必须显式恢复。任务拆分 stateRevision（UI/CAS 状态版本，task 动作的 expectedRevision 对应此值）和 executionRevision（pause/complete/cancel/expire 时递增，使旧 prepared/approval 失效）；正常 active→waiting→active 只改 stateRevision，不能使审批自身失效。
- **REQ-004**: 项目保存策略、会话保存目标、任务承载有限授权、单次审批绑定精确操作。任务授权只支持可证明的结构化读取，时长可选 30 分钟/4 小时，且不能超过任务绝对到期时间；单次审批沿用 15 分钟 TTL。TaskGrant 绑定 taskID/epoch/自身 revision/TTL，不绑定 executionRevision；暂停后可在原 TTL 内复用 grant，但旧操作必须重新准备。
- **REQ-005**: 对每项能力，允许条件为全部硬限制满足，且当前规则由合法授权来源满足：项目 allow，或可授权 ask 加有效 task grant，或可审批 ask 加单次审批。deny 优先；无 TaskGrant 不使项目 allow 的子任务失权。
- **REQ-006**: 旧 TargetScope 按可验证来源区分显式执行限制与导航/推断。缺少来源时记为 legacy_unclassified 并停止相关资源派发，用户一次迁移确认提交目标及边界保留/修改；不默认无限制，也不永久固化为空硬边界。
- **REQ-007**: 用户可通过鉴权、CAS 和审计的边界接口修改本人可管理的边界；项目硬限制、父任务边界和角色上限不可由该接口覆盖。
- **REQ-008**: 同 Home 使用唯一 manifest 指向的规范 ADK runtime root（Web DataDir 下的 `adk`）；默认 stdio 不再独立使用 `ai/adk`。只有一个 owner，第二进程明确拒绝；v1 不实现远程 broker。
- **REQ-009**: 每个 Home 的 `<Home>/security/control.json` 保存 storeID、随机 recoveryEpoch 和执行 gate，Home manifest 指向唯一 RuntimeRoot，普通备份不包含 control 文件。策略、授权、审批和操作描述绑定 epoch；epoch 不符或 gate 关闭时禁止资源派发。
- **REQ-010**: 管理恢复先轮换新的随机 epoch 并关闭 gate，再保全现有账本、恢复配对快照；checkpoint/manifest 必须绑定 storeID+epoch，跨设备导入生成新 storeID+epoch 并进入管理模式。旧 task/schedule grants 及全部未消费的 pending/decided/authorized 审批失效，未终结旧任务 paused 但不能跨 epoch 直接续接，继续旧工作须新建 SecurityTask 并按新 epoch 重新授权；schedule disabled、策略 unconfirmed。gate 关闭时连外部对账读取也禁止；账本保全完整且受影响资源确定、仅结果 unknown/记录冲突时，持久阻断相关资源写入，全部策略确认后可开 gate，由新受限任务作已授权读取对账；证据丢失且无法确定影响范围时整个 gate 保持关闭，仅允许管理。
- **REQ-011**: schedule 的 configRevision/authorityRevision 与 statusRevision 分离。occurrence 唯一键为 scheduleID/configRevision/原计划 dueAt；状态刷新不撤销授权，重复触发只扣减一次次数，恢复后不自动追补旧 occurrence。
- **REQ-012**: 全部运行时工具登记能力和 resource/resource_set/project/session/none 五种目标类型；资源发现与任务/恢复控制不能因没有 CurrentTarget 而被资源选择阻断。未登记或无法约束的效果不得标成 readonly。restricted 拒绝 opaque，compatible 的 opaque 操作只支持单次审批，legacy 按存量有效设置适配。
- **SEC-001**: 模型、工具输出、日志、技能、记忆和工具参数中的 approved/actor/Permit 不是授权证据；授权与任务续接动作必须从可信入口生成。
- **SEC-002**: 子任务使用当前项目硬边界、父链限制与角色上限；每次派发重新验证其使用的项目规则、父授权或审批来源，不复制永久权限快照。
- **SEC-003**: PreparedOperation 和单次审批绑定 taskID/recoveryEpoch/executionRevision、真实资源/连接版本、参数/预览、目标/策略/授权 revision 与终端 generation，不绑定 task.stateRevision。派发时独立检查任务 active、expiry 和 RootTurnID/child scope 仍属于当前有效轮次；continue 新建 RootTurn 并关闭旧轮次绑定，旧未派发 call 不复活。
- **SEC-004**: 派发登记、审批消费、授权使用和审计在同一 ADK SQLite 事务；保留 unknown 对账和现有重复保护粒度，不以清理会话或恢复快照重试不明副作用。
- **SEC-005**: Web SQLite、ADK SQLite 与定时 JSON 使用 coordinator 的短时 barrier 和 changing 协议；等待模型、审批、网络时不持锁，锁顺序固定；中断迁移或 changing 对象不得派发。
- **SEC-006**: 仅执行适配器按 reference 读取凭据，SDK state/events、日志、审计和前端不保存模型 key、密码或私钥。
- **SEC-007**: Go 审批不等于本机或远端 OS 沙箱；无法证明的任意 Shell、MCP 二次访问和路径竞态按 opaque 处理。
- **CON-001**: 不增加第二套模型循环、单次审批账本或执行账本；纯领域包不依赖 AI/Web，不导入 SDK internal API。
- **CON-002**: 每阶段通过独立分支 PR 到 develop，记录实际 SHA 和本地证据，明确授权后才合并；不触发未请求的 CI 或生产操作。
- **CON-003**: macOS 集成使用签名脚本与 Lake Dev/隔离 Home，不复制正式版 secrets，不让两个后端共用 Home。
- **GUD-001**: 前端复用 AppSelect、Glyph、共享主题/圆角；真实验证浅深色、窄窗、键盘、运行中撤销和迁移恢复入口。
- **PAT-001**: 判定使用显式时间、版本和不可变描述；控制面动作使用 expectedRevision/actionID，拒绝测试断言外部派发计数为零。

## 2. Implementation Steps

“否 / 未开始”表示当前实际状态。每阶段依赖前一阶段退出条件；阶段内部按表中依赖执行，无直接依赖的任务可独立准备。所有标记“新增”的路径和函数均为拟实现，不表示已存在。基础阶段只建立存储和门禁，功能仍处于 legacy/shadow；enforced 必须等全部入口覆盖和迁移验证完成。

### Implementation Phase 1

- **GOAL-001**: 建立唯一权威存储、兼容 reader guard 和不可随普通备份回退的恢复门禁。

依赖：无。退出条件：明确规范路径与 owner，发现旧双库时先保全并处理身份冲突；未来 schema/中断恢复关闭派发；原操作证据不丢失。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | 新增 `docs/security/tool-entrypoints.md`，逐项登记 `Engine.invoke` 全部早期/常规分支、`invokeSessionTool`、`Server.bridge`、`Server.terminalRoute`、`ai.Serve`、`executeSchedule` 和实际 I/O；记录身份来源、目标种类、权限/审批/账本路径，用运行时工具目录核对覆盖数量。依赖：无。 | 否 | 未开始 |
| TASK-002 | 新增 `internal/ai/security_home.go:ResolveSecurityHome/AcquireSecurityOwner`，使用 Home manifest 固定 storeID 与 Web DataDir 下 `adk` 的规范 runtime root；修改 `cmd/lake/main.go`、`internal/ai/stdio.go:Serve`、`internal/web/server.go:New` 和 `adk_evidence.go:runtimeDirectory` 使用同一身份。第二 owner 明确拒绝，不自动开第二库、不杀已有进程；独立 Home 显式隔离。依赖：TASK-001。 | 否 | 未开始 |
| TASK-003 | 新增 `internal/security/schema.go` 与 `internal/ai/security_control.go:ReadControlState/RotateRecoveryEpoch`，维护 `<Home>/security/control.json` 的 storeID/随机epoch/gate，原子写入并同步落盘；checkpoint/manifest 绑定 storeID+epoch，普通备份排除此控制文件，跨设备导入使用新身份和关闭 gate。`adkStore`、Web/stdio 启动校验 schema、storeID、epoch 和中断标记，错误时只允许管理操作。依赖：TASK-002。 | 否 | 未开始 |
| TASK-004 | 新增 `internal/ai/security_store_migration.go:InventoryLegacyStores/MigrateLegacyStores`，先为原 Web `adk` 与 stdio `ai/adk` 制作一致备份；为 session/op/evidence 保留源库 namespace 和关联。同身份同 hash 可标记同源但保留原记录，冲突或未决内容进入只读历史/相关资源阻断，显式处理后才开 gate；禁止直接混并 SDK 内部表。生成迁移 manifest 并验证可重入。依赖：TASK-003。 | 否 | 未开始 |
| TASK-005 | 新增 `internal/ai/security_home_test.go`、`security_control_test.go`、`security_store_migration_test.go`：两个进程争用、不同 Home、两个旧库重复/冲突/unknown、迁移每个断点、未来 schema、丢失/损坏 control-state 均有确定结果；更新新增 `docs/validation/lake-security-v1.md` 记录兼容基础 SHA。依赖：TASK-004。 | 否 | 未开始 |

### Implementation Phase 2

- **GOAL-002**: 建立普通会话的 SecurityTask 状态机，拆分目标和边界并提供旧状态恢复闭环。

依赖：GOAL-001。退出条件：跨轮次继续、新任务、暂停/结束/过期都有可信事件；旧空目录会话可经一次明确确认恢复；目标操作与边界操作独立。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-006 | 新增 `internal/security/task.go`、`target.go`，定义 SecurityTask/CurrentTarget/TargetResolution/ExecutionBoundary 及固定来源和 24 小时 task deadline；SecurityTask 明确 stateRevision/executionRevision，前者用于 UI/CAS，后者在 pause/complete/cancel/expire 递增，active→waiting→active 不递增。定义 TaskEvent 的 new/continue/pause/resume/complete/cancel/expire，终态不可恢复；新增纯状态转移表测试。依赖：TASK-005。 | 否 | 未开始 |
| TASK-007 | 新增 `internal/ai/security_tasks.go:CreateSecurityTask/ApplyTaskEvent` 与 `security_store.go` 的基础 task/target/boundary/event 表及 `security_legacy_session_policies`，先按 session 保存存量七项权限、入口来源和 revision/epoch；任务由服务端生成 ID，可信 actionID 幂等，expectedRevision 对 stateRevision 做 CAS；存储 executionRevision 及当前有效 RootTurnID/child scope 绑定，记录与 WorkGoal/SRE/workflow 的类型化关联；结束一轮只置 idle；conversation 被新任务替换时原子终结旧任务并撤销旧 grant/未派发调用，workflow/SRE 按可信运行账本终态结束；普通重启置 paused，原 epoch 的合法续接不刷新 deadline，备份恢复旧 epoch 任务不得续接。依赖：TASK-006。 | 否 | 未开始 |
| TASK-008 | 修改 `internal/ai/engine.go` 的普通轮次初始化、`types.go:Config`、`adk_session.go:prepareADKHistory` 和 `internal/web/agent.go:runTurn`：新普通消息先原子结束旧 conversation 任务、停未派发调用并失效旧 grant，再建新 task；可信继续/恢复动作或真实消息精确继续命令，校验 taskID/expectedRevision（stateRevision）/sourceMessageID 后才可续接；continue 原子关闭旧 RootTurn/child scope 绑定并新建 RootTurn，旧未派发 call 不得复活。trim 后带额外文字/引用均按新消息处理。新增 `internal/web/security_task_routes.go` 的 task 控制入口，模型候选不能决定续接。补新主题与同会话同资源不得继承旧 grant 的回归。依赖：TASK-007。 | 否 | 未开始 |
| TASK-009 | 新增 `internal/web/target_resolution.go:ResolveTarget`，提取 `directoryTurnScope/questionTargetScope` 的发现逻辑，匹配真实连接地址与稳定 ID；显式未解决切换禁止退回旧目标。新模式只由 ExecutionBoundary 限制，目录选择仅生成候选；每操作冻结目标 revision。依赖：TASK-006。 | 否 | 未开始 |
| TASK-010 | 新增 `internal/ai/security_migration.go:ClassifyLegacyScope/ResolveLegacyScope`，区分有证据的 explicit restriction 与 navigation/inferred；无来源置 legacy_unclassified+pendingResolution，禁止资源派发直到用户提交明确 targetIDs 和边界保留/修改。保留真实 deny，不把旧空范围永久固化为硬边界，也不自动迁成无限制。依赖：TASK-007、TASK-009。 | 否 | 未开始 |
| TASK-011 | 新增 `internal/web/security_boundary_routes.go`，实现设计规定的目标选择、可管理边界修改与迁移确认接口；校验用户来源、项目/会话归属、边界 owner、expectedRevision/actionID，原子记录审计。不能修改父/项目 deny，普通 target 更新不能修改边界；扩展目录/资源选择测试覆盖已有故障会话恢复。依赖：TASK-008、TASK-010。 | 否 | 未开始 |
| TASK-012 | 新增 `internal/ai/security_tasks_test.go` 和 Web task/boundary 路由测试：一轮 idle→可信继续、精确“继续”/“继续检查”、近似命令/引用→新 task、过期 stateRevision 拒绝、active→waiting→active 不改 executionRevision、pause/终态递增 executionRevision、continue 关闭旧轮次、普通新消息→新 task、换题、终态、24 小时绝对到期、暂停、重启、旧范围确认、跨项目/父边界拒绝；使用显式测试时钟，拒绝断言零派发。依赖：TASK-011。 | 否 | 未开始 |

### Implementation Phase 3

- **GOAL-003**: 实现能力注册表与统一授权公式，以 shadow 比较现有结果。

依赖：GOAL-002。退出条件：全部工具登记；项目 allow/无 grant 子任务仍允许；ask/无授权需审批；任一硬 deny 不可覆盖；shadow 不改变原有效权限。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-013 | 新增 `internal/security/types.go`、`reason.go`、`canonical.go`，定义 PreparedOperation、Decision、AuthoritySource、resource/resource_set/project/session/none 五种目标类型和原因码；稳定 JSON 规范化绑定 taskID/epoch/executionRevision、有效 RootTurn/child scope、真实连接及参数/预览等安全 revision，排除 task.stateRevision。秘密只使用后端 reference revision，模型参数不能设置 actor 或构造 Permit。依赖：TASK-012。 | 否 | 未开始 |
| TASK-014 | 新增 `internal/security/capability.go`，按 TASK-001 清单登记工具、能力、resource/resource_set/project/session/none 目标类型、证明等级和预览方式；只有前两种做资源解析，资源发现与任务/恢复控制不因缺少 CurrentTarget 被阻断。复用 `ToolRisk`、`CommandPolicy`、`readonlySQL/redisReadOnly` 作为证据，未登记工具不默认为 readonly；新增目录覆盖测试。依赖：TASK-013。 | 否 | 未开始 |
| TASK-015 | 新增 `internal/security/evaluator.go:Evaluate`，严格实现 REQ-005 的授权公式，先判硬限制再解析当前能力的合法授权来源；project allow 无需 grant，ask 的 task/single 来源受 grantable/confirmation 约束，deny 不可覆盖。每次校验父链/角色及具体来源 revision/epoch；增加父 allow 无 grant、父 ask 无 grant、父来源撤销和多能力全满足测试。依赖：TASK-014。 | 否 | 未开始 |
| TASK-016 | 新增 `internal/ai/security_adapter.go:PrepareOperation`，使用 TASK-007 已建的 `security_legacy_session_policies` 按 session 保存 Web/standalone 的存量有效七项配置、入口来源、revision/epoch并生成 legacy 适配，不被项目默认覆盖，也不覆盖同项目其他会话；替换 `Engine.invoke` 的重复 policy 分析，shadow 仅记录脱敏差异。新项目 restricted/compatible 的固定范围、读取预算和 opaque 规则按设计实现。依赖：TASK-015。 | 否 | 未开始 |
| TASK-017 | 在新增 `internal/security/evaluator_test.go` 建立显式时间、规则冲突和固定性能 fixture（100 资源、20 规则、20 grants、并发 8），记录纯 Evaluate p95<1ms；后续派发集成用同 fixture 测准备/登记相对旧链 p95 增量≤10ms，不计网络/模型。检查领域包不导入 AI/Web。依赖：TASK-016。 | 否 | 未开始 |

### Implementation Phase 4

- **GOAL-004**: 将授权、原生审批与实际派发纳入同一事务和恢复 epoch。

依赖：GOAL-003。退出条件：审批只消费一次、撤销先提交则零派发、changing/epoch 不符即拒绝，原 unknown 对账保留。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-018 | 扩展 `internal/ai/security_store.go` 的已有基础表，增加设计中的 project policy/task grant/schedule grant/occurrence/resource revision/decision/authority event 表及唯一约束；所有权威对象绑定 storeID/epoch，grant 绑定 taskID/自身 revision/TTL 而不绑 executionRevision，绝对 expiry≤task deadline；原审批/操作绑定 executionRevision 和 RootTurn/child scope。扩展 `adkStore` 与原 nativeApproval/nativeOperation 列，不另建审批或执行账本。依赖：TASK-017。 | 否 | 未开始 |
| TASK-019 | 新增 `internal/ai/security_coordinator.go` 与 `internal/web/security_catalog.go`，实现共享短时 barrier、固定锁序和 changing→Web更新→ready 版本协议；资源创建/编辑/导入/删除、MCP 配置均接入，纯名称变化不提升连接 revision。失败恢复前保持不可派发，新增逐提交断点测试。依赖：TASK-018。 | 否 | 未开始 |
| TASK-020 | 修改 `adk_approval.go:waitNativeApproval/decideNativeApproval/claimNativeApprovals`，保留原 15 分钟 TTL、状态机和 ADK confirmation，新增 taskID/epoch/executionRevision/有效 RootTurn/child scope 和描述摘要绑定，不绑定 stateRevision；旧缺少绑定或 epoch 不符的未消费审批失效，重复确认幂等，active→waiting→active 正常审批可消费，pause 后旧审批不可复活。扩展 `adk_parallel_approval_test.go`。依赖：TASK-019。 | 否 | 未开始 |
| TASK-021 | 实现 `security_coordinator.go:AcquirePermit`，修改 `adk_operations.go:dispatchNativeOperation`：事务中复核 gate/epoch、task active/expiry/executionRevision、RootTurnID/child scope 当前有效性、策略与实际授权来源，消费审批、记录使用及原生操作/审计。Permit 只传进程内冻结描述，适配器不得重解目标；保留当前重复保护与 finish unknown 语义。依赖：TASK-020。 | 否 | 未开始 |
| TASK-022 | 新增 `internal/ai/security_dispatch_test.go`，用 barrier 控制撤销/取消与提交两种先后、审批后改参数/连接、两个消费者、task paused/terminal、epoch 切换、事务失败与登记后崩溃；验证 active→waiting→active 不使自身审批失效，pause/resume 后旧 prepared/approval 拒绝但原 TTL grant 可用于新准备，continue 后旧轮次/child call 拒绝；断言回滚不消费授权、拒绝无 I/O，unknown 不阻断无关合法读取。依赖：TASK-021。 | 否 | 未开始 |

### Implementation Phase 5

- **GOAL-005**: 覆盖所有执行入口，正确传递任务、父边界和授权来源，稳定调度 occurrence 身份。

依赖：GOAL-004。退出条件：入口清单无 agent 旁路；子角色只能更严格；schedule 状态写入不吊销自身授权，同 occurrence 只消费一次。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-023 | 修改 `internal/ai/tools.go:Engine.invoke`、`internal/web/agent.go:bridge` 全部早期/常规分支，资源、附件、记忆及项目控制工具均按其目标种类 Prepare/AcquirePermit。将 `approved bool` 降为无独立放行能力的兼容字段；实际 I/O 接收内部 Permit/冻结描述。依赖：TASK-022。 | 否 | 未开始 |
| TASK-024 | 修改 `terminal_access.go:ResolveTerminalAccess`、`terminal.go:Execute/Input/Interrupt/Close`、`server.go:terminalRoute` 和 `manual_terminal.go`，区分真实人工入口和 agent，保留 owner/generation/上下文及单写者；建连成功后重审原命令，restricted 不允许任意交互输入。新增 `internal/web/security_terminal_test.go`。依赖：TASK-023。 | 否 | 未开始 |
| TASK-025 | 修改 `internal/ai/session_tools.go:invokeSessionTool` 与 `internal/web/extensions.go:extensionBridge`，绑定受信 server/tool/resource 映射、config/catalog revision 和 task/epoch；自报 readonly 不授予权限，stdio 服从本机禁令，opaque 仅 compatible 单次审批。新增 `internal/ai/security_mcp_test.go`。依赖：TASK-023。 | 否 | 未开始 |
| TASK-026 | 修改 `agent_scope.go:scopedChildConfig`、`adk_sre_roles.go:ExecuteSRERole`、`adk_observation_roles.go:runInvestigations`，显式传递 SecurityTask/父链和实际 AuthoritySource；只收窄资源/角色，不要求每个 project allow 调查创建 grant。新增 `internal/ai/security_children_test.go`，验证父 allow 无 grant、父来源撤销及角色上限。依赖：TASK-023。 | 否 | 未开始 |
| TASK-027 | 修改 `internal/web/tool_bridge.go:checkToolWorkflowScope`、`workflows.go:startWorkflow/executeWorkflowRun`，每个 workflow run 映射 SecurityTask、冻结模板/目标；改造 AI external_watch/external_watch_scheduler/adk_work_wait/work_goal 恢复路径，使用原 task 且不刷新 deadline/expiry。新增 `internal/web/security_workflow_test.go`。依赖：TASK-026。 | 否 | 未开始 |
| TASK-028 | 修改 `internal/web/schedules.go:tickSchedules/writeSchedules/executeSchedule` 与 `schedule_routes.go:scheduleRoute`：显式拆 configRevision/authorityRevision/statusRevision；状态与运行关联更新只增 statusRevision。配置更新走 changing/原子替换/ready；以原计划 dueAt 建唯一 occurrence，在 ADK 事务内扣次数并创建 task grant，再幂等补建 Web run。新增重复 tick、状态更新不失效、修改/撤销和崩溃回归。依赖：TASK-027。 | 否 | 未开始 |
| TASK-029 | 按 TASK-001 复查文件路径/symlink/hash、SQL/服务端权限、网络解析/重定向、SSH trust、credential reference 等实际 I/O，无法约束者标 opaque。新增 `internal/ai/security_adapters_test.go` 和补充静态 `scripts/check_security_boundary.py`；以假适配器零派发和主/stdio/Pilot/child/workflow/schedule/MCP/terminal 矩阵测试证明无旁路。依赖：TASK-024、TASK-025、TASK-028。 | 否 | 未开始 |

### Implementation Phase 6

- **GOAL-006**: 提供任务续接、目标选择、边界迁移和授权撤销的完整用户交互。

依赖：GOAL-005。退出条件：新任务与继续任务有明确可信动作；旧空目录可一次确认恢复；授权只从合法用户入口签发，UI 状态与后端即时失效一致。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-030 | 新增 `internal/web/security_routes.go`，接入设计中的项目策略、task grant、revoke 和分页审计接口；复用 task/boundary 路由，全部做 `Server.protect`、身份/归属、CAS、actionID、task/epoch 及 expiry 上限校验。schedule 授权要求显式到期与次数；旧 aiOptions 不得覆盖新权威状态。新增越权/跨项目/重复提交路由测试。依赖：TASK-029。 | 否 | 未开始 |
| TASK-031 | 修改 `web-agent/shared/contracts.ts` 和 Web snapshot/SSE，投影任务状态/stateRevision/控制动作、目标解析、边界来源/可管理性、授权来源/时限、迁移待确认与恢复 gate；不发送 Permit 或秘密。断线从 snapshot 恢复，不因重连续期或生成任务授权。依赖：TASK-030。 | 否 | 未开始 |
| TASK-032 | 新增 `web-agent/web/src/SecuritySettings.tsx`、`SecurityTaskControls.tsx`、`TaskGrantCard.tsx`、`TargetResolutionCard.tsx`、`BoundaryResolutionCard.tsx`，修改 PermissionSettings/AIPanel/approvalPresentation。默认新消息新任务；继续/恢复控件和精确继续命令绑定可信 taskID/expectedRevision/sourceMessageID；模型续接提议须用户确认。清楚区分选目标、改边界、授予读取和批准单次动作；deny 无批准按钮。依赖：TASK-031。 | 否 | 未开始 |
| TASK-033 | 新增 `web-agent/web/test/securityPresentation.test.ts`，验证 task 终态/暂停、普通消息不携旧 grant、迁移边界确认、真实恢复按钮、expiry/revoke、SSE 刷新及旧客户端错误；Lake Dev 验证浅深色、窄窗、键盘、运行中撤销、已有空目录会话恢复，记录 SHA/截图。依赖：TASK-032。 | 否 | 未开始 |

### Implementation Phase 7

- **GOAL-007**: 完成备份恢复、重新确认策略与受控启用，阻止旧授权及调度预算复活。

依赖：GOAL-006。退出条件：恢复先轮换 epoch 并关闭 gate；所有旧临时授权/审批失效；策略未确认不开 gate。账本完整且影响范围确定的 unknown/冲突保持相关写阻断，开 gate 后可由新受限任务读取对账；证据丢失且影响范围不明则仅允许管理；不自动追补旧调度。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-034 | 新增 `internal/web/security_backup.go` 与 `internal/ai/security_recovery.go:RestoreSecurityBackup`：暂停派发、原子轮换 control-state 的随机 epoch 并置 gate=closed，保全当前账本/审计，再恢复配对 Web/ADK/JSON 快照。旧 task/schedule grants 及全部未消费 pending/decided/authorized 审批失效，未终结旧任务 paused 且不可跨 epoch 续接，继续旧工作必须创建新 SecurityTask/新 epoch 授权；schedule disabled、project policy unconfirmed；备份不能覆盖 control-state，checkpoint/manifest 绑定 storeID+epoch，跨设备导入用新身份且关闭 gate，不自动追补 occurrence。账本保全完整且影响资源确定的 unknown/冲突持久阻断相关写入，全部策略确认后才可开 gate，由新受限任务读取对账后解除写阻断；若证据丢失且无法确定影响范围，整个 gate 保持关闭仅管理。gate 关闭期间禁止任何外部对账读取。依赖：TASK-033。 | 否 | 未开始 |
| TASK-035 | 新增 `internal/web/security_migration_routes.go`，在 `cmd/lake/main.go` 的现有命令结构接入 status/shadow/enforce/verify-backup/restore 管理命令；必须使用 TASK-034 恢复协议。新增用户策略重新确认/恢复清单接口，记录 actor/actionID/epoch及持久资源写阻断；开 gate 前确认全部策略，旧任务不得直接恢复，用户续旧工作时新建 SecurityTask；enforce 仅在全部入口覆盖、旧状态处置及一致性检查完成后开放，无环境变量旁路或清账本选项。依赖：TASK-034。 | 否 | 未开始 |
| TASK-036 | 新增 `internal/ai/security_recovery_test.go`、`security_rollback_test.go`，覆盖备份→撤销/策略deny/消费定时次数→恢复，要求旧 grant 和 pending/decided/authorized 审批零派发、旧 task 不可跨 epoch 续接且无重复调度；每个恢复断点重启关闭 gate，期间外部读取也是零派发。账本完整且影响资源明确时，策略全确认后用新受限任务对账读取，unknown/冲突相关资源仍拒写；证据丢失且影响范围不明时整个 gate 关闭，仅管理；测试 epoch 不符、control-state 缺失、未来 schema和无法等价映射时拒绝旧模式降级。记录支持回退 SHA，历史无 reader guard 二进制不在支持范围。依赖：TASK-035。 | 否 | 未开始 |

### Implementation Phase 8

- **GOAL-008**: 收口旧授权路径并完成隔离 Dev 验收，交付真实可追溯的集成证据。

依赖：GOAL-007。退出条件：全部入口、四项评审问题及恢复测试通过；新权威状态唯一放行；记录实际 SHA、限制与平台结果，未解决关键缺陷为零。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-037 | 修改 `internal/ai/permissions.go/tools.go/session_tools.go` 和 Web configure/bridge，移除已替代的独立授权路径；旧 aiOptions 仅保留兼容确认偏好/只读投影，nativePolicyHash 不作为第二放行来源，删除 `approved bool` 的执行依赖。复查入口清单与所有 gate/epoch/父来源校验。依赖：TASK-036。 | 否 | 未开始 |
| TASK-038 | 运行 Testing 节的 Go/race/vet、ADK/security boundary、前端和性能检查；集中执行任务续接/换题、无 grant 子任务、旧空目录迁移、撤销后恢复、调度次数及所有入口矩阵。失败修复后重跑相关检查；记录命令与实际 SHA，不把没有自动 CI 当作通过。依赖：TASK-037。 | 否 | 未开始 |
| TASK-039 | 使用 `scripts/build_lake_desktop.sh --dev --install` 签名构建和独立验收 Home，实测新任务/继续/暂停/结束、截图空目录恢复、目标切换、审批后变更、即时撤销、Pilot/MCP/workflow/schedule、重启与备份恢复管理门禁。使用专用测试凭据/假目标，不操作生产；保存平台/路径/SHA/截图。依赖：TASK-038。 | 否 | 未开始 |
| TASK-040 | 更新 `docs/validation/lake-security-v1.md`，新增 `docs/security/user-guide.md`，记录覆盖计数、性能样本、最低回退版本、独立 Home/owner 规则、恢复后重新授权步骤及未验证项；按真实结果更新本文状态，整理 PR 到 develop，等待对应明确合并授权。依赖：TASK-039。 | 否 | 未开始 |

## 3. Alternatives

- **ALT-001**: 仅修改 prompt 要求模型判断目标/权限。拒绝：不能建立可信 task、授权来源、并发撤销或恢复边界。
- **ALT-002**: 将所有旧 TargetScope 固化为 legacy_scope。拒绝：会保留空目录故障并丢失原有明确重选恢复能力，改为按证据分类和一次迁移确认。
- **ALT-003**: 用 RootTurnID 或 sessionID 直接当安全任务。拒绝：前者无法跨轮次继续，后者会让新任务继承旧授权；使用显式 SecurityTask。
- **ALT-004**: 子任务必须持有 TaskGrant。拒绝：项目已经 allow 的读取无需额外 grant；采用授权来源满足规则，再与硬边界/角色求交。
- **ALT-005**: 恢复后按原 expiry 保留未到期授权。拒绝：撤销、策略收紧和消费次数可能已回退；恢复推进 epoch 并使旧授权失效。
- **ALT-006**: 新建策略服务、审批循环或独立执行账本。v1 不采用：固定 Go 规则和现有 ADK 原生账本足以承载本范围，避免新一致性故障域。
- **ALT-007**: 用模型评审证明任意命令只读。拒绝：无法约束二次访问与副作用；使用 structured/opaque 分类及真实服务端权限。

## 4. Dependencies

- **DEP-001**: 详细设计修订 2 的 SecurityTask 状态机、授权公式、迁移确认和恢复协议为所有阶段的接口依据；变更契约须同步两份文档及相关用例。
- **DEP-002**: official ADK public toolconfirmation、nativeApproval/nativeOperation/nativeEvidence 和 `internal/agent/storage`；不将 SDK 升级或私有内部表混并作为隐含前提。
- **DEP-003**: 规范存储、单 owner、control-state 与 reader guard 必须在任务/授权上线前完成；TASK-002 至 TASK-005 未通过时不得启用新权威数据。
- **DEP-004**: 使用仓库固定 Go/Node/pnpm 工具链和持久签名身份；缺失时按 CONTRIBUTING 配置，不使用未签名替代品。
- **DEP-005**: 真实适配器验收需要独立 SSH/DB/Kubernetes/MCP fixture；没有条件时明确该适配器未验收，假适配器不能冒充真实联调。

## 5. Files

以下按职责分组。标为“新增”的文件尚不存在；TASK-001 发现额外入口时必须补注册和验收，不能以此静态清单限制安全覆盖。

- **FILE-001**: 新增 `internal/security/{schema,task,target,types,reason,canonical,capability,evaluator}.go` 及测试：纯领域模型、任务状态机、授权公式、描述摘要。
- **FILE-002**: 新增 `internal/ai/security_{home,control,store_migration,tasks,store,migration,adapter,coordinator,recovery}.go` 及测试：规范存储、epoch/gate、任务与事务集成。
- **FILE-003**: 修改 `internal/ai/{engine,types,permissions,tools,directory_targets,session_tools,stdio,adk_session,adk_evidence,adk_approval,adk_operations}.go`：真实入口、普通轮次映射、持久化和原生审批/账本。
- **FILE-004**: 修改 `internal/ai/{agent_scope,adk_sre_roles,adk_observation_roles,external_watch,external_watch_scheduler,adk_work_wait,work_goal}.go`：父授权来源、角色和后台恢复。
- **FILE-005**: 新增 `internal/web/{target_resolution,security_task_routes,security_boundary_routes,security_catalog,security_routes,security_backup,security_migration_routes}.go` 及测试：可信用户动作、迁移/恢复管理、Web 适配。
- **FILE-006**: 修改 `internal/web/{agent,store,server,directory_targets,resource_edit,resource_import,resource_tree,extensions,terminal_access,terminal,manual_terminal,tool_bridge,workflows,schedules,schedule_routes}.go` 及 `cmd/lake/main.go`：资源/终端/定时版本、规范路径和管理命令。
- **FILE-007**: 修改 `web-agent/shared/contracts.ts`、`web-agent/web/src/{PermissionSettings,AIPanel}.tsx`、`approvalPresentation.ts`；新增 SecuritySettings/SecurityTaskControls/TaskGrantCard/TargetResolutionCard/BoundaryResolutionCard 组件及 `web-agent/web/test/securityPresentation.test.ts`。
- **FILE-008**: 新增 `docs/security/{tool-entrypoints,user-guide}.md`、`docs/validation/lake-security-v1.md` 与 `scripts/check_security_boundary.py`，更新本计划和详细设计的实际状态。

## 6. Testing

- **TEST-001**: 领域测试覆盖硬 deny、全部能力满足、project allow 无 grant、ask 有/无合法来源、父来源撤销、未知工具、epoch 不符、稳定摘要和秘密参数拒绝。
- **TEST-002**: 任务测试使用显式时钟，覆盖新普通消息新 task、可信继续及精确用户继续命令保持 task、普通新消息原子终结旧 conversation/失效 grant/停未派发调用、workflow/SRE 可信终态结束而模型文本无效、相似/引用/附加内容不续接、taskID/revision 不匹配拒绝、同会话同目标换题不继承 grant、一轮结束 idle、pause/resume 保留 grant 原 TTL、结束/取消/过期失效 grant、终态不可续、24 小时寿命、重启 paused 和 grant 更短 TTL，stateRevision CAS 与 executionRevision 变化规则独立，continue 新轮次关闭旧 RootTurn/child scope 绑定。
- **TEST-003**: 目标/边界测试覆盖真实资源地址、多候选、未解决切换不回退旧目标、引用/否定文本、导航不建硬边界、显式限制不扩大、旧无来源范围一次确认及空目录旧会话恢复。
- **TEST-004**: 派发竞态用可控 barrier，验证撤销/取消与提交先后、参数/连接/终端变化、单次审批重复消费、事务回滚、gate 关闭和 epoch 切换；active→waiting→active 原审批成功，pause/resume 后旧操作拒绝且可用原 TTL grant 新准备，continue 后旧 RootTurn/child scope 调用拒绝；每项拒绝检查实际适配器调用为零。
- **TEST-005**: 恢复测试必须执行备份→授权撤销/项目 deny/一次定时消费→恢复，验证旧授权不复活、schedule 不自动追补、剩余次数不能复用；中断恢复任一步重启仍关闭 gate，gate 关闭期间没有外部对账读取；账本完整且受影响资源明确时，全部策略确认后新受限任务可获对账读取权限，unknown/冲突资源写阻断持续有效；证据丢失且范围不明时整个 gate 关闭仅管理。旧 epoch 的 task/未消费审批不可直接续用。
- **TEST-006**: 同 Home Web/stdio/第二进程所有权、两个旧库同 ID 不同记录、namespace 保留、规范路径、control-state 损坏/缺失、配对备份和不支持降级均有回归。
- **TEST-007**: 主会话/stdio/Pilot/child/workflow/schedule/MCP/terminal 运行 allow/ask/deny/expired/revoked/paused/epoch-mismatch 矩阵；相同上下文判定一致，角色收窄只能更严格。真正人工终端入口单独鉴权，模型伪造 actor 失败。
- **TEST-008**: 调度 fixture 覆盖 configRevision/authorityRevision/statusRevision 分离、领取/关联/完成状态写入不使授权失效、原计划 dueAt 唯一、重复 tick 只扣一次、修改/取消后旧 occurrence 停止、恢复后需重新授权。
- **TEST-009**: 随机生成不对应真实凭据的秘密哨兵，注入模型配置、连接和异常；捕获的 SDK state/events、日志、审计及前端快照不得含哨兵。测试失败也不输出真实秘密。
- **TEST-010**: 实现新包后执行 `go test ./internal/security ./internal/ai ./internal/web ./internal/agent/storage ./cmd/lake`、对应路径的 `go test -race` 与 `go vet`，以及 `python3 scripts/check_adk_runtime_boundary.py` 和新增的 `python3 scripts/check_security_boundary.py`。失败按相关改动修复，不删除门禁。
- **TEST-011**: 执行 `pnpm --dir web-agent check`、`pnpm --dir web-agent test:frontend`、`pnpm --dir web-agent build:web`；真实 Dev 检查任务续接、边界确认、恢复策略确认、实时失效和浅深色/窄窗/键盘，记录实际 SHA/Home。
- **TEST-012**: 使用 TASK-017 固定 fixture 保存平台、原始样本与 p95：Evaluate<1ms，本地准备/登记相对旧链 p95 增量≤10ms。超标先优化快照/索引，不删除派发校验。
- **TEST-013**: 本轮文档交付只校验 frontmatter、必需章节、声明 ID 唯一、引用与任务依赖闭合、链接及 `git diff --check`；不运行应用测试/构建，不把未来验收写成已通过。

## 7. Risks & Assumptions

- **RISK-001**: 旧 Web/standalone 默认不同；存量会话采用 `security_legacy_session_policies` 保存有效七项设置与来源快照，不能将会话差异合并成一个放宽的项目默认。
- **RISK-002**: 旧 TargetScope 缺少可证明来源；unknown 先阻止资源派发，再提供一次确认，既不静默提权，也不永久固化误判空范围。
- **RISK-003**: 多个旧存储可能存在相同 ID、不同操作历史；保留原 namespace 和关联，冲突/unknown 需显式处置，不自动丢弃或重放。
- **RISK-004**: 两个 SQLite 和 JSON 无单一 ACID 事务；通过 changing、单 owner、固定锁序和 occurrence 幂等协调；发生不一致先阻断而非回退放行。
- **RISK-005**: 备份恢复会回退权限数据和调度预算；恢复 epoch、关闭 gate、旧授权失效和重新确认策略为强制协议，普通备份不能覆盖 control-state。
- **RISK-006**: 任意本机/远端 Shell 或高权限 MCP 可能超出可观测范围；restricted 拒绝 opaque，compatible 呈现真实执行域，OS 沙箱需另行设计。
- **RISK-007**: 已登记并发送到外部的副作用无法被撤销回滚；以提交为线性化点，尽力取消并真实记录 unknown，不承诺分布式 exactly-once。
- **RISK-008**: 无 reader guard 的历史二进制无法受新 schema 约束；仅支持兼容基础版及更新版本回退，不将直接旧程序启动作为支持流程。
- **RISK-009**: 默认新消息创建新任务会增加任务控制交互；UI 提供明确继续/恢复动作，后端支持绑定 task/revision 的精确“继续”/“继续检查”命令，但不能依赖模型意图推断复用授权。
- **RISK-010**: 八阶段覆盖面大；可以按实际 diff 再拆 PR，但不得跳过阶段退出条件或在缺少入口/恢复保证时宣称 enforced 完成。
- **ASSUMPTION-001**: v1 面向单用户桌面/本机服务；多用户远程认证、租户隔离和管理角色需要独立设计。
- **ASSUMPTION-002**: 控制面入口与凭据不委托给 agent；本方案不防御已经控制 OS 账户/进程的攻击者，也不承诺抵抗恶意全盘回滚控制文件与数据库。
- **ASSUMPTION-003**: 此次只重设计与更新实施计划；功能尚未实施。文档 PR 合并不授权功能 PR 合并、安装生产或发布。

## 8. Related Specifications / Further Reading

- [Lake Security v1 详细设计（修订 2）](../docs/design/lake-security-v1.md)
- [贡献规范](../CONTRIBUTING.md)
- [开发与发布流程](../docs/development-workflow.md)
- [ADK runtime 与恢复](../docs/experiments/adk-runtime.md)
- [前端 UI 规范](../docs/ui-guidelines.md)
- [已有会话权限计划](feature-session-permissions-1.md)
- [已有目录目标解析计划](feature-directory-target-resolution-1.md)
