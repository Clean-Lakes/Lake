---
goal: 删除 TypeScript 命令的历史待核实执行门禁
version: 1
date_created: 2026-11-09
last_updated: 2026-11-09
owner: Lake
status: In progress
tags: [runtime, refactor]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

用户要求命令不再因旧操作的待核实状态被阻断。本批删除相关执行检查，不通过补充只读白名单修补单条命令。

## 1. Requirements & Constraints

- **REQ-001**: 新的宿主 Bash 调用绕过任务/项目/旧 Go/共同成员的历史结果锁、历史目录围栏和跨调用参数去重。
- **REQ-002**: 显式步骤可创建新尝试，原未知操作和尝试不改为已核实或成功。
- **SEC-001**: 同调用 ID 不自动重放；资源、配置、当前权限、SSH 指纹、有效代次、停止和期限继续校验。
- **CON-001**: 不扩大 Plan 或明确只读范围；非命令适配器保留原合同，验收继续核对真实结果。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 删除命令派发的待核实依赖。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | `tasks.ts` 的 `operation/prepareHostOperation/start` 分离新命令执行与历史结果，删除无命令调用依赖的别名/目录围栏。 | ✅ | 2026-11-09 |
| TASK-002 | `superagent.ts/execution.ts` 删除 SSH 命令派发前历史冲突回调，保留实际认证对端记录和原 SSH 校验。 | ✅ | 2026-11-09 |
| TASK-003 | 更新提示词、`agent.md` 和任务确认说明，明确新语义及原记录保全。 | ✅ | 2026-11-09 |

### Implementation Phase 2

- **GOAL-002**: 证明命令可继续且原状态不被伪造。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 单测覆盖同任务、跨任务、共同任务、旧 Go 和原调用 ID；SDK/loopback SSH 覆盖分类为非只读的历史日志查询及实际非零/断线后继续。依赖 TASK-001 至 TASK-003。 | ✅ | 2026-11-09 |
| TASK-005 | 运行 runtime 类型/源码/SDK、共享命令策略及 ADK 边界；签名安装 Dev 并复测截图任务，比较原未知行哈希。依赖 TASK-004。 | | |
| TASK-006 | 更新验证记录和 develop PR；不自动合并或发布。依赖 TASK-005。 | | |

## 3. Alternatives

- **ALT-001**: 扩充 `last/ls/重定向` 只读白名单；无法消除之后其他命令遇到相同旧锁，未采用。
- **ALT-002**: 清空旧 unknown；会伪造执行结果，未采用。

## 4. Dependencies

- **DEP-001**: 当前 LakeExecution 权限/资源/SSH 验证及 TaskLedger 的独立操作 ID。

## 5. Files

- **FILE-001**: `runtime/typescript/tasks.ts`、`superagent.ts`、`execution.ts`、`super-prompts.ts` 及对应测试。
- **FILE-002**: `agent.md`、`docs/security/task-confirmation.md` 和 `docs/validation/typescript-candidate/command-pending-gates-2026-11-09.md`。

## 6. Testing

- **TEST-001**: 旧 unknown 保持哈希不变；新 Bash 可执行，不同调用 ID 的同参数可执行，同原调用 ID 不重发。
- **TEST-002**: 当前禁止/审批/停止/配置变更/Plan/明确只读范围仍拒绝或按设置询问；非命令原行为保留。
- **TEST-003**: 截图中包含 glob 和重定向的命令在 Dev 继续原任务，报告实际可覆盖的重启次数及数据范围。

## 7. Risks & Assumptions

- **RISK-001**: 新命令可能再次产生先前未知操作的实际效果；这是用户授权移除历史锁后的行为，当前权限/审批保持。
- **ASSUMPTION-001**: 仅宿主生成的 Bash/commandExecutionId 绑定走命令分支，模型不能把非命令工具伪装为该绑定。

## 8. Related Specifications / Further Reading

- [架构约定](../agent.md)
- [任务计划与验收](../docs/security/task-confirmation.md)
