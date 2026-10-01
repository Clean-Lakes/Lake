---
goal: 补齐插件运行时、工作流 v2 桌面管理、自定义专员和专员恢复
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [feature, migration, runtime, desktop]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

在 Go/Eino 单运行时中完成四项功能闭环。以现有工具授权、私有凭据文件、运行记录为基础；每一项均包含实际调用入口与回归验证。

## 1. Requirements & Constraints

- **REQ-001**: 已启用且摘要有效的插件 MCP 与 Hook 进入聊天运行时；禁用或篡改后立即拒绝调用。
- **REQ-002**: 桌面支持工作流 v2 定义编辑、校验、预览、保存、修订、运行、运行记录、事件与恢复。
- **REQ-003**: 自定义专员支持注册、禁用、删除、独立模型、工具白名单及范围；聊天和 v2 工作流使用同一配置。
- **REQ-005**: v17 对早期缺少 tool_call_id 的 v16 会话事件表先备份再补列，保留历史会话与事件；完整 v16 库幂等升级。
- **REQ-006**: 空会话返回空事件数组，桌面恢复兼容历史 null 数组响应，启动后可正常输入。
- **REQ-004**: 专员在模型响应与工具执行边界持久化检查点；完成步骤复用，未知写操作默认拒绝重试。
- **SEC-001**: SQLite 专员表只存元数据和摘要；执行上下文在 0700 目录的 0600 文件中原子保存，不包含模型凭据。
- **SEC-002**: 插件声明不含凭据；MCP 使用独立本地凭据引用；Hook 每次运行仍经过批准。
- **CON-001**: 保持 Eino 执行专员，不引入第二个 Agent 运行时。macOS 发布二进制与桌面包使用现有签名脚本。
- **PAT-001**: 桌面通过结构化 stdin 和会话桥调用 CLI；执行使用现有审批事件。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 专员配置与执行闭环；验收为配置的专员可在聊天与工作流中使用自身模型和工具。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 cmd/lake/settings.go 与 specialist_runtime.go 注册 Profile 配置、验证模型及白名单，复用代码和 SSH 工具工厂；加入 CLI 与桌面配置入口。 | ✅ | 2026-10-01 |
| TASK-002 | 在 lake/agent/specialist 增加执行记录重放与私有检查点，store/specialist_task.go 增加原子恢复状态；CLI 与桥提供任务状态和恢复。依赖 TASK-001。 | ✅ | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 插件声明实际运行；验收为 MCP 与 Hook 启用、调用、禁用、摘要失效都有真实结果。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 扩展 lake/extension/plugins 清单的 assets 与 MCP/Hook 类型验证；在 cmd/lake/mcp_client.go 和 chat.go 组装已验证声明，逐次核对插件状态。 | ✅ | 2026-10-01 |

### Implementation Phase 3

- **GOAL-003**: 桌面 v2 完整管理；验收为结构化编辑和执行无模型解析依赖，审批、状态、事件与恢复可见。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 在 cmd/lake/workflow_v2_cli.go 增加结构化定义管理入口，bridge.go/chat.go 增加 v2 执行请求；client/desktop/app.go 和前端增加编辑、预览、运行与恢复面板。 | ✅ | 2026-10-01 |
| TASK-005 | 增加四项回归测试，运行 Go/前端验证与签名发布脚本，更新 docs/zcode-capability-matrix.md 和使用文档。依赖 TASK-001 至 TASK-004 及 TASK-006。 | ✅ | 2026-10-01 |
| TASK-006 | 在 lake/store/store.go 添加 v17 条件补列迁移及私有备份，migration_v17_test.go 验证旧会话保留、正常读取和重复打开。 | ✅ | 2026-10-01 |
| TASK-007 | 修复空会话 null 事件恢复错误，事件接口返回空数组，时间线兼容旧响应，并把桌面时间线回归纳入发布验收。 | ✅ | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 仅保存 ADK 中断内存快照无法覆盖进程在工具调用后崩溃的边界；采用持久化响应和工具记录重放，并继续由 ADK 执行。

## 4. Dependencies

- **DEP-001**: 现有 Eino ADK、SQLite Store、Lake 工具审批和 Wails 会话桥。

## 5. Files

- **FILE-001**: lake/agent/specialist、lake/store/specialist_task.go：配置与恢复核心。
- **FILE-002**: lake/extension/plugins、lake/extension/hooks、cmd/lake/mcp_client.go：插件运行时。
- **FILE-003**: cmd/lake/workflow_v2_cli.go、cmd/lake/bridge.go、cmd/lake/chat.go：结构化管理和执行入口。
- **FILE-004**: client/desktop/app.go、client/desktop/frontend/src：桌面管理。

## 6. Testing

- **TEST-001**: 专员白名单、跨湖/项目拒绝、独立模型配置、禁用和实际调用验证。
- **TEST-002**: 重启后复用已完成模型和工具响应；未知读重试，未知写需显式允许并重新审批；并发恢复拒绝。
- **TEST-003**: 插件 MCP/Hook 组装、声明格式、秘密拒绝、禁用与摘要变化阻断。
- **TEST-004**: 工作流 v2 结构化保存修订、桥运行恢复、前端编译及现有流程回归。
- **TEST-005**: 空会话事件 JSON 为 []，前端兼容 null/空会话及历史消息；签名桌面实际启动后输入可用。

## 7. Risks & Assumptions

- **RISK-001**: 崩溃时外部写操作可能已完成，恢复页面与 CLI 必须提示核对外部结果，默认不重放。
- **RISK-002**: 检查点包含项目上下文与工具输出，必须保持私有权限、容量限制与安全路径验证。
- **ASSUMPTION-001**: 用户已授权四项本地代码改造与构建；真实模型/远端资源验证需要现有可用凭据与明确操作对象。

## 8. Related Specifications / Further Reading

[迁移方案](architecture-zcode-lake-1.md)

[能力矩阵](../docs/zcode-capability-matrix.md)


实施证据（2026-10-01）：`cmd/lake/migration_closure_test.go` 覆盖本机 MCP 实际调用/禁用、聊天 Hook 审批、独立专员模型/白名单、v2 管理/版本冲突及实时桥审批；`lake/agent/specialist/checkpoint_test.go` 覆盖重启重放、未知写保护、文件锁和符号链接保护。全量 Go 测试/vet、桌面模块测试/vet、Web 测试、两个前端构建、迁移样本、签名 CLI 和 Wails 构建均通过 `scripts/verify_lake_release.sh`。专员/工作流/CLI 并发检测通过。桌面原生页面已核对 v2 预览与专员配置；本机旧库已由签名 CLI 升级至 v17，保留私有备份并验证历史会话正常读取。随后补充空事件 JSON 与 null 时间线回归，桌面时间线 4 项测试、受影响存储测试及前端构建通过；最终签名应用启动后空会话输入可用。

发布验收日期：2026-10-01。真实远端服务与模型服务未在自动化测试中调用；用户 LaunchAgent 未安装。
