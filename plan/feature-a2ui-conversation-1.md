---
goal: 在 Lake 对话中接入 A2UI 并完成交互式端口巡检
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [feature, ui, a2ui]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

使用官方 A2UI React 0.12.0 的 v0.9 协议入口处理 v0.9.1 消息。AI 可在同一对话面板中组合组件，组件数据可增量更新；第一条完整交互为选择主机、查询监听端口、选择进程并查看详情与日志。

## 1. Requirements & Constraints

- **REQ-001**: 支持 createSurface、updateComponents、updateDataModel、deleteSurface；面板更新复用相同 surfaceId。
- **REQ-002**: 注册 lake_ui 与 lake_port_inspector；动态界面与现有终端执行、工作流、AI 消息共用时间线。
- **REQ-003**: 保存面板快照与操作记录，恢复历史面板；只读 Web 禁用操作按钮。
- **SEC-001**: 验证组件目录、绑定路径、树深度和操作来源；不执行模型提供的代码或命令；SSH 使用 operate.Service 的现有授权、作用域与审批。
- **SEC-002**: 界面数据脱敏后才持久化或发送；历史面板操作重新校验当前资源及端口记录；限制重复点击。
- **CON-001**: macOS CLI 仅通过 scripts/build_lake.sh 构建签名；桌面使用 scripts/build_lake_desktop.sh，成功后仅保留一份构建。
- **PAT-001**: 采用 Lake 自有受限组件目录、官方 MessageProcessor 与 A2uiSurface；不使用网页嵌入组件。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成可验证的协议、存储与 Agent 工具。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 lake/agent/a2ui.go 实现类型、Apply、快照校验和操作校验；在 lake/store/agent_event.go 注册 a2ui 面板事件和 ui_action 事件。 | Yes | 2026-10-01 |
| TASK-002 | 在 cmd/lake/a2ui.go 注册 lake_ui、lake_port_inspector；实现固定端口查询、PID 查询与 journalctl 日志读取，使用 operate.Service.RunCommand。依赖 TASK-001。 | Yes | 2026-10-01 |
| TASK-003 | 在 cmd/lake/bridge.go 和 cmd/lake/chat.go 接通面板事件及 ui_action 请求，恢复快照，将已展示数据保留到模型上下文。依赖 TASK-001、TASK-002。 | Yes | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 完成前端交互、恢复和签名交付。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 在 client/desktop/frontend/src/shared/A2UISurface.tsx 定义 Lake Catalog，接入官方处理器与 React 渲染器；实现表格筛选、主机表单、操作禁用和原位更新。依赖 TASK-001。 | Yes | 2026-10-01 |
| TASK-005 | 在 client/desktop/frontend/src/timeline.ts、App.tsx 和 client/desktop/app.go 接通操作请求与事件；只读 Web 复用组件。依赖 TASK-003、TASK-004。 | Yes | 2026-10-01 |
| TASK-006 | 执行后端 race 测试、前端状态测试及真实浏览器交互验证；构建 Web 嵌入资源后运行签名桌面构建。依赖 TASK-005。 | Yes | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 继续扩展一次性 json-render 报告；保留其历史兼容，但新交互面板采用 A2UI 数据与动作模型。
- **ALT-002**: 使用餐厅演示的 Python/Gemini 后端；不采用，Lake 现有 Go Agent 与模型已经可生成 JSON。

## 4. Dependencies

- **DEP-001**: @a2ui/react 和 @a2ui/web_core 固定为 0.12.0；使用 v0_9 入口。
- **DEP-002**: 现有 SQLite 版本化事件、operate.Service、Wails 桥接与命令审批。

## 5. Files

- **FILE-001**: lake/agent/a2ui.go 与 lake/store/a2ui.go：协议状态和脱敏。
- **FILE-002**: cmd/lake/a2ui.go、bridge.go、chat.go、tool_registry.go：工具与操作路由。
- **FILE-003**: client/desktop/frontend/src/a2ui.ts、shared/A2UISurface.tsx、shared/A2UISurface.css、timeline.ts、App.tsx、wails.d.ts：动态面板与时间线。
- **FILE-004**: client/desktop/app.go、README.md、docs/third-party-notices.md：桌面 API、文档和许可。

## 6. Testing

- **TEST-001**: 验证增量更新、旧快照恢复、循环和未知组件拒绝、字段脱敏、跨面板及未声明动作拒绝。
- **TEST-002**: 固定 SSH fixture 验证端口解析、PID 检查、日志限制、审批拒绝不执行和上下文保持。
- **TEST-003**: Playwright 验证主机选择、端口列表、筛选、进程详情、原位更新、连续点击锁、只读历史与窄屏。
- **TEST-004**: 前后端编译及 race 测试通过；签名验证通过且构建目录应用数量为 1。
- **TEST-005**: 真实桥接与本地模型 fixture 验证 lake_ui 生成图表/表单、关闭并重开桥接、回传表单、持久化输入、原位更新及模型上下文保持。

验证记录：后端 `go test -race ./lake/... ./cmd/lake`、桌面 Go race、对应 `go vet`、桌面 23 项前端测试及 Web 2 项事件测试通过。Playwright 在真实前端中验证官方渲染器、双向绑定、点击锁、筛选保持、进程/日志标签页、错误保留原结果、窄屏、跨会话重复 surfaceId 隔离与只读 Web 实时更新；使用显式标注的示例数据和 SSH fixture，没有查询实际主机。

## 7. Risks & Assumptions

- **RISK-001**: Linux 主机缺少 ss 或 journalctl，或无权限获取进程信息；面板展示实际错误与缺失范围，不伪造数据。
- **RISK-002**: 模型生成的结构不符合目录；返回修正反馈，保留最后一个有效面板。
- **ASSUMPTION-001**: 首期端口与日志检查针对当前湖已登记 Linux SSH 主机；日志来自所选 PID 的 journalctl，不猜测应用文件路径。

## 8. Related Specifications / Further Reading

[A2UI Quickstart](https://a2ui.org/quickstart/)
[A2UI v0.9.1 schema](https://github.com/a2ui-project/a2ui/blob/main/specification/v0_9_1/json/server_to_client.json)
[官方 React Renderer](https://github.com/a2ui-project/a2ui/tree/main/renderers/react)
[Lake 构建规则](../AGENTS.md)
