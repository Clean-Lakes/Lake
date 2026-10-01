---
goal: Lake 对空模型响应进行有界恢复并保留原任务上下文
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [model, recovery, conversation]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

修复模型正常 HTTP 响应没有可见内容时直接终止会话的问题。当前截图对应 Generate 解析错误；本轮覆盖三个协议的普通回复及流式空回复，保留既有上下文、附件、工具定义和真实工具结果。

## 1. Requirements & Constraints

- **REQ-001**: 无文本且无有效工具调用使用分类错误；单次模型生成最多两次请求，仅可恢复的空响应触发一次重试。
- **REQ-002**: Anthropic 仅思考且 max_tokens 截断时，在重试请求中关闭思考，不修改用户配置、不增加输出额度；其他空回复使用相同请求。
- **REQ-003**: HTTP 错误、协议解析错误、无效工具调用、拒绝、取消和已输出内容的流式失败不触发重试。
- **REQ-004**: 重试属于模型请求层，不重启 Agent 或重新执行已完成工具；当前消息、图片、历史及工具选项保持一致。
- **REQ-005**: 正常解析的空响应亦计入调用数及 Token 用量；最终中文错误说明恢复次数、请求保留和可行下一步，不输出服务方原始响应。
- **SEC-001**: 认证字段、响应原文和隐藏思考不进入日志或错误；仅使用模拟模型验证，不发送实际 MCP 凭证或安装截图中的服务。
- **CON-001**: macOS 应用及 bin/lake 使用签名构建脚本；重启前检查运行任务与草稿。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 分类空回复并实现同一请求的有界恢复。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | lake/model/recovery.go 定义 EmptyResponseError、generateWithRecovery 与 streamWithRecovery；最多两次模型请求，取消与输出边界阻止重试。 | Yes | 2026-10-01 |
| TASK-002 | lake/model/anthropic.go、openai_chat.go、openai_responses.go 将单次请求拆出，校验空输出与拒绝，解析后即统计用量；Anthropic 空思考截断只在重试中关闭 thinking。依赖 TASK-001。 | Yes | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 验证恢复不重放工具并交付签名应用。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | lake/model/recovery_test.go 覆盖三个协议空回复、思考截断、流式空回复、失败上限、取消与拒绝；cmd/lake/context_recovery_test.go 模拟 MCP 附件请求与真实工具结果在恢复时保持不变；chat.go 在失败路径提交用量。依赖 TASK-002。 | Yes | 2026-10-01 |
| TASK-004 | 更新 README.md，运行相关 race/vet 检查，签名构建安装并验签；检查当前交互，空闲时重启，有待回答问题时保留进程并报告下次启动生效。依赖 TASK-003。 | Yes | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 重跑整个 Agent 会重复工具操作，使用模型层重试。
- **ALT-002**: 自动切换协议或模型会改变已配置服务和费用，本轮保留配置。

## 4. Dependencies

- **DEP-001**: 现有 Anthropic、OpenAIChat、OpenAIResponses 适配器、UsageMeter 和 schema.StreamReader。
- **DEP-002**: 已实现失败请求/图片保留、结构化上下文交接和签名构建脚本。

## 5. Files

- **FILE-001**: lake/model/recovery.go、recovery_test.go、anthropic.go、openai_chat.go、openai_responses.go、usage.go。
- **FILE-002**: cmd/lake/chat.go、context_recovery_test.go；README.md；本计划。

## 6. Testing

- **TEST-001**: 第一次空输出、第二次正常时成功；连续空输出只调用两次且计入统计，错误不含响应原文。
- **TEST-002**: Anthropic 仅思考截断重试 thinking disabled，原配置、附件和工具不变。
- **TEST-003**: HTTP/无效工具/拒绝不重试；取消中止；已输出部分文本的流式失败不重复输出。
- **TEST-004**: Agent 调用历史检索工具后遇到空响应只重试当前生成，工具只执行一次；失败后同会话及重开仍保留原 MCP 图片与请求。

验证记录：`go test -race ./lake/model ./lake/agent ./cmd/lake` 与 `go vet ./lake/model ./lake/agent ./cmd/lake` 均通过。三个协议同时覆盖 Generate/Stream 首次空响应恢复及失败上限；额外覆盖思考截断、无效工具、HTTP错误、拒绝、取消及流式部分输出不重放。桥接模拟中，MCP图片、当前请求与真实工具结果保持原样，历史检索提议/完成事件各一次，失败的两次模型用量正常提交。

当前模型入口的无凭证检查：TCP/TLS 连通、HTTP返回401，未验证网关上游推理健康，也未发送实际会话、图片或认证信息。旧错误无服务方响应诊断，不能据此确定截图空内容的具体上游原因。

2026-10-01 21:31 已通过 scripts/build_lake_desktop.sh --install 构建并安装 `Lake-20261001-213125-53139.app` 到 `/Users/lingyunxieqing/Applications/Lake.app`；CLI 位于 `/Users/lingyunxieqing/Desktop/Lake/bin/lake`。TypeScript/Wails构建、应用严格验签及CLI验签通过，签名身份为 Lake Local Development Code Signing。旧应用已备份，builds仅保留此构建。更新后只读观察确认当前 MiMo 会话仍等待问题卡答复，所以保持原进程；修复在下次启动生效。

## 7. Risks & Assumptions

- **RISK-001**: 额外模型请求会消耗时间和 Token；限定一次且计入统计。
- **RISK-002**: 原服务方响应没有保存在旧错误中，无法证明本次截图由思考截断或网关异常导致；修复现有解析路径中可确认的恢复缺口。
- **ASSUMPTION-001**: 用户要求修复截图中的错误；不授权重跑旧 SSH 工作流或安装具体 MCP 服务。

## 8. Related Specifications / Further Reading

[上下文交接](feature-task-context-handoff-1.md)
[会话连续性](refactor-conversation-continuity-1.md)
[构建规则](../AGENTS.md)
