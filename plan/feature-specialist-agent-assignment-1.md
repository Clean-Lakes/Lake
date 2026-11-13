---
goal: 专员对话中的显式 Agent 分配与实际执行回传
version: 1
date_created: 2026-11-10
last_updated: 2026-11-10
owner: Lake
status: 'Completed'
tags: [feature, acp, specialist, typescript, ui]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

专员是持续的任务负责人，Task Worker 保留独立任务与执行上下文，Codex / runtime-acp 是可以分配的执行 Agent。将此前只在设置中提供的执行配置接入专员对话、任务派发、实际进度和报告收集。模型供应商名称不代表外部 Agent 已执行。

2026-11-10 后续修订：本计划记录上一版独立分配面板。当前仅保留 Codex，执行选择合并到聊天模型菜单；默认值、自动路径及替代入口见[统一模型入口实施](refactor-codex-composer-1.md)。原显式接单、幂等与实际回传继续复用。

## 1. Requirements & Constraints

- **REQ-001**: 专员输入区提供普通对话及分配新任务给 Lake Worker、runtime-acp、Codex 的明确入口；显示专员、Task Worker、执行 Agent 的关系。
- **REQ-002**: 显式分配由宿主创建原 Task/Worker 并冻结后端；不依赖模型猜测 run_external_agent，不改写已有任务或专员默认配置。
- **REQ-003**: 外部 Agent 未启用、未安装、未验证连接、缺少认证或配置版本变化时，拒绝派发并保留草稿，提供当前项目的配置入口。
- **REQ-004**: 对话与任务详情从实际 acpRuns 投影执行者、派发阶段、运行状态和报告；completed 仅表示外部运行回传，任务完成沿原验收账本判定。
- **SEC-001**: 当前权限、审批、租约、取消、准确项目/任务/child 身份和未知操作约束沿用原宿主；不通过模型名称或文本创建执行证据。
- **SEC-002**: 显式分配使用准确频道、职责版本及配置版本；相同 requestId 和输入返回原接单回执，冲突输入拒绝，不自动重放任务。
- **CON-001**: 仅扩展 TypeScript 开发版本；保持 Go 历史记录、原生 child 和已冻结任务的兼容性；不触碰正式版配置或凭据。
- **GUD-001**: 使用 AppSelect、Glyph、ProviderIcon 与共享圆角；验证明暗、窄窗口、键盘焦点与实际裁切。
- **PAT-001**: 保留官方 AgentRuntime 与现有 ACP service、Task/Security/Memory 所有权；不增加模型循环或第二份任务账本。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成可信分配契约和宿主派发。任务按顺序执行。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 web-agent/shared/external-agents.ts 定义 SpecialistAgentAssignment / AgentExecutionSummary；在 runtime/typescript/acp/registry.ts 输出非秘密就绪原因。 | ✅ | 2026-11-10 |
| TASK-002 | 在 runtime/typescript/superagent.ts 的 send 校验分配、使用原 newAssignment 冻结执行后端、记录幂等接单回执；server.ts 拒绝将显式分配变成普通排队消息。依赖 TASK-001。 | ✅ | 2026-11-10 |
| TASK-003 | 在 superagent.ts 的 workerView / decorate 输出按准确任务绑定的外部运行投影；保留原报告与验收。依赖 TASK-001。 | ✅ | 2026-11-10 |

### Implementation Phase 2

- **GOAL-002**: 完成专员对话与任务详情的分配交互。依赖 Phase 1；以下任务可独立实现。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 新增 web-agent/web/src/AgentAssignmentControl.tsx；App.tsx 的 sendMessage 发送显式分配并保留失败草稿，提供准确项目的 Agent 设置入口。 | ✅ | 2026-11-10 |
| TASK-005 | 新增 web-agent/web/src/AgentExecution.tsx，在 SpecialistChannel.tsx 与 WorkerExecutionTree.tsx 展示真实执行链、状态和报告；模型入口明确标识协调模型。 | ✅ | 2026-11-10 |

### Implementation Phase 3

- **GOAL-003**: 完成实际派发与可见性验证。依赖 Phase 1/2。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | 在 runtime/typescript/server.test.cjs 验证直接派发、未就绪拒绝、角色/配置 CAS、重复请求、真实 ACP 工具回执与回传；在 web-agent/web/test 验证 UI 状态投影不虚构调用或验收。 | ✅ | 2026-11-10 |
| TASK-007 | 执行 TS/前端检查与相关回归；用签名脚本构建安装 Lake Dev，验证明暗/窄窗口/配置入口与真实执行，更新 docs/validation/acp-agent-execution/compatibility.md 和 draft PR #222。 | ✅ | 2026-11-10 |

## 3. Alternatives

- **ALT-001**: 只给模型选择器添加 Codex 名称不能证明派发，也不能表达模型与独立执行 Agent 的区别，因此不采用。
- **ALT-002**: 仅提示模型调用 run_external_agent 仍会受工具未注册、路由选择和模型推理影响；显式用户分配采用确定的宿主接单，普通模型委派继续兼容。

## 4. Dependencies

- **DEP-001**: 当前分支已有 runtime/typescript/acp/service.ts 的独立进程、桥接工具、取消及回传能力。
- **DEP-002**: 原 LakeSuperagent Task、Worker、频道、权限和结果验收账本。

## 5. Files

- **FILE-001**: web-agent/shared/external-agents.ts、contracts.ts：分配输入及实际执行投影。
- **FILE-002**: runtime/typescript/acp/registry.ts、superagent.ts、server.ts：就绪、接单、冻结与状态来源。
- **FILE-003**: web-agent/web/src/AgentAssignmentControl.tsx、AgentExecution.tsx、App.tsx、SpecialistChannel.tsx、WorkerExecutionTree.tsx、ComposerModelSelect.tsx、api.ts、externalAgents.css：分配与回传交互。
- **FILE-004**: runtime/typescript/server.test.cjs、web-agent/web/test/agent-assignment.test.ts：有意义的派发及状态回归。

## 6. Testing

- **TEST-001**: 显式 runtime-acp 分配无 Router 模型调用，实际独立 ACP 进程得到宿主工具，原任务收集真实回执；原生及 Codex 选择按同一绑定规则。
- **TEST-002**: 未就绪、准确角色/项目/职责版本不符及连接版本变化不建 Task、不消费草稿；重复 requestId 不重复执行。
- **TEST-003**: 对话和详情区分未派发、执行中、审批、已回传、失败及结果未知；报告文本与供应商名称不能制造已执行或验收成功。
- **TEST-004**: 前端类型/构建/回归及签名 Lake Dev 的实际显示、焦点和配置跳转。

## 7. Risks & Assumptions

- **RISK-001**: 配置在查看和发送之间变化；宿主在接单时比较准确 revision，并在每次实际工具调用时沿用现有撤销检查。
- **RISK-002**: 握手不能证明模型认证可用；UI 明确连接验证边界，任务真实失败单独显示，不伪造测试成功。
- **ASSUMPTION-001**: 显式“分配新任务”每次建立独立 Worker；普通对话继续由现有路由判断新任务或补充，不自动迁移历史任务。

## 8. Related Specifications / Further Reading

- [ACP 架构与首批实施](architecture-acp-agent-execution-1.md)
- [所有权与集成边界](../agent.md)
- [前端规范](../docs/ui-guidelines.md)
- [验证记录](../docs/validation/acp-agent-execution/compatibility.md)
