---
goal: 工作流接入模型分析、目标步骤与有证据的自适应恢复
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [workflow, agent, recovery]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

桌面直接运行工作流后进入同轮 Lake Agent 分析；命令明确失败时由限定原资源的 Eino 专员诊断、调整和验证，再推进依赖节点。增加目标式 SSH 步骤。

## 1. Requirements & Constraints

- **REQ-001**: v1/v2 桌面直接运行必须进入模型总结并记录真实模型用量；结果包含节点状态及有界实际输出，不重新启动已执行工作流。
- **REQ-002**: v1 增加 ssh_task/goal；原 ssh_command 非零退出可进入最多16轮、最多180秒的专员恢复；成功须引用恢复末尾一次实际成功验证，不接受仅文本声称成功。
- **SEC-001**: 专员只操作当前步骤原资源，命令保持统一执行审批与 SSH 审批；授权撤回、审批拒绝、执行结果未知不尝试替代写操作。未知结果写入 unknown，恢复沿用原有人工核对规则。
- **CON-001**: Go/Eino 单运行时；固定 DAG 继续保存依赖和快照，历史失败尝试、调整命令及验证保存在工作流输出、事件和专员检查点。明确 execution_mode=fixed 可关闭步骤自动恢复。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 模型处理入口和自适应步骤运行。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | cmd/lake/chat.go 去除工作流早返回，执行前加载 Agent，实际执行后向模型传递有界结果，统一完整轮次耗时和用量；v2 工具返回实际节点结果。 | ✅ | 2026-10-01 |
| TASK-002 | lake/workflow/spec.go、engine.go 增加 goal/ssh_task/execution_mode、StepExecutor、未知执行标记；cmd/lake/workflow_adaptive.go 使用受限 Eino 专员及验证完成工具；workflow_tools.go 和 CLI 接入。 | ✅ | 2026-10-01 |
| TASK-003 | cmd/lake/workflow_v2_executor.go 为 SSH 明确失败提供同一恢复能力，修复非零退出被判成功；engine_v2.go 把未知写持久化，并传节点身份及目标上下文。依赖 TASK-002。 | ✅ | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 实测模型参与、故障后替代方法和真实状态验证。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-004 | bridge/engine/adapter 回归验证直接运行调用模型、原命令失败后不同命令恢复并继续依赖、无验证拒绝成功、拒绝审批/越权/未知结果不继续，审批期间目标变更和授权撤回阻断，未知不伪造退出码，明确失败分支与历史不被覆盖；工作流步骤专员只从父运行恢复。依赖 TASK-001、TASK-002、TASK-003。 | ✅ | 2026-10-01 |
| TASK-005 | 签名构建，实际运行原服务器端口巡检并由模型分析；另用独立测试目录制造可控故障验证动态替代和后续节点，保留实际记录，不重启业务资源。依赖 TASK-004。 | ✅ | 2026-10-01 |
| TASK-006 | 更新 docs/migration-closure.md、私有报告和计划状态，交付签名版本。依赖 TASK-005。 | ✅ | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 只让模型润色最终原始输出不能处理步骤中途失败及后续依赖，增加可审计的步骤级专员执行。

## 4. Dependencies

- **DEP-001**: 已登记模型、SSH 资源、统一审批、专员运行与检查点存储；模型不可用时明确报错，目标步骤不静默改为固定执行。

## 5. Files

- **FILE-001**: cmd/lake/workflow_adaptive.go 为共享恢复适配器；lake/workflow 保持调度和状态机；cmd/lake/chat.go 保持主会话及用量。
- **FILE-002**: 专员原有私有检查点与 workflow_event 存储证据；client/desktop/frontend/src/SpecialistCallCard.tsx 显示模型诊断及验证阶段。

## 6. Testing

- **TEST-001**: 模拟模型按失败输出生成替代命令，真实调用模拟 SSH 并用验证调用完成，后续依赖执行且原失败证据保留。
- **TEST-002**: 真实端口巡检和测试目录故障回归，证明有模型调用和不同执行方法，原业务服务保持运行。

## 7. Risks & Assumptions

- **RISK-001**: 模型选择不保证能处理所有故障；达到时限、无法验证或审批拒绝则保留失败/未知状态。
- **ASSUMPTION-001**: 用户已授权修复工作流及测试；服务器重启仅是示例，不授权重启业务服务器或既有业务服务。

## 8. Related Specifications / Further Reading

[迁移闭环](../docs/migration-closure.md)
[原生长任务](feature-script-longtask-1.md)
