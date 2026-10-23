---
goal: 为 Lake 会话增加可审阅后执行的 Plan 模式
version: 1.0
date_created: 2026-10-22
last_updated: 2026-10-22
owner: Lake
status: 'Completed'
tags: [feature, planning, permissions, ui]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

会话提供普通执行和 Plan 两种模式。Plan 阶段先调查、澄清需求、输出方案；用户可继续修改方案，或点击执行当前计划进入普通执行模式。

## 1. Requirements & Constraints

- **REQ-001**: 输入区提供 Plan 开关和 `/plan` 命令，模式按会话持久化，旧会话默认普通执行。
- **REQ-002**: Plan 使用只读工具及现有 ask_user_question；最终方案随会话保存，修改方案后旧方案不可执行。
- **SEC-001**: 工具目录和执行入口共同限制写文件、未知命令、MCP 调用、工作流启动、计划任务及资源变更；静默权限不能绕过 Plan 限制。可信策略确认只读的命令才允许运行。
- **SEC-002**: 执行当前计划须校验方案 ID、会话模式、空闲状态和空队列；执行仍受原会话权限约束。
- **CON-001**: 不覆盖既有工作区改动；遵守 AGENTS.md 的 Dev 隔离、签名构建及 docs/ui-guidelines.md。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 在运行时强制 Plan 限制并保存可审阅方案。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/ai/plan_mode.go 定义模式、只读工具白名单和方案；catalog.go 过滤 sessionCatalog，strategy_prompt.go 将规划指令加入 FixedRules；tools.go 与 permissions.go 拒绝写操作；engine.go 在新轮失效旧方案、成功后保存最终方案，并关闭 Plan 的记忆提取。 | Yes | 2026-10-22 |
| TASK-002 | internal/web/plan_mode.go 提供模式设置与执行计划端点，使用 messageMu 串行校验模式、忙碌状态、队列和方案 ID；agent.go 配置模式并在 Plan 阶段绕过 SRE 自动协作；terminal_scope.go 返回持久模式。依赖 TASK-001。 | Yes | 2026-10-22 |

### Implementation Phase 2

- **GOAL-002**: 提供输入区模式切换、方案审阅和完整验证。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | web-agent/shared/contracts.ts、web/src/PlanMode.tsx、planMode.css、api.ts、App.tsx、AIPanel.tsx 增加模式开关、/plan、计划操作与错误处理；窄屏和深色使用主题变量。依赖 TASK-002。 | Yes | 2026-10-22 |
| TASK-004 | internal/ai/plan_mode_test.go、internal/web/plan_mode_test.go、web-agent/web/test/plan-mode.test.ts 验证只读约束、持久化、模式隔离、过期及重复执行拒绝、前端可访问状态；运行 Go race、Plan 前端测试与类型检查，再签名构建 Dev 客户端并用隔离预览验证；在最新 develop 独立工作区记录全量测试与 Dev 包验证。依赖 TASK-003。 | Yes | 2026-10-22 |

## 3. Alternatives

- **ALT-001**: 只注入规划提示词无法阻止实际写操作，因此执行层必须强制校验。
- **ALT-002**: 复用 SRE plan_only 会将普通规划绑定特定四专员流程，采用独立会话模式。

## 4. Dependencies

- **DEP-001**: 现有可信命令策略、会话权限、结构化提问、ADK 状态投影与消息队列锁。

## 5. Files

- **FILE-001**: internal/ai/plan_mode.go、types.go、catalog.go、tools.go、permissions.go、engine.go 及 plan_mode_test.go。
- **FILE-002**: internal/web/plan_mode.go、agent.go、server.go、terminal_scope.go 及 plan_mode_test.go。
- **FILE-003**: web-agent/shared/contracts.ts、web/src/PlanMode.tsx、planMode.css、api.ts、App.tsx、AIPanel.tsx、web/test/plan-mode.test.ts 和 README.md。

## 6. Testing

- **TEST-001**: 静默写权限全部开启时 Plan 仍拒绝写文件、写 SQL、Redis 写命令、未知 shell、MCP、工作流及计划任务；只读证据和结构化提问可用。
- **TEST-002**: 会话重载保留模式和方案；新轮、取消及失败不允许执行旧方案；忙碌、队列非空、过期 ID 和重复点击返回冲突。
- **TEST-003**: 输入区模式标签和方案操作在普通、Plan、忙碌、浅色、深色及窄窗口正确展示；类型检查、Plan 前端测试、Go race 和签名 Dev 构建通过；全量前端测试通过。

## 7. Risks & Assumptions

- **RISK-001**: 未被可信策略识别为只读的命令在 Plan 中不可运行；模型须说明调查缺口，不能降低为普通执行。
- **ASSUMPTION-001**: 用户要求新增类似 Codex 的 Plan 功能，授权实现、验证及本地 Dev 安装，不涉及发布。

## 8. Related Specifications / Further Reading

[UI 规范](../docs/ui-guidelines.md)
[本地联调](../CONTRIBUTING.md)
[OpenAI 官方 Plan 说明](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)

验收记录：[Plan 模式验收](../docs/validation/lake-plan-mode.md)。功能与专项验证完成；PR 基于最新 develop，保留原安装并通过签名包和隔离页面验证。
