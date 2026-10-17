---
goal: 为侧栏会话增加名称编辑并持久保存
version: 1
date_created: 2026-10-13
last_updated: 2026-10-13
status: Completed
tags: [feature, session, navigation]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

通过铅笔按钮和右键菜单编辑会话名称，保持侧栏、顶部和缓存一致。

## 1. Requirements & Constraints

- **REQ-001**: 编辑既有会话名称，空名称拒绝，最多 200 字符；保存后手动名称不被自动命名覆盖。
- **REQ-002**: 使用现有弹窗和图标风格；支持输入预选、Enter 保存、Escape 取消和键盘焦点循环。
- **REQ-003**: 允许调查期间修改名称，不修改会话项目、状态、历史、资源和执行任务。
- **SEC-001**: PATCH 沿用认证和 Origin 防护，不接受其他字段，不记录已知凭据名称；不推送。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 实现持久名称编辑。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/web/store.go RenameSession 更新 title/updatedAt，删除 sessionNaming 自动命名标志，发送 session 事件；server.go PATCH /api/sessions/:id 校验参数及来源。 | Yes | 2026-10-13 |
| TASK-002 | web-agent/web/src/SessionEdit.tsx 弹窗；App.tsx 编辑按钮、右键菜单、缓存更新；api.ts renameSession；styles.css 悬浮/选中/触控入口。依赖 TASK-001。 | Yes | 2026-10-13 |
| TASK-003 | session_edit_test.go 验证调查中编辑、持久化、自动命名锁定、错误参数、来源认证；签名构建和本地 UI 验证，空闲更新 Web。依赖 TASK-002。 | Yes | 2026-10-13 |

## 3. Alternatives

- **ALT-001**: 浏览器 prompt 与现有界面不一致，采用共享弹窗样式。

## 4. Dependencies

- **DEP-001**: WorkSession、session 事件刷新、snapshotCache、NavigationMenu。

## 5. Files

- **FILE-001**: internal/web/store.go、server.go、session_edit_test.go。
- **FILE-002**: web-agent/web/src/App.tsx、SessionEdit.tsx、api.ts、styles.css。

## 6. Testing

- **TEST-001**: HTTP PATCH 编辑及重启持久化；状态/历史不受影响；手动名称覆盖保护；参数与 Origin 校验。
- **TEST-002**: TypeScript/Vite 构建、签名校验和浏览器打开编辑弹窗。

## 7. Risks & Assumptions

- **ASSUMPTION-001**: 用户此处编辑指截图侧栏的会话名称；不修改已发送聊天内容。
- **RISK-001**: 正在调查时暂缓重启调试服务，避免中断任务。

## 8. Related Specifications / Further Reading

[会话导航](feature-session-permissions-1.md)
