---
goal: 保存并执行自定义子 Agent 运维调查工作流
version: 1
date_created: 2026-10-12
last_updated: 2026-10-12
owner: Lake
status: Completed
tags: [feature, workflow, multi-agent]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

在项目中创建、编辑和删除自定义调查模板，按指定顺序实际执行独立子 Agent，最后独立验证并生成 Lake 总结；每次运行使用独立会话和不可变模板快照。

## 1. Requirements & Constraints

- **REQ-001**: 模板有名称、总目标和 1–7 个步骤；每步具有唯一 ID、Scout/Trace/Deep 职责、目标及 1–3 个项目内资源。
- **REQ-002**: 执行顺序由引擎固定，前步失败或取消停止后续步骤；全部调查成功后运行 Beacon 并由 Lake 汇总。
- **REQ-003**: UI 支持增删、排序、保存和重用模板，显示运行记录、状态、步骤进度和进入执行会话。
- **SEC-001**: 强制使用现有只读子 Agent 权限；工作流汇总模型无执行工具；跨项目资源、未知职责和失效版本拒绝执行。
- **CON-001**: 不推送；macOS bin/lake 仅由 scripts/build_lake.sh 签名构建；保持现有 4177 实例运行。
- **CON-002**: 每次运行最多 8 个子任务（7 调查加 1 独立验证），沿用现有时限、预算和审批；重启后标为中断且不重放。
- **PAT-001**: 复用 SQLite 事务、既有会话 SSE 和 AgentTaskList；每次运行绑定独立 sessionId。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成可确定执行的模板与运行服务。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/ai/workflow.go 增加 ChatWorkflow、步骤预验证和固定顺序执行；engine.go 在首个模型响应前调用计划，catalog.go 限制汇总工具。 | ✅ | 2026-10-12 |
| TASK-002 | internal/web/workflows.go 和 schema.sql 增加项目模板 CRUD、版本校验、独立运行会话、取消和中断恢复；server.go 接入路由。依赖 TASK-001。 | ✅ | 2026-10-12 |

### Implementation Phase 2

- **GOAL-002**: 交付可操作的编辑器并验证真实执行。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | web-agent/shared/contracts.ts、web/src/api.ts、Workflows.tsx、workflows.css 和 App.tsx 提供项目入口、步骤排序、保存、运行、停止和运行记录。依赖 TASK-002。 | ✅ | 2026-10-12 |
| TASK-004 | 添加 Go 集成测试验证顺序、证据、验证、停止、权限和模板快照；执行 race 检查、TypeScript 和真实浏览器调试；签名构建并在空闲时更新 4178 后端。依赖 TASK-001–TASK-003。 | ✅ | 2026-10-12 |

## 3. Alternatives

- **ALT-001**: 仅将模板写成提示词让模型自行分派；不能保证执行顺序和实际启动，未采用。
- **ALT-002**: 首版加入任意 Shell、修复和回滚步骤；需要新的变更生命周期与回滚契约，本次先交付用户选择的自定义调查模板。

## 4. Dependencies

- **DEP-001**: 已有子 Agent 引擎、只读观察工具和 Beacon 原始证据验证。
- **DEP-002**: 已有 SQLite 会话存储、审批 API、React 编辑器和签名构建脚本。

## 5. Files

- **FILE-001**: internal/ai/workflow.go、workflow_test.go、engine.go、types.go、turn_input.go、catalog.go、multi_agent.go。
- **FILE-002**: internal/web/workflows.go、workflows_test.go、schema.sql、store.go、server.go。
- **FILE-003**: web-agent/shared/contracts.ts、web/src/api.ts、Workflows.tsx、workflows.css、App.tsx。

## 6. Testing

- **TEST-001**: 固定顺序启动两个独立调查后验证；根模型不调用 delegate 也有真实运行记录。
- **TEST-002**: 无证据失败、步骤失败与取消阻止后续步骤，禁用任意执行工具。
- **TEST-003**: 模板版本冲突、跨项目资源、非法角色、角色资源类型、重复步骤 ID、删除与运行快照不变。
- **TEST-004**: 服务重启后运行中断，浏览器编辑、排序、保存、运行及查看子 Agent 无溢出或 JS 错误。

## 7. Risks & Assumptions

- **RISK-001**: 现有子 Agent 只有固定观察能力，模板可配置调查目标但不能新增自定义命令。
- **RISK-002**: 子 Agent 的模型/权限/证据失败必须作为失败返回，不能将部分调查显示为工作流成功。
- **ASSUMPTION-001**: 本次手动运行，无定时器、条件分支或自动重放；用户已选择自由配置调查目标和步骤。

## 8. Related Specifications / Further Reading

[子 Agent 设计](architecture-lake-multi-agent-1.md)
[子 Agent 验证记录](../docs/validation/lake-multi-agent.md)
