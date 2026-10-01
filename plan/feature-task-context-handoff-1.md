---
goal: Lake 使用可恢复的结构化任务交接记录和按 Token 空间调整的上下文压缩
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [context, compaction, task-state, recovery]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

参考 Codex 的上下文接续和外部持久状态机制，在 Lake 现有模型协议上实现带来源的结构化交接记录。用户目标、硬约束、已报告结果、未完成事项、下一步和记录引用分别保存；保留原文检索与失败附件保护。

## 1. Requirements & Constraints

- **REQ-001**: 压缩输出包含独立的 TaskState 字段，并与摘要、来源覆盖集合一起原子存入 SQLite；旧纯文字摘要可以继续恢复。
- **REQ-002**: 用户目标和约束必须引用实际用户来源并保留原文引句；前次约束不能因模型遗漏而消失；交接记录不授予操作权限或证明助手声明为实际执行成功。
- **REQ-003**: 压缩保留量按照 Token 空间选择，近期消息上限 64 条；摘要及任务状态合计预算为输入空间的五分之一且最多 4096 Token；当前请求、失败附件和固定资料保持原样。
- **REQ-004**: 摘要模型不调用工具，格式不完整时使用可核对的原文交接记录，不重复执行用户任务；取消或预算不足时不覆盖旧记录。
- **SEC-001**: 不保存认证字段或私钥，状态来源仅限当前会话；任务状态使用历史资料角色，不替代真实权限校验。
- **CON-001**: 本轮保持用户模型配置，使用跨模型可读交接记录；OpenAI 加密压缩项不能在其他模型协议上伪装或复用。
- **CON-002**: 用户二进制和桌面应用通过签名脚本构建安装，重启前检查任务和草稿。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 实现结构化且可核对的压缩交接。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | lake/agent/task_state.go 定义 TaskState、带来源事实、生成提示词、原文回退和约束合并；compact.go 将交接状态参与下一次分块摘要和输入预算。 | Yes | 2026-10-01 |
| TASK-002 | lake/agent/context.go 增加状态字段；compact.go 使用自适应摘要预算和保留空间，保持失败保护及整轮边界；添加 /compact 与自动压缩阈值配置。依赖 TASK-001。 | Yes | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 持久恢复与完成验证。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | lake/store/task_context.go 实现 v19 task_state 列迁移；agent_event.go 原子保存并验证状态来源；cmd/lake/chat.go 与 bridge.go 恢复和提交状态。依赖 TASK-001。 | Yes | 2026-10-01 |
| TASK-004 | 添加 agent 状态及多次压缩测试、store 迁移及来源隔离测试、bridge 重开接续测试；更新 README.md。依赖 TASK-002、TASK-003。 | Yes | 2026-10-01 |
| TASK-005 | 运行 Go race/vet、必要前端验证；scripts/build_lake_desktop.sh --install 签名安装，空闲时重启并验签。依赖 TASK-004。 | Yes | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 直接使用 OpenAI opaque 压缩项需要匹配服务与模型，不能适配已有 Anthropic/Chat 网关；本轮使用可读结构化交接。
- **ALT-002**: 只增大文字摘要不能保证关键约束不丢失；状态分类、来源校验和既有约束合并同时实现。

## 4. Dependencies

- **DEP-001**: 现有 PrepareContext、SummarizeWithModel、conversation_summary 和只读历史检索。
- **DEP-002**: Go/Eino 模型适配器、SQLite 私有存储和 macOS 签名构建脚本。

## 5. Files

- **FILE-001**: lake/agent/task_state.go、task_state_test.go、context.go、compact.go、context_test.go。
- **FILE-002**: lake/store/task_context.go、task_context_test.go、agent_event.go、store.go。
- **FILE-003**: cmd/lake/chat.go、bridge.go、conversation_context.go、model_config.go，以及 chat_test.go、bridge_test.go、model_config_test.go、context_recovery_test.go；README.md；本计划。
- **FILE-004**: lake/store/migration_fixtures_external_test.go 升级断言同步至 v19。

## 6. Testing

- **TEST-001**: 连续分块及多次压缩时保留用户约束；非法来源与助手伪授权不能进入用户目标或约束。
- **TEST-002**: 自适应保留量、长消息分块、失败图片、取消和固定资料预算回归。
- **TEST-003**: v18 升级到 v19 保留历史摘要；状态随摘要原子保存、重开恢复、跨会话来源拒绝、敏感字段拒绝。
- **TEST-004**: 桥接模拟模型在重开后接收到状态分类与原始约束；签名构建安装通过。

验证结果：`go test -race ./lake/... ./cmd/lake` 与 `go vet ./lake/... ./cmd/lake` 均通过。覆盖三次压缩、模型遗漏约束、非法来源、失败附件、配置阈值、手动压缩不调用主 Agent、重开恢复，以及旧摘要数据库升级。桌面构建中的 TypeScript 编译和 Wails 打包通过。

2026-10-01 21:00 构建签名应用 `Lake-20261001-210039-50422.app`，安装到 `/Users/lingyunxieqing/Applications/Lake.app`，保留旧应用备份。确认任务空闲、输入框为空后重启新版；本机数据库只读核验版本 19 与 task_state 列存在，历史会话保留。应用和 CLI 的签名身份均为 Lake Local Development Code Signing，通过严格验签。此轮运行验证仅使用模拟模型，未重跑远端任务。

## 7. Risks & Assumptions

- **RISK-001**: 模型会遗漏或错误分类信息；使用来源校验和原文约束合并，保存完整历史供回查，不能声称无损永久记忆。
- **RISK-002**: 受保护资料本身超过模型窗口时仍需明确提示，不能静默丢弃。
- **RISK-003**: 本地 Token 估计与服务商实际分词可能不同；此轮处理会话历史接续，未实现 Agent 同一轮内工具循环的原生服务端压缩。待办与结果保留历史来源，可能需要模型按较新的实际记录核对。
- **ASSUMPTION-001**: 用户授权实现 Lake 的 Codex 式任务接续机制，未要求更换模型或自动重跑远端操作。

## 8. Related Specifications / Further Reading

[会话连续性](refactor-conversation-continuity-1.md)
[Codex 配置](https://learn.chatgpt.com/docs/config-file/config-reference)
[OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction)
[构建规则](../AGENTS.md)
