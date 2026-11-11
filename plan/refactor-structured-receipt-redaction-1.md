---
goal: 防止结构化脱敏破坏执行回执并保证异常收尾
version: 1
date_created: 2026-11-11
last_updated: 2026-11-11
owner: Codex
status: In progress
tags: [backend, security, receipts, bug]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

用户指出实际报告以“完成结果的提交校验仍失败”结尾。只读审计发现真实 Bash 回执报 JSON 解析错误：整段 JSON 文本脱敏误替换了数值字段的一部分。finish 在解析失败后没有结束命令的内部 promise，留下 running 命令并阻碍退出。本轮修复共享回执和清理链路，不重跑用户服务器或改写旧结果。

## 1. Requirements & Constraints

- **REQ-001**: 复用 runtime/typescript/model-errors.ts 的 redactModelValue，按字符串字段脱敏，保留数值、布尔、键及 Date，不在 JSON 序列化文本中替换后重新解析。
- **REQ-002**: execution.ts 的结果及进展事件、superagent 工具账本、Agent 展示、MCP、数据库及宿主核实输入沿同一结构化规则处理；保留原脱敏器及原权限检查。
- **REQ-003**: 命令回执处理异常时结束本次 promise 与 waiters，清理 lives/timer，持久记录 unknown；不得伪造成功、重派或无限等待清理。
- **SEC-001**: 不打印或保存原密钥，测试使用虚构短数字及特殊字符，仍验证正文和错误秘密被遮蔽；数字碰巧包含相同字节不意味着它是认证数据。
- **SEC-002**: 原 Task、unknown、权限、记忆、幂等和验收保持；不清除失败、不回灌备份，不重新执行截图任务。
- **CON-001**: 保留本机模型和 max；复用当前 develop 草稿 PR；仅签名安装 Dev，生产不变。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 修复结构化回执与异常生命周期。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | execution.ts、superagent.ts、agent.ts、extensions.ts、mysql.ts、server.ts 替换不安全的整段 JSON 脱敏；使用既有 redactModelValue。 | Yes | 2026-11-11 |
| TASK-002 | execution.ts 为回执处理失败提供一次性拒绝及 lives/timer/waiters 清理；阻止外层 catch 再次提交同一失败收尾。 | Yes | 2026-11-11 |
| TASK-003 | model-errors.test.ts、execution-dispatch.test.ts 回归数字碰撞、转义秘密、Date、真实宿主账本完成与脱敏器异常清理；运行隔离宿主与固定 Codex 集成。依赖 TASK-001、TASK-002。 | Yes | 2026-11-11 |

### Implementation Phase 2

- **GOAL-002**: 安装验证并记录边界。依赖 GOAL-001。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 运行后端类型、全部单元、宿主、固定 Codex、运行时边界与命名检查；记录真实失败证据的匿名原因及测试准确结果。 | | |
| TASK-005 | 干净提交后通过 scripts/build_lake_desktop.sh --dev --install 安装，核对签名、来源、既有账本与本机 Codex 配置；不发送业务任务。依赖 TASK-004。 | | |
| TASK-006 | 更新 agent.md、运行说明、验证记录及原 develop 草稿 PR，保留未合并及历史状态不追溯改写的限制。依赖 TASK-005。 | | |

## 3. Alternatives

- **ALT-001**: 只修改提交错误文案：不能修复真实回执解析和内部 promise 悬挂。
- **ALT-002**: 忽略旧 unknown 并直接验收：会冒充原操作成功，不采用。
- **ALT-003**: 不再屏蔽短数字凭据：可能泄露实际字符串秘密，保留正文脱敏，修复结构化处理。

## 4. Dependencies

- **DEP-001**: 已有 redactModelValue 的非变异、Date、Error 与原型安全行为。
- **DEP-002**: 原 ExecutionPort、TaskLedger 及隔离 SSH 传输夹具，无真实认证或外部 I/O。

## 5. Files

- **FILE-001**: runtime/typescript/execution.ts、superagent.ts、agent.ts、extensions.ts、mysql.ts、server.ts、model-errors.ts。
- **FILE-002**: runtime/typescript/model-errors.test.ts、execution-dispatch.test.ts；必要的 server/ACP 集成夹具。
- **FILE-003**: agent.md、runtime/typescript/README.md、docs/validation/acp-agent-execution/。

## 6. Testing

- **TEST-001**: 数字凭据匹配耗时/计数的一部分不破坏 JSON 或数值，字符串中的凭据仍脱敏，日期与布尔保持有效。
- **TEST-002**: 经真实 ExecutionPort 和 TaskLedger 的夹具只执行一次，成功回执可正常 work_finish，不留下活动命令或清理挂起。
- **TEST-003**: 故意抛错的脱敏器使回执保留 unknown，promise/waiters/close 均可终结；不报告成功，不重新派发。
- **TEST-004**: 固定 Codex 工具链与原有权限/恢复/账本回归继续通过，本机配置及旧业务记录不改写。

## 7. Risks & Assumptions

- **RISK-001**: 结构化函数保留固定 schema 的键；脱敏只处理字符串值，不把数字元数据变成文本。
- **RISK-002**: 历史报告和真正 unknown 不因修复而变成已完成；本轮不验证实际集群状态或真实模型耗时。
- **ASSUMPTION-001**: 已有工作分支仍基于 current origin/develop；PR 合并和生产操作未获授权。

## 8. Related Specifications / Further Reading

- [任务验收](../docs/security/task-confirmation.md)
- [三模块与任务职责](../agent.md)
- [之前仅改流程的验证](../docs/validation/acp-agent-execution/specialist-read-latency.md)
