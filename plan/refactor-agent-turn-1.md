---
goal: 修复普通文字回复重复生成与回合结束时输入丢失
version: 1
date_created: 2026-10-09
last_updated: 2026-10-09
owner: Lake
status: 'Completed'
tags: [agent, conversation, bug]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

普通问候触发五次无工具模型调用，最后进入no_progress。将助手回合结束与运维任务验收分离；没有工具调用的回复结束当前回合，后续输入继续已有上下文。

## 1. Requirements & Constraints

- **REQ-001**: agent/src/agent/runtime.ts 中已完成且无tool_calls的非空回复只生成一次，返回turn_complete；空回复立即报告model_protocol_error。
- **REQ-002**: 回合结束仍需持久化模型历史、检查点与预算；业务succeeded仍只通过原有验收门。
- **REQ-003**: 回复生成及结束过程中到达的新输入必须执行一次；无新输入不得自动再次调用模型。
- **REQ-004**: 追问必须以最新用户输入结束模型上下文；新版客户端重启后台时应加载当前签名版本。
- **SEC-001**: 不改变资源授权、审批和秘密脱敏；不读取Keychain。
- **CON-001**: macOS通过scripts/build_lake.sh签名构建，保留已配置DS模型。

## 2. Implementation Steps

- **GOAL-001**: 一次问候只产生一个助手回合，运维工具流程保持有效。

| Task | Description | Completed | Date |
|---|---|---|---|
| TASK-001 | runtime.ts结束无工具回复，hooks增加待处理输入检查；application.ts根执行结束后唤醒尚未消费的输入；cli-chat.ts将turn_complete展示为就绪；context.ts将最新用户输入放在追问末尾；daemon-client.ts通过当前签名入口重启后台。 | Yes | 2026-10-09 |
| TASK-002 | 更新runtime-guards.test.ts错误的五次文字回复期望，cli-conversation.test.ts增加普通聊天、连续问答和结束边界输入回归；依赖TASK-001。 | Yes | 2026-10-09 |
| TASK-003 | 运行check、相关及完整必要套件；签名构建、真实DS问候和连续问答验证；更新验证记录并提交。依赖TASK-002。 | Yes | 2026-10-09 |

## 3. Alternatives

- **ALT-001**: 仅隐藏相似文字仍浪费模型调用并终止于错误，不能解决循环语义。
- **ALT-002**: 不仅凭文字回复将运维任务标记succeeded，以免绕过证据验收。

## 4. Dependencies

- **DEP-001**: 已有ModelHistory、InboxService、检查点与任务状态接口。

## 5. Files

- **FILE-001**: agent/src/agent/runtime.ts、context.ts、agent/src/app/application.ts、agent/src/surfaces/cli-chat.ts、daemon-client.ts、agent/builtin/prompts/coordinator.md。
- **FILE-002**: agent/test/integration/runtime-guards.test.ts、cli-conversation.test.ts；docs/lake-cli-compatibility.md、docs/validation/lake-ts-agent-v0.0.1.md。

## 6. Testing

- **TEST-001**: 无工具回复恰好一次模型调用，历史和预算一致；不创建操作或伪造验收。
- **TEST-002**: 连续输入每次恰好回答一次，已有上下文保留，背景空闲不重启。
- **TEST-003**: 模型生成及回合结束时收到输入不丢失、不重复；空正文无工具时明确协议错误。
- **TEST-004**: 原工具闭环、重复工具限制、取消、恢复与业务验收；签名DS实测。

## 7. Risks & Assumptions

- **RISK-001**: 回合退出与新输入并发，必须用持久收件箱判断剩余工作，而非无条件重启。
- **RISK-002**: 已启动的旧版 CLI 会话仍引用旧运行时；关闭旧窗口并启动当前签名入口后加载本次修复。
- **ASSUMPTION-001**: 用户要求修复本机Lake聊天重复；继续使用当前DS配置。

## 8. Related Specifications / Further Reading

[终端交互计划](refactor-cli-conversation-1.md) · [CLI](../docs/lake-cli-compatibility.md)
