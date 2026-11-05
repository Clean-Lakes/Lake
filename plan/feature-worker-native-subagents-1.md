---
goal: 为任务 Worker 接入 ZCode 原生子智能体并在第三联按资源目录展示执行过程
version: 1
date_created: 2026-11-06
last_updated: 2026-11-06
owner: Lake
status: 'In progress'
tags: [feature, zcode, worker, subagent, inspector]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

用户确认沿用 Lake 三联界面：点击任务打开第三联，查看由 Lake 为任务分配的 Worker、其临时子智能体及真实工具记录。多资源保留项目已有目录层级。当前 TS/ZCode 候选位于 PR #183；本次沿该已有工作分支增量实现，不切换正式版、不合并 PR。

## 1. Requirements & Constraints

- **REQ-001**: Pilot 仅路由；任务 Worker 可以使用 ZCode v3.17.2 原生子智能体控制工具。复用公开 SubagentPort、runner、AgentRuntime，不新增模型循环或修改上游实现。
- **REQ-002**: 子智能体拥有独立执行 Session，绑定原项目、Task、Worker 与真实 agentId；不创建长期专员或第二份任务完成状态。
- **REQ-003**: 子智能体只取得父 Worker 业务能力与角色配置的交集；不能调用父任务结清、路由、专员管理工具或继续递归。
- **REQ-004**: 前台与后台子任务使用原生等待/停止/消息协议；父任务须汇合所有子任务，不能在子任务仍运行时结清。提前结束、停止和重启保留实际记录并禁止重放。
- **REQ-005**: 第三联以任务为中心，显示真实 Worker 与子智能体生命周期、操作、参数及结果；不展示内部推理。选中任务收起清单，中间对话保留。
- **REQ-006**: 使用准确 resourceTree/resourceId 分组。单资源子任务归原目录；跨资源、无资源和无法定位的过程保留任务级分组；同一子任务不复制为多个执行身份。
- **SEC-001**: 子工具继续经过当前父权限、任务 owner/generation、范围、审批与原操作账本；可信 child Session 命名空间隔离 toolCallId，避免跨子调用碰撞。
- **SEC-002**: Agent/TaskOutput/停止/消息等控制工具不构成业务成功证据；成功验收必须来自原任务的真实资源工具回执。
- **CON-001**: 使用当前 TS 候选与 Dev 隔离数据。遵守签名构建、develop PR 与显式合并授权；不重启正式版、不读取或输出凭据。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 原生子委派通过同一任务权限、业务账本与停止生命周期。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 扩展 runtime/zcode/agent-host.ts 的 HostProfile 与可信子调用上下文；在 runtime/zcode/agent.ts 通过公开 createExploreSubagentPort 构造受管理 child AgentRuntime，并投影原生运行记录。 | ✅ | 2026-11-06 |
| TASK-002 | 修改 runtime/zcode/superagent.ts 的 Worker profile，开放原生控制工具并加入 invokeControl；原业务工具串行派发，执行前重验任务、权限与取消。依赖 TASK-001。 | ✅ | 2026-11-06 |
| TASK-003 | 在 runtime/zcode/tasks.ts 的 Operation 与 operation() 保存可信子调用来源；原验收不把子 Agent 控制回执作为业务成功。依赖 TASK-002。 | ✅ | 2026-11-06 |
| TASK-004 | 在 web-agent/shared/contracts.ts 扩展 AgentRun 的原生来源、任务、Worker、child Session 和工具卡字段，旧记录保持缺省兼容。 | ✅ | 2026-11-06 |

### Implementation Phase 2

- **GOAL-002**: 第三联展示同一真实任务和原资源目录中的执行层级。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | 新增 web-agent/web/src/WorkerExecutionTree.tsx 与纯分组模型及 CSS；复用 resource-tree-model.ts 和既有工具详情组件，展示 Worker、真实子任务与准确资源归属。依赖 TASK-004。 | ✅ | 2026-11-06 |
| TASK-006 | 修改 SessionInspector.tsx、SuperTaskInspector.tsx、AIPanel.tsx、App.tsx 的任务入口和原生子过程投影，避免对话/第三联重复；保留旧 SRE。依赖 TASK-005。 | ✅ | 2026-11-06 |

### Implementation Phase 3

- **GOAL-003**: 取得可复现的运行、权限、目录分组与 Dev 界面证据。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | 扩展 runtime/zcode/server.test.cjs 的本地合成模型夹具，覆盖真实子 Read、纯文字不验收、Write 审批、停止/重启与同 callId 隔离；父 Worker 不预先读取以免假阳性。依赖 TASK-001 至 TASK-004。 | ✅ | 2026-11-06 |
| TASK-008 | 为执行树模型覆盖嵌套目录、重名资源、多资源与未知资源、跨任务隔离；完成前后端检查、签名候选构建与 Lake Dev 明暗/窄窗验证。依赖 TASK-005 至 TASK-007。 | false | — |
| TASK-009 | 更新 runtime/zcode/README.md、agent.md 和验证记录，保存 tested SHA、检查结果与未验证边界；将本次变更提交至已有 develop PR，不合并。依赖 TASK-008。 | ✅ | 2026-11-06 |

## 3. Alternatives

- **ALT-001**: 只打开 subagents.enabled。默认 child 不继承 Lake 工具包装且会被父 Session 代理拒绝，不能保留现有账本与权限，故不采用。
- **ALT-002**: 自建子智能体模型循环或将临时子智能体保存成长期专员。分别重复原生运行时或混淆任务生命周期，故不采用。

## 4. Dependencies

- **DEP-001**: PR #183 的 TypeScript/ZCode 候选及其固定 v3.17.2 依赖，当前基线 35e40262344048528a2145b4c809db79c92c995b。
- **DEP-002**: 现有 TaskLedger、LakeSecurity、项目资源目录与三联 Inspector。

## 5. Files

- **FILE-001**: runtime/zcode/agent.ts、agent-host.ts 与所需宿主子智能体模块：公开运行时接入与事件投影。
- **FILE-002**: runtime/zcode/superagent.ts、tasks.ts：可信绑定、实际操作与原目标验收。
- **FILE-003**: web-agent/shared/contracts.ts、web-agent/web/src/WorkerExecutionTree.tsx 及相邻组件/模型/CSS：任务执行详情与目录。
- **FILE-004**: runtime/zcode/server.test.cjs、前端执行树测试、说明和验证材料。

## 6. Testing

- **TEST-001**: 本地合成供应商驱动真实原生 Agent/Read，确认独立 Session、原 Task 账本、真实输出与单份报告。
- **TEST-002**: 子纯文字无业务回执、越界文件、拒绝/过期审批、任务停止与重启均不能产生写入或伪造验收。
- **TEST-003**: 两个 child 复用同一原始 callId，操作来源保持独立；后台任务汇合前不能结清。
- **TEST-004**: 前端模型和可视验证检查原目录、同名资源、任务级跨资源项、折叠状态、明暗主题与窄窗。

## 7. Risks & Assumptions

- **RISK-001**: 原生后台完成通知、子权限与父任务结束存在竞争；使用真实 registry 状态、取消信号和派发前重验，不根据文字推断完成。
- **RISK-002**: 同任务并行业务调用切换 active attempt；本期保留子模型并发，对实际业务派发使用任务内串行约束。
- **ASSUMPTION-001**: 用户授权本次 TS/ZCode Dev 功能改造与原型界面实现；未授权合并或生产发布。

## 8. Related Specifications / Further Reading

- [贡献流程](../CONTRIBUTING.md)
- [开发工作流](../docs/development-workflow.md)
- [当前候选](../runtime/zcode/README.md)
- [Super-agent 架构](architecture-lake-superagent-1.md)
- [UI 规范](../docs/ui-guidelines.md)

当前检查点：代码与签名 Dev 安装已完成；63 项后端、644 项前端和 25 项账本/活动/目录回归通过。实际测试源码为 `ffcbc00a2711dddf74652eadaf92fe512b9dfe1f`。原生任务清单/第三联基本交互已在首个实现版本验证，最终历史投影修正后的原生重复检查因 Mac 锁屏待用户解锁；TASK-008 保留未完成。详见[验证记录](../docs/validation/worker-native-subagents/validation.md)。
