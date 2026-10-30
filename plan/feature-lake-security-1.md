---
goal: 按五模块职责落实任务闭环、安全控制、资源操作及档案验收，SOP只读手册独立交付
version: 5
date_created: 2026-10-30
last_updated: 2026-10-30
owner: Lake
status: Planned
tags: [feature, architecture, security, authorization, migration, adk]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

本计划对应 [Lake Security v1 详细设计（修订 5）](../docs/design/lake-security-v1.md)，代码基线为 `be656805d345466f11bbb9c2c4af92e670da7420`。保持文件名以延续原 PR 和文档链接；frontmatter 的 version 表示计划修订号。全部功能任务尚未开始，文档完成不表示模块已经实现。

本Security计划仅后端改造，不修改前端组件/样式/交互及shared契约。用户另行提出的SOP清单UI由[独立设计](../docs/design/builtin-sop-catalog-v1.md)与[独立计划](feature-builtin-sop-catalog-1.md)交付，不捆绑本计划实施。修订4先建立权威存储、恢复门禁及WorkGoal/步骤/尝试/证据/验收闭环，SecurityTask仅管理关联目标的限时执行；孤儿风险必须核实后才能收口，再实现策略与派发。旧范围按来源迁移；项目直接允许与临时授权是不同授权来源；恢复备份会使旧授权失效并要求重新确认策略。保留目标解析、安全决策、执行保护三层，以及现有 ADK 原生审批、操作账本和 continuation。

修订5按五模块对应交付职责，每个任务只有一个主责模块；模块划分不改变原事务边界与前置依赖。八阶段包含 50 项任务，建议按阶段提交可评审 PR。执行每阶段前以最新 `origin/develop` 为基础核对接口变化；本计划不授权功能 PR 合并、生产安装或发布。

## 1. Requirements & Constraints

- **REQ-001**: `CurrentTarget`、`pendingResolution` 和 `ExecutionBoundary` 独立建模；目录导航不创建硬边界，目标修改不签发授权。
- **REQ-002**: 复用WorkGoal为持久goalID、WorkItem为版本化stepID，关联ExecutionAttempt、nativeOperation/nativeEvidence、AcceptanceRecord和CoverageLink。SecurityTask是goal下的限时执行上下文，不代表目标本身；消息/轮次结束、重试或授权过期不删除或完成goal。
- **REQ-003**: TaskIntent为continue_goal/new_goal/select_goal/clarify，由真实输入、当前选择目标及原交互绑定校验；“开始吧”、带内容的继续/重试可推进同goal，歧义则选择且不派发。新goal不取消或掩盖旧goal；默认旧前台上下文paused并取消未派发/请求取消在途，仅显式monitored_background且owner/授权有效的后台继续；旧上下文可过期但原目标/风险持续可见。SecurityTask状态为active/idle/waiting/paused/completed/cancelled/expired，最长24小时；上下文completed不显示为目标完成。stateRevision用于CAS，executionRevision使暂停/终态旧调用失效，正常审批往返不自失效。
- **REQ-004**: 项目保存策略、会话保存目标、任务承载有限授权、单次审批绑定精确操作。任务授权支持结构化读取、受信命令模板与精确服务集合重启；自由Shell/任意交互输入/opaque MCP不接受任务通配授权，时长可选 30 分钟/4 小时，且不能超过任务绝对到期时间；单次审批沿用 15 分钟 TTL。TaskGrant 绑定 taskID/epoch/自身 revision/TTL，不绑定 executionRevision；暂停后可在原 TTL 内复用 grant，但旧操作必须重新准备。
- **REQ-005**: 对每项能力，允许条件为全部硬限制满足，且当前规则由合法授权来源满足：项目 allow，或可授权 ask 加有效 task grant，或可审批 ask 加单次审批。deny 优先；无 TaskGrant 不使项目 allow 的子任务失权。用户确认的task_envelope仍限制项目allow，范围外必须单次例外或显式扩展；不能绕过项目/父硬边界。
- **REQ-006**: 旧 TargetScope 按可验证来源区分显式执行限制与导航/推断。缺少来源时记为 legacy_unclassified 并停止相关资源派发，用户一次迁移确认提交目标及边界保留/修改；不默认无限制，也不永久固化为空硬边界。
- **REQ-007**: 用户可通过鉴权、CAS 和审计的边界接口修改本人可管理的边界；项目硬限制、父任务边界和角色上限不可由该接口覆盖。
- **REQ-008**: 同 Home 使用唯一 manifest 指向的规范 ADK runtime root（Web DataDir 下的 `adk`）；默认 stdio 不再独立使用 `ai/adk`。只有一个 owner，第二进程明确拒绝；v1 不实现远程 broker。
- **REQ-009**: 每个 Home 的 `<Home>/security/control.json` 保存 storeID、随机 recoveryEpoch 和执行 gate，Home manifest 指向唯一 RuntimeRoot，普通备份不包含 control 文件。策略、授权、审批和操作描述绑定 epoch；epoch 不符或 gate 关闭时禁止资源派发。
- **REQ-010**: 管理恢复先轮换新的随机 epoch 并关闭 gate，再保全现有账本、恢复配对快照；checkpoint/manifest 必须绑定 storeID+epoch，跨设备导入生成新 storeID+epoch 并进入管理模式。旧 task/schedule grants 及全部未消费的 pending/decided/authorized 审批失效，未终结旧任务 paused 但不能跨 epoch 直接续接，继续旧工作须新建 SecurityTask 并按新 epoch 重新授权；schedule disabled、策略 unconfirmed。gate 关闭时连外部对账读取也禁止；账本保全完整且受影响资源确定、仅结果 unknown/记录冲突时，持久阻断相关资源写入，全部策略确认后可开 gate，由新受限任务作已授权读取对账；证据丢失且无法确定影响范围时整个 gate 保持关闭，仅允许管理。
- **REQ-011**: schedule 的 configRevision/authorityRevision 与 statusRevision 分离。occurrence 唯一键为 scheduleID/configRevision/原计划 dueAt；状态刷新不撤销授权，重复触发只扣减一次次数，恢复后不自动追补旧 occurrence。
- **REQ-012**: 全部运行时工具登记能力和 resource/resource_set/project/session/none 五种目标类型；资源发现与任务/恢复控制不能因没有 CurrentTarget 而被资源选择阻断。未登记或无法约束的效果不得标成 readonly。restricted 拒绝 opaque，compatible 的 opaque 操作只支持单次审批，legacy 按存量有效设置适配。
- **REQ-013**: goalRevision/stepRevision表达目标契约/步骤定义，progressRevision表达日常状态；只用当前版本、可信证据和逐条件验收关闭目标。模型正文、exitCode=0和另一目标成功均不能代替验收。
- **REQ-014**: 失败尝试只能以同目标/步骤的等价验收CoverageLink覆盖；原failed记录不改写。unknown、仍在运行或副作用不明必须先对账，必要步骤未执行不允许静默waive；删减要求需用户确认计划修订。
- **REQ-015**: 每次外部派发必须有有效goal/step/attempt/task及owner/generation/lease。默认lease15秒、每5秒续期/扫描，不延长grant/deadline；过期即时拒绝新派发，sweeper周期不构成宽限。
- **REQ-016**: 孤儿执行必须冻结队列/旧权限、请求取消、核实handle/副作用并持久保留资源冲突阻断。取消未确认不等于停止；新尝试或新目标成功不能清除风险。孤儿记录仅在可信核实/安全移交后闭环，不自动重放。
- **SEC-001**: 模型、工具输出、日志、技能、记忆和工具参数中的 approved/actor/Permit 不是授权证据；授权与任务续接动作必须从可信入口生成。
- **SEC-002**: 子任务使用当前项目硬边界、父链限制与角色上限；每次派发重新验证其使用的项目规则、父授权或审批来源，不复制永久权限快照。
- **SEC-003**: PreparedOperation和单次审批绑定goalID/planRevision/stepID/stepRevision/attemptID/taskID/recoveryEpoch/executionRevision、真实资源/连接版本、参数/预览、目标/策略/授权 revision 与终端 generation，不绑定 task.stateRevision。派发时独立检查任务 active、expiry 和 RootTurnID/child scope 仍属于当前有效轮次；continue 新建 RootTurn 并关闭旧轮次绑定，旧未派发 call 不复活。
- **SEC-004**: 派发登记、审批消费、授权使用和审计在同一 ADK SQLite 事务；保留 unknown 对账和现有重复保护粒度，不以清理会话或恢复快照重试不明副作用。
- **SEC-005**: Web SQLite、ADK SQLite 与定时 JSON 使用 coordinator 的短时 barrier 和 changing 协议；等待模型、审批、网络时不持锁，锁顺序固定；中断迁移或 changing 对象不得派发。
- **SEC-006**: 仅执行适配器按 reference 读取凭据，SDK state/events、日志、审计和前端不保存模型 key、密码或私钥。
- **SEC-007**: Go 审批不等于本机或远端 OS 沙箱；无法证明的任意 Shell、MCP 二次访问和路径竞态按 opaque 处理。
- **CON-001**: 不增加第二套模型循环、单次审批账本或执行账本；纯领域包不依赖 AI/Web，不导入 SDK internal API。
- **CON-002**: 每阶段通过独立分支 PR 到 develop，记录实际 SHA 和本地证据，明确授权后才合并；不触发未请求的 CI 或生产操作。
- **CON-003**: macOS 集成使用签名脚本与 Lake Dev/隔离 Home，不复制正式版 secrets，不让两个后端共用 Home。
- **CON-004**: 本Security计划无UI改造，不修改web-agent前端源码、样式、shared/contracts.ts，不新增页面、任务条、授权卡、按钮或浏览器。后端复用现有消息/提问/审批/执行记录/停止/核实协议；额外管理走API/CLI，不要求新前端字段。
- **GUD-001**: 兼容现有UI的响应形状、枚举和审批/提问语义；安全判断保留后端，无兼容表达的动作停止并提供管理方式，不能为保持旧显示放松检查。
- **PAT-001**: 判定使用显式时间、版本和不可变描述；控制面动作使用 expectedRevision/actionID，拒绝测试断言外部派发计数为零。

## 2. Implementation Steps

### 五模块交付对应

模块名称与[五模块架构图](../docs/design/images/lake-security-five-modules.svg)及详细设计第3节一致。任务正文的【模块名】表示唯一主责；下表只引用原任务，不重复声明或新建任务。跨模块事务、联调和验收由主责组织，协作依赖以逐任务和阶段门槛为准。

| 模块 | 主责任务 | 主要交付与协作 | 模块验收门槛 |
| --- | --- | --- | --- |
| 任务中心 | TASK-006、TASK-007、TASK-013、TASK-014、TASK-017、TASK-034、TASK-035 | 目标/计划与可信续接、资源意图、父子任务和后台归属；依赖档案保存尝试，安全控制提供限时执行上下文 | 继续/重试保持原goal，新goal不丢旧待办；目标选择不扩大权限 |
| SOP 手册 | [独立SOP计划](feature-builtin-sop-catalog-1.md)全部19项 | 7份内容与版本、只读接口、工作区浏览；本Security计划不实现匹配/执行器 | 无模型/无资源可读，浏览零任务/零授权/零执行；不阻塞其独立上线 |
| 安全控制 | TASK-003、TASK-011、TASK-012、TASK-015、TASK-016、TASK-019、TASK-020、TASK-021、TASK-022、TASK-023、TASK-025、TASK-026、TASK-027、TASK-028、TASK-029、TASK-030、TASK-038、TASK-040、TASK-041、TASK-043、TASK-044、TASK-045、TASK-047 | 策略/授权/审批、派发保护、owner与孤儿、迁移/恢复；通过资源操作取消/查询，向档案提交风险事实 | 无效权限/旧owner零派发，范围外确认；unknown不盲重试，恢复不复活旧授权 |
| 资源操作 | TASK-001、TASK-031、TASK-032、TASK-033、TASK-036、TASK-037 | 入口清单、实际适配器、受控命令/MCP/终端/定时；子任务与workflow配合任务中心接入 | 清单内agent I/O无旁路，冻结目标执行，实际结果与handle可查询/取消 |
| 任务档案与验收 | TASK-002、TASK-004、TASK-005、TASK-008、TASK-009、TASK-010、TASK-018、TASK-024、TASK-039、TASK-042、TASK-046、TASK-048、TASK-049、TASK-050 | 规范存储、尝试/证据/验收/风险持久化、现有协议投影；汇总四块后端联调与真实Dev证据 | 同goal证据可追溯，失败保留，必需条件和副作用闭环才完成；状态与结论一致 |

五模块是职责视图，以下八阶段是实施顺序，不能机械改成五阶段串行：先做规范存储/恢复门禁，再做目标与验收基础，随后安全策略、派发、全入口适配、协议兼容、恢复演练及Dev收口。保留50项原任务的ID、依赖、退出条件和未开始状态。

“否 / 未开始”表示当前实际状态。每阶段依赖前一阶段退出条件；阶段内部按表中依赖执行，无直接依赖的任务可独立准备。所有标记“新增”的路径和函数均为拟实现，不表示已存在。基础阶段只建立存储和门禁，功能仍处于 legacy/shadow；enforced 必须等全部入口覆盖和迁移验证完成。

### Implementation Phase 1

- **GOAL-001**: 建立唯一权威存储、兼容 reader guard 和不可随普通备份回退的恢复门禁。

依赖：无。退出条件：明确规范路径与 owner，发现旧双库时先保全并处理身份冲突；未来 schema/中断恢复关闭派发；原操作证据不丢失。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | 【资源操作】新增 `docs/security/tool-entrypoints.md`，逐项登记 `Engine.invoke` 全部早期/常规分支、`invokeSessionTool`、`Server.bridge`、`Server.terminalRoute`、`ai.Serve`、`executeSchedule` 和实际 I/O；记录身份来源、目标种类、权限/审批/账本路径，用运行时工具目录核对覆盖数量。依赖：无。 | 否 | 未开始 |
| TASK-002 | 【任务档案与验收】新增 `internal/ai/security_home.go:ResolveSecurityHome/AcquireSecurityOwner`，使用 Home manifest 固定 storeID 与 Web DataDir 下 `adk` 的规范 runtime root；修改 `cmd/lake/main.go`、`internal/ai/stdio.go:Serve`、`internal/web/server.go:New` 和 `adk_evidence.go:runtimeDirectory` 使用同一身份。第二 owner 明确拒绝，不自动开第二库、不杀已有进程；独立 Home 显式隔离。依赖：TASK-001。 | 否 | 未开始 |
| TASK-003 | 【安全控制】新增 `internal/security/schema.go` 与 `internal/ai/security_control.go:ReadControlState/RotateRecoveryEpoch`，维护 `<Home>/security/control.json` 的 storeID/随机epoch/gate，原子写入并同步落盘；checkpoint/manifest 绑定 storeID+epoch，普通备份排除此控制文件，跨设备导入使用新身份和关闭 gate。`adkStore`、Web/stdio 启动校验 schema、storeID、epoch 和中断标记，错误时只允许管理操作。依赖：TASK-002。 | 否 | 未开始 |
| TASK-004 | 【任务档案与验收】新增 `internal/ai/security_store_migration.go:InventoryLegacyStores/MigrateLegacyStores`，先为原 Web `adk` 与 stdio `ai/adk` 制作一致备份；为 session/op/evidence 保留源库 namespace 和关联。同身份同 hash 可标记同源但保留原记录，冲突或未决内容进入只读历史/相关资源阻断，显式处理后才开 gate；禁止直接混并 SDK 内部表。生成迁移 manifest 并验证可重入。依赖：TASK-003。 | 否 | 未开始 |
| TASK-005 | 【任务档案与验收】新增 `internal/ai/security_home_test.go`、`security_control_test.go`、`security_store_migration_test.go`：两个进程争用、不同 Home、两个旧库重复/冲突/unknown、迁移每个断点、未来 schema、丢失/损坏 control-state 均有确定结果；更新新增 `docs/validation/lake-security-v1.md` 记录兼容基础 SHA。依赖：TASK-004。 | 否 | 未开始 |

### Implementation Phase 2

- **GOAL-002**: 建立普通会话的 目标/步骤/尝试/验收闭环与SecurityTask状态机，拆分目标和边界并提供旧状态恢复闭环。

依赖：GOAL-001。退出条件：跨轮次继续、新任务、暂停/结束/过期都有可信事件；旧空目录会话可经一次明确确认恢复；目标操作与边界操作独立。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-006 | 【任务中心】扩展 `internal/ai/work_goal.go:WorkGoal/WorkItem/nativeWorkGoal` 与新增 `internal/security/work_closure.go`：goal/plan/step版本、验收契约、进度版本及目标状态，复用原权威行不建第二目标账本；定义ExecutionAttempt/AcceptanceRecord/CoverageLink身份和SecurityTask.goalID。依赖：TASK-005。 | 否 | 未开始 |
| TASK-007 | 【任务中心】新增 `internal/ai/work_goal_binding.go:ResolveGoalIntent`、`internal/web/goal_intent_routes.go`，真实消息/selectedGoalID/原待开始交互决定continue/new/select/clarify；目标歧义不派发，换goal不自动取消旧goal或继承grant。扩展 `work_goal.go/work_tools.go` 重试/恢复规则，不把失败attempt变为不可续原目标。依赖：TASK-006、TASK-012。 | 否 | 未开始 |
| TASK-008 | 【任务档案与验收】新增 `internal/ai/work_attempts.go` 与 `adk_session.go` 应用表迁移，记录 `work_execution_attempts/work_acceptance_records/work_coverage_links`；SRE attempt映射而非复制operation，原生operation/evidence携带goal/step/version/attempt关联，unique+归属校验拒绝跨goal证据。依赖：TASK-006。 | 否 | 未开始 |
| TASK-009 | 【任务档案与验收】新增 `internal/ai/work_acceptance.go:VerifyStep/VerifyGoal/RecordCoverage`，按受信验证器/显式人工核验逐条件pass/fail/insufficient；CAS核对目标契约、进度和未决operation，必要步骤不能默默waive。失败覆盖保留旧failed，unknown必须先核实。扩展 `reduceWorkGoal/work_finish` 只在目标验收及副作用闭环后completed。依赖：TASK-008。 | 否 | 未开始 |
| TASK-010 | 【任务档案与验收】在 `internal/ai/adk_operations.go` 扩展ownerID/generation/leaseUntil/handle、取消与orphan风险字段；定义 `internal/security/execution_owner.go` 协议及 `internal/ai/execution_ownership.go` 基础查询，队列/outbox/watch/agent终端均能追到原operation。旧无归属记录先核实，不误杀人工终端。依赖：TASK-008。 | 否 | 未开始 |
| TASK-011 | 【安全控制】新增 `internal/security/task.go`、`target.go`，定义 SecurityTask/CurrentTarget/TargetResolution/ExecutionBoundary 及固定来源和 24 小时 task deadline；SecurityTask 明确 stateRevision/executionRevision，前者用于后端交互绑定/CAS，后者在 pause/complete/cancel/expire 递增，active→waiting→active 不递增。定义 TaskEvent 的 new/continue/pause/resume/complete/cancel/expire，终态不可恢复；新增纯状态转移表测试。依赖：TASK-005。 | 否 | 未开始 |
| TASK-012 | 【安全控制】新增 `internal/ai/security_tasks.go:CreateSecurityTask/ApplyTaskEvent` 与 `security_store.go` 的基础 task/target/boundary/event 表及 `security_legacy_session_policies`，先按 session 保存存量七项权限、入口来源和 revision/epoch；任务由服务端生成 ID，可信 actionID 幂等，expectedRevision 对 stateRevision 做 CAS；存储 executionRevision 及当前有效 RootTurnID/child scope 绑定，记录与 WorkGoal/SRE/workflow 的类型化关联；结束一轮只置 idle；goal切换不终结旧目标，明确暂停/关闭只改变相应上下文和授权；workflow/SRE执行结束后仍需目标验收；普通重启置 paused，原 epoch 的合法续接不刷新 deadline，备份恢复旧 epoch 任务不得续接。依赖：TASK-011。 | 否 | 未开始 |
| TASK-013 | 【任务中心】修改 `internal/ai/engine.go`、`types.go:Config`、`adk_session.go:prepareADKHistory` 与 `internal/web/agent.go:runTurn`，绑定当前goalID/step/attempt/securityTask，禁止每轮清空并重建目标；运行中AdmitSupplement/adk_supplement_preemption保留原goal/RootTurn/工具上下文，不随推理抢先取消实际操作或改权限；由TaskIntent推进/选择/澄清，明确新goal不结束旧goal。审批continuation保留轮次，下一轮关闭旧未派发call；task过期只新建上下文关联原goal。依赖：TASK-012、TASK-007。 | 否 | 未开始 |
| TASK-014 | 【任务中心】新增 `internal/web/target_resolution.go:ResolveTarget`，提取 `directoryTurnScope/questionTargetScope` 的发现逻辑，匹配真实连接地址与稳定 ID；显式未解决切换禁止退回旧目标。新模式只由 ExecutionBoundary 限制，目录选择仅生成候选；每操作冻结目标 revision。依赖：TASK-011。 | 否 | 未开始 |
| TASK-015 | 【安全控制】新增 `internal/ai/security_migration.go:ClassifyLegacyScope/ResolveLegacyScope`，区分有证据的 explicit restriction 与 navigation/inferred；无来源置 legacy_unclassified+pendingResolution，禁止资源派发直到用户提交明确 targetIDs 和边界保留/修改。保留真实 deny，不把旧空范围永久固化为硬边界，也不自动迁成无限制。依赖：TASK-012、TASK-014。 | 否 | 未开始 |
| TASK-016 | 【安全控制】新增 `internal/web/security_boundary_routes.go`，实现设计规定的目标选择、可管理边界修改与迁移确认接口；校验用户来源、项目/会话归属、边界 owner、expectedRevision/actionID，原子记录审计。不能修改父/项目 deny，普通 target 更新不能修改边界；扩展目录/资源选择测试覆盖已有故障会话恢复。依赖：TASK-013、TASK-015。 | 否 | 未开始 |
| TASK-017 | 【任务中心】新增 `internal/ai/security_tasks_test.go` 与Web路由fixture，验证开始吧/带内容继续同goal、明确新goal保留旧待办/风险、歧义零派发、同goal上下文到期需重授但不丢步骤、pause保留TTL、旧RootTurn不复活、state/execution版本区分与旧范围确认。依赖：TASK-016、TASK-009。 | 否 | 未开始 |
| TASK-018 | 【任务档案与验收】新增 `internal/ai/work_closure_test.go` 模拟service2/tiles1442文档同步：S1统计→S2直接失败→A2中转成功→S3校验，验证等价替代覆盖及完整goal验收；A1unknown、缺必要步骤、源快照变化、已有目标记录被覆盖或新G2成功均不能关闭G1。依赖：TASK-017、TASK-010。 | 否 | 未开始 |

### Implementation Phase 3

- **GOAL-003**: 实现能力注册表与统一授权公式，以 shadow 比较现有结果。

依赖：GOAL-002。退出条件：全部工具登记；项目 allow/无 grant 子任务仍允许；ask/无授权需审批；任一硬 deny 不可覆盖；shadow 不改变原有效权限。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-019 | 【安全控制】新增 `internal/security/types.go`、`reason.go`、`canonical.go`，定义 PreparedOperation、Decision、AuthoritySource、resource/resource_set/project/session/none 五种目标类型和原因码；稳定 JSON 规范化绑定 taskID/epoch/executionRevision、有效 RootTurn/child scope、真实连接及参数/预览等安全 revision，排除 task.stateRevision。秘密只使用后端 reference revision，模型参数不能设置 actor 或构造 Permit。依赖：TASK-017。 | 否 | 未开始 |
| TASK-020 | 【安全控制】新增 `internal/security/capability.go`，按 TASK-001 清单登记工具、能力、resource/resource_set/project/session/none 目标类型、证明等级和预览方式；只有前两种做资源解析，资源发现与任务/恢复控制不因缺少 CurrentTarget 被阻断。复用 `ToolRisk`、`CommandPolicy`、`readonlySQL/redisReadOnly` 作为证据，未登记工具不默认为 readonly；新增 `internal/security/command_profiles.go` 及测试，定义受信profile/version、类型化argv/服务集合、诊断默认50次与重启默认1次预算；禁止字符串前缀授权、动态shell和未知模板自动执行。新增目录覆盖测试。依赖：TASK-019。 | 否 | 未开始 |
| TASK-021 | 【安全控制】新增 `internal/security/evaluator.go:Evaluate`，严格实现 REQ-005 的授权公式，先判硬限制再解析当前能力的合法授权来源；project allow 无需 grant，ask 的 task/single 来源受 grantable/confirmation 约束，deny 不可覆盖。每次校验父链/角色及具体来源 revision/epoch；增加父 allow 无 grant、父 ask 无 grant、父来源撤销和多能力全满足测试。依赖：TASK-020。 | 否 | 未开始 |
| TASK-022 | 【安全控制】新增 `internal/ai/security_adapter.go:PrepareOperation`，使用 TASK-012 已建的 `security_legacy_session_policies` 按 session 保存 Web/standalone 的存量有效七项配置、入口来源、revision/epoch并生成 legacy 适配，不被项目默认覆盖，也不覆盖同项目其他会话；替换 `Engine.invoke` 的重复 policy 分析，shadow 仅记录脱敏差异。新项目 restricted/compatible 的固定范围、读取预算和 opaque 规则按设计实现。依赖：TASK-021。 | 否 | 未开始 |
| TASK-023 | 【安全控制】在新增 `internal/security/evaluator_test.go` 建立显式时间、规则冲突和固定性能 fixture（100 资源、20 规则、20 grants、并发 8），记录纯 Evaluate p95<1ms；后续派发集成用同 fixture 测准备/登记相对旧链 p95 增量≤10ms，不计网络/模型。检查领域包不导入 AI/Web。依赖：TASK-022。 | 否 | 未开始 |

### Implementation Phase 4

- **GOAL-004**: 将授权、原生审批与实际派发纳入同一事务和恢复 epoch。

依赖：GOAL-003。退出条件：审批只消费一次、撤销先提交则零派发、changing/epoch 不符即拒绝，原 unknown 对账保留。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-024 | 【任务档案与验收】扩展 `internal/ai/security_store.go` 的已有基础表，增加设计中的 project policy/task grant/schedule grant/occurrence/resource revision/decision/authority event 表及唯一约束；所有权威对象绑定 storeID/epoch，grant 绑定 taskID/自身 revision/TTL 而不绑 executionRevision，绝对 expiry≤task deadline；原审批/操作绑定 executionRevision 和 RootTurn/child scope。扩展 `adkStore` 与原 nativeApproval/nativeOperation 列，不另建审批或执行账本。依赖：TASK-023。 | 否 | 未开始 |
| TASK-025 | 【安全控制】新增 `internal/ai/security_coordinator.go` 与 `internal/web/security_catalog.go`，实现共享短时 barrier、固定锁序和 changing→Web更新→ready 版本协议；资源创建/编辑/导入/删除、MCP 配置均接入，纯名称变化不提升连接 revision。失败恢复前保持不可派发，新增逐提交断点测试。依赖：TASK-024。 | 否 | 未开始 |
| TASK-026 | 【安全控制】修改 `adk_approval.go:waitNativeApproval/decideNativeApproval/claimNativeApprovals`，保留原 15 分钟 TTL、状态机和 ADK confirmation，新增 taskID/epoch/executionRevision/有效 RootTurn/child scope 和描述摘要绑定，不绑定 stateRevision；旧缺少绑定或 epoch 不符的未消费审批失效，重复确认幂等，active→waiting→active 正常审批可消费，pause 后旧审批不可复活。扩展 `adk_parallel_approval_test.go`。依赖：TASK-025。 | 否 | 未开始 |
| TASK-027 | 【安全控制】实现 `security_coordinator.go:AcquirePermit`，修改 `adk_operations.go:dispatchNativeOperation`：事务中复核 gate/epoch、task active/expiry/executionRevision、RootTurnID/child scope 当前有效性、策略与实际授权来源，消费审批、原子扣减主/子任务共享的命令额度、记录使用及原生操作/审计；unknown不返额度，确认not_executed仅可事务返还一次。Permit 只传进程内冻结描述，适配器不得重解目标；保留当前重复保护与 finish unknown 语义。依赖：TASK-026。 | 否 | 未开始 |
| TASK-028 | 【安全控制】新增 `internal/ai/security_dispatch_test.go`，用 barrier 控制撤销/取消与提交两种先后、审批后改参数/连接、两个消费者、task paused/terminal、epoch 切换、事务失败与登记后崩溃；验证 active→waiting→active 不使自身审批失效，pause/resume 后旧 prepared/approval 拒绝但原 TTL grant 可用于新准备，continue 后旧轮次/child call 拒绝；断言回滚不消费授权、拒绝无 I/O，unknown 不阻断无关合法读取。依赖：TASK-027。 | 否 | 未开始 |
| TASK-029 | 【安全控制】实现 `execution_ownership.go:AcquireOwner/RenewOwner/FenceOwner`，在 `dispatchNativeOperation` 同事务检查goal/step/attempt依赖、owner generation、lease、epoch/grant并登记操作；lease默认15秒/5秒心跳，不续grant。旧owner/无归属/原步骤不满足时零派发；原callback仅登记结果不可续副作用。依赖：TASK-028、TASK-010。 | 否 | 未开始 |
| TASK-030 | 【安全控制】新增 `internal/ai/orphan_reconciler.go`，启动及每5秒扫描失联/过期owner、未决watch/outbox/handle，冻结新派发、取消并观察真实进程/远程结果；持久写阻断、人工接管与generation fencing。新增 `orphan_reconciler_test.go` 控制时钟验证失联、过期、迟到回调、重复取消、未知结果、新任务成功不清风险、人工终端不误杀及进程组取消。依赖：TASK-029。 | 否 | 未开始 |

### Implementation Phase 5

- **GOAL-005**: 覆盖所有执行入口，正确传递任务、父边界和授权来源，稳定调度 occurrence 身份。

依赖：GOAL-004。退出条件：入口清单无 agent 旁路；子角色只能更严格；schedule 状态写入不吊销自身授权，同 occurrence 只消费一次。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-031 | 【资源操作】修改 `internal/ai/tools.go:Engine.invoke`、`internal/web/agent.go:bridge` 全部早期/常规分支，资源、附件、记忆及项目控制工具均按其目标种类 Prepare/AcquirePermit。将 `approved bool` 降为无独立放行能力的兼容字段；实际 I/O 接收内部 Permit/冻结描述。依赖：TASK-030。 | 否 | 未开始 |
| TASK-032 | 【资源操作】修改 `terminal_access.go:ResolveTerminalAccess`、`terminal.go:Execute/Input/Interrupt/Close`、`server.go:terminalRoute` 和 `manual_terminal.go`，区分真实人工入口和 agent，保留 owner/generation/上下文及单写者；建连成功后重审原命令，restricted 不允许任意交互输入。新增 `internal/ai/command_dispatch.go`，仅执行受信模板编译的冻结executable/argv/目录/安全环境，不执行模型原始Shell文本。新增 `internal/web/security_terminal_test.go` 及命令adapter测试。依赖：TASK-031。 | 否 | 未开始 |
| TASK-033 | 【资源操作】修改 `internal/ai/session_tools.go:invokeSessionTool` 与 `internal/web/extensions.go:extensionBridge`，绑定受信 server/tool/resource 映射、config/catalog revision 和 task/epoch；自报 readonly 不授予权限，stdio 服从本机禁令，opaque 仅 compatible 单次审批。新增 `internal/ai/security_mcp_test.go`。依赖：TASK-031。 | 否 | 未开始 |
| TASK-034 | 【任务中心】修改 `agent_scope.go:scopedChildConfig`、`adk_sre_roles.go:ExecuteSRERole`、`adk_observation_roles.go:runInvestigations`，显式传递 SecurityTask/父链和实际 AuthoritySource；只收窄资源/角色，不要求每个 project allow 调查创建 grant。新增 `internal/ai/security_children_test.go`，验证父 allow 无 grant、父来源撤销及角色上限。依赖：TASK-031。 | 否 | 未开始 |
| TASK-035 | 【任务中心】修改 `internal/web/tool_bridge.go:checkToolWorkflowScope`、`workflows.go:startWorkflow/executeWorkflowRun`，每个 workflow run 映射 SecurityTask、冻结模板/目标；改造 AI external_watch/external_watch_scheduler/adk_work_wait/work_goal 恢复路径，使用原 task 且不刷新 deadline/expiry。新增 `internal/web/security_workflow_test.go`。依赖：TASK-034。 | 否 | 未开始 |
| TASK-036 | 【资源操作】修改 `internal/web/schedules.go:tickSchedules/writeSchedules/executeSchedule` 与 `schedule_routes.go:scheduleRoute`：显式拆 configRevision/authorityRevision/statusRevision；状态与运行关联更新只增 statusRevision。配置更新走 changing/原子替换/ready；以原计划 dueAt 建唯一 occurrence，在 ADK 事务内扣次数并创建 task grant，再幂等补建 Web run。新增重复 tick、状态更新不失效、修改/撤销和崩溃回归。依赖：TASK-035。 | 否 | 未开始 |
| TASK-037 | 【资源操作】按 TASK-001 复查文件路径/symlink/hash、SQL/服务端权限、网络解析/重定向、SSH trust、credential reference 等实际 I/O，无法约束者标 opaque。新增 `internal/ai/security_adapters_test.go` 和补充静态 `scripts/check_security_boundary.py`；以假适配器零派发和主/stdio/Pilot/child/workflow/schedule/MCP/terminal 矩阵测试证明无旁路。依赖：TASK-032、TASK-033、TASK-036。 | 否 | 未开始 |

### Implementation Phase 6

- **GOAL-006**: 实现任务/授权后端与既有消息、提问、审批和核实接口兼容。

依赖：GOAL-005。退出条件：目标推进/选择、尝试重试与验收有明确可信动作；旧空目录可一次确认恢复；授权只从合法用户入口签发，后端即时失效且不改变现有界面/协议。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-038 | 【安全控制】新增 `internal/web/security_routes.go`，接入设计中的项目策略、task grant、revoke 和分页审计接口；复用 task/boundary 路由，全部做 `Server.protect`、身份/归属、CAS、actionID、task/epoch 及 expiry 上限校验。schedule 授权要求显式到期与次数；旧 aiOptions 不得覆盖新权威状态。task-grants与task_envelope更新同事务，扩展需expectedGrantRevision和差异确认、默认不刷新TTL/预算；单次批准只绑定精确task_envelope例外。新项目本机受控命令为ask可直接任务授权，既有显式deny保留。新增越权/跨项目/重复提交路由测试。依赖：TASK-037。 | 否 | 未开始 |
| TASK-039 | 【任务档案与验收】修改后端 `internal/web/store.go/agent.go/server.go` 的snapshot/SSE兼容投影；严格保持当前contracts字段形状与枚举，不修改 `web-agent/shared/contracts.ts`。goal/step/task/revision私有状态由后端会话及原消息/问题/审批ID关联；不要求客户端增加goalID或读取新View，不发送Permit/秘密。新增 `internal/web/security_compat_test.go` 和现有响应golden fixture。依赖：TASK-038。 | 否 | 未开始 |
| TASK-040 | 【安全控制】新增 `internal/ai/security_confirmation.go` 与 `internal/web/security_confirmation_bridge.go`，使用现有question选择目标/仅本次或任务范围，再用现有通用operation审批确认完整scope；选择本身不签权限，最后匹配nativeApproval.Binding才签grant/单次例外。范围/TTL/预算放既有说明与预览，不新增前端组件、按钮或approval kind；额外管理走CLI/API。依赖：TASK-039。 | 否 | 未开始 |
| TASK-041 | 【安全控制】新增 `internal/web/security_confirmation_test.go`，校验既有提问/审批ID、payload及响应形状兼容、重复提交幂等、task授权与单次类型绑定、选择不等于批准、超范围不执行、旧客户端设置不覆盖权威状态。使用当前未修改的前端做兼容冒烟检查；不得新增securityPresentation组件/测试或改变视觉交互。依赖：TASK-040。 | 否 | 未开始 |
| TASK-042 | 【任务档案与验收】新增后端 `internal/web/work_closure_view.go` 与 `work_closure_view_test.go`，内部GoalClosureView统一驱动既有AIView/ReplyTiming/work goal/operation outcome与最终回复验收事实；原工具失败/历史计时不删改，完整关联经现有work_read、原始执行记录及管理API读取。不新增workClosurePresentation/风险清单组件或点查导航；G2成功不清G1风险，旧协议无法展示细节仍由后端强制阻断。依赖：TASK-041、TASK-030、TASK-009。 | 否 | 未开始 |

### Implementation Phase 7

- **GOAL-007**: 完成备份恢复、重新确认策略与受控启用，阻止旧授权及调度预算复活。

依赖：GOAL-006。退出条件：恢复先轮换 epoch 并关闭 gate；所有旧临时授权/审批失效；策略未确认不开 gate。账本完整且影响范围确定的 unknown/冲突保持相关写阻断，开 gate 后可由新受限任务读取对账；证据丢失且影响范围不明则仅允许管理；不自动追补旧调度。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-043 | 【安全控制】新增 `internal/web/security_backup.go` 与 `internal/ai/security_recovery.go:RestoreSecurityBackup`：暂停派发、原子轮换 control-state 的随机 epoch 并置 gate=closed，保全当前账本/审计，再恢复配对 Web/ADK/JSON 快照。旧 task/schedule grants 及全部未消费 pending/decided/authorized 审批失效，未终结旧任务 paused 且不可跨 epoch 续接，继续旧工作必须创建新 SecurityTask/新 epoch 授权；schedule disabled、project policy unconfirmed；备份不能覆盖 control-state，checkpoint/manifest 绑定 storeID+epoch，跨设备导入用新身份且关闭 gate，不自动追补 occurrence。账本保全完整且影响资源确定的 unknown/冲突持久阻断相关写入，全部策略确认后才可开 gate，由新受限任务读取对账后解除写阻断；若证据丢失且无法确定影响范围，整个 gate 保持关闭仅管理。gate 关闭期间禁止任何外部对账读取。依赖：TASK-042。 | 否 | 未开始 |
| TASK-044 | 【安全控制】新增 `internal/web/security_migration_routes.go`，在 `cmd/lake/main.go` 的现有命令结构接入 status/shadow/enforce/verify-backup/restore 管理命令；必须使用 TASK-043 恢复协议。新增用户策略重新确认/恢复清单接口，记录 actor/actionID/epoch及持久资源写阻断；开 gate 前确认全部策略，旧执行上下文不得跨epoch恢复，用户续旧工作时新建SecurityTask关联原goal；enforce 仅在全部入口覆盖、旧状态处置及一致性检查完成后开放，无环境变量旁路或清账本选项。依赖：TASK-043。 | 否 | 未开始 |
| TASK-045 | 【安全控制】新增 `internal/ai/security_recovery_test.go`、`security_rollback_test.go`，覆盖备份→撤销/策略deny/消费定时次数→恢复，要求旧 grant 和 pending/decided/authorized 审批零派发、旧 task 不可跨 epoch 续接且无重复调度；每个恢复断点重启关闭 gate，期间外部读取也是零派发。账本完整且影响资源明确时，策略全确认后用新受限任务对账读取，unknown/冲突相关资源仍拒写；证据丢失且影响范围不明时整个 gate 关闭，仅管理；测试 epoch 不符、control-state 缺失、未来 schema和无法等价映射时拒绝旧模式降级。记录支持回退 SHA，历史无 reader guard 二进制不在支持范围。依赖：TASK-044。 | 否 | 未开始 |
| TASK-046 | 【任务档案与验收】扩展 `security_recovery.go` 与 `orphan_reconciler.go`，备份/重启/owner变更保留goal-step-attempt-op-evidence和coverage关系；旧epoch只允许回写核实、不可续派发。未决孤儿/资源占用先索引阻断，取消/目标切换不丢handle。测试恢复后新G2成功不能解旧G1写阻断，缺关联进入管理/核实清单。依赖：TASK-045、TASK-042。 | 否 | 未开始 |

### Implementation Phase 8

- **GOAL-008**: 收口旧授权路径并完成隔离 Dev 验收，交付真实可追溯的集成证据。

依赖：GOAL-007。退出条件：全部入口、目标闭环、孤儿治理及恢复测试通过；新权威状态唯一放行；记录实际 SHA、限制与平台结果，未解决关键缺陷为零。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-047 | 【安全控制】修改 `internal/ai/permissions.go/tools.go/session_tools.go` 和 Web configure/bridge，移除已替代的独立授权路径；旧 aiOptions 仅保留兼容确认偏好/只读投影，nativePolicyHash 不作为第二放行来源，删除 `approved bool` 的执行依赖。复查入口清单与所有 gate/epoch/父来源校验。依赖：TASK-046。 | 否 | 未开始 |
| TASK-048 | 【任务档案与验收】运行 Testing 节的 Go/race/vet、ADK/security boundary、原前端兼容回归与性能检查；集中执行任务续接/换题、无 grant 子任务、旧空目录迁移、撤销后恢复、调度次数及所有入口矩阵。失败修复后重跑相关检查；记录命令与实际 SHA，不把没有自动 CI 当作通过。依赖：TASK-047。 | 否 | 未开始 |
| TASK-049 | 【任务档案与验收】使用 `scripts/build_lake_desktop.sh --dev --install` 签名构建和独立验收 Home，实测新任务/继续/暂停/结束、截图空目录恢复、目标切换、审批后变更、即时撤销、Pilot/MCP/workflow/schedule、重启与备份恢复管理门禁。使用专用测试凭据/假目标，不操作生产；保存平台/路径/SHA/截图。依赖：TASK-048。 | 否 | 未开始 |
| TASK-050 | 【任务档案与验收】更新 `docs/validation/lake-security-v1.md`，新增 `docs/security/user-guide.md`，记录覆盖计数、性能样本、最低回退版本、独立 Home/owner 规则、恢复后重新授权步骤及未验证项；按真实结果更新本文状态，整理 PR 到 develop，等待对应明确合并授权。依赖：TASK-049。 | 否 | 未开始 |

## 3. Alternatives

- **ALT-001**: 仅修改 prompt 要求模型判断目标/权限。拒绝：不能建立可信 task、授权来源、并发撤销或恢复边界。
- **ALT-002**: 将所有旧 TargetScope 固化为 legacy_scope。拒绝：会保留空目录故障并丢失原有明确重选恢复能力，改为按证据分类和一次迁移确认。
- **ALT-003**: 用 RootTurnID 或 sessionID 直接当安全任务。拒绝：前者无法跨轮次继续，后者会让新任务继承旧授权；使用显式 SecurityTask。
- **ALT-004**: 子任务必须持有 TaskGrant。拒绝：项目已经 allow 的读取无需额外 grant；采用授权来源满足规则，再与硬边界/角色求交。
- **ALT-005**: 恢复后按原 expiry 保留未到期授权。拒绝：撤销、策略收紧和消费次数可能已回退；恢复推进 epoch 并使旧授权失效。
- **ALT-006**: 新建策略服务、审批循环或独立执行账本。v1 不采用：固定 Go 规则和现有 ADK 原生账本足以承载本范围，避免新一致性故障域。
- **ALT-007**: 用模型评审证明任意命令只读。拒绝：无法约束二次访问与副作用；使用 structured/opaque 分类及真实服务端权限。

## 4. Dependencies

- **DEP-001**: 详细设计修订 5 的 目标/步骤/尝试/验收闭环与SecurityTask状态机、授权公式、迁移确认和恢复协议为所有阶段的接口依据；变更契约须同步两份文档及相关用例。
- **DEP-002**: official ADK public toolconfirmation、nativeApproval/nativeOperation/nativeEvidence 和 `internal/agent/storage`；不将 SDK 升级或私有内部表混并作为隐含前提。
- **DEP-003**: 规范存储、单 owner、control-state 与 reader guard 必须在任务/授权上线前完成；TASK-002 至 TASK-005 未通过时不得启用新权威数据。
- **DEP-004**: 使用仓库固定 Go/Node/pnpm 工具链和持久签名身份；缺失时按 CONTRIBUTING 配置，不使用未签名替代品。
- **DEP-005**: 真实适配器验收需要独立 SSH/DB/Kubernetes/MCP fixture；没有条件时明确该适配器未验收，假适配器不能冒充真实联调。

## 5. Files

以下按职责分组。标为“新增”的文件尚不存在；TASK-001 发现额外入口时必须补注册和验收，不能以此静态清单限制安全覆盖。

- **FILE-001**: 新增 `internal/security/{schema,task,target,types,reason,canonical,capability,command_profiles,evaluator}.go` 及测试：纯领域模型、目标闭环与owner协议、任务状态机、授权公式、描述摘要；新增 `work_closure.go/execution_owner.go`。
- **FILE-002**: 新增 `internal/ai/security_{home,control,store_migration,tasks,store,migration,adapter,coordinator,recovery}.go` 及测试：规范存储、epoch/gate、任务与事务集成；新增 `work_attempts.go/work_acceptance.go/work_goal_binding.go/execution_ownership.go/orphan_reconciler.go`；新增 `internal/ai/command_dispatch.go` 编译执行受控命令。
- **FILE-003**: 修改 `internal/ai/{engine,types,permissions,tools,directory_targets,session_tools,stdio,adk_session,adk_evidence,adk_approval,adk_operations}.go`：真实入口、普通轮次映射、持久化和原生审批/账本。
- **FILE-004**: 修改 `internal/ai/{agent_scope,adk_sre_roles,adk_observation_roles,external_watch,external_watch_scheduler,adk_work_wait,work_goal}.go`：父授权来源、角色和后台恢复。
- **FILE-005**: 新增 `internal/web/{target_resolution,security_task_routes,security_boundary_routes,security_catalog,security_routes,security_backup,security_migration_routes}.go` 及测试：可信用户动作、迁移/恢复管理、Web 适配。
- **FILE-006**: 修改 `internal/web/{agent,store,server,directory_targets,resource_edit,resource_import,resource_tree,extensions,terminal_access,terminal,manual_terminal,tool_bridge,workflows,schedules,schedule_routes}.go` 及 `cmd/lake/main.go`：资源/终端/定时版本、规范路径和管理命令。
- **FILE-007**: 新增后端 `internal/ai/security_confirmation.go`、`internal/web/security_confirmation_bridge.go`、`work_closure_view.go`、`security_compat_test.go`、`security_confirmation_test.go` 及兼容fixture；前端源码与shared/contracts.ts仅作为只读协议依据，不纳入改动。
- **FILE-008**: 新增 `docs/security/{tool-entrypoints,user-guide}.md`、`docs/validation/lake-security-v1.md` 与 `scripts/check_security_boundary.py`，更新本计划和详细设计的实际状态。

## 6. Testing

- **TEST-001**: 领域测试覆盖硬 deny、全部能力满足、project allow 无 grant、ask 有/无合法来源、父来源撤销、未知工具、epoch 不符、稳定摘要和秘密参数拒绝。
- **TEST-002**: 显式时钟验证开始吧/补充/重试维持goal、歧义零派发、新goal不取消旧goal或转移grant、上下文到期新授权关联原goal；本轮idle不等于目标完成，暂停保留TTL、终态不可续、state/execution版本分离、旧RootTurn不复活。
- **TEST-003**: 目标/边界测试覆盖真实资源地址、多候选、未解决切换不回退旧目标、引用/否定文本、导航不建硬边界、显式限制不扩大、旧无来源范围一次确认及空目录旧会话恢复。
- **TEST-004**: 派发竞态用可控 barrier，验证撤销/取消与提交先后、参数/连接/终端变化、单次审批重复消费、事务回滚、gate 关闭和 epoch 切换；active→waiting→active 原审批成功，pause/resume 后旧操作拒绝且可用原 TTL grant 新准备，continue 后旧 RootTurn/child scope 调用拒绝；每项拒绝检查实际适配器调用为零。
- **TEST-005**: 恢复测试必须执行备份→授权撤销/项目 deny/一次定时消费→恢复，验证旧授权不复活、schedule 不自动追补、剩余次数不能复用；中断恢复任一步重启仍关闭 gate，gate 关闭期间没有外部对账读取；账本完整且受影响资源明确时，全部策略确认后新受限任务可获对账读取权限，unknown/冲突资源写阻断持续有效；证据丢失且范围不明时整个 gate 关闭仅管理。旧 epoch 的 task/未消费审批不可直接续用。
- **TEST-006**: 同 Home Web/stdio/第二进程所有权、两个旧库同 ID 不同记录、namespace 保留、规范路径、control-state 损坏/缺失、配对备份和不支持降级均有回归。
- **TEST-007**: 主会话/stdio/Pilot/child/workflow/schedule/MCP/terminal 运行 allow/ask/deny/expired/revoked/paused/epoch-mismatch 矩阵；相同上下文判定一致，角色收窄只能更严格。真正人工终端入口单独鉴权，模型伪造 actor 失败。
- **TEST-008**: 调度 fixture 覆盖 configRevision/authorityRevision/statusRevision 分离、领取/关联/完成状态写入不使授权失效、原计划 dueAt 唯一、重复 tick 只扣一次、修改/取消后旧 occurrence 停止、恢复后需重新授权。
- **TEST-009**: 随机生成不对应真实凭据的秘密哨兵，注入模型配置、连接和异常；捕获的 SDK state/events、日志、审计及前端快照不得含哨兵。测试失败也不输出真实秘密。
- **TEST-010**: 实现新包后执行 `go test ./internal/security ./internal/ai ./internal/web ./internal/agent/storage ./cmd/lake`、对应路径的 `go test -race` 与 `go vet`，以及 `python3 scripts/check_adk_runtime_boundary.py` 和新增的 `python3 scripts/check_security_boundary.py`。失败按相关改动修复，不删除门禁。
- **TEST-011**: 以后端golden/JSON与路由测试确认现有payload/枚举不变；可运行未修改前端的check/test:frontend/build:web作兼容回归，不增加前端源码或UI测试文件。Dev仅用原有提问/审批/停止/执行记录/核实流程检查后端行为；恢复/接管管理走API/CLI，记录实际SHA/Home。
- **TEST-012**: 使用 TASK-023 固定 fixture 保存平台、原始样本与 p95：Evaluate<1ms，本地准备/登记相对旧链 p95 增量≤10ms。超标先优化快照/索引，不删除派发校验。
- **TEST-013**: 本轮文档交付只校验 frontmatter、必需章节、声明 ID 唯一、引用与任务依赖闭合、链接及 `git diff --check`；不运行应用测试/构建，不把未来验收写成已通过。

- **TEST-014**: 任务一次授权后多种合规命令不重复确认；跨资源/参数/路径/模板、次数耗尽、模板升级均零派发并显示差异。单次例外不扩大后续范围，显式扩展不自动续期或补额度；project allow不得绕过task_envelope，项目/父deny不可覆盖。注入管道、命令替换、别名/未知脚本验证不执行原始Shell；两个子任务竞争最后一次维护额度最多派发一次，unknown不退额度。

- **TEST-015**: 闭环fixture覆盖原截图场景、部分完成、失败等价覆盖、unknown不可覆盖、必要步骤未执行、计划版本改变/旧验收失效、模型成功文本无证据、G2成功不关闭G1；后端验收事实与现有状态字段来自同一内部GoalClosureView，原前端源码和卡片失败计数保持。
- **TEST-016**: 无goal/step/attempt、owner失联/过期、父取消、队列恢复、旧callback、agent终端handle遗失均触发零新派发及取消/核实；取消requested/unsupported/unknown不释放风险，已确认停止才reconcile。并发owner接管以generation fence，授权不转移；远程detach不可作为strict自动模板执行。

## 7. Risks & Assumptions

- **RISK-001**: 旧 Web/standalone 默认不同；存量会话采用 `security_legacy_session_policies` 保存有效七项设置与来源快照，不能将会话差异合并成一个放宽的项目默认。
- **RISK-002**: 旧 TargetScope 缺少可证明来源；unknown 先阻止资源派发，再提供一次确认，既不静默提权，也不永久固化误判空范围。
- **RISK-003**: 多个旧存储可能存在相同 ID、不同操作历史；保留原 namespace 和关联，冲突/unknown 需显式处置，不自动丢弃或重放。
- **RISK-004**: 两个 SQLite 和 JSON 无单一 ACID 事务；通过 changing、单 owner、固定锁序和 occurrence 幂等协调；发生不一致先阻断而非回退放行。
- **RISK-005**: 备份恢复会回退权限数据和调度预算；恢复 epoch、关闭 gate、旧授权失效和重新确认策略为强制协议，普通备份不能覆盖 control-state。
- **RISK-006**: 任意本机/远端 Shell 或高权限 MCP 可能超出可观测范围；restricted 拒绝 opaque，compatible 呈现真实执行域，OS 沙箱需另行设计。
- **RISK-007**: 已登记并发送到外部的副作用无法被撤销回滚；以提交为线性化点，尽力取消并真实记录 unknown，不承诺分布式 exactly-once。
- **RISK-008**: 无 reader guard 的历史二进制无法受新 schema 约束；仅支持兼容基础版及更新版本回退，不将直接旧程序启动作为支持流程。
- **RISK-009**: 目标关联错误可能造成孤儿目标或错误授权复用；绑定selectedGoalID/原交互/契约版本，歧义先选择，不以每条消息或固定短语自动重建目标。授权与目标路由独立复核。
- **RISK-010**: 八阶段覆盖面大；可以按实际 diff 再拆 PR，但不得跳过阶段退出条件或在缺少入口/恢复保证时宣称 enforced 完成。
- **ASSUMPTION-001**: v1 面向单用户桌面/本机服务；多用户远程认证、租户隔离和管理角色需要独立设计。
- **ASSUMPTION-002**: 控制面入口与凭据不委托给 agent；本方案不防御已经控制 OS 账户/进程的攻击者，也不承诺抵抗恶意全盘回滚控制文件与数据库。
- **ASSUMPTION-003**: 此次只重设计与更新实施计划；功能尚未实施。文档 PR 合并不授权功能 PR 合并、安装生产或发布。

## 8. Related Specifications / Further Reading

- [Lake Security v1 详细设计（修订 5）](../docs/design/lake-security-v1.md)
- [贡献规范](../CONTRIBUTING.md)
- [开发与发布流程](../docs/development-workflow.md)
- [ADK runtime 与恢复](../docs/experiments/adk-runtime.md)
- [前端 UI 规范](../docs/ui-guidelines.md)
- [已有会话权限计划](feature-session-permissions-1.md)
- [已有目录目标解析计划](feature-directory-target-resolution-1.md)

- [独立内置SOP清单设计](../docs/design/builtin-sop-catalog-v1.md)
- [独立内置SOP清单实施计划](feature-builtin-sop-catalog-1.md)
