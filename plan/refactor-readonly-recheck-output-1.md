---
goal: 修复独立只读复查的长回执读取和可恢复调用错误
version: 1
date_created: 2026-11-09
last_updated: 2026-11-09
owner: Lake
status: Completed
tags: [bug, runtime, security]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

真实 Dev 复查已取得只读回执，随后因 `systemd-detect-virt` 未识别及模型尝试本机 Python 读取 SDK 截断产物而失败。宿主应让模型修正错误参数，并直接分页读取本任务已经登记的回执。

## 1. Requirements & Constraints

- **REQ-001**: 仅将准确的 `systemd-detect-virt` 查询参数识别为只读。
- **REQ-002**: `read_tool_output` 根据准确调用 ID 读取当前 Worker、代次和子执行归属下的持久回执，不接收文件路径、不启动命令、不生成另一份业务证据。
- **SEC-001**: 逐次重验当前 Worker、策略、目标资源、回执哈希和来源权限；保留原 unknown、记忆依赖、绝对期限与验收。
- **SEC-002**: 原项目拒绝本机命令仍然拒绝。普通 Shell 参数或资源错误在工具校验阶段返回真实失败，不变成调用权限解析异常而结束整轮。
- **CON-001**: 仅改 Lake 宿主适配，继续使用 SDK 公开端口与原执行循环。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 修复失败路径及真实错误反馈。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 `web-agent/shared/command-policy.ts` 的 `commandPolicy` 校验虚拟化查询准确参数和系统路径。 | ✅ | 2026-11-09 |
| TASK-002 | 在 `runtime/typescript/superagent.ts` 增加当前回执分页工具，并在 `configureBash` 保留原生校验后执行宿主只读预检。 | ✅ | 2026-11-09 |
| TASK-003 | 在 `runtime/typescript/super-prompts.ts` 指导截断回执读取；`reportPresentation` 仅映射已知宿主错误，保留未知错误通用退路。 | ✅ | 2026-11-09 |

### Implementation Phase 2

- **GOAL-002**: 证明恢复能力及边界，并安装 Dev。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 增加命令正反例、回执归属/篡改/撤权测试及真实 SDK 调用失败后继续读取并完成的回归。依赖 TASK-001 至 TASK-003。 | ✅ | 2026-11-09 |
| TASK-005 | 运行源测试、打包后 SDK 测试、类型检查和 ADK 边界；保留真实原任务记录摘要并比较。依赖 TASK-004。 | ✅ | 2026-11-09 |
| TASK-006 | 签名构建安装 Lake Dev，记录准确 SHA 和本机验证；更新开放的 develop PR。依赖 TASK-005。 | ✅ | 2026-11-09 |

## 3. Alternatives

- **ALT-001**: 给远端任务放开本机执行或任意 Python 只读证明；这会改变原项目边界，不采用。
- **ALT-002**: 开放整个 SDK 产物目录；这会暴露其他任务或子执行产物，不采用。

## 4. Dependencies

- **DEP-001**: 原 TaskLedger Operation 的 `callId/output/outputHash` 和当前策略复验。
- **DEP-002**: SDK 公开 `ToolEntry.validateInput` 的可恢复工具失败结果。

## 5. Files

- **FILE-001**: `runtime/typescript/superagent.ts`、`super-prompts.ts` 与相关宿主/SDK 回归。
- **FILE-002**: `web-agent/shared/command-policy.ts` 与 `web-agent/web/test/command-policy.test.ts`。
- **FILE-003**: `docs/validation/typescript-candidate/readonly-recheck-output-2026-11-09.md`。

## 6. Testing

- **TEST-001**: 真实失败命令识别只读，未知参数、非系统路径、写入和动态脚本仍不识别只读。
- **TEST-002**: 当前任务可分页读取原回执；其他任务/代次/子执行、哈希变化及权限收窄均拒绝，且不新增证据。
- **TEST-003**: 真实 SDK 接收被拒本机 Bash 的失败，再读取远端长回执并提交；无本机执行、无多余审批、原未知记录不变。

## 7. Risks & Assumptions

- **RISK-001**: 模型仍可能选错工具；宿主错误应可恢复，不能保证任意模型均主动纠正。
- **ASSUMPTION-001**: 当前工具输出已经脱敏并由原 Operation 持久化；分页不读取模型提供的文件路径。

## 8. Related Specifications / Further Reading

- [架构约定](../agent.md)
- [独立只读复查](feature-memory-invalid-readonly-recheck-1.md)
- [任务确认](../docs/security/task-confirmation.md)
