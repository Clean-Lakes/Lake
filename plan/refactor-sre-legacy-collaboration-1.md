---
goal: 旧只读 SRE 计划续跑时由模型重新安排剩余专员并保留已完成证据
version: 1
date_created: 2026-10-16
last_updated: 2026-10-16
owner: Lake
status: Completed
tags: [sre, collaboration, migration]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

当前恢复旧计划仍把全部取证工作分给调查员。本次在续跑边界对具备独立剩余工作的旧只读计划进行一次模型重新规划，保存修订与证据来源，不中断在途任务。

## 1. Requirements & Constraints

- **REQ-001**: 新计划记录 collaborationVersion；旧只读计划存在可并行的未完成检查，或可同时复核既有证据，且无验证员时，续跑先通过完整协调者模型决定角色分工。
- **REQ-002**: 升级保留原目标、范围、验收、步骤交付物和真实依赖。已完成取证原样沿用并保留 ReusedFromAttemptID 与原采样时间。
- **SEC-001**: 不升级正在执行、含变更或未知结果的任务；不增加动作或绕过权限。不把沿用证据当作新的独立验收。
- **REQ-003**: Plan 显示旧计划接手顺序的原因；沿用步骤标识为沿用证据，升级过程与修订在对话可见。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 修复旧计划续跑路径。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/ai/sre_collaboration_upgrade.go 实现旧计划识别、约束校验与原子修订；sre_orchestrator.go 在续跑边界调用，sre_types.go 记录协议版本。 | ✅ | 2026-10-16 |
| TASK-002 | web-agent/shared/contracts.ts 和 web-agent/web/src/SREPlanCard.tsx 显示计划接手顺序和沿用证据；sre_coordination.go 更新继续工具语义。依赖 TASK-001。 | ✅ | 2026-10-16 |

### Implementation Phase 2

- **GOAL-002**: 验证实际续跑与 Dev 集成。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | internal/ai/sre_collaboration_upgrade_test.go 验证冻结、取消和未知结果约束；internal/web/sre_parallel_test.go 模型重新分工并真实并行，完成步骤不重跑。依赖 TASK-002。 | ✅ | 2026-10-16 |
| TASK-004 | 运行 Go/race 和前端检查；签名构建 Dev，仅空闲时重载；保存 docs/validation/lake-sre-legacy-collaboration.json。依赖 TASK-003。 | ✅ | 2026-10-16 |

## 3. Alternatives

- **ALT-001**: 仅要求用户手动新建会话会丢失续跑体验，不采用。
- **ALT-002**: 直接改写在途计划或虚构其他专员发言会破坏审计与真实性，不采用。

## 4. Dependencies

- **DEP-001**: 已有 SRE 仓库事务、模型计划校验、并行调度与证据原文读取。

## 5. Files

- **FILE-001**: internal/ai/sre_collaboration_upgrade.go、sre_orchestrator.go、sre_types.go、sre_coordination.go。
- **FILE-002**: web-agent/shared/contracts.ts、web-agent/web/src/SREPlanCard.tsx、sreCollaboration.css 和对应测试。

## 6. Testing

- **TEST-001**: 种入旧计划和完成取证，继续后有实际模型规划、两角色并行、原步骤不重跑、旧事实可追溯。
- **TEST-002**: 拒绝改范围、改已完成步骤、漏原交付物、删除依赖、加入变更和仍串行的升级计划；未知和在途任务不迁移。
- **TEST-003**: 全量 Go/race、前端类型与回归、Dev 签名和空闲状态检查。

## 7. Risks & Assumptions

- **RISK-001**: 协调模型可能无法返回合法重新分工，失败时保留旧计划及证据并显示明确错误，不静默退回串行。
- **ASSUMPTION-001**: 不强制简单单步骤任务有多个专员，仅对具备独立剩余交付物的旧调查计划升级。

## 8. Related Specifications / Further Reading

[SRE 协作](../docs/sre-collaboration.md)；[并行协作](feature-sre-parallel-collaboration-1.md)。

验证结果：Go 全量、AI/Web race、181 项前端测试与类型检查通过；签名 Dev 已构建安装。用户明确要求后重启 Dev，新进程和 8 个会话快照健康；待核实操作保留，未恢复或重放任务。
