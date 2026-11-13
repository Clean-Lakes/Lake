---
goal: Pilot 召集长期专员并收取真实对话回应
version: 1
date_created: 2026-11-13
last_updated: 2026-11-13
owner: Lake
status: 'Completed'
tags: [feature, pilot, conversation]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

为“全部干员报数”和指定多人讨论提供独立的对话轮次。使用现有 SDK、AgentHost、调度容量及角色频道；每人真实回应，超时和失败可见，最后由独立 Pilot 上下文汇总。本轮不产生业务目标，不恢复 ACP 分支已移除的业务验收。

## 1. Requirements & Constraints

- **REQ-001**: `convene_specialists` 从当前真实人工事件建立轮次，冻结全部或明确 RoleID 收件人，同 event/part 重试幂等。
- **REQ-002**: 每位收件人冻结既有 Agent/模型与头像，拥有独立原生 SDK 或 Codex ACP Session；只有当前有效执行的成功结束回调能够提交其回复，署名并投递至来源 Pilot 对话及角色频道。
- **REQ-003**: 宿主持久记录排队、回应中、已回应、失败、超时、中断和取消，等待全部收件人结清后由 Pilot 模型汇总。
- **SEC-001**: 对话执行只生成文字，不提供资源工具、任务工具、子智能体或记忆读取；不签发业务许可或成功证据。
- **SEC-002**: 模型派发及提交前检查当前项目、安全状态、角色存续、来源和轮次；停止后迟到回复失效，重启不重放。
- **CON-001**: 初版使用 `codex/pilot-conversation-rounds -> develop`；2026-11-13 用户授权在 `codex/acp-pilot-integration -> develop` 整合 ACP 并安装 Lake Dev；未经用户明确授权不合并、不发布、不操作正式环境。
- **GUD-001**: 复用现有干员署名、Glyph、状态文字及主题；UI 只展示实际宿主状态。
- **PAT-001**: SQLite 事务内冻结回应和确定性投递 ID，复用现有 AgentRuntime 和主调度容量。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 接通独立对话生命周期。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 `runtime/typescript/specialist-conversations.ts` 实现 create/profile/pump/settled/stop/recover；接入 `superagent.ts` 当前人工来源、工具、调度、停止和工作区投影。 | ✅ | 2026-11-13 |
| TASK-002 | 在 `super-prompts.ts` 描述多人对话工具语义；保留资源工作的委派和当前报告协议，禁止代替干员回应。依赖 TASK-001。 | ✅ | 2026-11-13 |

### Implementation Phase 2

- **GOAL-002**: 交付可观察界面和验证证据，依赖 GOAL-001。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 扩展 `contracts.ts`、`AIPanel.tsx`、`superPilotActivity.ts` 及对话状态组件，按来源轮次显示每人状态与汇总状态。 | ✅ | 2026-11-13 |
| TASK-004 | 增加宿主生命周期、真实 HTTP/SDK 与前端回归，验证完整成功、缺席、停止、重启、重试、隔离和业务记录不变；运行签名 Lake Dev 验证并记录 SHA。依赖 TASK-003。 | ✅；原来源限制已由 TASK-005～008 的完整集成与安装解决。 | 2026-11-13 |

### Implementation Phase 3

- **GOAL-003**: 整合 ACP 与多人对话，在固定 Lake Dev 中完成安装及验收；依赖 GOAL-001 和 GOAL-002。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | 从当前 origin/develop 建立集成分支，保留 ACP f62a1158 与对话 b8115453 的完整历史，解决调度、角色身份和对话展示冲突。 | ✅ | 2026-11-13 |
| TASK-006 | 在 AgentHost/ACP 添加无业务 Task 的 conversation 来源，按冻结角色配置运行原生或 Codex，禁止工具和重放，保留实际 Agent Logo 及头像；补充回归。依赖 TASK-005。 | ✅ | 2026-11-13 |
| TASK-007 | 运行组合源码/SDK/ACP/前端检查，备份并停止现有 Dev，使用标准签名桌面入口安装，核对已安装源码和进程。依赖 TASK-006。 | ✅；已安装干净来源 c270f6c8，严格签名及隔离路径验证通过。 | 2026-11-13 |
| TASK-008 | 在安装的 Lake Dev 验证真实召集、缺席/停止、角色配置、明暗及完整窄窗布局；保留 tested SHA 并让用户可直接试用。依赖 TASK-007。 | ✅；原项目真实六人 Codex 报到及 Pilot 汇总、独立 QA 缺席与停止、明暗宽/窄窗、焦点与输入光标通过。 | 2026-11-13 |

## 3. Alternatives

- **ALT-001**: 只修改提示词无法提供真实收件人、回执、超时和停止语义，因此不采用。
- **ALT-002**: 将报到伪装成业务 Task 会与工具证据验收混淆，因此采用独立对话记录并复用执行宿主。

## 4. Dependencies

- **DEP-001**: 已有 `LakeAgents`、稳定 RoleID、角色频道、SQLite records 和公开 SDK Session。
- **DEP-002**: 当前项目模型配置及签名 Lake Dev 构建入口。

## 5. Files

- **FILE-001**: `runtime/typescript/specialist-conversations.ts`、对应测试及 `superagent.ts`：生命周期和集成。
- **FILE-002**: `web-agent/shared/contracts.ts`、`web-agent/web/src/PilotConversationProgress.tsx`、`AIPanel.tsx`、`superPilotActivity.ts`：公开投影和 UI。
- **FILE-003**: `runtime/typescript/super-prompts.ts`、`agent.md`、`docs/lake-pilot.md`：行为及架构说明。
- **FILE-004**: `docs/validation/typescript-candidate/pilot-conversation-2026-11-13.md`：最终测试记录。
- **FILE-005**: `docs/validation/acp-agent-execution/pilot-conversation-integration-2026-11-13.md` 及相邻证据目录：本次组合构建、真实 Lake Dev 和补齐的界面验收。

## 6. Testing

- **TEST-001**: 真实 SQLite + 受控 SDK 边界验证冻结名单、幂等、每人独立 Session、真实回复投递、空回应失败和 Pilot 汇总顺序。
- **TEST-002**: 注入时钟验证超时、取消、迟到回调、重启不重放及项目/角色隔离，不使用实际等待测试期限。
- **TEST-003**: HTTP/真实 SDK 合成模型验证工具发现、成员和汇总请求、持久消息，确保没有业务目标或 Operation。
- **TEST-004**: 前端类型、相关回归、完整构建以及 Lake Dev 明暗/窄窗验证，保留实际 tested SHA。
- **TEST-005**: ACP/原生混合 HTTP 召集、冻结 Agent/模型/头像、单成员配置失败；真实固定版 Codex 验证无 Lake MCP 传输、无业务 Task、跨轮次及带工具/续会拒绝，本机配置、登录和扩展陷阱保持不变。

## 7. Risks & Assumptions

- **RISK-001**: 模型可能把召集误判为普通聊天；用明确工具说明和真实模型 Dev 实测检查，宿主保证已经登记轮次的完成约束。
- **RISK-002**: 模型超时或后端退出会造成缺席；以真实终态投影，不从部分输出补造回应，不自动重试。
- **ASSUMPTION-001**: 纯文字多人讨论不执行资源操作；后续业务要求继续通过原 `route_work` 单独派工。

## 8. Related Specifications / Further Reading

- [架构约定](../agent.md)
- [Lake Pilot](../docs/lake-pilot.md)
- [贡献规范](../CONTRIBUTING.md)
- [分支与发布规范](../docs/development-workflow.md)
- [本次验收与安装限制](../docs/validation/typescript-candidate/pilot-conversation-2026-11-13.md)
- [ACP 集成与已安装 Dev 验收](../docs/validation/acp-agent-execution/pilot-conversation-integration-2026-11-13.md)
