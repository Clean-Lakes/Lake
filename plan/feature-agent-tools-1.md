---
goal: 补齐 Lake Agent 的任务、问答、历史、技能、工作流和调度工具
version: 1
date_created: 2026-10-14
last_updated: 2026-10-14
owner: Lake
status: Completed
tags: [feature, tools]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

在 Go 后端实现对照 ZCode 后确认的工具缺口。浏览器、JS runtime 和通用动态工作流不属于本次范围。

## 1. Requirements & Constraints

- **REQ-001**: 新增 todo_read/write、ask_user_question、read_session_context、load_skill、list_workflows/get_workflow_run/run_workflow/save_workflow、schedule_create/list/update/delete、task_output/stop、read_tool_result。
- **REQ-002**: read 支持行分页、图片和 PDF 文本；grep/glob 支持筛选、上下文、分页；文件编辑支持 expected_hash；大工具结果持久化并可分页。
- **SEC-001**: 工具结果脱敏，禁止读取凭据，历史和工作流严格限当前项目，技能仅允许配置目录内 SKILL.md；问答回复不能授予操作权限。
- **CON-001**: 用户-facing bin/lake 必须通过 scripts/build_lake.sh 签名构建；不覆盖已有终端改动。
- **PAT-001**: 状态归属后端，问答显示复用 React 会话面板，新增文件按单一职责拆分。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 可恢复的任务、问答和工具注册。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/ai 增加工具 schema、Todo 和 Question；Engine.Handle 提供 questionReply，取消和重启清除等待态。 | ✅ | 2026-10-14 |
| TASK-002 | web-agent/shared/contracts.ts 与 web/src/AgentQuestion.tsx 增加可键盘操作的选项和自由输入；工具动作显示中文。 | ✅ | 2026-10-14 |

### Implementation Phase 2

- **GOAL-002**: 安全执行和持久化，依赖 TASK-001。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | internal/web/tool_bridge.go 提供项目历史和工作流工具；技能由 internal/ai/skills.go 读取受限路径。 | ✅ | 2026-10-14 |
| TASK-004 | internal/web/schedules.go 原子持久化 RFC3339 时间和最小 60 秒间隔；后台调度提醒和只读运维工作流；执行前持久化 claim，重启不重放遗漏任务。 | ✅ | 2026-10-14 |
| TASK-005 | internal/ai/file_read.go 增加分页/图片/PDF 文本读取，search_files.go 增加精细搜索，runtime.go 加入编辑 hash 校验。 | ✅ | 2026-10-14 |
| TASK-006 | internal/ai/tool_results.go 落盘脱敏结果并分页；task_tools.go 统一 shell/子 Agent/工作流读取与取消。 | ✅ | 2026-10-14 |
| TASK-007 | 新增行为测试，运行 Go race、前端测试、类型检查和 scripts/build_lake.sh。 | ✅ | 2026-10-14 |

## 3. Alternatives

- **ALT-001**: 整体移植 TypeScript runtime 会引入 Node 运行依赖，与 Lake 原生 Go 发布结构冲突。

## 4. Dependencies

- **DEP-001**: 现有 Engine、Bridge、Store 工作流和 React 构建；PDF 文本使用可检测的 pdftotext adapter，缺失时明确失败。

## 5. Files

- **FILE-001**: internal/ai/catalog.go、tools.go、engine.go、types.go、stdio.go 及新增职责文件。
- **FILE-002**: internal/web/agent.go、server.go 与新增 tool_bridge.go、schedules.go。
- **FILE-003**: web-agent/shared/contracts.ts、web/src/AIPanel.tsx、activity.ts、AgentQuestion.tsx。

## 6. Testing

- **TEST-001**: 问答真实回复、非法回复、取消/重启；Todo 持久化；所有工具注册与实际调用。
- **TEST-002**: 跨项目拒绝、工作流版本冲突、调度 claim/restart、技能路径逃逸。
- **TEST-003**: UTF-8 分页、大结果恢复、搜索筛选、过期文件 hash 和图片/PDF adapter。

## 7. Risks & Assumptions

- **RISK-001**: PDF adapter 依赖本机 pdftotext；不把外部依赖缺失标记为成功。
- **ASSUMPTION-001**: 调度仅在 Lake 后台运行时执行，重启跳过错过时点，不自动重放外部操作。

## 8. Related Specifications / Further Reading

[工作流](feature-operations-workflow-1.md)
[ZCode 工具注册](../third_party/zcode/apps/zcode-cli/packages/core/src/tool/handlers/index.ts)
