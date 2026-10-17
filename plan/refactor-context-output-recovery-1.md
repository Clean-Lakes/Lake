---
goal: 恢复长会话的摘要预算匹配和单次输出截断
version: 1
date_created: 2026-10-13
last_updated: 2026-10-13
status: Completed
tags: [refactor, context, recovery]
---
# Introduction

![Status: In progress](https://img.shields.io/badge/status-Completed-green)

修复摘要外层 JSON 转义后的预算匹配；输出截断最多重试一次，保留已完成取证；上下文进度按实际会话输入预算显示。

## 1. Requirements & Constraints

- **REQ-001**: fitSummaryInput 在可序列化预算上限和不可压缩历史下限之间搜索，保留用户原文及工具调用配对。
- **REQ-002**: 截断响应不进入 History、不执行工具；同轮最多自动重试一次，不增加配置 token 上限，不更改明确设置的思考级别。
- **REQ-003**: 自动思考允许在恢复时暂用最低正向级别；记录恢复提示，保留原配置、完成的操作和失败请求用量。
- **REQ-004**: 进度环按会话输入预算显示，详情区同时列总预算、输出预留和模型支持窗口；失败信息中文显示。
- **SEC-001**: 不读取 Keychain，不输出模型密钥/私钥；不对真实主机执行命令、不修改生产会话历史、不推送。

## 2. Implementation Steps

- **REQ-005**: 回复计时在首次模型数据之前已有旋转/扫光动效，等待确认与结束后静止；主/终端聊天框图片粘贴保留预览，普通文字原样粘贴，图片上限沿用校验。

### Implementation Phase 1

- **GOAL-001**: 修正预算匹配、截断恢复及界面说明。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/ai/context_compaction.go fitSummaryInput 双向有界搜索，context_compaction_test.go 覆盖原来的跳过有效区间。 | Yes | 2026-10-13 |
| TASK-002 | engine.go/output_recovery.go/provider.go 截断丢弃、同历史重试、显式思考保留、用量记录；output_recovery_test.go 验证无工具重放及失败有界。 | Yes | 2026-10-13 |
| TASK-003 | context.go、contracts.ts、ContextUsage.tsx 输入预算进度与模型能力分开说明，aiErrors.ts 中文提示及 frontend 回归。 | Yes | 2026-10-13 |
| TASK-004 | Go race/前端/签名构建；更新 4180 调试版，生成本地 arm64 客户端包供安装版升级。依赖 TASK-001～TASK-003。 | Yes | 2026-10-13 |

| TASK-005 | imageAttachments.ts、App.tsx、TerminalAI.tsx 剪贴板位图捕获及预览；ReplyDuration.tsx/styles.css 首段响应前的动效；前端 88 项回归及真实 ⌘V 验证。 | Yes | 2026-10-13 |

## 3. Alternatives

- **ALT-001**: 不自动删除旧会话或清空上下文；原始消息和操作证据保留。
- **ALT-002**: 不无限重试或擅自增加 token 费用上限；恢复失败明确提示用户。

## 4. Dependencies

- **DEP-001**: 现有 fitToolContext、供应商 finish reason、思考能力白名单、私有状态文件和签名构建脚本。

## 5. Files

- **FILE-001**: internal/ai/context_compaction.go、engine.go、output_recovery.go、provider.go、context.go 与相关测试。
- **FILE-002**: web-agent/shared/contracts.ts、web-agent/web/src/ContextUsage.tsx、aiErrors.ts 和 frontend 测试。

## 6. Testing

- **TEST-001**: 合成转义输出复现有效区间，完成历史与截断工具不混入重试，重试保持上限与显式思考设置。
- **TEST-002**: 生产历史只读统计、Go race、前端回归、CLI/APP 签名与 arm64 安装包摘要验证。

## 7. Risks & Assumptions

- **RISK-001**: 模型仍可再次触及上限，限定一次恢复后保留可继续的历史并显示原因。
- **ASSUMPTION-001**: 修复本地代码与调试版；运行中的已安装客户端保持现有连接，需使用新本地包才能加载修复。

## 8. Related Specifications / Further Reading

[上下文预算](feature-context-meter-1.md)
[会话恢复](refactor-context-turn-recovery-1.md)
