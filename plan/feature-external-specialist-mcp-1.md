---
goal: 外部研发 Agent 经 MCP 给长期专员发指令
version: 1
date_created: 2026-11-14
last_updated: 2026-11-14
owner: Lake
status: 'Completed'
tags: [feature, gateway, mcp, specialist]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

研发人员在自家 Agent（Claude Code、Codex CLI 等）中为每个专员配置一条 stdio MCP 入口，直接发指令、收回应。指令复用专员频道真实人工输入链路（InputEvent → Pilot 路由 → route_work → Worker → 署名报告回投频道）；Lake Security、operation permissions、计划/审批确认照旧在 Lake 界面完成。接入形态：`--mcp-specialist` stdio 子命令（每个专员一个 MCP 条目）；鉴权：独立签发的受限网关凭据。

## 1. Requirements & Constraints

- **REQ-001**: `--mcp-specialist` stdio 入口提供 `send_instruction`（`client_request_id` 幂等）、`wait_instruction`（≤600s）、`get_instruction_status`；共享模式另有 `list_specialists`，单专员模式拒绝其他 RoleID。
- **REQ-002**: 指令经 `gatewayInstruction` 复用 `LakeSuperagent.send()` 到频道会话，InputEvent/Message 带 `external:{kind:'mcp'}` 标记，`preferredRoleId` 绑定专员；同 `clientRequestId` 幂等重放、内容变化 409。
- **REQ-003**: `instructionStatus` 投影事件 disposition、Decision、任务/Goal 状态、`pendingInteraction` 等待与频道署名回应；`waitSeconds≤60` 服务端长轮询。
- **REQ-004**: 设置 → Agent 页签提供网关凭据创建（可限定专员）、删除与可复制的 MCP 配置命令（`/api/settings/gateway/tokens` 返回本安装的精确命令）。
- **SEC-001**: 网关凭据存 `<Home>/secrets/mcp-gateway.json`（0600/0700 私有文件、constant-time 比较、可吊销），仅授权发指令与读状态；与 UI 会话令牌互不通用，Cookie 不被网关接受。
- **SEC-002**: 网关工具不提供资源工具、不签发许可或验收证据；每次变更过 `security.check()`；stdio 进程只经回环 HTTP 访问后端（拒绝非回环 origin），不直接打开 SQLite。
- **SEC-003**: 已停止/已取消任务的署名通知不得冒充正常回应；停止频道后未结指令进入 stopped。
- **CON-001**: 只使用 `codex/external-specialist-mcp -> develop`；未经用户明确授权不合并、不发布、不操作正式环境。
- **GUD-001**: 频道消息显示"外部 Agent"徽标（Glyph `plug` + `--radius-settings-badge`）；设置卡片复用 `external-agent-panel`、`AppSelect` 与主题 tokens。
- **PAT-001**: 幂等键 `digest([projectId, roleId, clientRequestId])` 记录于 `superGatewayInstructions`（沿用 `superAgentAssignments` 模式）；回环地址校验复用 runtime.json。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 受限网关与后端路由。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | `gateway.ts`：凭据生命周期（创建/列表/删除/constant-time 认证/角色范围/`resolveToken`），私有文件校验复用扩展配置模式；`gateway.test.ts` 覆盖生命周期、越权、篡改文件与安全围栏。 | ✅ | 2026-11-14 |
| TASK-002 | `superagent.ts`：`gatewaySpecialists`、`gatewayInstruction`、`instructionStatus`（含任务取消/失败与停止通知的状态归类）；`send()` 与 `store.addMessage` 支持 `external` 标记；`router-context`/`super-prompts` 注明外部来源。 | ✅ | 2026-11-14 |
| TASK-003 | `server.ts`：`/api/gateway/*` 网关认证分支（Bearer-only）、specialists/instructions 路由、`/api/settings/gateway/*` 会话态管理路由与命令信息。 | ✅ | 2026-11-14 |

### Implementation Phase 2

- **GOAL-002**: stdio 入口、前端与验证；依赖 GOAL-001。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | `mcp-stdio.ts`：`specialistTools`（回环 endpoint 校验、token 解析、角色绑定、wait 轮询）+ `runSpecialistMcp` 注册与 `--mcp-specialist` argv 分支；`mcp-stdio.test.ts` 直测工具语义。 | ✅ | 2026-11-14 |
| TASK-005 | 前端：`GatewaySettings.tsx`（创建/限定/删除/复制命令）接入 Agent 页签；`TranscriptMessage` 外部 Agent 徽标；`gatewaySettings.css`；api helpers；`gatewaySettings.test.ts`。 | ✅ | 2026-11-14 |
| TASK-006 | `gateway.test.cjs`：真实 HTTP 端到端——完整 Pilot 路由→Worker→署名报告、幂等/内容冲突、错误令牌/会话令牌/越权/吊销、停止频道、无效 waitSeconds。 | ✅ | 2026-11-14 |
| TASK-007 | 隔离签名实例真实模型端到端：stdio MCP 握手/工具发现/发指令/收报告、幂等重放、吊销即 401、UI 徽标与设置卡片明暗窄窗；验证记录与截图。 | ✅；发现并修复公共指令 ID 解析两处遗漏（0660e9ed、1b947a7e）。 | 2026-11-14 |

## 3. Alternatives

- **ALT-001**: 后端 Streamable HTTP MCP 端点——需要稳定端口与新的对外监听面，且 Dev 应用端口随机；stdio 子进程不新增监听面且每个专员一个入口，故采用。
- **ALT-002**: 复用 runtime.json 进程令牌——等于完整 API 权限，与单令牌安全模型不符；采用独立受限网关凭据。
- **ALT-003**: 仅文字回应（复用对话轮次机制）——用户明确选择完整业务路径，指令等同频道人工输入。

## 4. Dependencies

- **DEP-001**: 既有专员频道链路（`superInputs`/`superChannels`/Pilot 路由/Worker 报告投递）与 SSE/通知端口。
- **DEP-002**: vendored `@modelcontextprotocol/server`（`acp/bridge.ts` 同款）与 `secrets/` 私有文件约定。

## 5. Files

- **FILE-001**: `runtime/typescript/gateway.ts`、`mcp-stdio.ts`、`gateway.test.ts`、`mcp-stdio.test.ts`、`gateway.test.cjs`：网关与入口。
- **FILE-002**: `runtime/typescript/server.ts`、`superagent.ts`、`store.ts`、`router-context.ts`、`super-prompts.ts`：路由、来源标记与投影。
- **FILE-003**: `web-agent/shared/contracts.ts`、`web-agent/web/src/GatewaySettings.tsx`、`gatewaySettings.css`、`ModelSettings.tsx`、`AIPanel.tsx`、`api.ts`：公开类型与 UI。
- **FILE-004**: `docs/lake-pilot.md`、`agent.md`：行为与架构说明。
- **FILE-005**: `docs/validation/typescript-candidate/external-specialist-mcp-2026-11-14.md` 及相邻截图目录：最终验证记录。

## 6. Testing

- **TEST-001**: `gateway.test.ts`——凭据生命周期、constant-time 认证、角色范围、篡改/符号链接/坏 JSON 拒绝、安全围栏。
- **TEST-002**: `mcp-stdio.test.ts`——回环校验、共享/单专员模式、令牌解析歧义、连接失败呈现、等待回路。
- **TEST-003**: `gateway.test.cjs`——真实 startLakeServer + 合成模型全链路（发指令→路由→Worker→报告）、幂等/冲突、认证矩阵、停止、参数校验。
- **TEST-004**: 前端类型、全量回归、构建；隔离签名 Lake Dev 实测脚本化 MCP 客户端真实指令 + UI 徽标/审批，记录 tested SHA。

## 7. Risks & Assumptions

- **RISK-001**: 外部指令等同人工输入可触发业务任务；缓解——审批照旧在 Lake UI，网关令牌可随时吊销、可限定专员。
- **RISK-002**: 研发 Agent 可能误用 `list_specialists` 之外的 RoleID；单专员模式硬绑定，共享模式返回 404/403。
- **ASSUMPTION-001**: stdio 进程与 Lake 后端同一用户、同一 Home（读取 runtime.json 与 secrets 文件）；跨机接入不在本轮范围。
- **ASSUMPTION-002**: `wait_instruction` 的 600s 上限足够长任务轮询；更长的进度由 `get_instruction_status` 分次读取。

## 8. Related Specifications / Further Reading

- [架构约定](../agent.md)
- [Lake Pilot · 外部研发 Agent 接入](../docs/lake-pilot.md)
- [贡献规范](../CONTRIBUTING.md)
- [分支与发布规范](../docs/development-workflow.md)
