---
goal: 将 Lake 长期专员对话入口与独立任务执行会话解耦，并补齐受限历史召回
version: 1
date_created: 2026-11-03
last_updated: 2026-11-03
owner: Lake
status: 'In progress'
tags: [feature, architecture, superagent, conversation, context]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

用户在一个长期专员入口持续沟通；系统为独立工作创建不同 Worker/执行 Session，并为后续问题找回准确任务。前台聊天历史按角色连续展示，模型上下文按任务隔离。2026-11-03 用户授权实施；按下列任务完成状态记录实际水位，未勾选项不视为已交付。Memory 门控保持原值。

审计源码：`af64c8cd6c859a387ee9ea166e0f14f7ed231535`，工作分支 `codex/worker-recovery-avatar`；包含本次读取的 `origin/develop@2b233a4ad9d405e5b7bf4705359303b31bcde652`。Lake Dev 最近已安装的运行源码为 `612298cc6461f08713825dad3075801472b7113d`；两者差异仅为专员名称验证文档。后续本方案提交也不代表运行能力已经交付。

## 1. Requirements & Constraints

### 实施前审计水位（保留基线）

| 能力 | 结论 | 可核对证据与实际限制 |
| --- | --- | --- |
| 持续 Pilot Router | 已实现基本链路 | `internal/ai/superagent_catalog.go:RouterCatalog` 仅提供路由、对象读取及受限 Memory；`internal/web/superagent_runtime.go:runSuperPilotTurn` 接真实用户消息。Router 无资源执行工具。 |
| 独立任务与上下文 | 已实现 | `internal/ai/superagent_router.go:ApplySuperDecision` 为每个 create 建立独立 TaskID、WorkerID、SessionID、RootTurn；TaskID 沿 canonical WorkGoal，执行与验收仍归原账本。 |
| 角色与实例分离 | 存储已具备，产品入口未接通 | `superagent_roles` 以项目和 role_key 生成 RoleID，多个 Worker 可以引用同一 RoleID；`superWorkerRow` 仍准确指向一个任务。不能把同名不同 RoleID 自动合并。 |
| 一个任务多个资源 | 参数和账本支持资源集合 | `internal/ai/work_tools.go:workTools/invokeWorkTool` 的 asset_refs 是数组。当前任务最初只确认优刻云，不代表系统只支持一台主机；已冻结任务不能静默增加另一资源。 |
| 长期专员对话入口 | 尚未实现 | `web-agent/web/src/PilotWorkspace.tsx:PilotWorkspace` 按 roots=workers 渲染，每个入口导航到 worker.sessionId；不是按角色聚合。`SuperWorkspace` 目前只有 workers，没有角色频道。 |
| 直聊自动区分新工作/旧工作 | 尚未实现 | `internal/web/superagent_runtime.go:runSuperTargetedInput/acceptSuperWorkerMessage` 直接将消息记为旧 TaskID 的 targeted-followup，未先做任务归属判断。这是截图中新主机问题被塞回旧任务的直接原因。 |
| 订阅与交回 Router | 部分实现 | `superagent_subscription.go:RouteSubscribedEvent/HandBackSuperEvent` 有持久订阅和交回函数；只允许未被 SDK 消费的输入交回，且没有 Worker 模型工具接入。不能把存储函数已有当作“模型理解越界后已能自动交回”。 |
| 有界上下文与压缩 | 已实现 | `superagent_context.go:BuildRouterContext` 每批最多16事件、总包16 KiB；`engine.go:compact` 约80%触发、以60%为整理目标，先缩减较早工具预览，必要时摘要。模型单次窗口及失败保全继续有效。 |
| 工作历史召回 | 部分实现 | `ReadSuperObject` 只支持 event/task/worker、revision/hash/UTF-8分页；Router 可读同项目对象，Worker 只能读自己的任务。任务索引只注入最多32个近期 Worker 的任务，`SuperWorkers` 列表上限100；没有完整历史搜索、跨任务证据正文读取或 Attempt/Evidence 多跳接口。 |
| 持久化与恢复 | 已实现基础机制 | 官方 ADK Session/artifact、收件/投递、租约、canonical 操作/验收保留。已记录结果的保留不等于能恢复源工具从未采集或已在采集端截断的字节。 |
| 任务报告连续展示 | Pilot 已有，角色频道缺失 | `superagent_source.go:DeliverPilotReport` 校验 ChannelRef=项目 RouterSessionID；尚无同一角色频道聚合多个任务报告的路径。 |
| Lake Memory | 偏好机制已有，Worker任务知识未交付 | `MemoryForWorker` 明确返回 task_knowledge_view_unavailable。N1–N5 开关/同意与现有角色限制有效；来源旁注不是自动学习成功经验，运维V2继续关闭。 |

### 目标边界

- **REQ-001**: 一个项目内，每个准确 RoleID 对应一个可持续使用的专员频道；任务数量变化不创建新的同角色导航行。不同 RoleID 即便显示名相同也保持独立。
- **REQ-002**: 专员频道只是输入/展示通道，不运行 Agent Loop、不拥有资源许可，也不把全部频道历史注入每个 Worker。Pilot/Router 和任务 Worker 继续使用官方 ADK。
- **REQ-003**: 用户消息先经真实来源持久化；未明确绑定现有任务的消息由 Router 判断 create/followup/respond/ask/stop。角色选择只限定接待角色，不自动决定 TaskID。
- **REQ-004**: 同一任务允许最初明确选择多个资源；真正独立的新资源检查创建新任务，保留旧任务及其证据。同任务的修改按现有版本/确认流程处理，不直接修改冻结绑定。
- **REQ-005**: “刚才优刻云磁盘呢”能定位准确历史任务；多个同资源任务或指代含糊时询问一次。仅查看已有结果不恢复任务；需要新观测时按原任务状态、范围与当前权限决定续办或创建显式关联的新工作。
- **REQ-006**: “比较这两台”创建独立比较任务，只读被明确引用且当前可读的A/B证据；展示资源、采集时间、操作结果和验收状态，缺失或过期结果不得当作实时状态。
- **REQ-007**: 历史检索和长期 Memory 分离。首批角色频道与任务切换不依赖 Worker Memory 上线；不可用时不附带可选知识。
- **SEC-001**: 每次派发仍核对项目策略、原Task/RootTurn/attempt、资源版本、当前owner、期限、额度、审批及未决操作。RoleID、来源引用、上下文摘要和前台选中状态都不是执行许可。
- **SEC-002**: 不为绕过暂停、轮数耗尽、到期、unknown或失败而复制原任务。旧任务的重试仍使用旧账本和限制；新任务必须对应真实新要求及来源。
- **SEC-003**: 跨任务只读结果访问由宿主验证准确引用和当前范围；禁止提供全量同项目Worker历史给模型。跨项目、关系另一端和已失效连接不得借引用泄露。
- **SEC-004**: 不改写已消费输入、不复活已派发调用、不复制审批或密钥。旧 HandBackSuperEvent 的 consumed 拒绝继续保留；消费后改派需要独立追加协议，不在首批放宽。
- **CON-001**: 使用当前项目原资源目录与权限；不增加第二套资源勾选管理，不按IP/名称自动合并资产，不更改Items/Security/Memory权威边界。
- **CON-002**: canonical WorkGoal/操作/证据/验收仍是唯一执行事实源。新频道、索引和报告投影可重建，不能自行结清任务。
- **CON-003**: 本方案实施通过功能分支和develop PR完成；Mac仅签名构建、安装和重启Lake Dev。合并和生产发布仍需各自授权。

### 内部契约（当前分支已实现，验收见实施步骤）

| 对象 | 准确字段/不变量 | 存储与用途 |
| --- | --- | --- |
| SpecialistChannel | id、projectID、roleID、hostSessionID、revision、createdAt；唯一(projectID,roleID) | superagent_role_channels，放现有规范库；hostSessionID指向Web展示Session，不创建ADK执行Session。 |
| RoleChannelSource | channelID、sourceSessionID、messageID、eventID、preferredRoleID、explicitTaskRef可空 | superagent_channel_sources 的宿主来源关联；引用原消息和附件，不搬运或伪造人类消息，不把preferredRoleID当授权。 |
| ChannelTimelineRef | channelID、kind、sourceSessionID、sourceID、taskID可空、workerID可空、createdAt | superagentChannelTimeline Web投影索引；同一源引用在同频道只展示一次，不能按正文相同去重。分页游标使用(createdAt,kind,sourceID)。 |
| TaskEvidenceRef | taskID、goalRevision、attemptID、operationID、evidenceID、resourceID、connectionVersion、collectedAt、resultState | 只读引用契约，由原账本生成；不包含凭据、旧执行owner、可重用permit或另一Worker整段历史。 |

RoleID沿用当前项目内准确标识；已有两个不同RoleID的“服务器运维排查专员/服务运行状态排查专员”不按词义自动合并。频道可先各自存在；角色别名/人工合并另行设计。新工作在准确频道中使用宿主允许的preferredRoleID，模型不得用自造role_key制造重复频道。

### 路由决策表

| 输入 | 路由结果 | 必须保留的边界 |
| --- | --- | --- |
| 检查优刻云 | 新任务A，资源=优刻云 | 创建提案后走现有确认和Security；角色频道不提供额外权限。 |
| 192.168.2.218这台呢 | Router识别新的独立主机检查，创建任务B | A的资源、状态、用量和证据不变；B使用其准确资源身份与新来源。 |
| 刚才优刻云磁盘呢 | 检索A；已有结果则引用回复，原目标仍可续办才followup | 原目标已结束/到期或要求超原范围时，不静默续期；新工作显式关联A并保留原因。 |
| 比较这两台 | 新比较任务C，记录依赖A/B与准确证据引用 | 历史读取与新采样分开；旧证据不代表当前健康，无证据则明确不足。 |
| 继续刚才被暂停的检查 | 读原任务并解释真实暂停条件 | 不create替代任务重置轮数、期限或unknown。 |
| 停止它 / 这台呢且候选不唯一 | 沿当前真实输入归属判断，仍不唯一则ask | 不停止整个角色下所有任务，不广播给全部Workers。 |

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成代码审计和现有能力定向回归，明确本方案不是已实现功能。此阶段已完成。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | 核对superagent_store.go、superagent_router.go、superagent_runtime.go和PilotWorkspace.tsx，记录Role/Worker/Task/Session当前映射与直聊强制followup路径。 | true | 2026-11-03 |
| TASK-002 | 核对superagent_context.go、engine.go:compact、superagent_subscription.go:HandBackSuperEvent及superagent_memory.go，区分分页召回、压缩、未消费交回与不可用Worker知识视图。 | true | 2026-11-03 |
| TASK-003 | 在审计SHA执行本文件第6节的既有Go与前端定向回归；记录结果，不以测试通过冒充目标频道功能已实现。 | true | 2026-11-03 |

### Implementation Phase 2

- **GOAL-002**: 持久建立角色频道及可重建时间线。依赖GOAL-001；完成条件为重复迁移、重启和分页不增加执行实例、不复制消息。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-004 | 在internal/ai/superagent_store.go与拟新增superagent_channels.go实现EnsureSpecialistChannel/ListSpecialistChannels。为schema3到schema4编写显式事务迁移和未知版本拒绝；保持现有表及TaskID/SessionID/epoch不变。为现有根Worker按准确RoleID生成唯一频道映射；旧版本不得继续写schema4，不能直接降级旧二进制。 | true | 2026-11-03 |
| TASK-005 | 在internal/web/superagent_source.go及拟新增superagent_channel_projection.go实现EnsureRoleChannelSession/ReconcileRoleChannelTimeline；使用既有Web Store迁移入口登记kind=role的非执行Session。跨库关联通过幂等投影/回执修复，不假设两个SQLite原子提交。依赖TASK-004。 | true | 2026-11-03 |
| TASK-006 | 在internal/web/superagent_routes.go提供项目鉴权的角色列表与频道分页读取；在web-agent/shared/contracts.ts增加SpecialistChannel、ChannelEntry和workspaceRole=role，保留旧workers响应兼容。返回准确内部任务引用供详情/审批使用；频道本身不出现在执行准入中。依赖TASK-005。 | true | 2026-11-03 |

### Implementation Phase 3

- **GOAL-003**: 角色消息自动选择任务，切换主机不修改旧任务。依赖GOAL-002；完成条件为A/B/返回A三步无需用户管理内部Session。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-007 | 在internal/web/superagent_runtime.go新增acceptSpecialistChannelMessage/runSpecialistChannelInput；先提交原消息、引用和附件，再把preferredRoleID及可核实explicitTaskRef交给同一Pilot Router。取消role频道默认targeted-followup；不直接ExecuteTurn频道Session。依赖TASK-006。 | true | 2026-11-03 |
| TASK-008 | 在internal/ai/superagent_catalog.go与superagent_router.go扩展角色限定路由；宿主校验RoleID属于当前频道项目。原精确回复/审批/外部句柄可走当前任务快路径；普通新消息先Router判断，资源相同仅为候选，不自动合并任务。create仍要求真实新要求；followup重验原scope/deadline/轮数，respond不能派发资源操作。依赖TASK-007。 | true | 2026-11-03 |
| TASK-009 | 在internal/web/superagent_runtime.go保留旧Worker链接兼容入口：界面导航到其角色频道并携带可见任务引用；新的普通用户输入经角色路由，原问题答案/审批继续投递原SDK/root。internal/ai/superagent_subscription.go只为准确任务归属保留直通；先判定再入Worker收件箱，不放宽已消费HandBack。依赖TASK-008。 | true | 2026-11-03 |
| TASK-010 | 在internal/web/superagent_source.go:DeliverPilotReport与superagent_outbox.go的现有投递机制上增加准确role channel目标；每个目标独立稳定delivery ID与回执。角色频道展示完整报告，Pilot复用现有通知策略；保留来源身份，同一报告重试不重复显示，不按相同正文删除不同报告。依赖TASK-006、TASK-008。 | true | 2026-11-03 |

### Implementation Phase 4

- **GOAL-004**: 补齐历史任务索引及受控证据召回。依赖GOAL-003；完成条件为任务超出近期索引后仍能找回，比较任务不继承另一任务执行权限。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-011 | 在internal/ai/superagent_context.go新增SearchSuperTaskIndex，按当前project、准确RoleID、资源ID和时间分页过滤canonical任务，默认20条、上限50条。Router工具增加查询入口；保留BuildRouterContext的16 KiB及事件完整读取要求，不将全频道消息注入模型，不再依赖最近32/列表100作为历史全集。 | true | 2026-11-03 |
| TASK-012 | 在拟新增internal/ai/superagent_evidence.go实现ReadReferencedTaskEvidence；只读取宿主登记到当前任务的TaskEvidenceRef。逐页重验项目、当前读取资格、资源连接版本、任务revision及证据关联；返回时间、状态、来源和明确截断标记，单页最多2 KiB，必要正文按页继续。禁止读取另一Worker transcript，未知结果保持unknown。依赖TASK-011。 | true | 2026-11-03 |
| TASK-013 | 在superagent_router.go与拟新增superagent_task_references.go登记比较任务C到A/B的只读依赖引用；这些引用不改变A/B状态、scope、验收或许可，也不自动继续旧命令。缺少当前证据时由C明确报告不足或按真实请求提出新观测。Worker任务知识Memory保持unavailable，不以该接口绕过Memory同意。依赖TASK-012。 | true | 2026-11-03 |

### Implementation Phase 5

- **GOAL-005**: 前台以角色连续展示，内部任务身份保持准确。依赖GOAL-003；TASK-015的跨任务证据展开另外依赖GOAL-004。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-014 | 修改web-agent/web/src/PilotWorkspace.tsx与App.tsx，以频道ID渲染角色入口、导航和最近活动摘要；数量为角色频道数。顶部显示角色名称，消息气泡不恢复已移除的头像/重复名称；资源树保持原项目目录。依赖TASK-006、TASK-009。 | true | 2026-11-03 |
| TASK-015 | 新增web-agent/web/src/SpecialistChannel.tsx，分页聚合原用户消息与各任务回复引用，分别读取准确Worker消息/卡片；原始事件ID去重、恢复滚动锚点、加载历史及流式进度。频道不拼接成一个模型Session；每条回复关联真实task/worker，跨任务比较提供按需来源详情。依赖TASK-010、TASK-013、TASK-014。 | true | 2026-11-03 |
| TASK-016 | 扩展SessionInspector.tsx及现有问答/审批处理，使频道内的输入、暂停、停止、执行详情、附件均指向准确任务和原SDK/root。多个活动任务不能用“最后选中Worker”代替归属；不明确就询问。保留权限、Plan、模型配置与草稿原语义，角色频道模型配置只作为新任务默认，不覆盖在途任务。依赖TASK-015。 | true | 2026-11-03 |

### Implementation Phase 6

- **GOAL-006**: 在最终源码完成可重复验收并通过develop PR交付。依赖GOAL-004、GOAL-005；Memory后续完整知识能力不作为此阶段的隐式依赖。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-017 | 实现TEST-001至TEST-008的迁移、路由、隔离、迟到投递与恢复测试；执行Go/race/vet、ADK边界、前端类型/测试/构建。每次变更记录被测SHA，不删除保护测试或放宽权限来达成切换。 | false | — |
| TASK-018 | 使用签名scripts/build_lake_desktop.sh --dev --install，在Lake Dev以真实A/B/返回A/比较序列验收。记录两项独立任务、第三比较任务、角色入口数量、实际证据、资源绑定和模型上下文占用；验证浅/深色、窄窗、三栏、键盘与引用caret，清空未发送合成草稿。依赖TASK-017。 | false | — |
| TASK-019 | 更新docs/design/lake-superagent-runtime.md、docs/lake-pilot.md、docs/ui-guidelines.md及原统一内核计划的实际水位，记录Memory未交付项、迁移及回退要求。以develop为目标更新PR、处理反馈；只在取得本PR合并授权后合并并清理可安全删除的分支。依赖TASK-018。 | false | — |

## 3. Alternatives

- **ALT-001**: 直接将旧Worker绑定改为所有项目资源。扩大原任务范围、混淆证据与验收，不采用。
- **ALT-002**: 前台仍按Worker列出，只把同名导航行合并。输入和消息仍缺少准确task归属，不能完成连续对话，不采用。
- **ALT-003**: 将角色频道历史全部复制进一个长期模型上下文。会使不同任务互相污染并持续挤占窗口，不采用。
- **ALT-004**: 只补Worker handback工具。当前consumed输入不能交回，且仍缺角色频道与聚合展示；可作为以后外部事件协议增量，不能单独满足本方案。
- **ALT-005**: 等待完整资产Memory后才做多任务入口。当前路由和任务隔离不依赖长期学习，延后会保留已知产品缺口，不采用。

## 4. Dependencies

- **DEP-001**: 当前官方ADK Runner、canonical WorkGoal/安全派发、宿主来源与outbox，沿现有实现使用；不另建任务循环或完成权威。
- **DEP-002**: 新的频道元数据/宿主展示Session迁移及准确双库投影。任何schema4能力启用前必须通过新旧reader、幂等和中断恢复检查；回退使用保留schema4读取能力的兼容提交，不能直接运行旧schema3二进制。
- **DEP-003**: bearqy的资产范围Worker知识、来源采集、经验形成及Items通用身份/版本契约仍属独立后续依赖；本方案不翻转N5专员或operationalMemoryV2Ready。
- **DEP-004**: 当前已授权项目资源与现有只读诊断配置；缺失目标OS/连接版本时按现有流程明确配置，不编造服务或静默扩大权限。

## 5. Files

- **FILE-001**: `internal/ai/superagent_store.go`、拟新增`superagent_channels.go`、现有`superagent_cutover.go`：角色频道、迁移及兼容查询。
- **FILE-002**: `internal/web/superagent_runtime.go`、`superagent_source.go`、`superagent_routes.go`、拟新增`superagent_channel_projection.go`、`store.go`：准确来源、频道接待与投影。
- **FILE-003**: `internal/ai/superagent_catalog.go`、`superagent_router.go`、`superagent_subscription.go`、`superagent_outbox.go`：路由与投递；不修改WorkGoal执行许可语义。
- **FILE-004**: `internal/ai/superagent_context.go`、拟新增`superagent_evidence.go`和`superagent_task_references.go`：历史索引与受限证据正文。
- **FILE-005**: `web-agent/shared/contracts.ts`、`web-agent/web/src/api.ts`、`PilotWorkspace.tsx`、`App.tsx`、`SessionInspector.tsx`、拟新增`SpecialistChannel.tsx`：持续角色入口和任务准确交互。
- **FILE-006**: `docs/design/lake-superagent-runtime.md`、`docs/lake-pilot.md`、`docs/ui-guidelines.md`、`plan/architecture-lake-superagent-1.md`及后续验证记录：实际交付水位。

## 6. Testing

- **TEST-001**: 以隔离SQLite fixture验证schema3到4迁移、重复迁移、未来版本拒绝、旧reader拒绝、未完成双库投影续跑；所有既有task/worker/root/operation/unknown/验收不变。
- **TEST-002**: 同RoleID创建A/B两个Task，具有不同Worker/ADK Session，侧栏仅一个角色频道；不同项目/不同RoleID同名不合并。频道本身没有执行Session或Worker槽。
- **TEST-003**: 使用受控模型及loopback SSH fixture执行A/B/返回A，B不进入A冻结scope，返回A使用A原目标与计数；权限不足、轮数暂停和过期不经create逃逸。
- **TEST-004**: 任务多于100、A不在最近32索引时，分页检索仍能找到A；不明确指代返回ask，不能把消息广播给所有Workers。
- **TEST-005**: 比较任务C只读A/B被引用的准确证据，跨项目、未引用任务、失效版本、unknown和过期采样保持拒绝/不足；C不继承A/B permit或人工pass。
- **TEST-006**: 重复输入、报告投递丢ACK、进程重启、流式卡片转持久消息以及相同正文的不同报告均按真实源ID处理；不重复派工、不吞掉独立报告。
- **TEST-007**: 频道内审批/问题/停止/附件属于各自原任务；迟到答复不能作用于另一个任务，同一UI下两个并行任务也不改变当前owner与SDK/root。
- **TEST-008**: 连续多任务对话触发既有压缩后，原约束/证据/原始记录仍可查，读取到的来源时间与对象一致；Router输入包仍受16 KiB边界约束，Worker Memory仍明确unavailable。

本次审计实际运行的既有回归（审计SHA，未实现目标功能）：

```sh
go test ./internal/ai ./internal/web -run 'TestSuper|TestAutomaticCompaction|TestActualInputCanTriggerCompaction|TestCompactionFallback' -json -count=1 -timeout=6m
pnpm --dir web-agent exec tsx --tsconfig web/tsconfig.json --test web/test/superagent-workspace.test.ts web/test/reply-identity.test.ts web/test/superagent-budget-pause.test.ts
```

结果：Go 75项、2包通过；前端10项通过；0失败。fixture使用隔离数据和受控/本地端点，不操作现有Dev任务或远端主机。本轮没有为文档重启Dev或重跑完整Go/race/平台验收；既有最近运行版本的完整验证见相关记录，不能替代未来频道实现的验收。

实施记录：规范库已增加角色频道、来源角色绑定和比较任务只读引用；Web 库增加宿主展示 Session 与可重建时间线。频道分页使用现有鉴权后的 `/api/sessions/{roleSessionID}/channel`，每页50条。`SpecialistChannel.tsx` 聚合真实来源，任务检查通过 App 的独立快照在右栏展示。证据代码合并在 `superagent_task_references.go`，未另拆 `superagent_evidence.go`；未新增模型循环。

## 7. Risks & Assumptions

- **RISK-001**: 角色名字变化可能导致误合并。唯一键使用项目+RoleID，别名和合并另行设计。
- **RISK-002**: 为让聊天顺畅而隐式放宽旧任务scope。路由与许可分开，跨目标新工作保持新Task，已有Task修改仍走原契约。
- **RISK-003**: 角色频道报告与Pilot报告双重投递造成重复正文。每个目标独立幂等回执，原报告引用不按文本去重。
- **RISK-004**: 历史证据失效或现场变化。结果显示准确资源、连接版本、采集时间和原状态；实时结论依赖新观测，摘要不补造缺失数据。
- **RISK-005**: 路由引入额外模型调用。先保证正确任务归属，只对准确任务引用/原句柄使用程序快路径；记录从接单到可见回应和实际派发的耗时，不承诺论文实验延迟。
- **ASSUMPTION-001**: 当前用户希望保留Pilot与可直聊专员的Lake产品界面；长期角色频道是Lake产品增量，官方论文中的Worker仍是单任务执行者。
- **ASSUMPTION-002**: 当前Home的鉴权owner和项目隔离继续使用现有实现；本方案不交付跨设备身份、云端常驻或外部Watchdog。

## 8. Related Specifications / Further Reading

- [三模块权威与Memory边界](../agent.md)
- [原统一Super-agent计划](architecture-lake-superagent-1.md)
- [当前运行实现](../docs/design/lake-superagent-runtime.md)
- [任务确认与独立验收](../docs/security/task-confirmation.md)
- [Memory实际能力与门控](../docs/lake-memory.md)
- [三模块接口与未完成依赖](../docs/design/items-security-memory-integration.md)
- [最近真实SSH重试验证](../docs/validation/lake-blocked-step-retry.md)
- [最近专员界面验证](../docs/validation/lake-specialist-name-hidden.md)
- [DeepSeek官方设计文章，§2、§3.3](https://x.com/DeepSeekHarness/status/2116857257245987236)
- [官方原型领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)
- [官方原型授权及follow-up](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md)
