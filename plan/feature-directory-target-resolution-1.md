---
goal: 让 Lake 依据项目目录理解用户指向的资源并拒绝旧目标回退
version: 1
date_created: 2026-10-12
last_updated: 2026-10-12
owner: Lake
status: Completed
tags: [bug, resource-target, ai]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

修复用户指向“新 k8s 集群”目录后仍沿用旧主机或本地 kubeconfig 的问题。以工作台实际目录为来源解析资源范围，保留原有操作审批。

## 1. Requirements & Constraints

- **REQ-001**: 资源带完整目录路径，目录查询可递归枚举资源；同名目录使用完整路径或目录引用区分。
- **REQ-002**: 明确目录引用优先于旧会话绑定，禁止旧主机预检查和目录外执行；后续话题沿用目录，显式资源引用可切换。
- **REQ-003**: 支持新k8s集群与k8s新集群的相同字词顺序变化；不把新与旧或其他不同名称当作相同目录。
- **SEC-001**: 目录是导航元数据，不是磁盘路径或授权；所有命令、文件、终端和子任务仍使用原有权限。
- **CON-001**: 同名、空目录或删除后的范围需要澄清，不能猜测操作目标；不推送、不检查生产主机。
- **PAT-001**: 复用 Store 目录结构、Engine 资源引用和审批流程。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成目录发现与执行目标约束。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/ai/directory_targets.go、catalog.go、tools.go 实现目录发现、路径过滤和资源范围校验；types.go、turn_input.go、engine.go 保存服务器提供的范围；multi_agent.go 校验子任务目标。 | ✅ | 2026-10-12 |
| TASK-002 | internal/web/directory_targets.go、agent.go 构建目录路径、解析消息并覆盖旧目标预检查，传递实际目录与当前范围。依赖 TASK-001。 | ✅ | 2026-10-12 |

### Implementation Phase 2

- **GOAL-002**: 验证用户案例及既有工作流。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 目录、目标隔离与端到端回归覆盖重名、空目录、递归、旧主机回退、显式切换和资源查询标签；运行 Go race 和前端检查，签名构建。依赖 TASK-001–TASK-002。 | ✅ | 2026-10-12 |
| TASK-004 | 更新独立 4178 调试后端，在 5174 验证显示；保留运行中的原生实例，记录验证结果。依赖 TASK-003。 | ✅ | 2026-10-12 |

## 3. Alternatives

- **ALT-001**: 只修改提示词；缺少实际目录信息且无法阻止旧目标预检查，未采用。
- **ALT-002**: 根据本地 kubeconfig 的版本或时间猜集群；与用户侧栏所指资源无必然关系，未采用。

## 4. Dependencies

- **DEP-001**: 既有 resourceTree 与项目资源数据。
- **DEP-002**: 既有只读检查、终端权限和子 Agent 调度。

## 5. Files

- **FILE-001**: internal/ai/directory_targets.go、directory_targets_test.go、types.go、turn_input.go、engine.go、catalog.go、tools.go、permissions.go、multi_agent.go。
- **FILE-002**: internal/web/directory_targets.go、directory_targets_test.go、agent.go；web-agent/web/src/activity.ts。

## 6. Testing

- **TEST-001**: 根目录、嵌套目录、递归资源、词序变化与重名区分。
- **TEST-002**: 用户修正目录后首次模型请求之前没有旧主机预检查；目录外命令、终端与子任务拒绝。
- **TEST-003**: 目录范围保持与显式切换，空目录、同名目录和删除目录不回退旧目标。
- **TEST-004**: 工作流和既有权限回归、UI 目录查找标签与签名验证。

## 7. Risks & Assumptions

- **RISK-001**: 自然语言不能保证任意语义均准确；仅在名称和实际目录明确对应时选择，否则需要澄清。
- **ASSUMPTION-001**: 用户截图中的目录是当前项目的资源分组；目录成员只能通过项目实际数据获取。

## 8. Related Specifications / Further Reading

[资源目录设计](feature-resource-directory-tree-1.md)
[工作流设计](feature-operations-workflow-1.md)
