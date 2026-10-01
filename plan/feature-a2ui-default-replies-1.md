---
goal: 所有 Lake AI 回复默认自动生成合适的 A2UI 展示
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [feature, a2ui, ui]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

所有 AI 正文使用官方 A2UI 渲染器。模型可生成复杂数据与交互布局；未调用 UI 工具的回复和历史文字通过 Markdown AST 自动映射为卡片、清单、表格、图表和代码块，无需额外模型请求。

## 1. Requirements & Constraints

- **REQ-001**: 桌面与只读 Web 的普通问答、解释、步骤、代码、数据和历史 AI 回复默认自动展示。
- **REQ-002**: 根据实际 AST 选择结构；百分比清单可生成图表与明细标签页，普通文字保持紧凑。
- **REQ-003**: 保留原始正文、全部数据、代码及复制和填入命令框功能；重复渲染保持稳定 ID。
- **SEC-001**: 新组件仅展示数据，Markdown 不执行 HTML、不自动请求图片；代码不自动执行。
- **CON-001**: 继续支持已有动态面板和报告；自动正文不占后端交互面板数量，不增加模型请求。
- **CON-002**: 使用现有签名构建脚本，验证完成后只保留一个应用构建。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 扩充受限目录和可验证的自动布局转换。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 lake/agent/a2ui.go、cmd/lake/a2ui.go 与前端 a2ui.ts 扩充 Markdown、Code、List、Table.headers、Chart.max/unit；校验绑定数据与字段。 | Yes | 2026-10-01 |
| TASK-002 | 在 client/desktop/frontend/src/automaticReply.ts 使用 unified/remark-parse/remark-gfm 的 AST 生成有界快照：分组标题、清单、代码、表格、明确百分比图表，保留长内容并分片。依赖 TASK-001。 | Yes | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 所有入口默认展示并完成签名交付。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 在 shared/A2UISurface.tsx 注册新组件，支持代码复制和安全 Markdown；在 shared/ConversationMessages.tsx 将所有 assistant 正文默认交给 A2UI，精简纯文字和静态面板的样式。依赖 TASK-001、TASK-002。 | Yes | 2026-10-01 |
| TASK-004 | 更新模型提示和 README；测试新目录、AST 保真、重复渲染、历史会话、桌面与 Web、代码填入和窄屏；构建 Web 嵌入资源及签名桌面应用。依赖 TASK-003。 | Yes | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 仅要求模型调用 UI 工具；无法覆盖漏调用、快捷查询和旧会话，不采用。
- **ALT-002**: 每次追加一次模型调用重写界面；增加等待和事实漂移风险，不采用。

## 4. Dependencies

- **DEP-001**: 当前官方 @a2ui/react 与 @a2ui/web_core 0.12.0。
- **DEP-002**: 现有 react-markdown、remark-gfm 以及相同版本的 unified、remark-parse。

## 5. Files

- **FILE-001**: lake/agent/a2ui.go、cmd/lake/a2ui.go、chat.go：目录和提示。
- **FILE-002**: frontend/src/automaticReply.ts、a2ui.ts、shared/A2UISurface.tsx/.css、shared/ConversationMessages.tsx：自动映射与展示。
- **FILE-003**: frontend/package.json、package-lock.json、automaticReply.test.mjs、README.md：依赖、测试与使用说明。

## 6. Testing

- **TEST-001**: AST 转换完整保留文字、链接、代码、表格及长正文；不从模糊数字臆造图表；生成快照通过校验。
- **TEST-002**: Go 目录拒绝无效绑定和字段；原有操作范围及恢复测试继续通过。
- **TEST-003**: 浏览器验证普通回复、百分比图表与明细、步骤、代码复制/填入、旧会话、只读 Web、原有面板和窄屏。
- **TEST-004**: 前端与 Go 编译测试、签名和构建数量验证通过。

验证记录：32 项桌面前端测试、2 项 Web 事件测试、Go agent/store/CLI race 与桌面 Go race、相关 go vet 通过。转换器生成的共享 fixture 由 TypeScript 与 Go 同时校验。Playwright 验证历史与实时普通回复、正确量程的百分比图表、清单与表格筛选、代码复制/仅填入、无工具调用时的默认 UI、窄屏、HTML 文字展示与无远程媒体请求；原有动态端口与表单面板、只读 Web 实时更新继续通过。全部检查使用示例数据，未查询真实主机。

## 7. Risks & Assumptions

- **RISK-001**: 复杂 Markdown 不适合拆解；保留完整安全 Markdown 展示，避免丢失引用关系。
- **RISK-002**: 很长正文超过单面板限制；按完整块和有界文本分片，不截断内容。
- **ASSUMPTION-001**: 文字是现有会话保存的权威正文，自动 UI 是可重新构建的视图；现有交互面板仍保存结构化快照。

## 8. Related Specifications / Further Reading

[已接入的 A2UI](feature-a2ui-conversation-1.md)
[A2UI Quickstart](https://a2ui.org/quickstart/)
[Lake 构建约束](../AGENTS.md)
