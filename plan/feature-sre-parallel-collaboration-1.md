---
goal: SRE 专员按依赖并行执行并在对话中交流与共享实时状态
version: 1
date_created: 2026-10-16
last_updated: 2026-10-16
owner: Lake
status: Completed
tags: [sre, collaboration, parallel]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

将串行步骤改为按依赖调度多个完整专员。专员通过明确的团队消息交换进展、请求复核并读取已采集证据，在同一对话中保留各自发言和状态。

## 1. Requirements & Constraints

- **REQ-001**: 不同角色的就绪步骤并行执行，每个固定角色同时最多一个步骤；变更步骤单独调度，依赖未满足的步骤不得开始。
- **REQ-002**: 增加 sre_team_update 和 sre_team_read，消息身份由运行时绑定；模型每轮获取有界团队状态。
- **REQ-003**: 进展和最终回复保留各自时间顺序，消息显示目标专员，状态来自真实运行。
- **SEC-001**: 父权限、资源锁、未知结果禁止重放、独立验收保持生效；失败后取消并等待所有在途专员退出后再释放父会话。
- **SEC-002**: 共享原文读取仅允许当前任务及专员授权资源，不把其他角色结论当成自己的独立观测。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 实现并行调度和有界团队交流。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/ai/sre_orchestrator.go 提取步骤执行并实现有界 DAG 调度；sre_execution.go 保持资源串行锁且区分其他在途派发和未知结果。 | ✅ | 2026-10-16 |
| TASK-002 | internal/ai/sre_team.go 实现团队消息、状态和证据读取；sre_tools.go、tools.go、engine.go 提供专员工具和最新状态；multi_agent.go 实时持久化证据。依赖 TASK-001。 | ✅ | 2026-10-16 |
| TASK-003 | sre_orchestrator.go 保留进展与最终消息；更新角色及计划提示；shared/contracts.ts 和 SRERoleMessage.tsx 显示目标专员与实际状态。依赖 TASK-002。 | ✅ | 2026-10-16 |

### Implementation Phase 2

- **GOAL-002**: 验证真实并行、交流、隔离与 Dev 集成。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | internal/web/sre_parallel_test.go 用本地模型屏障证明不同专员同时执行、实际工具结果实时可见、跨角色请求和回复、依赖顺序及失败收尾；前端验证定向消息与状态。依赖 TASK-003。 | ✅ | 2026-10-16 |
| TASK-005 | Go 全量与 race、前端检查、签名安装 Dev，保存 docs/validation/lake-sre-parallel-collaboration.json。依赖 TASK-004。 | ✅ | 2026-10-16 |

## 3. Alternatives

- **ALT-001**: 仅在 UI 同时显示四个头像没有真实并行与交流，不采用。
- **ALT-002**: 不区分变更与独立调查并行执行会破坏验收时间关系，不采用。

## 4. Dependencies

- **DEP-001**: 现有独立子引擎、SRE 仓库事务、资源锁、模型并发池与证据原文存储。

## 5. Files

- **FILE-001**: internal/ai/sre_orchestrator.go、sre_team.go、sre_roles.go、sre_execution.go、sre_tools.go、engine.go、tools.go、multi_agent.go、sre_types.go 和角色提示。
- **FILE-002**: web-agent/shared/contracts.ts、web-agent/web/src/SRERoleMessage.tsx、sreCollaboration.css 与对应测试。

## 6. Testing

- **TEST-001**: 用两个以上不同角色的真实模型请求屏障证明并行，模型工具实际读取临时文件并交换消息。
- **TEST-002**: 验证同角色串行、动作独占、依赖顺序、失败取消、权限撤销和跨任务证据拒绝。
- **TEST-003**: Go/race、前端类型及现有回归通过，Dev 使用独立数据。

## 7. Risks & Assumptions

- **RISK-001**: 并行模型增加同时在用额度，继续由模型池和共享任务预算限制，不新建无限队列。
- **ASSUMPTION-001**: 独立工作可并行，存在真实先后依赖的步骤必须通过计划声明。

## 8. Related Specifications / Further Reading

[SRE 协作](../docs/sre-collaboration.md)；[完整运行时](refactor-sre-agent-runtime-1.md)。
