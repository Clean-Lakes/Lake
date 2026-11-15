---
goal: 将专员 MCP 改为项目级消息接入，并展示来源消息与现有任务的关联
version: 1
date_created: 2026-11-15
last_updated: 2026-11-15
owner: Lake
status: 'In progress'
tags: [refactor, superagent, mcp, channels]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

用户选定含「消息与任务」的接入渠道渲染图，并授权功能、UI、回归测试及 Lake Dev 验证。MCP 接入作为 Super Agent 的消息入口，连接绑定项目，默认由 Pilot 路由；来源消息显示现有 Task/Worker 的进展与报告。继续使用已有 `codex/external-specialist-mcp -> develop` PR，不合并或发布。

## 1. Requirements & Constraints

- **REQ-001**: 接入连接拥有稳定 id、名称、项目、启用状态和 Pilot/固定专员路由方式；项目创建后不可改变，跨项目另建连接。
- **REQ-002**: `--mcp-channel --connection <id>` 提供 `send_message`、`get_message_status`、`wait_message`、`test_connection`；消息必须带外部线程和客户端消息键，追问用准确 `reply_to`。
- **REQ-003**: 幂等范围为连接、线程和消息键；请求内容变化冲突。消息、事件和回执原子提交。不同外部会话不共享 Router 批次或回复。
- **REQ-004**: 状态投影包含全部关联任务的身份、专员、执行会话、当前进展及准确报告；一项任务的报告不能提前结清多任务消息。
- **REQ-005**: 独立「接入渠道」设置页采用选定的主从布局；支持创建、启停、路由设置、复制接入配置、测试、删除、消息分页及现有任务详情导航。
- **SEC-001**: 连接身份、项目由已验证凭据派生；跨连接/线程读取与续接拒绝；停用、吊销及配置改变在异步准入提交前和长轮询返回前重验。
- **SEC-002**: 既有单专员凭据、CLI、指令及回执保持原范围；不得自动升级为项目权限。模型、SSH 和网关秘密不进入日志、文档或截图。
- **CON-001**: 只实现本机 MCP 适配器；不宣称 Webhook、IM、跨机或推送订阅已经交付。MCP 查询返回原消息的结果，不声称客户端已经阅读。
- **GUD-001**: 使用 AppSelect、Glyph、已有主题与 superellipse 圆角；验证深浅主题、窄窗、键盘、任务详情与所有主要交互。
- **PAT-001**: Task/Worker 仍是唯一执行记录；接入连接和消息只管理来源及结果投影，不建立第二套任务、审批或验收。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成连接、消息与 MCP 协议，保留旧入口。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | `web-agent/shared/contracts.ts` 定义连接、路由、消息列表和任务来源契约。 | true | 2026-11-15 |
| TASK-002 | `runtime/typescript/gateway.ts` 实现私有连接凭据、CRUD、状态与当前范围验证；`server.ts` 注册 settings 和受限消息 API。 | true | 2026-11-15 |
| TASK-003 | `runtime/typescript/superagent.ts` 实现连接消息准入、线程幂等、准确续接、Router 历史隔离、全任务状态与报告投影。 | true | 2026-11-15 |
| TASK-004 | `runtime/typescript/mcp-stdio.ts` 与 `server.ts` CLI 分支实现项目级工具、预算内等待和无模型连接检查。 | true | 2026-11-15 |

### Implementation Phase 2

- **GOAL-002**: 按选定界面实现真实交互并接通任务详情；依赖 Phase 1 契约。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | `GatewaySettings.tsx`、`gatewaySettings.css` 实现连接列表/详情、消息到任务关系、空态/错误/分页和复制配置。 | true | 2026-11-15 |
| TASK-006 | `ModelSettings.tsx`、`App.tsx`、`api.ts` 分离渠道/执行器/工具入口，按准确项目、会话和任务身份打开既有任务详情。 | true | 2026-11-15 |

### Implementation Phase 3

- **GOAL-003**: 完成回归、签名 Dev 实测及可复查记录；依赖前两阶段。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | 运行 TS、HTTP、前端回归和构建、架构边界检查；覆盖原七项可靠性回归。 | true | 2026-11-15 |
| TASK-008 | `scripts/build_lake_desktop.sh --dev --install` 安装签名 Dev，以隔离 Home 和本地模型夹具实测官方 MCP SDK、消息/多任务/回复、接入管理及 UI。 | false | — |
| TASK-009 | 更新 `agent.md`、`docs/lake-pilot.md`、验证报告与 PR 描述，记录准确 tested SHA、限制和截图，恢复日常 Dev 项目。 | false | — |

## 3. Alternatives

- **ALT-001**: 仅重命名旧专员网关不满足项目级路由和线程身份，弃用。
- **ALT-002**: 为渠道新建任务调度器造成双重执行权威，弃用；只投影现有任务。
- **ALT-003**: 自动迁移旧角色凭据会扩大权限，弃用；旧配置保留为兼容接入。

## 4. Dependencies

- **DEP-001**: 现有 `superInputs`、事务回执、Pilot、Task/Worker、报告投递和任务详情。
- **DEP-002**: 已固定的官方 MCP SDK 与现有前端控件，无新增外部服务。

## 5. Files

- **FILE-001**: `runtime/typescript/{gateway,server,mcp-stdio,superagent,router-context}.ts` 及相关回归文件。
- **FILE-002**: `web-agent/shared/contracts.ts`、`web-agent/web/src/{GatewaySettings,ModelSettings,App,AIPanel}.tsx`、样式、API 与前端测试。
- **FILE-003**: `agent.md`、`docs/lake-pilot.md`、`docs/validation/typescript-candidate/` 下本次验证记录。

## 6. Testing

- **TEST-001**: 连接 CRUD、私有文件、固定项目、无角色越界、停用/吊销、旧凭据不升级及重启。
- **TEST-002**: 并发幂等/内容冲突/事务回滚、连接与线程隔离、准确追问、上下文隔离、Router 回复归属、多任务部分报告和结束状态。
- **TEST-003**: MCP 新旧工具、复制配置 custom data 路径、截止时间、连接测试不派发模型。
- **TEST-004**: UI 连接切换、分页、异步刷新、任务链接、空/错误/加载状态、深浅主题、窄窗与键盘焦点。
- **TEST-005**: 签名安装版本的原生 Lake Dev、官方 SDK 端到端和已有日常数据恢复；不把模型夹具写为真实业务验收。

## 7. Risks & Assumptions

- **RISK-001**: Project Router 的共享 Session 历史可能混入其他来源，必须在单次工作集和 SDK 历史投影共同隔离并回归。
- **RISK-002**: 多任务的早期报告或 Pilot 确认容易误作终态，必须从全部关联执行状态计算。
- **ASSUMPTION-001**: 当前接入为同一台机器、同一系统用户的受限委托；其他来源协议将单独实现身份与授权映射。

## 8. Related Specifications / Further Reading

- [架构约定](../agent.md)
- [前端规范](../docs/ui-guidelines.md)
- [贡献规范](../CONTRIBUTING.md)
- [任务与报告](../docs/security/task-confirmation.md)
- [原网关实现](feature-external-specialist-mcp-1.md)
- [前轮可靠性验证](../docs/validation/typescript-candidate/external-specialist-mcp-fixes-2026-11-15.md)
