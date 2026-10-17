---
goal: 改善 SRE 专员报告的文字层级、证据入口与 Markdown 排版
version: 1
date_created: 2026-10-16
last_updated: 2026-10-16
owner: Lake
status: Completed
tags: [sre, ui, typography]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

直接呈现已记录的调查报告结构，并使其他专员消息支持 Markdown。保持无外框的对话样式和小尺寸湖生态头像。

## 1. Requirements & Constraints

- **REQ-001**: 调查结论、观察事实、待验证假设、尚未确认与后续检查分别呈现；空分组隐藏。
- **REQ-002**: 证据编号匹配当前 attempt 的实际记录，点击展开相应原文，不重新执行资源操作。
- **SEC-001**: 不改变报告内容或验收状态；Markdown 禁止原始 HTML，不显示内部证据 ID。
- **CON-001**: 沿用主题变量、Glyph 和现有头像；不增加重色背景或大卡片。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成结构化报告和消息排版。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 web-agent/shared/contracts.ts 添加 SRERoleReport，在 web-agent/web/src/SREReport.tsx 实现原始结构呈现和安全 Markdown。 | ✅ | 2026-10-16 |
| TASK-002 | 在 web-agent/web/src/SRERoleMessage.tsx 仅为 finding 使用 report，并实现当前消息的证据定位；在 sreCollaboration.css 添加限宽、段落、分组、代码和深色主题样式。依赖 TASK-001。 | ✅ | 2026-10-16 |

### Implementation Phase 2

- **GOAL-002**: 验证桌面、窄屏、深色与证据交互，安装 Dev。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 扩展 web-agent/web/test/sre-transcript.test.ts，验证字段、证据映射、Markdown 安全和错误/进度不显示旧报告；运行前端测试和类型检查。依赖 TASK-002。 | ✅ | 2026-10-16 |
| TASK-004 | 使用隔离合成数据截图验证浅色、深色、窄窗口及证据定位；签名构建安装 Lake Dev，记录 docs/validation/lake-sre-report-typography.json。依赖 TASK-003。 | ✅ | 2026-10-16 |

## 3. Alternatives

- **ALT-001**: 只增加纯文本行距无法区分事实与假设，不采用。

## 4. Dependencies

- **DEP-001**: 后端已有 attempt.report；沿用 react-markdown、remark-gfm 和证据只读分页 API。

## 5. Files

- **FILE-001**: web-agent/shared/contracts.ts、web-agent/web/src/SREReport.tsx、SRERoleMessage.tsx、sreCollaboration.css。
- **FILE-002**: web-agent/web/test/sre-transcript.test.ts、fixtures/sre-report.ts 与验证记录。

## 6. Testing

- **TEST-001**: pnpm --dir web-agent check 与 pnpm --dir web-agent test:frontend 全部通过。
- **TEST-002**: 合成消息的所有非空分组可见；证据点击只展开相应记录；窄窗口无页面水平溢出；深色使用主题色。

## 7. Risks & Assumptions

- **RISK-001**: 历史消息可能没有 report 字段，须保留正文 Markdown 回退。
- **ASSUMPTION-001**: report 是后端持久保存的事实来源，不通过前端文本猜测事实分类。

## 8. Related Specifications / Further Reading

[UI 规范](../docs/ui-guidelines.md)；[SRE 协作](../docs/sre-collaboration.md)。
