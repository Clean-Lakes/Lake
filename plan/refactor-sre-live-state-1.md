---
goal: SRE 专员持续执行动效、准确步骤状态与未知结果阻塞处理
version: 1
date_created: 2026-10-16
last_updated: 2026-10-16
owner: Lake
status: Completed
tags: [sre, ui, runtime]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

让每位正在运行的专员持续显示真实活动与耗时，修复验证员步骤映射、校验失败误判未知、继续任务先承诺后被拦截的问题。

## 1. Requirements & Constraints

- **REQ-001**: 运行中专员显示轻量动效、真实活动、耗时与证据数；结束、暂停、待确认与减少动态偏好停止执行动效。
- **REQ-002**: 验证员使用真实分配步骤与资源，Plan 和专员状态一致；无自动验收条件时保留实际复核回复。
- **REQ-003**: 已知派发前校验错误记为未执行，真正派发后的超时仍记为未知；继续交接前检查阻塞并引导模型给出实际可行答复。
- **SEC-001**: 不自动重放、确认或放宽未知操作；提供可定位的核实入口，历史校验误判仅在可信运行时错误和确定未派发条件下纠正并记录审计。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 修复运行时事实与活动同步。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/ai/sre_execution.go 分类可信派发前错误；internal/web/agent.go 校验处返回类型化错误；sre_coordination.go 预检未知阻塞。 | ✅ | 2026-10-16 |
| TASK-002 | sre_verification.go 与 sre_orchestrator.go 保留实际步骤、资源和复核摘要；multi_agent.go、engine.go、tools.go 同步专员活动。 | ✅ | 2026-10-16 |
| TASK-003 | SRERoleMessage.tsx、SREPlanCard.tsx、sreTranscript.ts 添加真实活动动效、耗时、Plan 对齐与未知操作定位入口，更新 contracts。依赖 TASK-001、TASK-002。 | ✅ | 2026-10-16 |

### Implementation Phase 2

- **GOAL-002**: 验证事实、动效与安全边界。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Go 测试校验未执行、真实超时、交接拒绝与验证员交付物；前端测试运行/结束/暂停/待确认、Plan 映射与核实定位，验证浅深色与窄窗口。依赖 TASK-003。 | ✅ | 2026-10-16 |
| TASK-005 | Go/race、前端类型与回归、签名 Dev 构建与安全重载；保存 docs/validation/lake-sre-live-state.json。依赖 TASK-004。 | ✅ | 2026-10-16 |

## 3. Alternatives

- **ALT-001**: 仅增加加载动画不能纠正错误事实，不采用。
- **ALT-002**: 把全部失败改为未执行会造成未知操作重放风险，不采用。

## 4. Dependencies

- **DEP-001**: 现有 AgentRun、仓库事件、StatusText 和操作核实 API。

## 5. Files

- **FILE-001**: internal/ai/sre_execution.go、sre_verification.go、sre_roles.go、sre_orchestrator.go、sre_coordination.go、multi_agent.go、engine.go、tools.go 与 internal/web/agent.go。
- **FILE-002**: web-agent/shared/contracts.ts、web-agent/web/src/SRERoleMessage.tsx、SREPlanCard.tsx、sreTranscript.ts、sreCollaboration.css 和对应测试。

## 6. Testing

- **TEST-001**: 参数校验未执行不产生未知阻塞；派发后超时保持未知；原始交付物和复核报告保留。
- **TEST-002**: 活动只展示当前运行专员，暂停/结束/等待确认和减少动态偏好保持诚实状态；核实入口对应真实操作。
- **TEST-003**: Go/race 与前端回归通过，Dev 数据和 release 隔离，未授权的生产任务不重放。

## 7. Risks & Assumptions

- **RISK-001**: 在途任务与命令可能阻止安全重载，须先检查真实状态，不以 UI 空闲替代终端状态。
- **ASSUMPTION-001**: 活动文案根据运行时阶段和实际工具类型产生，不显示推测进展或虚构百分比。

## 8. Related Specifications / Further Reading

[SRE 协作](../docs/sre-collaboration.md)；[UI 规范](../docs/ui-guidelines.md)。

验证结果：Go 全量与 AI/Web race、185 项前端测试及类型检查通过。签名 Dev 已安装重启，9 个会话快照健康。真实组件验证持续动效、计时、暂停/待确认状态、未知操作定位和核实表单；Mac 锁屏导致重载后的原生窗口目视检查不可用。没有重跑生产检查。
