---
goal: 对齐 Lake 与 Codex 常用 CLI 参数和交互，接入用户既有 DS 模型
version: 1
date_created: 2026-10-08
last_updated: 2026-10-08
owner: Lake
status: 'Completed'
tags: [cli, agent, model, compatibility]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

以本机 `codex --help`、`exec --help`、`resume --help` 为名称与行为基线。扩展 Lake 自有 TS 内核；不导入 Codex/ZCode runtime。此计划同时记录实现和明确不支持的功能，避免参数静默无效。

## 1. Requirements & Constraints

- **REQ-001**: 裸命令、位置 PROMPT、exec/e、resume 与 --last、-m/-c/-p/-C、--add-dir、-s/-a、--no-alt-screen、-h/-V 使用统一解析和分层帮助。
- **REQ-002**: exec 读取 stdin，--json 输出 JSONL 事件，-o 写最后结果；保留旧 run --json 单 JSON 契约。
- **REQ-003**: 默认本地工作区可启动，无需用户先手写湖/环境 UUID；运维仍使用明确资源范围与授权。
- **REQ-004**: model/config/profile 覆盖按会话冻结，不能修改所有客户端的 daemon 配置；只读和审批策略在网关重新校验。
- **REQ-005**: DS 保留 deepseek-v4-pro/deepseek-flash，使用官方 Chat Completions 端点；支持 reasoning_content 配对回填。
- **SEC-001**: 只读既有 ~/.lake/secrets/model/deepseek，写新私有引用；不打印 key、不调用 Keychain、不迁移其他旧数据。
- **CON-001**: cloud、远程 app-server、MCP/plugin 宿主、图像和任意 shell 等未实现项明确拒绝，不用空函数伪装完整 Codex 功能。

## 2. Implementation Steps

- **GOAL-001**: CLI 常用参数通过协议与真实入口验证，DS 流式工具往返实测成功。

| Task | Description | Completed | Date |
|---|---|---|---|
| TASK-001 | 新增 agent/src/surfaces/cli-options.ts 的 parseCli/helpText，集中参数、别名、stdin 与未知功能错误。 | Yes | 2026-10-08 |
| TASK-002 | 新增 domain/invocation.ts；扩展 config/entities/dto 与 app/application.ts，会话保存模型、工作目录、策略和预算覆盖。 | Yes | 2026-10-08 |
| TASK-003 | app/workspaces.ts 解析并注册显式工作目录；operations/gateway.ts 在准备/派发/执行侧拒绝只读越界，冻结自动审批。 | Yes | 2026-10-08 |
| TASK-004 | cli.ts/cli-chat.ts/cli-exec.ts 实现默认聊天、exec JSONL/文件输出、会话选择和 resume/fork、模型查看与切换；routes.ts 复用同一内核。 | Yes | 2026-10-08 |
| TASK-005 | ChatModelAdapter 保存并回填 reasoning_content；私有配置 DS 并执行两模型的流式工具往返 smoke。 | Yes | 2026-10-08 |
| TASK-006 | 运行 parser/policy/surface 测试、原回归、签名构建；写 docs/lake-cli-compatibility.md，更新记录并本地提交。 | Yes | 2026-10-08 |

## 3. Alternatives

- **ALT-001**: 不把完整 Codex 云端/插件功能冒充成已有能力；这类子命令给出 capability_unavailable 与帮助矩阵。
- **ALT-002**: 不改全局 daemon 模型来实现 -m；使用持久的会话覆盖防止多会话互相影响。

## 4. Dependencies

- **DEP-001**: 既有 Node 24.14.0、pnpm 10.33.4、Zod 和 signed build，无新增 Agent 框架。

## 5. Files

- **FILE-001**: domain/invocation.ts、surfaces/cli-options.ts、cli-exec.ts、app/workspaces.ts、CLI/API/网关/模型适配器与测试、兼容说明。

## 6. Testing

- **TEST-001**: 裸 prompt、短/长参数、重复 -c、--、stdin、exec resume、错误选项和帮助不启动 daemon。
- **TEST-002**: 会话覆盖隔离、只读阻断、有作用域的自动审批、旧授权失效、resume/fork 保留进度语义。
- **TEST-003**: JSONL/输出文件/交互输入，断线与取消；真实 DS 只用无敏感内容的工具闭环，不访问运维资源。

验收结果：check 通过，单元 7/7、集成 48/48、验收 12/12；规定脚本的签名分发与真实 PTY 通过；DS 两模型真实流式工具往返通过。详情见 [增量验证记录](../docs/validation/lake-ts-agent-v0.0.1.md)。

## 7. Risks & Assumptions

- **RISK-001**: DeepSeek 思考模式要求 reasoning_content 回填；仅保存最终文本会使后续 tools 请求失败。
- **ASSUMPTION-001**: 用户授权接入既有私有 DS 凭据并做小规模连接测试；旧配置只读，旧凭据保留。

## 8. Related Specifications / Further Reading

[Lake v0.0.1](architecture-lake-ts-agent-v0.0.1.md) · [官方 CLI 参考](https://developers.openai.com/codex/cli/reference/) · [DS API](https://api-docs.deepseek.com/en/) · [DS thinking](https://api-docs.deepseek.com/guides/thinking_mode/)
