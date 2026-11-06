---
goal: 接通 Lake 的 Agent SDK 通用 Agent 工具与资源执行
version: 1
date_created: 2026-11-06
last_updated: 2026-11-06
owner: Lake Runtime
status: 'Completed'
tags: [feature, typescript, agent, ssh]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

用户授权 Pilot、专员和 Task Worker 拥有同一通用 Agent 能力。沿用从 origin/develop 90aa1274 创建的当前干净分支及开放 PR 188，在已有停止/MySQL 变更上完成能力接入；不合并 PR 或发布生产版本。

## 1. Requirements & Constraints

- **REQ-001**: Pilot 能直接执行和调用原生子智能体，专员通过独立 Worker 执行；职责不再裁剪通用文件、Shell、搜索、待办、网页、澄清和计划能力。
- **REQ-002**: 通用 Shell 使用公开 Agent SDK Bash handler/ExecutionPort；本机与 SSH 明确绑定当前项目资源、配置版本及真实目标，支持有界前台/后台执行、读取与取消。命令由模型规划，不限制为固定指标。
- **REQ-003**: Pilot 直接执行也产生原 Task/attempt/Operation；纯对话不创建假业务成功，原生子执行沿用父任务身份和审批，结果在第三联可追溯。
- **REQ-004**: 发布上游工具能力清单；有对应宿主端口的能力可用，无端口的产品服务明确未连接，不用成功占位或伪搜索冒充能力。
- **SEC-001**: 当前资源归属、Pilot 原权限、明确项目策略、配置/凭据版本、SSH 指纹、停止和 generation 在派发与结果使用时重验；任意 Shell 不被只读外观豁免 unknown。
- **SEC-002**: 原 SDK 权限 broker 与原账本继续负责批准和验收；禁止读取 Lake 凭据、打印私钥和复制生产凭据，不允许通过本机 Shell 绕过宿主秘密保护。
- **CON-001**: 仅使用固定 运行时的公开导出和 ports，不改上游，不增加模型循环，不改变 Items/Security/Memory 所有权与原未决操作。
- **CON-002**: 使用签名 Lake Dev 构建；当前修改不等于整个 TS 产品/Windows/外部可选服务的等价验收，不放宽原完整切换门禁。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 建立实际工具与执行适配合同。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 新增 runtime/typescript/capabilities.ts，从公开 builtInTools 定义基础工具、控制工具及所需 ports；更新 agent-host.ts 允许宿主包装执行/上下文。 | true | 2026-11-06 |
| TASK-002 | 新增 runtime/typescript/execution.ts，包装公开 Node ExecutionPort 与 ssh.ts 连接，绑定资源、限时、输出、后台句柄及取消；在 security.ts 接通明确命令能力与原策略重验。本机执行隔离 Lake 私有状态。依赖 TASK-001。 | true | 2026-11-06 |

### Implementation Phase 2

- **GOAL-002**: Pilot、Worker 和 child 共享执行体系。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 重构 superagent.ts profile 为共享任务工具接点；Pilot 按当前 admitted batch 按需建立直接执行 Task，复用原 ledger；更新停止/恢复/投影，历史及纯路由不制造执行结果。依赖 TASK-002。 | true | 2026-11-06 |
| TASK-004 | 在 agent.ts 包装公开原生工具及本机/SSH execution ports，保留前台/后台生命周期和 child 来源；将 AskUserQuestion、Plan、Skill 连接已有交互/计划/技能权威；明确网络及可选服务的真实能力。依赖 TASK-003。 | true | 2026-11-06 |
| TASK-005 | 更新 super-prompts.ts、router-context.ts 和 agent.md，描述能力统一、默认委派和直接执行规则；任务原始上下文与当前权限保持分离。依赖 TASK-004。 | true | 2026-11-06 |

### Implementation Phase 3

- **GOAL-003**: 真实 SDK 验证并交付。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | 扩展 server.test.cjs，使用真实本机进程、SSH 协议夹具和公开 SDK 验证 Pilot 直接执行、Worker 自主命令、child、后台汇合、审批拒绝/版本变化/停止/unknown/秘密隔离；补能力清单及执行单元测试。依赖 TASK-004。 | true | 2026-11-06 |
| TASK-007 | 运行 TS/前端/既有 MySQL、Memory、任务、迁移与 ADK/Dev 边界回归，签名安装 Lake Dev，验证实际源码 SHA、界面和目录保持，记录真实远端/外部服务限制。依赖 TASK-005、TASK-006。 | true | 2026-11-06 |
| TASK-008 | 完成 docs/validation/typescript-candidate/agent-capabilities.md、runtime/typescript/README.md 和本计划，更新 PR 188 标题/说明及验证依据；保留开放待评审。依赖 TASK-007。 | true | 2026-11-06 |

## 3. Alternatives

- **ALT-001**: 只移除工具白名单。无法绑定 SSH、原审批和任务账本，也可能暴露未配置端口，不采用。
- **ALT-002**: 按每个 kubectl/mysql 场景增加固定工具。保留专用工具作为便捷读取，通用执行使用资源绑定的原生 Bash。

## 4. Dependencies

- **DEP-001**: 固定 Agent SDK 3.17.2 的公开 builtInTools、AgentRuntime、ExecutionPort、Node adapters、SubagentPort。
- **DEP-002**: LakeStore、TaskLedger、LakeSecurity、SSH 指纹及私有凭据、MCP/Skills、分层 Memory 和现有交互 UI。

## 5. Files

- **FILE-001**: runtime/typescript/capabilities.ts、execution.ts、agent-host.ts、agent.ts、superagent.ts、security.ts、ssh.ts、tasks.ts。
- **FILE-002**: runtime/typescript/super-prompts.ts、router-context.ts、server.ts、activity.ts、相关测试及工具能力清单。
- **FILE-003**: agent.md、runtime/typescript/README.md、docs/validation/typescript-candidate/agent-capabilities.md、本计划。

## 6. Testing

- **TEST-001**: Pilot 直接调用真实业务工具无需先创建专员；独立任务、原始来源、审批、child 工具输出与 Task 验收准确关联。
- **TEST-002**: SSH 通过已保存连接执行模型给出的实际命令，协议服务观察完整命令与取消；不以目录配置冒充远端成功。
- **TEST-003**: 本机命令、后台汇合、失败/超时/停止、配置和权限变化、跨项目及受限策略均有真实结果验证；凭据不能通过 Shell 或文件工具进入模型。
- **TEST-004**: 原 MySQL、Memory、路由、停止、计划与旧任务记录回归；前端类型/测试/构建和签名 Dev 来源通过；完整后端切换门禁保持拒绝。

## 7. Risks & Assumptions

- **RISK-001**: 关闭 SSH 通道不证明远端副作用回滚，未知结果仍保存原操作并禁止自动重放。
- **RISK-002**: 上游可选浏览器、厂商搜索、动态工作流及预约服务依赖对应实际端口；工具名存在不能代表服务已连接。
- **ASSUMPTION-001**: 当前授权包含完整通用 Agent 接入与本机/SSH Dev 验证，不包含自动重跑用户历史比较、修改真实远端业务或生产发布。

## 8. Related Specifications / Further Reading

- [模块职责](../agent.md)
- [Security](../docs/design/lake-security-v1.md)
- [执行 Port](../third_party/agent-sdk/apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts)
- [上游工具公开导出](../third_party/agent-sdk/apps/zcode-cli/packages/core/src/index.ts)
- [开发流程](../docs/development-workflow.md)
