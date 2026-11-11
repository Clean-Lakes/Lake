---
goal: 将专员对话页改为保留 Lake 风格的角色任务列表
version: 1
date_created: 2026-11-11
last_updated: 2026-11-11
owner: Codex
status: In progress
tags: [frontend, specialist, tasks]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In_progress-yellow)

用户已确认带角色头像的任务列表渲染图，要求先完成前端，后端问题另行处理。专员入口展示角色信息、可检索/筛选的任务列表和原任务详情；Pilot 保持现有对话。

## 1. Requirements & Constraints

- **REQ-001**: 专员页以真实 Worker 列表替换对话消息流，显示角色头像、任务、状态、实际执行 Agent、已知进度和更新时间。
- **REQ-002**: 复用现有频道读取、任务快照、任务详情、附件、模型选择及派发入口；新建任务按钮只聚焦现有输入。
- **REQ-003**: 点击行按准确 sessionId/taskId 打开详情；轮询保留筛选、搜索、选择、行节点和阅读位置。
- **SEC-001**: 确认、SSH 信任与停止沿原任务身份，断线禁用；不调用真实主机验证展示、不生成假进度、不将外部回传当验收。
- **CON-001**: 不修改 runtime 后端、API、凭据或用户任务历史；本轮不解决目录检索、MCP 和模型问题。
- **GUD-001**: 复用 Lake 主题 token、湖生态头像、Glyph、ProviderIcon/AppSelect 和现有右栏；验证明暗、窄窗、键盘与减少动态效果。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成仅依赖既有协议的任务列表及入口接入。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 web-agent/web/src/specialistTaskListModel.ts 投影过滤、准确资源路径、时间、已知进度与状态；未知进度保持未报告。 ✅ | 2026-11-11 |
| TASK-002 | 在 web-agent/web/src/SpecialistTaskList.tsx 和 specialistTaskList.css 实现角色头部、共享头像、筛选搜索、任务行与空状态。依赖 TASK-001。 ✅ | 2026-11-11 |
| TASK-003 | SpecialistChannel.tsx 复用原频道轮询接入列表；App.tsx 对角色页关闭聊天末尾跟随并保留原派发输入；SessionInspector.tsx 保留原任务确认入口。依赖 TASK-002。 ✅ | 2026-11-11 |

### Implementation Phase 2

- **GOAL-002**: 验证交互及签名 Lake Dev 并提交可审查结果。依赖 GOAL-001。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 使用虚构数据测试任务状态、准确身份、路径及未知进度；真实 App fixture 验证筛选、搜索、详情、确认与断线；保留原有前端回归。 ✅ | 2026-11-11 |
| TASK-005 | 执行 pnpm --dir web-agent check、test:frontend、build:web；浏览器验证明暗/窄窗/键盘，记录截图及结果。依赖 TASK-004。 ✅ | 2026-11-11 |
| TASK-006 | 从干净提交执行 scripts/build_lake_desktop.sh --dev --install，避免中断正在运行的任务；验证 Dev 及来源 SHA，更新现有 develop 草稿 PR，不合并。依赖 TASK-005。 | | |

## 3. Alternatives

- **ALT-001**: 复制一套聊天页面：与用户已确认的任务列表目标不符。
- **ALT-002**: 新增后端列表接口或持久状态：现有频道协议已具备任务与活动快照，本轮保持前端范围。

## 4. Dependencies

- **DEP-001**: SpecialistChannelPage.workers/active/entries 及 SessionSnapshot 提供准确执行身份；现有 api.specialistChannel/api.snapshot 保持不变。
- **DEP-002**: 现有 SessionInspector、SuperRoleAvatar、TaskProgress、ComposerModelSelect 与主题系统。

## 5. Files

- **FILE-001**: web-agent/web/src/specialistTaskListModel.ts、SpecialistTaskList.tsx、specialistTaskList.css：任务页实现。
- **FILE-002**: web-agent/web/src/SpecialistChannel.tsx、App.tsx、SessionInspector.tsx、SpecialistTaskControls.tsx：既有入口与确认接入。
- **FILE-003**: web-agent/web/test/specialist-task-list.test.ts、test/fixtures/specialist-task-list.*：回归与真实 App 验证数据。
- **FILE-004**: docs/ui-guidelines.md、docs/validation/acp-agent-execution/：新界面说明与实际验收记录。

## 6. Testing

- **TEST-001**: 同名任务保持独立原 session/task；跨项目资源和失效路径不可混入；未知进度不推断百分比。
- **TEST-002**: 活动、需确认、已验收、待验收、停止及失败如实显示；按真实角色身份选同一头像，按 Worker 冻结执行后端显示 Agent。
- **TEST-003**: 真实 App fixture 验证搜索/筛选、选择与详情、任务确认目标、附件/草稿保留、断线、空页、减少动态效果与明暗窄窗。
- **TEST-004**: 前端类型、全套前端回归和构建通过；Dev 记录提交与截图，不启动真实资源操作。

## 7. Risks & Assumptions

- **RISK-001**: 非活动任务没有完整快照；列表使用已加载可信记录的进度，否则明确未报告，详情按需读取。
- **RISK-002**: 原聊天自动滚动会把任务列表推到底部；角色页必须退出 FollowScroll，其他会话保持原行为。
- **ASSUMPTION-001**: 当前已有 codex/acp-agent-execution 分支与 develop 草稿 PR 可继续使用，后端及生产发布不在本次授权范围。

## 8. Related Specifications / Further Reading

- [贡献规范](../CONTRIBUTING.md)
- [开发流程](../docs/development-workflow.md)
- [UI 规范](../docs/ui-guidelines.md)
- [ACP 兼容记录](../docs/validation/acp-agent-execution/compatibility.md)
