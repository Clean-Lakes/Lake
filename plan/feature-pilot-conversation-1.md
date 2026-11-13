---
goal: Pilot 召集长期专员并收取真实对话回应
version: 1
date_created: 2026-11-13
last_updated: 2026-11-13
owner: Lake
status: 'In progress'
tags: [feature, pilot, conversation]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

为“全部干员报数”和指定多人讨论提供独立的对话轮次。使用现有 SDK、AgentHost、调度容量及角色频道；每人真实回应，超时和失败可见，最后由独立 Pilot 上下文汇总。本轮不产生业务目标，不修改原 Task 验收。

## 1. Requirements & Constraints

- **REQ-001**: `convene_specialists` 从当前真实人工事件建立轮次，冻结全部或明确 RoleID 收件人，同 event/part 重试幂等。
- **REQ-002**: 每位收件人拥有独立 SDK Session；只有当前有效执行的成功结束回调能够提交其回复，署名并投递至来源 Pilot 对话及角色频道。
- **REQ-003**: 宿主持久记录排队、回应中、已回应、失败、超时、中断和取消，等待全部收件人结清后由 Pilot 模型汇总。
- **SEC-001**: 对话执行只生成文字，不提供资源工具、任务工具、子智能体或记忆读取；不签发业务许可或成功证据。
- **SEC-002**: 模型派发及提交前检查当前项目、安全状态、角色存续、来源和轮次；停止后迟到回复失效，重启不重放。
- **CON-001**: 只使用 `codex/pilot-conversation-rounds -> develop`；未经用户明确授权不合并、不发布、不操作正式环境。
- **GUD-001**: 复用现有干员署名、Glyph、状态文字及主题；UI 只展示实际宿主状态。
- **PAT-001**: SQLite 事务内冻结回应和确定性投递 ID，复用现有 AgentRuntime 和主调度容量。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 接通独立对话生命周期。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 `runtime/typescript/specialist-conversations.ts` 实现 create/profile/pump/settled/stop/recover；接入 `superagent.ts` 当前人工来源、工具、调度、停止和工作区投影。 | ✅ | 2026-11-13 |
| TASK-002 | 在 `super-prompts.ts` 描述多人对话工具语义；保留资源工作原委派与验收合同，禁止代替干员回应。依赖 TASK-001。 | ✅ | 2026-11-13 |

### Implementation Phase 2

- **GOAL-002**: 交付可观察界面和验证证据，依赖 GOAL-001。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 扩展 `contracts.ts`、`AIPanel.tsx`、`superPilotActivity.ts` 及对话状态组件，按来源轮次显示每人状态与汇总状态。 | ✅ | 2026-11-13 |
| TASK-004 | 增加宿主生命周期、真实 HTTP/SDK 与前端回归，验证完整成功、缺席、停止、重启、重试、隔离和业务验收不变；运行签名 Lake Dev 验证并记录 SHA。依赖 TASK-003。 | 自动回归、独立 Home 签名模型与宽窗 UI 已完成；原生覆盖被 ACP 来源保护阻止，完整窄窗目视待验证，见验收记录。 | 2026-11-13 |

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

## 6. Testing

- **TEST-001**: 真实 SQLite + 受控 SDK 边界验证冻结名单、幂等、每人独立 Session、真实回复投递、空回应失败和 Pilot 汇总顺序。
- **TEST-002**: 注入时钟验证超时、取消、迟到回调、重启不重放及项目/角色隔离，不使用实际等待测试期限。
- **TEST-003**: HTTP/真实 SDK 合成模型验证工具发现、成员和汇总请求、持久消息，确保没有业务目标或 Operation。
- **TEST-004**: 前端类型、相关回归、完整构建以及 Lake Dev 明暗/窄窗验证，保留实际 tested SHA。

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
