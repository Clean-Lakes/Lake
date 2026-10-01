---
goal: 减少 A2UI 生成格式失败并修复面板与聊天正文的尺寸和对齐
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [bug, a2ui, ui]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

当前记录显示一次 lake_ui 失败后重试成功，但错误行仍显著显示；UI 行 width:100% 覆盖正文 820px 列宽，造成面板左移和过大。提供简单组件输入，保留协议兼容及验证，将调整过程合并为准确的最终展示状态，并统一面板尺寸。

## 1. Requirements & Constraints

- **REQ-001**: lake_ui 接受 surfaceId/components/data，由程序生成官方 A2UI 消息；继续支持原 messages，但禁止两种输入混用。
- **REQ-002**: 新面板自动创建、已有面板自动更新；所有结果继续通过现有 schema、目录、作用域及数据校验，不绕过端口面板保护。
- **REQ-003**: 展示格式拒绝使用独立错误代码记录；同轮相邻 UI 尝试汇总显示最终状态，失败原记录仍可展开，操作错误继续显示失败。
- **REQ-004**: UI 面板与聊天正文使用相同列宽、左右位置；指标与卡片紧凑，长文本不溢出，静态结果清单默认可展开。
- **SEC-001**: 不保存原工具输入或错误中的任意值，不读取或输出模型/SSH 凭据。
- **CON-001**: 不改用户已有数据；历史面板直接应用新样式；签名构建、安装并只保留一个构建。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 简化生成接口与重试状态。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 cmd/lake/a2ui.go 为 uiToolInput 增加 surfaceId/components/data；使用 UISession.Get 决定创建或更新；兼容 messages；更新模型示例。 | Yes | 2026-10-01 |
| TASK-002 | 在 cmd/lake/chat.go、bridge.go、activity.go 记录安全的展示错误代码；在前端 activity.ts、ActivityLine.tsx、ConversationMessages.tsx 聚合同轮相邻展示尝试并保留展开详情。 | Yes | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 修复视图尺寸并交付验证版。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 在 shared/A2UISurface.css 将 message-row.ui 恢复 820px 对齐；缩小卡片、标题和指标；在 A2UISurface.tsx 将长指标紧凑显示及静态 Table 清单折叠。 | Yes | 2026-10-01 |
| TASK-004 | 添加接口、重试分组与历史/实时浏览器回归；回放已保存面板验证对齐和无溢出；构建 Web 资源，签名安装桌面应用。依赖 TASK-001、TASK-002、TASK-003。 | Yes | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 仅隐藏失败行；不修复格式输入且丢失过程，不采用。
- **ALT-002**: 删除校验以接受任意模型输出；破坏安全目录，不采用。

## 4. Dependencies

- **DEP-001**: 现有 A2UI v0.9.1/v0.9 处理器、受限组件目录和会话快照。
- **DEP-002**: 现有聊天事件时间线和每轮最多两次格式失败的预算。

## 5. Files

- **FILE-001**: cmd/lake/a2ui.go、chat.go、bridge.go、activity.go、lake/store/agent_event.go 及相关测试。
- **FILE-002**: frontend/src/activity.ts、shared/ActivityLine.tsx/.css、ConversationMessages.tsx、A2UISurface.tsx/.css 及回归测试。
- **FILE-003**: README.md 与本计划。

## 6. Testing

- **TEST-001**: 简单输入首次展示与同面板更新成功；原 messages 正常；混合输入、未知组件、动作和端口面板覆盖仍拒绝。
- **TEST-002**: 重试成功汇总为已展示，只有格式拒绝仍保留待修正状态；跨轮、操作失败和不同工具不能错误合并。
- **TEST-003**: 浏览器回放已保存面板，UI 与正文左右位置/宽度一致；长指标、清单展开、交互面板及窄屏正常。
- **TEST-004**: Go race、前端测试/build、Web build、签名与当前安装验证通过。

## 7. Risks & Assumptions

- **RISK-001**: 模型仍可能提供无效组件；现有校验和有界自动正文展示继续处理。
- **ASSUMPTION-001**: 旧记录未保存第一次无效参数，不能精确恢复具体拒绝字段；不猜测或改写历史审计。

## 8. Related Specifications / Further Reading

[重试预算](refactor-presentation-retries-1.md)
[默认回复界面](feature-a2ui-default-replies-1.md)
[构建规则](../AGENTS.md)

## Verification Results

- `go test -race ./lake/agent ./lake/store ./cmd/lake`、桌面模块 `go test -race ./...` 及 Go vet 通过。
- 桌面前端 34 项测试、Web 2 项测试及两个生产资源 build 通过。
- 浏览器回放已保存的 CPU/磁盘面板：1440px 视口正文、UI 和活动均为 x=420px、width=820px；680px 视口均为 x=222px、width=436px。指标字号分别 22/22/16/16px，无页面或指标溢出。原始组件和数据未改，完整 7 条明细可展开和搜索。
- 历史无错误类别的失败+成功尝试、实时 invalid_ui+重试、正文自动展示、代码复制/填入和只读 Web 回归通过；没有模型调用或远端执行。
- 通过 scripts/build_lake_desktop.sh --install 构建并安装。当前唯一构建为 Lake-20261001-174412-31426.app；安装位置 /Users/lingyunxieqing/Applications/Lake.app。主程序与内嵌 CLI 严格签名验证通过，安装/构建/CLI 的对应 CDHash 一致。
- 截图：/Users/lingyunxieqing/.codex/visualizations/2026/10/01/01a0f56d-49ee-7c22-9f04-58470bd48b44/lake-a2ui-aligned-result.png。

## Follow-up: Shared Message Alignment

确认卡片仍有独立 width:100%，终端记录也撑满消息区，旧报告使用 900px。移除这些外层宽度覆盖，包括 A2UI 的重复列宽声明；所有 message-row 统一由 App.css 的正文列宽决定。进度和审批也使用同一宽度变量。问题卡片内部保持填满所在列，并允许长词换行。

浏览器以已保存的确认问题和回答回放，并检查待回答、已回答、已中断状态。正文、问题、终端、旧报告、A2UI 的左右边缘全部一致：1440px 视口 x=420、width=820、right=1240；680px 视口 x=222、width=436、right=658；没有横向溢出。桌面与 Web 生产资源构建通过。截图：lake-question-aligned.png。

本次后续样式修复已签名安装，唯一构建为 Lake-20261001-175934-32766.app；安装/构建代码与 CLI 的对应签名 CDHash 均匹配。确认当前运行结束后重启已安装应用以应用样式。
