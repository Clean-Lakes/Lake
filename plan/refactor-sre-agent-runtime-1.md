---
goal: 使四个 SRE 专员使用完整子智能体运行时并分离累计预算与上下文窗口
version: 1
date_created: 2026-10-16
last_updated: 2026-10-16
owner: Lake
status: Completed
tags: [sre, agents, runtime, bug]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

修复完整工具专员仍被旧调查预算、32 次工具配额、34 轮循环和固定报告截止时间截断的问题。验证员保留完整工具循环，固定验收采样只作为运行时验收依据。

## 1. Requirements & Constraints

- **REQ-001**: 实际专员继承父会话模型上下文、输出额度与循环上限；不使用旧调查子 Agent 的累计预算或工具调用配额。
- **REQ-002**: SRE 任务累计预算使用父会话 contextWindow × maxSteps；按实际用量结算，不扣除缓存占用；历史默认预算在用户继续任务时迁移，已用量不清零。
- **REQ-003**: 有固定验收探针和没有固定探针的验证员均可继续调用普通工具；自动验收只能使用本次固定采样的证据 ID，不接受额外工具或模型口头结论替代。
- **SEC-001**: 保留父权限实时交集、操作持久记录、未知结果禁止重放、资源边界、取消与单次请求超时。只出计划及报告格式修正阶段仍不执行资源操作。
- **CON-001**: 不操作正式版，不执行用户线上任务；仅在 Dev 空闲时加载签名构建。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 消除旧运行时限制并保留可验证的验收来源。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | agent_budget.go、sre_roles.go、engine.go、tools.go 分离 SRE 记账与旧子任务配额，继承父循环和模型配置。 | ✅ | 2026-10-16 |
| TASK-002 | sre_orchestrator.go、sre_types.go、sre_service.go 记录完整运行时预算策略并按继续动作迁移旧默认预算；证据索引展示实际任务预算。 | ✅ | 2026-10-16 |
| TASK-003 | sre_roles.go、sre_verification.go 保留验证员完整循环；单独返回并匹配固定采样证据 ID；无固定验收仍能自主复核。提供角色间任务事实交接。 | ✅ | 2026-10-16 |

### Implementation Phase 2

- **GOAL-002**: 以真实工具循环与高累计 token 用量验证修复。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 添加跨 64k 累计用量和 32 次工具调用的专员回归、父模型配置继承、验证员补充采样及验收来源隔离、预算迁移和取消回归。依赖 TASK-001–TASK-003。 | ✅ | 2026-10-16 |
| TASK-005 | 执行 Go 与 race 回归；更新 docs/sre-collaboration.md 和验证记录；签名安装 Dev 并在空闲后重启。依赖 TASK-004。 | ✅ | 2026-10-16 |

## 3. Alternatives

- **ALT-001**: 仅增大旧 64k 子任务上限仍将上下文与累计用量混用，拒绝采用。
- **ALT-002**: 取消所有边界会失去父循环、任务累计预算和权限约束，拒绝采用。

## 4. Dependencies

- **DEP-001**: 现有 Engine.ChatTurn、SRERepository 原子事务和真实证据文件。

## 5. Files

- **FILE-001**: internal/ai/agent_budget.go、sre_roles.go、sre_verification.go、sre_orchestrator.go、agent_evidence.go、engine.go、tools.go、sre_types.go。
- **FILE-002**: internal/web/sre_service.go、SRE 回归与 docs/sre-collaboration.md。

## 6. Testing

- **TEST-001**: 本地合成 provider 报告真实协议形状的累计用量，并通过普通工具执行临时文件与命令；不调用用户模型。
- **TEST-002**: go test ./... 与 go test -race ./internal/ai ./internal/web；验证已用量不重置、验收不能被补充证据升级、权限和取消生效。

## 7. Risks & Assumptions

- **RISK-001**: 完整循环可使用更多模型用量；预算按父会话最大循环请求额度计算并持久记录，继续任务不重置累计用量。
- **ASSUMPTION-001**: 父会话模型设置和执行权限是完整专员的共同基础，角色提示定义职责。

## 8. Related Specifications / Further Reading

[完整工具专员](refactor-sre-full-agents-1.md)；[SRE 协作](../docs/sre-collaboration.md)。
