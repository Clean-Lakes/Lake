---
goal: Lake 普通会话长任务持续跟进、持久等待与自动压缩续跑
version: 1.0
date_created: 2026-10-29
last_updated: 2026-10-29
owner: Lake
status: 'Implemented — validation in progress'
tags: [feature, adk, long-task, compaction, recovery]
---

# Introduction

**状态：核心实现已落地，最终回归与 Dev 安装验收进行中。**

普通会话已能调用多轮工具和自动压缩，但模型返回最终文字就能结束一轮，没有通用的外部任务完成门槛。本方案补齐目标账本、外部任务观察、ADK 等待恢复和压缩后的接续；首先覆盖普通 core 会话，随后映射至共享界面。Pilot 继续拥有自己的任务、计划、审批与角色生命周期。

基线是 develop `6debebb2c7a64c2753470b4069b9a75ec3e23e41`，由用户授权合并 PR #118 得到，其树与已测试的 `a45bafbe0b86a59e61c05bbf7e2c7a35d1720d62` 一致。本文件保留原设计及验收目标。实现、已覆盖边界和未覆盖的故障矩阵见下方实施记录及验证文档。

只读排查的事实：示例会话用了 13/500 次模型调用，最后输入 129516 token，输入预算为 450000−8192=441808 token，没有压缩卡片；最后外部结果仍含 `deploying/building`，回复后会话却为 completed。用户曾明确排除数据库操作。这里仅保留脱敏统计；不复制原会话、发布单 ID、地址或配置。该样例证明的是持续跟进缺口，不证明本次停止由压缩导致。

现有实现位置：`internal/ai/engine.go:509` 的 ExecuteTurn 默认成功结束为 completed；`internal/ai/adk_driver.go:42` 的 runOfficialADK 负责官方 Runner；`internal/ai/adk_provider_step.go:68` 每轮请求前调用 compactForTurn；`internal/ai/polling.go:18` 连续三次不变 Shell 查询会结束答复。现有压缩能保留整批工具配对，但摘要输出不完整以外的若干错误仍会向外返回。

## 1. Requirements & Constraints

- **REQ-001**: 普通 core 会话的已登记工作目标必须持续推进至已验证完成、明确失败、等待用户、主动暂停、取消或额度耗尽。文字回复和外部任务已受理都不能直接把目标标成完成；解释性闲聊保持现有低成本路径。
- **REQ-002**: 以宿主持久任务及原操作句柄管理异步工作。等待期间无模型空转，同一事件至多提交一次恢复输入；允许新用户消息正常进入会话，不能把所有会话都锁在旧任务上。
- **REQ-003**: 独立工作项分别推进。用户接管数据库的工作项为 waiting_user；没有该前置依赖的构建及发布观察仍进行。需要该前置条件的部署不得自行启动。
- **REQ-004**: 自动压缩在同一目标内可重复进行；保留用户原约束、任务 ID、工作项依赖、操作/证据引用、待答问题、已有审批绑定、剩余额度和下一观察时间。摘要不成为执行状态的唯一来源。
- **REQ-005**: 关闭窗口不终止后端任务；后端退出时持久化待恢复状态，重开后先核对已有任务，不能声称关机期间仍在执行。新功能不自动接管升级前已经结束的历史会话。等待必须释放会话执行占用；每个目标保留独立的 SDK runtimeSessionId 和恢复检查点，新话题不能覆盖旧目标的待恢复调用，旧目标恢复也不能覆盖当前话题的历史投影。
- **REQ-006**: 顶部沿用既有七类状态与 Pilot 角色 Logo。外部等待映射“处理中”，详情说明等待对象与最近观察时间；等待用户映射“待确认”，预算暂停映射“已暂停”。只有当前关联目标和任务实际终结才显示“已结束”。
- **SEC-001**: 继续使用现有资源、工具、审批和 MCP 权限。压缩、事件唤醒、目标登记和读状态都不授予新写权限；明确排除的数据库目标进入持久约束，依赖项不能绕过约束。
- **SEC-002**: 不按模型文字或任意 JSON 的 status 字段推断可重试操作。dispatched/unknown 的原变更只可按原句柄核对；原调用 ID、指纹和目标的防重放校验继续有效。
- **SEC-003**: MCP 的 call_mcp_tool 保持默认 write 风险。自动观察仅可通过宿主注册、固定版本、明确只读的观察适配器，在当前会话权限内调用；不使用工具名、MCP 自报注解或模型保证自动降低风险。
- **CON-001**: 只使用官方 ADK Go v2.6.0 的公开 Runner、LlmAgent、functiontool 和 workflow 输入恢复能力；不添加第二套模型/工具循环、不导入 SDK internal、不恢复退役运行时。内部唤醒不伪装成人类消息或批准。
- **CON-002**: 执行额度绑定目标并跨唤醒累计，默认沿用 MaxSteps=500；新增目标默认最大经过时间为 24 小时。外部等待不消耗模型轮次但计入经过时间。额度到期进入 paused，展示已做与待做事项；压缩和重启不能清零额度。
- **CON-003**: 开发与验证仅使用临时 Home、虚构工具和 Lake Dev；不对排查样例中的发布任务继续执行。普通实现 PR 指向 develop，生产发布需独立授权。
- **PAT-001**: 新领域表通过 adkStore 的共享私有 sessions.sqlite 管理，官方会话事件保留由 SDK 写入。领域变更与投递 outbox 在同一事务提交，通过幂等 outbox 更新 SDK 事件及可重建 View，避免假装两个存储写入天然原子。

### 任务与等待契约

新增 `WorkGoal`：宿主生成 id，包含 sessionId、originRootTurnId、runtimeSessionId、runtimeCheckpoint、revision、userSourceRefs、目标、硬约束引用、状态、工作项、budgetUsed/budgetLimit、deadlineAt、createdAt/updatedAt。每个工作项有宿主 ID、依赖项、验收条件、原操作 ID、证据引用和状态；用户文字、工具输出和模型摘要的来源类别分别保留。现有 Todo 只作进度展示，不自动转为执行授权或验收证据。

新增 `ExternalWatch`：宿主生成 id，包含 goalId/itemId、原 nativeOperation ID、serverIdentity、adapterId/version、绑定的原句柄、readCapabilityRef、lastFingerprint、nextCheckAt、lastObservedAt、attempt/failureCount、wakeSequence/consumedSequence、revision、leaseOwner/leaseUntil。模型不能提供 polling 工具名称、任意 URL、Shell 字符串或认证字段。未有可信只读适配器时工作项进入 blocked，说明不能持续观察，不猜测其成功。

新增工具 `work_begin`、`work_read`、`work_update`、`work_wait`、`work_finish`。开始目标必须引用真实当前用户请求；模型选择工作分解，宿主分配身份、校验依赖与来源。可观察的异步派发由适配器自动绑定至当前工作项；没有目标时，在原操作派发前建立仅涵盖当前请求的目标及工作项。`work_wait` 仅接受宿主 watch ID；`work_finish` 必须提交 outcome、实际结论和 evidenceRefs，不能关闭仍有未终结观察或未满足依赖的工作项。取消、额度和人工阻塞由宿主判定，不由摘要覆盖。

| 当前状态 | 允许事件与结果 |
| --- | --- |
| running | 新的真实操作结果更新进度；已绑定异步工作进入 waiting_external；缺失的人类决定进入 waiting_user；全部工作项满足验收才可 completed |
| waiting_external | 可信观察完成/失败或有明确下一步时唤醒同一目标；相同观察只更新观测时间；不可达按退避重试；权限失效或无法核对句柄进入 blocked |
| waiting_user | 保存原问题/审批及等待的工作项；有依赖的工作项停止，没有依赖的已有观察继续；答案只作用于对应问题，不能变成变更审批 |
| paused / blocked | 暂停停止自动推进，blocked 显示具体缺口；用户明确补全条件或恢复后重新校验权限及原句柄，不能重新派发历史变更 |
| completed / failed / cancelled | 终态不因迟到事件逆转；旧事件只更新原观察记录。失败项必须有真实失败证据，取消不等于远端已停止 |

目标聚合顺序：只要存在可运行项则 running；否则仍有在观察的外部项则 waiting_external，并列保留需要用户处理的项；无可自动推进项且有人类前置条件则 waiting_user；其余由明确暂停、阻塞及终态规则归约。不同目标独立，旧目标不强制覆盖当前新话题的状态。

### 等待、恢复与压缩参数

观察优先复用已支持的事件源；轮询使用 5、10、20、40、60 秒序列，到 60 秒后保持，加入由 watch ID 决定的 ±10% 稳定抖动。单次查询最长 15 秒；单会话最多 8 个同时在查的观察，全局最多 32 个。连续 5 次传输失败进入 blocked，认证/授权失败立即 blocked。正常的长时间 running 不累计传输失败，也不因连续三次内容不变而结束工作目标。

租约为 45 秒，提交结果时以 revision+leaseOwner 条件写入，过期 worker 无权发布结果。服务启动扫描未终态观察并重新取得租约；平台休眠恢复后每个观察先做一次当前状态读取，不补放所有错过的定时点。相同指纹不增加唤醒序号，日志刷新不单独唤醒模型；终态、失败、显式需要用户、适配器定义的可执行阶段变化才产生唤醒。

压缩使用现有 estimatedContextCost 的同一计算单位：`B=(ContextWindow-MaxOutput)*2`，不另扣 cachedInput、不重复添加 10% provider 安全余量。软触发改为 `estimatedContextCost >= B*80/100`，压缩后目标 `B*60/100`，硬请求上限仍为 B；目标投影、系统策略、工具目录和本轮原文均计入预算。模型摘要最长 4096 输出 token、45 秒独立子期限。宿主任务投影预算为 `min(4096,max(256,inputBudget/20))` token 的保守估算；超出时保留身份/阻塞/下一动作及分页引用，原始约束和记录保持可按 ID 读取。不可裁掉本轮原请求来强行满足预算。

模型摘要是可替换的历史交接数据，持久工作目标和原工具配对独立保存。只有投影通过 validHistory、来源、预算和乐观版本校验才提交；随后持久化 SDK 投影并继续同一目标。摘要超时、空输出、无效输出、限流或临时连接失败时，使用未取消的父 context 尝试现有 fitOlderToolContext/fitToolContext；仅缩小模型侧工具预览并保留至少 1/16 输入空间。父 context 已取消时立即退出。不可约束输入仍过大时进入 paused 并给出原因，不返回假成功或无限重试。手动压缩失败仍保留原状态并报告失败。

## 2. Implementation Steps

所有阶段顺序执行；阶段内只有无显式依赖且不修改同一文件的任务可并行。实施时每阶段单独形成可验证的 develop PR；本设计 PR 不包含后续实现的合并授权。

### Implementation Phase 1

- **GOAL-001**: 验证 ADK 外部输入恢复路径并建立可恢复领域账本；验收为无模型忙等、无双重派发且领域事务可重建。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 新增 internal/ai/adk_work_wait_test.go：用官方 workflow.ResumeOrRequestInput 和原 function-response 恢复路径证明等待前、等待中、事件已提交但未消费三处进程退出均可接续；校验原 call ID、目标、预算和审批 envelope 不变，等待 10 分钟虚拟时间模型请求数不增加、会话执行槽已释放、新用户话题可以完成，然后旧目标仍按原调用恢复。该测试是后续阶段门槛；不能通过时报告能力缺口，不改成宿主模型轮询循环。 | 见实施记录 | 2026-10-29 |
| TASK-002 | 新增 internal/ai/work_goal.go、work_goal_store.go：定义上述 WorkGoal/WorkItem/ExternalWatch、纯归约函数 ReduceWorkGoal、CAS 方法 TransitionWorkGoal 和 outbox；在 internal/ai/adk_session.go 的 adkStore 中迁移。保留未知字段兼容，旧库加载不生成历史任务。依赖 TASK-001。 | 见实施记录 | 2026-10-29 |
| TASK-003 | 在 internal/ai/runtime_contract.go 与 types.go 加入可重建的目标/等待投影，显式区分当前 RootTurnID 与 goal origin；为 transition/outbox 的崩溃窗口增加事务测试。JSON 缓存丢失时从领域表和 SDK 原记录恢复，不能写空表覆盖旧任务。依赖 TASK-002。 | 见实施记录 | 2026-10-29 |

### Implementation Phase 2

- **GOAL-002**: 已启动异步工作被宿主持续观察；验收为 build 成功后仍能继续原目标，等待数据库仅阻塞依赖项。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 新增 internal/ai/work_tools.go 与 prompts/work-continuity.txt，在 extended_catalog.go/session_tools.go/sessionCatalog 注册五个 work 工具。work_wait 单独占一个工具批次；work_finish 校验验收证据及非终态工作项，拒绝后仍由原 LlmAgent 调度。将目标完成契约加入普通 core 策略，不用语言关键词识别用户意图。依赖 TASK-003。 | 见实施记录 | 2026-10-29 |
| TASK-005 | 新增 internal/ai/external_watch.go 与 external_watch_scheduler.go，实现本文件的租约、退避、去重、并发限额、deadline 和 shutdown。调度器只运行经过宿主校验的只读观察与投递事件，不直接调用模型或执行下一条变更。先添加 Shell 句柄适配器；增加固定版本 release 适配器，只接受注册服务的原派发结果及 get_release_status 等明确允许的读取能力；以独立 mock schema 契约测试验证 ID/状态路径，不信任任意 MCP status。依赖 TASK-002。 | 见实施记录 | 2026-10-29 |
| TASK-006 | 新增 internal/ai/adk_work_wait.go，借鉴 adk_questions.go 的原调用恢复：在专用 machine-input workflow 持久化中断 ID 和来源，按 TASK-001 证明的公开中断路径退出本次 Runner 并释放会话占用，不保留阻塞整个会话的等待工具；目标的 SDK runtimeSessionId、调用 envelope 和预算单独保存。收到真实事件时构造原 work_wait 的 function-response 并通过官方 Runner 接续，投影写回原目标而非当前新话题。不得把普通 root 改成丢失 confirmation envelope 的 Workflow AgentNode。依赖 TASK-001、TASK-004、TASK-005。 | 见实施记录 | 2026-10-29 |
| TASK-007 | 在 adk_driver.go、adk_provider_step.go 和 engine.go 接入工作决策及最终状态归约。对存在活动目标但模型直接给出最终文字的情况，在公开 LlmAgent 回调内只处理完整最终响应，不改 partial 文字：全部可自动推进项都在等待可信外部句柄时生成带宿主来源的 work_wait 调用并持久暂停；仍有可运行项时生成 work_read 状态纠正响应，使同一个官方循环继续。生成的内部调用保留来源，不冒充模型或人类授权；最多允许连续两次无新进展的决策纠正，随后 paused，不能自动无限追加“继续”。持久 ModelRounds 跨等待恢复累加。原轮结束仍在领域投影持久化后才释放占用。依赖 TASK-006。 | 见实施记录 | 2026-10-29 |
| TASK-008 | 修改 polling.go：已登记且关联可信句柄的工作目标连续无输出改成等待观察；没有工作目标的普通“查看状态”请求保留三次无变化后结束答复的原行为。修改 adk_recovery.go 与 engine.go 的 Abort/Shutdown：取消观察及后续推进，迟到事件不激活目标，不替用户停止远端命令。依赖 TASK-005、TASK-007。 | 见实施记录 | 2026-10-29 |

### Implementation Phase 3

- **GOAL-003**: 同一目标可多次压缩且不丢身份；验收为三次压缩后能继续观察并最终核验，所有历史变更派发次数仍为一。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-009 | 在 context.go、context_compaction.go 与 engine.go 的 compact 统一软阈值 80%、目标 60% 和硬上限，不另建 Token 计数器。在 adk_projection.go 的 nativeCompaction 使用同一预算门槛，避免 SDK 和 Lake 各压一次。加入含目标 ID和来源引用的宿主投影，摘要不能改写目标、授权或用户约束。依赖 TASK-003。 | 见实施记录 | 2026-10-29 |
| TASK-010 | 重构 compactForTurn/compact 的父子 context：摘要的 45 秒超时不取消主任务；对上述自动摘要失败使用父 context 进入既有安全预览恢复，无法压到预算才 paused。自动摘要失败后 60 秒内不重复摘要请求，除非已无法形成合法硬预算输入；后一情况直接 paused，不能在冷却期反复撞接口。手动压缩保持失败不覆盖语义。依赖 TASK-009。 | 见实施记录 | 2026-10-29 |
| TASK-011 | 在 context_compaction_test.go、compaction_recovery_test.go、context_resume_test.go、context_pacing_test.go 和 adk_projection_test.go 增加连续三次压缩、摘要超时/429/连接失败/空输出、父取消、大目录、超大不可裁约束、压缩与旧观察事件并发用例；快照提交前校验 goal revision，版本变动时重建投影而非覆盖真实状态。依赖 TASK-010、TASK-006。 | 见实施记录 | 2026-10-29 |

### Implementation Phase 4

- **GOAL-004**: Web、CLI 与恢复路径显示一致的真实任务状态；验收为界面不把正在观察的任务显示结束，用户新消息与取消保持可用。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-012 | 在 internal/web/agent.go 与新增 work_goal_routes.go 公开只读投影及显式暂停/恢复/取消命令，加入会话归属和乐观版本校验。接入现有消息队列：同一会话至多一个 Runner，用户消息优先于旧 wake；wake 只在原目标仍有效且会话空闲时消费，不注入假 user 消息或新建一条消息轮次。共享 Web/CLI/调度入口的相同 Engine 服务，不能只在浏览器计时器里实现。依赖 TASK-007、TASK-008。 | 见实施记录 | 2026-10-29 |
| TASK-013 | 扩展 web-agent/shared/contracts.ts 与 sessionBadgeState.ts 的工作投影，在 SessionInspector.tsx 的执行页提供紧凑工作项及等待信息；沿用既有七类状态、Glyph、角色 Logo 和多联布局，不增加顶部文字块。当前话题优先显示自己的任务状态，查看历史任务不激活其执行。更新 docs/ui-guidelines.md 与 docs/experiments/adk-runtime.md。依赖 TASK-012。 | 见实施记录 | 2026-10-29 |
| TASK-014 | 新增 work-continuity fixture 与端到端回归：同时模拟两项发布和四项构建，一项依赖用户数据库确认；独立项继续，依赖部署零调用；完成观察后最终汇报；测试新消息抢先、停止、重开、事件重复、跨会话伪句柄和权限变化。浏览器检查明暗/800px/三联、键盘、减少动态效果，原生 Lake Dev 复验入口可见与停止。依赖 TASK-011、TASK-013。 | 见实施记录 | 2026-10-29 |

### Implementation Phase 5

- **GOAL-005**: 按仓库工作流形成可合并证据；验收为每阶段测试 SHA、失败项和 Dev 来源可核对，无生产资源操作。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-015 | 每阶段运行 python3 scripts/check_adk_runtime_boundary.py、受影响 Go 测试与 race/vet；最终运行 go test ./...、go test -race ./internal/ai ./internal/web ./internal/agent/...、go vet ./...，以及 Node 24.14.0 下 corepack pnpm --dir web-agent test:frontend 和 build:web。已有失败必须记录并确认来源，不删测试、不放宽门槛；没有完成的命令不能标绿。依赖 TASK-014。 | 见实施记录 | 2026-10-29 |
| TASK-016 | 提交实际代码后使用 scripts/build_lake_desktop.sh --dev --install 签名构建；核对 build-origin.gitHead 与测试 SHA。仅用显式隔离 Home 和 mock 外部工具验收断点恢复，不复制生产凭据、不重启正式版。将结果写入 docs/validation/long-task-continuity.md，按每阶段 develop PR 提交，合并分别取得授权。依赖 TASK-015。 | 见实施记录 | 2026-10-29 |

## 3. Alternatives

- **ALT-001**: 只增加 MaxSteps 或上下文窗口不能修复样例：本次额度远未用完，问题发生在任务未终结时接受最终答复。
- **ALT-002**: 宿主反复调用模型并追加“继续”会增加成本、重置身份和扩大误操作面；采用官方循环中的工作契约及真实事件恢复。
- **ALT-003**: 只改提示词可改善主动性，不能提供后台等待、崩溃防重放或完整完成条件；提示词与宿主账本同时交付。
- **ALT-004**: 任意 MCP status/name 自动分类无法建立可信任务句柄与只读权限；采用明确版本的宿主观察适配器，未知服务显示无法观察。
- **ALT-005**: 把完成声明存在摘要或 Todo 中会让模型压缩决定权限和真实进度；采用独立领域表、原操作记录及证据引用。

## 4. Dependencies

- **DEP-001**: go.mod 中现有官方 google.golang.org/adk/v2 v2.6.0；本次设计已核对本地公开 llmagent.AfterModelCallback、workflow.ResumeOrRequestInput、Runner.Run 及 Lake 的工具确认恢复实现，不以计划授权升级依赖。
- **DEP-002**: internal/agent/storage/sqlite.go 的私有数据库、事务及一致性备份；adk_session.go 的领域迁移入口、adk_operations.go 的防重放操作记录、adk_evidence.go 的来源证据。
- **DEP-003**: 已注册 release 服务的只读观察能力及版本化返回结构。实现期用虚构契约适配器验证；真实服务若无可信只读接口就保留 blocked，不调用写工具冒充状态查询。
- **DEP-004**: 现有消息队列、会话归属校验、权限与批准决策、Shared Glyph/AgentIcon、七类状态及官方 ADK 边界检查。

## 5. Files

- **FILE-001**: 新建 internal/ai/work_goal.go、work_goal_store.go、work_tools.go、external_watch.go、external_watch_scheduler.go、adk_work_wait.go，以及对应 *_test.go；目标账本、可信观察与官方恢复。
- **FILE-002**: internal/ai/adk_session.go、adk_driver.go、adk_provider_step.go、adk_projection.go、adk_recovery.go、runtime_contract.go、types.go、engine.go、polling.go、extended_catalog.go、session_tools.go；沿用原调用与持久化边界。
- **FILE-003**: internal/ai/context.go、context_compaction.go、context_resume.go、prompts/compaction-summary.txt、新建 prompts/work-continuity.txt 及列出的压缩回归；预算与摘要失败恢复。
- **FILE-004**: internal/web/agent.go、message_queue.go、新建 work_goal_routes.go 及测试；Web 状态与恢复队列。
- **FILE-005**: web-agent/shared/contracts.ts、web-agent/web/src/sessionBadgeState.ts、SessionInspector.tsx、sessionInspector.css，以及新增工作连续性 fixture 和测试；不重复新建 Island 状态系统。
- **FILE-006**: docs/experiments/adk-runtime.md、docs/ui-guidelines.md、新建 docs/validation/long-task-continuity.md；实施记录。只读参考 plan/feature-task-context-handoff-1.md 的历史目标，不恢复其已退役路径或构建方法。

## 6. Testing

- **TEST-001**: 外部任务先 building→running→success，期间任意次数同指纹：派发恰好一次、模型等待期零调用、终态只消费一次、最终验收读到真实结果才完成。
- **TEST-002**: 数据库工作项等待用户；没有该依赖的任务继续观察，依赖数据库的部署调用数为零；用户普通答复和压缩摘要不能当作操作批准。
- **TEST-003**: 原派发后进程退出且返回值未知：只核对原句柄，不能新建派发 ID 规避防重放；SDK session、Goal 和队列原身份保持一致。
- **TEST-004**: 在创建观察、写 outbox、获得租约、提交事件、提交恢复输入、发布完成投影等各持久边界注入崩溃，验证至多一次事件消费及旧 worker 的 fencing。
- **TEST-005**: 模拟虚拟时间 24 小时、系统休眠、时钟偏移和五次传输失败；预算不会随重启或压缩重置，暂停与阻塞如实展示；相同状态不触发模型忙等。
- **TEST-006**: 同目标连续三次摘要与预览恢复，取消父任务，摘要子期限结束、429、错误或空摘要、超大原始请求和工具目录；保留用户原文、Call/Tool 配对、证据 ID、待确认事项和已执行次数。
- **TEST-007**: 并发用户新消息、目标取消和迟到外部事件；原目标不污染新 RootTurnID，不新建假用户轮次、不覆盖其他任务进度，删除会话后无外部访问或模型恢复。
- **TEST-008**: 权限撤回、MCP 服务替换、伪造任务句柄、跨会话来源、工具输出伪指令及隐私字段注入均被拒绝；观察适配器不能调用任意写操作。
- **TEST-009**: 前端完整 App fixture 验收上方状态、执行详情、角色图标、暂停恢复取消、新消息反馈与多联窄栏；重开 Dev 复验后台继续和恢复提示，生产数据保持未访问。

设计文档验收：标识符声明唯一、所有引用存在、8 个必需章节完整、列出的现有源文件和函数存在。运行时验收以本次验证文档为准；不能以 PR #118 的前端检查替代本方案的 Go/ADK 验收。

## 7. Risks & Assumptions

- **RISK-001**: 任务执行时间与服务可达性没有无限保证；24 小时/累计模型额度及真实阻塞要可见，不能宣传无限上下文或永不中断。
- **RISK-002**: MCP 返回结构及权限会变化；适配器按版本和服务身份校验，未知结果停止自动推进，不重启已发操作。
- **RISK-003**: 模型可能漏登记工作或错误判断结论；可信异步派发在宿主自动绑定，终结须核对真实未完成观察和可执行验收条件。叙述性结论仍展示来源和未验证部分。
- **RISK-004**: SQLite 领域事务与 SDK 事件并非一个事务；用 outbox、版本和故障注入验证可恢复性。回退前先暂停新目标并保留附加表，不删除操作和观察记录；迁移为新增结构，不能静默降级仍活跃的新任务。
- **ASSUMPTION-001**: 当前请求先合并 #118，再完成可实施方案；当前已实现普通 core 会话的持续跟进；实际外部资源验收和生产发布仍需单独授权，不能以模拟测试替代。

## 8. Related Specifications / Further Reading

- [贡献规范](../CONTRIBUTING.md)
- [分支与发布规范](../docs/development-workflow.md)
- [官方 ADK 运行与恢复](../docs/experiments/adk-runtime.md)
- [前端状态与布局](../docs/ui-guidelines.md)
- [历史任务交接目标，仅作背景](feature-task-context-handoff-1.md)
- [当前轮恢复与压缩](refactor-context-turn-recovery-1.md)
- [PR #118：本方案前置集成](https://github.com/Clean-Lakes/Lake/pull/118)

## 实施记录（2026-10-29）

核心能力已实现：公开 ADK 等待/恢复、私有领域表和事务 outbox、五个工作工具、原句柄观察、自动压缩失败降级、跨话题接续、执行详情与控制、累计预算与 Dev 构建。实现未增加 SDK internal 依赖或另一套模型循环。

- TASK-001～008、012～013：运行能力已实现；`adk_work_wait_test.go` 验证公开 API，`work_goal_test.go`、`work_recovery_test.go`、`work_lifecycle_test.go` 验证 Shell、重启、跨话题、CAS/租约、六个独立观察与数据库前置条件、取消和删除。没有声称逐一注入原矩阵列出的每个断电窗口。
- TASK-009～011：80% 软阈值、60% 目标、摘要子超时与预览恢复、冷却及三次压缩保留目标/答案已实现并有回归；系统休眠、时钟跳变与全部错误排列尚未逐项模拟。
- TASK-014：真实 App fixture 已检查明暗、三联与控制键盘。800px 截图存在终端抽屉遮挡，不能据此宣称完成窄窗目标面板视觉验收；原生自动化连接超时，未虚构 GUI 验收成功。
- TASK-015～016：执行结果、准确测试提交和安装来源在 [验证记录](../docs/validation/long-task-continuity.md) 及 PR #120 更新。

与原设计的具体差异：领域存储合并在 `work_goal.go`；工作策略以固定 prompt fragment 加入请求，不改变原基础策略模板；消息和命令接入现有 agent/server 路由。观察器当前串行执行，低于 8/32 并发上限。发布观察需要在 MCP 服务编辑页显式选择“发布平台状态（v1）”，导入配置不能自动授予该能力。未配置的已启动发布进入 blocked，不推断完成。

后台接续中遇到新变更审批或新问题时停在需要人类输入的边界，不在隐藏的子执行器内伪造批准。等待用户的工作项由真实后续请求及原记录明确接续，按钮不会把数据库前置条件自动标成已完成。后台恢复中途崩溃进入 blocked 供核对，完整等待检查点可在重启后自动读取原句柄接续。没有可信恢复句柄的本机进程不会重新运行。
