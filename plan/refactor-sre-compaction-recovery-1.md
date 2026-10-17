---
goal: 修复 SRE 自动压缩中断并合并重复操作和错误展示
version: 1
date_created: 2026-10-16
last_updated: 2026-10-16
owner: Lake
status: Completed
tags: [sre, recovery, ui]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

针对已采集 18 项证据后因摘要未完成而失败的调查任务，增加仅限摘要请求的有界重试与安全预览回退，并减少重复记录展示。

## 1. Requirements & Constraints

- **REQ-001**: Responses API 的流式和完整响应都拒绝未完成输出；保留用量并区分输出额度耗尽。
- **REQ-002**: 摘要最多重试一次；自动压缩仍失败时，仅在保留原用户消息、调用身份且输入可安全缩减时继续。
- **REQ-003**: 成功操作合并折叠，异常与未知操作保留直接入口；同次失败在对话中只展示一次。
- **SEC-001**: 不重放工具、不提交部分摘要、不改变权限；取消和不可缩减的输入仍停止。手动压缩失败保持原历史。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成运行时恢复和精简呈现。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/ai/provider.go 分类未完成 Responses 并保留用量；engine.go 和 context_compaction.go 增加一次摘要重试和只缩减工具预览的自动回退。 | ✅ | 2026-10-16 |
| TASK-002 | web-agent/web/src/SRERoleMessage.tsx 折叠成功操作，aiErrors.ts 翻译错误，timeline.ts 按 attempt 完成时间去除重复错误。 | ✅ | 2026-10-16 |

### Implementation Phase 2

- **GOAL-002**: 验证恢复、边界与 Dev 安装。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | internal/ai/compaction_recovery_test.go 和 web-agent/web/test/sre-transcript.test.ts 覆盖摘要两次失败后继续、原始记录与调用身份保留、取消、错误去重和操作折叠。依赖 TASK-001、TASK-002。 | ✅ | 2026-10-16 |
| TASK-004 | 执行 Go 全量与 race、前端测试及类型检查；签名安装 Dev；记录 docs/validation/lake-sre-compaction-recovery.json 与截图。依赖 TASK-003。 | ✅ | 2026-10-16 |

## 3. Alternatives

- **ALT-001**: 直接忽略压缩错误并发送超额上下文会再次失败，不采用。
- **ALT-002**: 接受部分模型摘要可能丢失约束与证据，不采用。

## 4. Dependencies

- **DEP-001**: 现有工具预览、完整原始操作记录与 SRE attempt 归属。

## 5. Files

- **FILE-001**: internal/ai/provider.go、engine.go、context_compaction.go、compaction_recovery_test.go。
- **FILE-002**: web-agent/web/src/SRERoleMessage.tsx、sreCollaboration.css、timeline.ts、aiErrors.ts 与 sre-transcript.test.ts。

## 6. Testing

- **TEST-001**: Go 全量、AI/Web race、前端类型检查与全部前端测试通过。
- **TEST-002**: 自动摘要连续失败后可继续下一轮模型分析；不接受部分摘要、不执行历史调用；手动失败和取消保留原状态。

## 7. Risks & Assumptions

- **RISK-001**: 预览可能省略工具输出，因此标记未知、保留原文及证据引用，不能以省略内容推断成功。
- **ASSUMPTION-001**: 任务原始权限和操作事实由运行时持有，不依赖模型摘要提供授权。

## 8. Related Specifications / Further Reading

[SRE 协作](../docs/sre-collaboration.md)；[完整子智能体运行时](refactor-sre-agent-runtime-1.md)。
