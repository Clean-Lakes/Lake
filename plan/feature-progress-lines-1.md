---
goal: Lake 聊天中显示实际工具活动和上下文压缩进度
version: 1
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: Completed
tags: [feature, desktop, web, progress]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

用紧凑进度行展示真实工具活动，保留运行状态、完成记录和可展开详情。桌面实时桥和 Web 历史事件使用同一转换规则。

## 1. Requirements & Constraints

- **REQ-001**: 文件读取、搜索、命令处理、资源查询、报告展示和上下文压缩按实际事件顺序插入聊天。
- **REQ-002**: 同一工具调用的开始与结束更新同一记录；相邻已完成的读取、搜索、命令记录可汇总，模型说明分隔活动。
- **REQ-003**: 失败、取消和未知状态必须保留；重开已结束会话不能出现永久转圈。
- **SEC-001**: 只提取明确允许的参数字段，使用 store.ExecutionPreview 脱敏并限制长度，不显示任意工具参数或文件正文。
- **CON-001**: 保持 Go/Eino 单运行时，不修改执行权限或重新运行已有远端任务。macOS 通过 scripts/build_lake_desktop.sh 构建签名应用。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完整传递实际工具活动和压缩事件。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 新增 cmd/lake/activity.go，提取脱敏摘要并判断工具返回失败、未知和正常完成；cmd/lake/chat.go 将实际结果状态传给 OnToolFinished，并输出所有主 Agent 的工具前说明。 | ✅ | 2026-10-01 |
| TASK-002 | cmd/lake/bridge.go 添加 activity 事件，携带保存后的 ConversationEvent；工具开始、结束、压缩实时发送，整轮结束将未完成调用标为 unknown。依赖 TASK-001。 | ✅ | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 桌面和 Web 共享紧凑进度展示及回看。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 新增前端 activity.ts 与 shared/ActivityLine.tsx/CSS；timeline.ts 恢复结构化活动；App.tsx 实时更新并在终态关闭活动。依赖 TASK-002。 | ✅ | 2026-10-01 |
| TASK-004 | 添加事件状态、顺序、归组、失败及脱敏回归；构建桌面/Web，签名安装，在实际窗口验证进度和展开。依赖 TASK-003。 | ✅ | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 让模型自由编写进度文本不能保证操作真实完成，使用工具和压缩事件确定状态。
- **ALT-002**: 只更新底部加载卡片会丢失中间操作，使用聊天中保留的进度行。

## 4. Dependencies

- **DEP-001**: 现有 conversation_event 表的 tool_proposed、tool_finished、summary_created 类型，以及允许的 preview、target、duration_ms 字段。
- **DEP-002**: 现有 React、Lucide 和 ConversationMessages 共享组件，无新增运行时依赖。

## 5. Files

- **FILE-001**: cmd/lake/activity.go、activity_test.go、chat.go、bridge.go、bridge_test.go。
- **FILE-002**: client/desktop/frontend/src/activity.ts、activity.test.mjs、timeline.ts、timeline.test.mjs、App.tsx、App.css、shared/ActivityLine.tsx、shared/ActivityLine.css、shared/ConversationMessages.tsx、package.json。
- **FILE-003**: client/desktop/README.md 和本计划。

## 6. Testing

- **TEST-001**: Go 验证活动摘要脱敏、错误和未知状态、桥实时事件与持久事件一致；现有压缩测试验证实时通知。
- **TEST-002**: 前端验证调用关联、跨轮 ID 隔离、相邻活动归组、完成后未知状态、说明与活动顺序以及历史回看。
- **TEST-003**: 桌面及 Web 生产构建通过；签名应用实际窗口显示灰阶进度行，详情可展开。
- **TEST-004**: 2026-10-01 实际 Lake 会话调用 lake_overview 和 lake_resources；两段模型说明与两条完成活动按顺序显示，详情展示工具名和耗时，切换后重开保留记录。Go cmd/lake 和 lake/... 测试、go vet、前端 21 项测试及桌面/Web 构建通过。

验证记录：`~/Library/Application Support/Lake/test-reports/progress-lines-20261001/verification.json`，同目录保存运行中预览、完成预览及实际窗口截图。

## 7. Risks & Assumptions

- **RISK-001**: 工具正常返回仍可能包含业务错误，检查输出的 error、unknown、exit_code 和任务状态以免错误标记成功。
- **ASSUMPTION-001**: 工具调用 ID 在同一轮唯一，跨轮用用户事件范围隔离；已有专员和 MCP 专用卡片继续使用其展示路径。

## 8. Related Specifications / Further Reading

[Lake 设计](../docs/lake-design.md)
[桌面说明](../client/desktop/README.md)
