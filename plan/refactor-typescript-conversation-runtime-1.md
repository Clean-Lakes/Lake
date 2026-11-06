---
goal: Restore conversational continuity and simplify ordinary Agent SDK task execution
version: 1
date_created: 2026-11-05
last_updated: 2026-11-05
owner: Lake
status: 'Completed'
tags: [architecture, refactor, typescript, conversation]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

用户授权保留 Pilot 与独立 Worker，改造 TypeScript Dev 的上下文、续派、普通任务协议与状态展示。实际缺陷：Pilot 读取修复前的 SSH unavailable 任务记录后直接报告当前缺少能力，未续派；此前“再试试”没有近期对话锚点。本计划不代表完整 TS 功能等价验收完成。

## 1. Requirements & Constraints

- **REQ-001**: Router 请求包含当前来源频道近期对话、最新公开专员报告、当前业务焦点和实际适配器能力；历史阻碍标注记录时间。
- **REQ-002**: followup 返回真实调度结果与具体原因；普通任务由宿主绑定步骤、attempt 和工具回执，模型只提供业务交付判断。
- **REQ-003**: 需确认只来源于当前真实交互；独立且宿主证明只读的诊断可继续，未知副作用仍禁止重放。
- **SEC-001**: 项目、当前权限、凭据、连接版本、原操作身份和明确人工/Plan 契约仍由现有权威记录校验。MCP annotation 不证明只读。
- **CON-001**: 继续使用 Agent SDK v3.17.2 官方 AgentRuntime，不新增模型循环，不访问正式 Home，不改旧 Go 记录；普通 PR 仍指向 develop，合并须另获用户授权。
- **PAT-001**: 最近对话是有来源的参考，不授予权限；旧任务原始记录保留，避免改写旧失败为成功。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 修复实际请求工作集和续派的可见性。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 新增 runtime/typescript/router-context.ts，构建有字节上限的近期消息、焦点、能力及任务摘要；在 superagent.ts 的 pump/profile/projectRouterRequest 接入 | ✅ | 2026-11-05 |
| TASK-002 | superagent.ts route 返回 queued/running/needs_input/limit_reached 等准确 dispatch 结果；保留事件幂等，不伪报启动 | ✅ | 2026-11-05 |

### Implementation Phase 2

- **GOAL-002**: 普通任务以业务工具和交付报告执行；依赖 GOAL-001 的上下文验收。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | tasks.ts 新增 host_managed 执行模式，自动准备普通步骤与回执；明确业务交付加真实当前回执才能完成，目录发现不能单独验收实质目标 | ✅ | 2026-11-05 |
| TASK-004 | superagent.ts 接入轻量工具表、work_finish 业务结果提交、实际报告保存；super-prompts.ts 精简全局协议，显式 Plan/旧复杂计划维持原契约 | ✅ | 2026-11-05 |

### Implementation Phase 3

- **GOAL-003**: 收敛阻断范围和真实等待状态，完成 Dev 验证；依赖 GOAL-002。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | tasks.ts 按宿主证明的只读能力允许独立诊断，保留原 unknown 与写入禁重放；superagent.ts 不因 unknown 阻止模型进行诊断判断 | ✅ | 2026-11-05 |
| TASK-006 | 后端频道和前端 PilotWorkspace 仅根据当前交互显示需确认；旧 waiting_user 不制造弹窗或批准 | ✅ | 2026-11-05 |
| TASK-007 | 新增协议、行为及隔离测试，运行 TS/前端检查；签名构建安装 TS Dev，验证运行来源、真实多轮续派和回执 | ✅ | 2026-11-05 |

## 3. Alternatives

- **ALT-001**: 继续追加提示词禁令，无法补回已裁掉的对话或提供实际能力，拒绝。
- **ALT-002**: 所有工具直接放入 Pilot，扩大上下文且改变独立任务设计；本次保留现有职责划分。
- **ALT-003**: 取消权限和原操作账本，会使未知写入重复执行；不采用。

## 4. Dependencies

- **DEP-001**: 已有 Agent SDK 3.17.2 SDK、LakeStore、TaskLedger、SSH/扩展适配器和真实审批交互。
- **DEP-002**: macOS 持久签名身份与 scripts/build_lake_desktop.sh --dev --ts-candidate --install。

## 5. Files

- **FILE-001**: runtime/typescript/router-context.ts 与对应测试：请求工作集与边界。
- **FILE-002**: runtime/typescript/superagent.ts、tasks.ts、super-prompts.ts：调度、工具入口、执行记录及交流。
- **FILE-003**: web-agent/web/src/PilotWorkspace.tsx 与相关前端测试：真实确认状态。
- **FILE-004**: agent.md、runtime/typescript/README.md、docs/validation/typescript-candidate/conversation-runtime.md：当前架构与验证结果。

## 6. Testing

- **TEST-001**: 旧 unavailable 报告、恢复能力、用户“再试试”、同一任务续派、实际 inspect_host 和真实报告；不得用预设模型顺序冒充真实模型验证。
- **TEST-002**: 近期公开报告进入实际 provider 请求；多任务焦点、频道/项目隔离、UTF-8 与请求预算、旧档案保留。
- **TEST-003**: 普通工具无需 work_begin/update；目录发现、伪造/失败/旧回执不能完成；Plan 与旧多步骤契约不被隐式接管。
- **TEST-004**: unknown 写入保留且不能重放，独立只读诊断允许；明确 deny/审批与连接版本变更仍生效。
- **TEST-005**: 旧 waiting_user 无交互不显示需确认；真实审批和问题正常可操作。

## 7. Risks & Assumptions

- **RISK-001**: 真实模型会受历史语句影响；同时验证实际请求和多轮模型行为，不仅验证工具能独立运行。
- **RISK-002**: 普通模式自动记录不能推断业务完成；完成仍需模型明确业务交付判断和宿主验证当前成功回执。
- **ASSUMPTION-001**: 用户已授权本次架构实施及覆盖 TypeScript Dev；没有授权合并或正式发布。

## 8. Related Specifications / Further Reading

- [模块所有权和当前迁移方向](../agent.md)
- [任务确认与验收](../docs/security/task-confirmation.md)
- [上下文契约](../docs/design/context-role-memory-contract.md)
- [贡献流程](../CONTRIBUTING.md)
- [开发与发布规范](../docs/development-workflow.md)
