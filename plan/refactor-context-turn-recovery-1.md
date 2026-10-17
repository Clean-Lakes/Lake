---
goal: 修复首轮工具上下文溢出并保持用户回复语言
version: 1
date_created: 2026-10-13
last_updated: 2026-10-13
status: Completed
tags: [bug, context, language]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

首轮多批次工具结果可形成压缩边界，避免只能压缩上一轮的问题。明确用户语言控制进度与最终回复。

## 1. Requirements & Constraints

- **REQ-001**: 保留当前用户原文、最新完整调用批次和工具调用 ID；压缩只发生在完整批次之间。
- **REQ-002**: 超大结果使用带截断标记的模型上下文预览，原始 UI 操作记录保留；不重放命令。
- **REQ-003**: 工具、元数据和英文历史不改变中文用户的回复语言；显式语言要求优先。
- **SEC-001**: 摘要和工具输出为不可信数据；压缩失败不改变历史；不输出凭据，不推送。
- **CON-001**: 模型自主决定调查步骤和子 Agent；仅空闲时重启本地调试服务。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 实现安全的首轮压缩和语言提示。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/ai/engine.go compact 支持同一轮完整批次边界；context_compaction.go 提供预算内预览。 | ✅ | 2026-10-13 |
| TASK-002 | prompts/user-language-policy.txt 明确进度和最终答案语言；engine.go 维持原始用户文本标记。 | ✅ | 2026-10-13 |
| TASK-003 | web-agent/web/src/aiErrors.ts 将预算失败本地化并说明历史保留。 | ✅ | 2026-10-13 |

### Implementation Phase 2

- **GOAL-002**: 回归首轮溢出与失败保留行为。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | context_compaction_test.go 验证多批次、超大单批次、调用关联、摘要失败、原记录与语言提示；复现用户失败会话的数据规模。依赖 TASK-001–TASK-003。 | ✅ | 2026-10-13 |
| TASK-005 | AI race 回归、前端检查、签名构建；空闲时更新 4180 调试服务。依赖 TASK-004。 | ✅ | 2026-10-13 |

## 3. Alternatives

- **ALT-001**: 单纯增大默认预算不能解决超过窗口或首轮无法压缩问题，保留现有用户预算。
- **ALT-002**: 固定强制委派违背模型自主调度要求，不采用。

## 4. Dependencies

- **DEP-001**: 现有 compaction-summary.txt 摘要调用与 validHistory 协议验证。

## 5. Files

- **FILE-001**: internal/ai/engine.go、context_compaction.go、context_compaction_test.go、prompts/user-language-policy.txt。
- **FILE-002**: web-agent/web/src/aiErrors.ts。

## 6. Testing

- **TEST-001**: go test -race ./internal/ai；前端类型检查与现有测试。
- **TEST-002**: 用户失败会话离线重放，只调用测试模型，不访问生产节点。

## 7. Risks & Assumptions

- **RISK-001**: 摘要可能遗漏事实，保留最新批次和原始 UI 记录，标明摘要不可信。
- **ASSUMPTION-001**: 模型可忽略语言提示；验证真实模型的中文进度响应，不声称绝对保证。

## 8. Related Specifications / Further Reading

[自主调度](refactor-model-agent-dispatch-1.md)
