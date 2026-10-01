---
goal: 失败轮次和附件持续保留并支持同会话原文检索
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [context, memory, continuity, recovery]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

当前历史恢复只纳入非空回复，导致失败请求及附件消失，后续“继续”错误地指向旧任务。统一实时与重载的失败上下文，保护尚未完成的最近请求，并提供有界的本会话历史原文检索。

## 1. Requirements & Constraints

- **REQ-001**: 失败轮次的用户请求、有效图片、问答答案进入实时和重载上下文；失败状态不能表示成功或执行许可。
- **REQ-002**: 未完成请求及图片在压缩时保留；成功回复结束本轮保留标记。摘要恢复依据实际来源集合，不能跳过未被摘要覆盖的较小序号。
- **REQ-003**: AI 可分页检索当前会话历史文字，按关键词或轮次 ID 读取有界原文；历史附件仅返回元数据，不把编码塞入文字工具结果。
- **SEC-001**: 不读取、输出或配置截图中的认证信息，不自动执行或重放远端任务；历史工具不能选择其他会话，敏感字段脱敏。
- **CON-001**: 保留原始数据库记录，正常使用签名构建脚本安装，重启前确认会话空闲与草稿状态。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 一致恢复请求和失败状态。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | cmd/lake/conversation_context.go统一错误历史消息生成；chat.go加载所有轮次，失败时记录有效输入并绑定来源，按摘要实际来源跳过记录。 | Yes | 2026-10-01 |
| TASK-002 | lake/agent/context.go添加Preserve标记；compact.go在预算内保留标记消息并压缩其他历史；store/agent_event.go允许同摘要水位补入更早来源且禁止来源减少；context_test.go验证非连续保留与超预算行为。 | Yes | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 压缩后可核对历史原文。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | lake/store/conversation_history.go实现会话限定、有界分页与脱敏；cmd/lake/conversation_history_tool.go注册lake_conversation_history只读工具，加入报告查看模式及活动目录。 | Yes | 2026-10-01 |
| TASK-004 | cmd/lake/context_recovery_test.go验证失败携图后继续、同进程和重启、压缩、来源及旧内容检索；store测试校验跨会话隔离与脱敏；README.md记录能力边界。依赖TASK-001、TASK-002、TASK-003。 | Yes | 2026-10-01 |
| TASK-005 | 运行相关Go race/vet和前端目录测试，脚本签名构建并安装桌面应用，空闲时重启。依赖TASK-004。 | Yes | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 仅提示模型记住用户没有输入数据仍然不可用；修复数据恢复路径。
- **ALT-002**: 把所有历史与图片永远装进窗口会再次超预算；采用完整本地记录、有来源摘要和有界回查。

## 4. Dependencies

- **DEP-001**: 已有conversation_turn、conversation_event和conversation_summary本地存储。
- **DEP-002**: 已有PrepareContext和工具注册、权限、活动目录机制。

## 5. Files

- **FILE-001**: cmd/lake/chat.go、conversation_context.go、conversation_history_tool.go、context_recovery_test.go、activity_tools.json。
- **FILE-002**: lake/agent/context.go、compact.go、context_test.go。
- **FILE-003**: lake/store/conversation_history.go、conversation_history_test.go、agent_event.go；README.md；本计划。

## 6. Testing

- **TEST-001**: 空回复失败后“继续”仍把最新任务与原图送入模型，实时桥接和进程重载均通过。
- **TEST-002**: 历史压缩保留失败请求及附件；非连续来源重载不丢消息；成功后释放保留。
- **TEST-003**: 原文检索可分页重建长文字，失败状态明确；不能读取其他会话，输出不含认证字段与图片编码。
- **TEST-004**: 签名构建及安装通过，不更改真实执行状态。

验证结果：`go test -race ./lake/agent ./lake/store ./cmd/lake`、对应`go vet`及前端38项测试通过。模拟模型拒绝带图请求后，在同桥接进程和重启桥接进程两种情形下均收到原请求、原图及失败标记；集成模型可回查被摘要省略的目录需求，未被摘要来源集合覆盖的较小序号仍恢复。验证分页原文、认证字段脱敏、同会话隔离、未完成请求压缩保留和同水位来源补入。内置Web与桌面生产构建均通过。签名脚本构建并安装`Lake-20261001-195614-46285.app`，应用及CLI严格验签通过；安装内置CLI与工作区`bin/lake`的CodeDirectory哈希一致（重新签名的时间导致整文件哈希不同），构建目录仅保留一份。桌面空闲、草稿为空时重启，原会话与335像素侧栏恢复。没有重跑远端任务，也没有使用或配置截图中的认证信息。

## 7. Risks & Assumptions

- **RISK-001**: 保留的未完成请求本身超过模型窗口时需明确提示；不能无界累积全文或声称永久完整模型记忆。
- **ASSUMPTION-001**: 本次请求为修复Lake会话连续性，截图中的MCP配置不是当前安装授权。

## 8. Related Specifications / Further Reading

[上下文预算恢复](refactor-conversation-context-recovery-1.md)
[构建规则](../AGENTS.md)
