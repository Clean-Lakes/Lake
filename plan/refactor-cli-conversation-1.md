---
goal: 按 Codex CLI 的交互模式修复 Lake 聊天与交付
version: 1
date_created: 2026-10-09
last_updated: 2026-10-09
owner: Lake
status: 'Completed'
tags: [cli, conversation, reliability]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

修复截图中的连接错误刷屏和成功无答案。参考官方 Codex CLI 的输入区、活动区与对话记录分工，用 TypeScript 实现 Lake 交互层；保留现有运维执行内核。

## 1. Requirements & Constraints

- **REQ-001**: 空白启动直接进入可编辑输入区；执行期间仍可输入，支持历史、粘贴、取消与继续对话。
- **REQ-002**: 活动状态原地刷新，主会话与专员输出区分；交付必须展示持久化最终答案，不被早期进度文字遮盖。
- **REQ-003**: 后台重启可重新读取私有连接描述符；连接失败只提示一次并退避，重试不重复执行写操作。
- **SEC-001**: 输出过滤终端控制字符；不显示隐藏推理、令牌或凭据；资源授权与审批机制保持生效。
- **CON-001**: 不引入 Codex Rust 执行内核；仅以官方代码和文档为交互参考；使用规定脚本签名构建 macOS CLI。

## 2. Implementation Steps

- **GOAL-001**: 终端聊天形成输入、执行活动、最终交付与下一轮的完整闭环。

| Task | Description | Completed | Date |
|---|---|---|---|
| TASK-001 | 在 app/report.ts、app/application.ts 和 cli-exec.ts 保存交付摘要并优先读取报告；旧报告生成可读结果，routes.ts 将上一轮交付结论带入关联任务。 | Yes | 2026-10-09 |
| TASK-002 | 在 daemon-client.ts 增加受控重连、超时与同 requestId 重试；cli-chat.ts 去重错误并退避。 | Yes | 2026-10-09 |
| TASK-003 | 新增 surfaces/cli-terminal.ts 实现持续输入和活动区；重写 cli-chat.ts 并调整 runConversation 空白启动。依赖 TASK-001、TASK-002。 | Yes | 2026-10-09 |
| TASK-004 | 添加真实 API 和 PTY 回归测试；执行 check 与必要测试、DS 实测、签名构建并记录验证。依赖 TASK-003。 | Yes | 2026-10-09 |

## 3. Alternatives

- **ALT-001**: 直接集成 Codex Rust TUI 会引入第二套任务协议与构建链；本次移植交互机制到已有 TypeScript surfaces。
- **ALT-002**: 只修复输出遗漏无法解决编辑输入、进度刷屏与连接恢复；本次同时修复三者。

## 4. Dependencies

- **DEP-001**: Node24 readline、现有持久化 API 请求收据与事件游标；不增加生产依赖。

## 5. Files

- **FILE-001**: agent/src/surfaces/cli-terminal.ts、cli-chat.ts、cli-exec.ts、cli-renderer.ts、daemon-client.ts、routes.ts。
- **FILE-002**: agent/src/app/application.ts、report.ts、agent/builtin/prompts/coordinator.md。
- **FILE-003**: agent/test/integration/cli-conversation.test.ts、daemon-client.test.ts；docs/lake-cli-compatibility.md 和 docs/validation/lake-ts-agent-v0.0.1.md。

## 6. Testing

- **TEST-001**: 无流式正文直接交付仍展示 CPU、内存等结果；早期进度不能遮盖最终摘要；恢复历史交付可读。
- **TEST-002**: 连接更换后重连、POST 同 requestId 无重复执行、离线错误不刷屏、取消请求不自动重试。
- **TEST-003**: PTY 验证输入编辑、粘贴、运行时输入、取消、连续两轮、调整窗口、退出恢复终端。
- **TEST-004**: DS Pro 真实本机查询、既有授权与多专员验收、签名 CLI 启动。

验证：check通过；单元7/7、集成57/57、验收13/13。真实PTY覆盖输入、粘贴、Tab补全、活动、取消、缩放、挂起恢复、连续对话与离线去重。签名CLI+后台的两轮mock模型验证最终答案与历史结论继承；真实DS Pro/high两轮查询12.754秒，最终709字答案可见，无Operation failed。详见 [验证记录](../docs/validation/lake-ts-agent-v0.0.1.md)。

## 7. Risks & Assumptions

- **RISK-001**: 终端宽度与中文字符影响光标；使用显示列宽及 resize 重绘并验证。
- **ASSUMPTION-001**: 用户要求落地 Codex 风格 CLI 交互，继续使用 Lake 内核和已配置 DS 模型。

## 8. Related Specifications / Further Reading

[CLI](../docs/lake-cli-compatibility.md) · [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) · [官方源码](https://github.com/openai/codex/tree/main/codex-rs/tui)
