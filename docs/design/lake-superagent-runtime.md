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
- `PlanLegacyWorkImport` 只生成元数据检查计划；不会写库、创建许可、重放工具或修改原任务。旧 SRE 仍需要 canonical goal 映射及验收对账。
- 任务、步骤、尝试、操作和验收沿原账本；新增事件/Worker/投递元数据不得建立第二完成权威。
- 已接入项目单一 Pilot、任务专员、实际用户来源、持久收件箱与回执、同修订任务详情及原终端入口。新项目通过宿主工作区激活；仍有旧活动任务的项目保留原 owner，拒绝双写。当前构建尚未完成 Dev 安装及原生端到端验收。
- 旧 SRE/日程统一接管、活跃历史迁移、新构建观察适配、Memory 来源管理投影及完整原生验收仍在实施。后续阶段、兼容规则与验收见[实施计划](../../plan/architecture-lake-superagent-1.md)，未完成项不会自动放行。

## 与历史方案的差异

早期多 Agent 方案以会话为父级、单轮委派为中心。本次目标是持续 Router 与独立工作，但保留原 SDK、来源、权限与操作身份。当前 Memory 仍沿 bearqy 的 N1–N5 与项目记忆契约，专员范围和运维 V2 不自动放开。

## 持久准入与恢复

元数据 schema 为 2；首次创建前使用规范库的一致快照备份，最低 Security reader 为 3。旧未发布开发检查点的 schema 1 拒绝打开，不能用旧库覆盖后来操作。跨库来源先 staged，实际消息、附件和引用上下文提交并绑定摘要后才 pending。

Assignment lease 为 45 秒，15 秒续租。真实问题、子图及外部等待释放活跃槽；机器接续使用原 function-response/checkpoint，不伪造用户补充。失去租约会 fencing 原 owner；不重放原工具，未决效果保留在 nativeOperation。派发事务、实际 I/O、步骤/目标验证及最终 checkpoint 重验对应 owner。进程恢复不续期原任务。

全局最多 6 个活动 Worker，模型并发 4，专员与后台模型最多占 3，为 Pilot/人工交互保留 1 个。任务准入按项目轮转；未完成路由或失效来源的提案不会阻塞可执行队列。模型轮次与 token 预留按 canonical goal 持久累积，未知用量保守保留预留。

同任务只允许一层子专员，根及所有子实例累计最多 8 个；失败和重新委派不重置计数。角色可以同名，实例/上下文仍隔离。原调查协作的 fan-out/fan-in 已改为官方 ADK 图，父子权限继续使用原 Security 交集；SRE 完整入口接管仍待后续批次。

跨 Task 写冲突以原操作账本为占用事实源，派发和冲突检查在同一事务。结果未知、部分副作用或未核实取消不会因为实例结束、租约过期或断线释放。

Pilot 每批最多 16 项，按真实人工控制/输入、日程、观察、告警优先。模型路由有 90 秒调用期限、每事件最多 3 次持久尝试和退避；新输入不被旧失败阻塞。直接回复与源事件结算同事务进入 outbox，宿主消息用固定 ID 幂等写入；任意外部通知渠道的 uncertain send 不允许盲目重发。

## Memory 兼容边界

Pilot 的表达偏好和项目知识继续使用原 N1–N5/项目 Memory 的读取、provider 重验、同意、撤回和 outbox。只读知识桥使用私有宿主上下文，不能用于 Memory 写入、另一会话或资源操作。

`SuperMemoryContext` 是额外宿主关联，未改变旧 `MemoryTurnSnapshot` 的序列化或 hash。专员强制关闭自然偏好继承与自动积累；`MemoryForWorker` 返回实际 task/worker/原消息关联和明确的 `task_knowledge_view_unavailable`。资产范围视图尚未交付前，不复制整个项目知识；运维 V2 保持关闭。本批不宣称成功经验自动学习或 Memory 阶段全部完成。

## macOS 生命周期

客户端关闭窗口保留原工作台；“退出界面（后台继续）”detach，不删除私有 runtime 或结束 Go 进程。重新打开通过 token、loopback、PID、Home 和数据目录核验后重连。“停止内核并退出”和更新前操作调用鉴权生命周期接口，停止新准入并走现有 checkpoint/未知操作保存和关闭路径，等待原 PID 退出。无强杀、LaunchAgent 或设备离线在线承诺。

Dev 安装脚本也拒绝覆盖存活后端；先停止 Dev 内核再安装。正式版应用和数据未更改。

## 本批验证记录（阶段检查点）

完整 `go test ./... -count=1 -timeout=10m` 已通过（AI 128s，Web 318s）；后续来源优先级、退避与 outbox 增量运行定向 race。`go vet ./...`、ADK 边界检查、Node 24 TypeScript 检查、16 项 Dev 脚本测试及原生 Swift 编译通过。此前完整前端 558 项通过。本批工作树当时含未提交变更，不能把该结果当作最终安装 SHA 的验收；最终 SHA、完整 race、签名 Dev 安装和实际界面/故障矩阵仍待交付记录。
