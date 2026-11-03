# Lake Super-agent 运行架构与接入记录

实施基线：`85a768d074f654d8428d1ea278f9d60dec7a2504`。本文件随真实实现更新；未列为完成的入口继续沿原运行路径，不以文档代替切换。

## 权威与现有入口

| 入口 | 当前宿主入口 | 执行与恢复 | 任务权威 |
| --- | --- | --- | --- |
| 普通与 Plan | `internal/web/agent.go:runTurn` | `internal/ai/adk_driver.go:runOfficialADK` | WorkGoal、work_closure；Plan 不自动执行变更 |
| Pilot/SRE | `internal/web/sre_service.go:launchSRE/followSREHandoff` | `internal/ai/adk_sre_workflow.go:runSREPlanSteps/executeADKPlan` | 现有 SRETask；统一接管前保持原 owner |
| 保存工作流 | `internal/web/workflows.go`、`tool_bridge.go` | 同一官方 ADK | 原定义、真实尝试与操作 |
| 日程 | `internal/web/schedules.go:executeSchedule` | 原 schedule authority 与 ADK | 原 occurrence/grant；不复用聊天审批 |
| 外部等待 | `internal/ai/adk_work_wait.go:resumeWorkGoal/runMachineInput` | 原 checkpoint、function-response 与句柄 | 原 WorkGoal、nativeOperation |
| 用户补充 | `internal/ai/user_supplements.go:AdmitSupplement/applySupplements` | 安全步骤接入、SDK 接纳后消费 | 原 root 与真实来源消息 |
| 所有资源工具 | `internal/ai/security_execution.go:invoke` | 原生审批、派发屏障、原执行器 | nativeOperation/nativeEvidence、Security owner |

## 当前实施

- `SuperTaskView` 是原 WorkGoal 与 GoalClosureView 的只读投影。历史 completed 文本、未验收和 unknown 不产生新的完成凭证。
- `PlanLegacyWorkImport` 保持纯检查；`ApplyLegacyWorkImport` 对排空后的旧 WorkGoal 建唯一 alias，保留原 ID、期限和账本。缺乏可核验来源、原句柄或验收的历史仅只读；纯 SRE 历史使用只读归档，不伪造操作或通过验收。
- 任务、步骤、尝试、操作和验收沿原账本；新增事件/Worker/投递元数据不得建立第二完成权威。
- 已接入项目单一 Pilot、任务专员、实际用户来源、持久收件箱与回执、同修订任务详情及原终端入口。新项目通过宿主工作区激活；仍有旧活动任务的项目保留原 owner，拒绝双写。当前构建尚未完成 Dev 安装及原生端到端验收。
- 已迁移域的保存工作流/日程 occurrence 登记到同一 Worker 准入，仍使用原 Security task、WorkGoal、定义、子作用域与官方 SRE 图。定义变化、许可到期或日程撤销会阻止后续派发；原生步骤/目标验收是完成权威。旧 SRE HTTP 写入口停止独立接单，普通/Plan/专用输入转给 Pilot。
- 构建观察只接原受监管 Shell 操作及句柄；通用外部构建平台尚无当前 Security 只读 profile，`ObserveBuildRun` 明确返回 unavailable，不自动调用通用 MCP。资产范围 Memory 接口与原生完整故障矩阵仍受依赖/验证限制，见[实施计划](../../plan/architecture-lake-superagent-1.md)。

## 与历史方案的差异

早期多 Agent 方案以会话为父级、单轮委派为中心。本次目标是持续 Router 与独立工作，但保留原 SDK、来源、权限与操作身份。当前 Memory 仍沿 bearqy 的 N1–N5 与项目记忆契约，专员范围和运维 V2 不自动放开。

## 持久准入与恢复

元数据 schema 为 4；首次创建及从 schema 3 升级前使用规范库的一致快照备份，最低 Security reader 仍为 3。规范库的独立 Super-agent 版本检查在 SDK AutoMigrate 前接受3/4并拒绝未来版本；schema 3 在事务内新增频道/来源/只读引用表、回填准确 RoleID 并写入4。旧 schema 3 二进制拒绝4，不可直接降级运行。旧未发布开发检查点的 schema 1/2 拒绝打开，不能用旧库覆盖后来操作。跨库来源先 staged，实际消息、附件和引用上下文提交并绑定摘要后才 pending。

Assignment lease 为 45 秒，15 秒续租。真实问题、子图及外部等待释放活跃槽；机器接续使用原 function-response/checkpoint，不伪造用户补充。失去租约会 fencing 原 owner；不重放原工具，未决效果保留在 nativeOperation。派发事务、实际 I/O、步骤/目标验证及最终 checkpoint 重验对应 owner。进程恢复不续期原任务。

全局最多 6 个活动 Worker，模型并发 4，专员与后台模型最多占 3，为 Pilot/人工交互保留 1 个。任务准入按项目轮转；未完成路由或失效来源的提案不会阻塞可执行队列。模型轮次与 token 预留按 canonical goal 持久累积，未知用量保守保留预留。

同任务只允许一层子专员，根及所有子实例累计最多 8 个；失败和重新委派不重置计数。角色可以同名，实例/上下文仍隔离。原调查协作的 fan-out/fan-in 已改为官方 ADK 图，父子权限继续使用原 Security 交集；工作流 SRE 角色沿原冻结子作用域登记，复用相同准入、预算和父级 fencing。

跨 Task 写冲突以原操作账本为占用事实源，派发和冲突检查在同一事务。结果未知、部分副作用或未核实取消不会因为实例结束、租约过期或断线释放。

Pilot 每批最多 16 项，按真实人工控制/输入、日程、观察、告警优先。模型路由有 90 秒调用期限、每事件最多 3 次持久尝试和退避；新输入不被旧失败阻塞。直接回复与源事件结算同事务进入 outbox，宿主消息用固定 ID 幂等写入；任意外部通知渠道的 uncertain send 不允许盲目重发。

## Memory 兼容边界

Pilot 的表达偏好和项目知识继续使用原 N1–N5/项目 Memory 的读取、provider 重验、同意、撤回和 outbox。只读知识桥使用私有宿主上下文，不能用于 Memory 写入、另一会话或资源操作。

`SuperMemoryContext` 是额外宿主关联，未改变旧 `MemoryTurnSnapshot` 的序列化或 hash。专员强制关闭自然偏好继承与自动积累；`MemoryForWorker` 返回实际 task/worker/原消息关联和明确的 `task_knowledge_view_unavailable`。资产范围视图尚未交付前，不复制整个项目知识；运维 V2 保持关闭。`SuperMemorySourceContext` 在已提交用户来源唯一对应一个真实任务时，提供任务 revision、尝试、操作、验收和被引用证据的只读旁注；多任务来源与普通偏好保持无 taskID。unknown 仍是 unknown，旁注不充当新的学习来源。Memory 正文、快照、hash 和整理器不变。本批不宣称成功经验自动学习或 Memory 阶段全部完成。

## macOS 生命周期

人工回答/原生审批在异常恢复时记录原 SDK/root 检查点，由统一准入续接；已被 SDK 接纳的回复不盲目重送。原父图缺失的子角色仍受阻，不能创建替代执行或续期许可。

客户端关闭窗口保留原工作台；“退出界面（后台继续）”detach，不删除私有 runtime 或结束 Go 进程。重新打开通过 token、loopback、PID、Home 和数据目录核验后重连。“停止内核并退出”和更新前操作调用鉴权生命周期接口，停止新准入并走现有 checkpoint/未知操作保存和关闭路径，等待原 PID 退出。无强杀、LaunchAgent 或设备离线在线承诺。

Dev 安装脚本也拒绝覆盖存活后端；先停止 Dev 内核再安装。正式版应用和数据未更改。

## 本批验证记录（阶段检查点）

完整 `go test ./... -count=1 -timeout=10m` 已通过（AI 128s，Web 318s）；后续来源优先级、退避与 outbox 增量运行定向 race。`go vet ./...`、ADK 边界检查、Node 24 TypeScript 检查、16 项 Dev 脚本测试及原生 Swift 编译通过。此前完整前端 558 项通过。本批工作树当时含未提交变更，不能把该结果当作最终安装 SHA 的验收；最终 SHA、完整 race、签名 Dev 安装和实际界面/故障矩阵仍待交付记录。

## 项目目录与现有权限

Pilot 与 Worker 使用当前项目原资源目录。`InheritSuperProjectAccess` 只由可信 Web 宿主调用：未配置过独立策略的项目以 legacy 适配器继承已捕获的真实会话权限；资源上限由同项目、当前 Store/epoch、ready 的权威目录行生成，并在目录变化及派发前同步。只有该适配器生成的准确当前策略 revision 才继续跟随目录；用户修改过的策略原样保留。该自动接入不会覆盖显式项目限制、旧 epoch、enforced Home 中缺失的已确认策略，也不清除审批、未决风险或 Memory 同意设置。前端去除单独的项目资源勾选界面，继续展示原资源树。

继承适配只在原权限与目录来源都可核实时，为宿主准备的准确操作表示文件/数据库/集群/网络范围；不将模型参数当作新的授权。原权限入口的明确用户修改使用已有 revision/CAS 接口同步到执行权限；普通刷新和 Worker 配置不刷新这份已确认权限。

## 长期专员频道（2026-11-03 实施候选）

前台每个项目/准确 RoleID 对应一个持久角色频道，后台仍按 Task 创建独立 Worker 和官方 ADK Session。频道只有 Web 展示 Session，没有 Agent Loop、执行许可或独立完成状态。侧栏以频道计数；同名但不同 RoleID、不同项目均不自动合并。

普通频道消息及旧 Worker 链接的新消息先持久保存真实来源，再经同一 Pilot Router 创建、补充、回复或询问。角色偏好由宿主绑定，模型只能使用该频道准确 role_key；共享频道不注册某个任务的 followup 订阅。跨库中断恢复先补齐来源角色绑定再激活事件。原审批/问题/停止仍指向原任务及 SDK/root，已消费输入和冻结范围不改写。

连续时间线引用原消息和回复卡片，不复制整段聊天进 Worker。分页按时间、类型和准确来源排序，用来源ID去重；同正文的不同报告保留。流式、排队及路由阶段沿用三点等待，实际工具和审批保持原组件；执行详情在右栏读取被明确选中的任务，聊天入口保持原频道。频道的思考/上下文/轮数选项只为新任务初始化，已有任务选项保留；全局模型选择仍沿用既有模型设置语义。

Router 新增 `search_super_tasks`，按角色、资源、标题及时间查询历史任务，默认20、最大50，单页索引包限制在16 KiB内；准确原要求继续通过 `read_super_object` 分页读取。比较任务用 `evidence_task_ids` 显式登记只读来源。Worker 仅能列举/读取这些来源的准确证据；每页最多2 KiB，重新验证项目、源任务修订、attempt/operation/evidence关联、当前项目资源范围、Store/epoch和真实连接版本。返回采集时间、来源资源、原操作和验收状态、内容hash与续读位置。unknown、失败及采集端未保存的字节不被补造成成功或完整输出。

实现与验收任务见[长期专员频道计划](../../plan/feature-specialist-channel-1.md)。本节描述当前分支实现，签名 Dev 与最终候选验收仍以计划 TASK-017/018 的实际记录为准；不代表已经合并或发布。Worker 的长期 Memory 仍明确 unavailable，N5 专员及运维 V2 门控未启用。


2026-11-03 候选验收：[长期专员频道验证记录](../validation/lake-specialist-channels.md)。历史正文读取在确认步骤后进入当前比较尝试的原操作账本，保留源任务引用和采集时间；成功读取不代表新的主机观测或源任务通过验收。人工验收/汇总再次验证源修订与连接。窗口隐藏与重连保留频道历史，状态岛首选宽度不依赖紧凑布局后的宽度。完整回归及签名Dev已通过；真实C4最终模型交付仍受外部provider可用性阻塞，不能视为已验收。
