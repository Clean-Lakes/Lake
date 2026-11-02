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
- 新增事件、订阅、收件箱、投递回执、Router catalog 与 Worker assignment API；已通过合成供应商、并发来源与 SDK 回执测试。当前主入口仍未切换，不能将这些单元测试当作客户端端到端验收。
- 后续阶段、兼容规则与验收见[实施计划](../../plan/architecture-lake-superagent-1.md)。此处不宣称主入口、旧 SRE、日程、Memory 或 UI 已完成切换。

## 与历史方案的差异

早期多 Agent 方案以会话为父级、单轮委派为中心。本次目标是持续 Router 与独立工作，但保留原 SDK、来源、权限与操作身份。当前 Memory 仍沿 bearqy 的 N1–N5 与项目记忆契约，专员范围和运维 V2 不自动放开。
