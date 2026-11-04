---
goal: 将交互任务目标与资源使用记录分离
version: 1
date_created: 2026-11-04
last_updated: 2026-11-04
owner: Lake
status: 'In progress'
tags: [refactor, task-runtime, resources]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

同一业务目标在执行中可能依次发现数据库、主机、集群和 MCP。任务保存目标、步骤、尝试和验收；资源由每次操作从所属项目目录解析。首次计划的资源参考不能成为后续任务的固定资源白名单。

## 1. Requirements & Constraints

- **REQ-001**: `work_begin` 的 `asset_refs` 可省略；未发现资源时也能建立或规划已分配任务。
- **REQ-002**: 同一 GoalID 追加合法项目资源只更新参考记录，不创建 Task/Worker，不重置目标、步骤、尝试、期限或用量。
- **REQ-003**: `WorkGoal.ResourceBindings` 和兼容 `Binding` 为资源历史快照；真正操作目标、连接版本及句柄保留在原 operation/permit。
- **SEC-001**: 保留实时项目权限、明确资源边界、原操作审批/连接版本、workflow 冻结模板、子角色范围及未知副作用检查。不得用任务资源参考签发权限。
- **CON-001**: 不更改 Memory 开关或资源目录；无前端协议、数据库 schema 变更。无受信操作描述的旧自动恢复继续保守核验原快照。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 移除任务资源白名单并保留原执行身份。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | `internal/ai/work_goal.go:beginWork` 和 `work_binding.go` 合并新增资源快照，幂等保存无步骤的资源补充；空或待澄清目录不阻止无资源建任务。实际访问仍由权限层处理。 | | |
| TASK-002 | `adk_work_wait.go:resumeWorkGoal` 对已有 Security 契约使用中性的资源选择及原操作恢复验证；保留旧无契约自动恢复的保守路径。 | | |
| TASK-003 | `security_sre.go:BindSecuritySREPlan` 将普通 SRE 资源候选改为当前项目目录；明确 workflow 原模板的资源、步骤和连接检查保持。`superagent_model.go:projectSuperTaskTx` 从准确项目/会话/目标的 operation 补全资源关联投影，不写回授权或任务完成状态。 | | |

### Implementation Phase 2

- **GOAL-002**: 更新工具契约并完成回归和 Dev 验证；依赖 GOAL-001。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | `work_tools.go`、`superagent_catalog.go`、`superagent_worker.go` 移除必填资源及“原计划固定资源”提示，说明任务可以跨项目内资源继续，具体操作必须用准确目标。 | | |
| TASK-005 | 更新 `work_binding_test.go`、`superagent_worker_test.go`，补充同 GoalID 跨资源、旧 Binding、重复追加、无资源建单、重启、权限收窄、原操作身份及 SRE/workflow 边界回归。运行 ai/web 完整测试、相关 race、vet、runtime boundary 和前端检查。 | | |
| TASK-006 | 更新 `agent.md`、`docs/lake-pilot.md` 及验收记录；在保留当前 Dev 候选的干净本地集成提交上签名构建安装，核对原数据和新任务行为；提交独立 develop PR，不自行合并。 | | |

## 3. Alternatives

- **ALT-001**: 仅删除报错文字不能解除固定名单，拒绝。
- **ALT-002**: 每发现一个资源就另建任务会丢失同一目标的连续性，拒绝。
- **ALT-003**: 将整个项目目录复制为每项任务的冻结名单会遗漏之后新增资源，拒绝。

## 4. Dependencies

- **DEP-001**: 现有官方 ADK、WorkGoal/attempt/acceptance、项目资源目录和 Security permit；不增加依赖。

## 5. Files

- **FILE-001**: TASK-001 至 TASK-005 列出的 `internal/ai/` 实现与回归文件；操作执行权威保持现有 `security_execution.go`、`security_catalog.go` 和原生操作账本。
- **FILE-002**: `agent.md`、`docs/lake-pilot.md`、`docs/validation/lake-task-resource-decoupling.md`。

## 6. Testing

- **TEST-001**: 用数据库 A 建任务后，在同一 GoalID 中追加集群 B；重复追加不新增快照，目标/计划版本、原尝试、期限和累计轮数不重置。
- **TEST-002**: 省略 `asset_refs`、空目录或待澄清目录可建任务；越界候选和实际越权访问仍拒绝。
- **TEST-003**: 旧 Binding 升级为历史参考，资源配置新版本追加而不改写旧记录；原操作快照和句柄不重放。
- **TEST-004**: managed 恢复不被未使用的历史资源阻断；原操作连接变更、workflow 模板替换、跨项目资源和收窄权限继续拒绝派发。

## 7. Risks & Assumptions

- **RISK-001**: 把资源参考误当作 grant 会扩大执行权限；通过准备及派发回归验证原 permit 和边界仍生效。
- **RISK-002**: 旧自动恢复缺少完整受信描述；仅此兼容路径保留原冻结快照验证，不自动重放或迁移执行。
- **ASSUMPTION-001**: 用户要求在同一项目内发现和使用资源；跨项目访问仍由既有项目隔离拒绝。

## 8. Related Specifications / Further Reading

- [三模块分工](../agent.md)
- [Security 设计](../docs/design/lake-security-v1.md)
- [长期专员与项目资源](../docs/lake-pilot.md)
- [开发规范](../CONTRIBUTING.md)
