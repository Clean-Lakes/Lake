---
goal: 采用 Tutti 的进程与提供商适配设计，直连本机 Codex App Server
version: 1
date_created: 2026-11-16
last_updated: 2026-11-16
owner: Lake
status: 'In progress'
tags: [refactor, codex, app-server, typescript]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

用户授权采用 Tutti 的本机智能体调用设计。以 origin/develop 的 `88682744` 为基线，将 Codex 的第三方 ACP 包装器替换为官方 `codex app-server`，拆分受管理进程、提供商协议适配器和统一活动事件；现有 Lake Task/Worker、专员、私有工具桥和来源账本继续消费统一接口。参考 Tutti `207beeea554435618dffd3b579d0ffe112b065c4` 的设计，自行实现 TypeScript 适配，不复制其 Go 源码。

## 1. Requirements & Constraints

- **REQ-001**: 固定官方 Codex 0.160.1；启动参数直接进入 `app-server`，删除第三方 codex-acp 的安装和生产调用。
- **REQ-002**: 通过按行 JSON-RPC 完成 initialize/initialized、thread/start、thread/resume、turn/start、turn/interrupt；按准确 thread/turn 关联异步输出，不能将 RPC 返回当作整轮完成。
- **REQ-003**: 将文本、工具活动、用量和终态转换为既有外部运行投影；恢复历史不产生新输出或重放旧工具。
- **SEC-001**: 保留本机 CODEX_HOME 登录与配置来源，不复制凭据、不改写用户配置；模型工具目录、继承 MCP/hooks/notify 禁用及私有 Lake 工具桥保持。所有业务调用继续经当前 ToolExecutor。
- **SEC-002**: 配置迁移增加 revision；旧 Worker/run 保留且不能静默改用新传输。当前取消、来源、权限、generation、截止时间与 dispatchPhase 合同继续生效。
- **CON-001**: 保留历史 `acpProfiles/acpRuns` 表与 `kind: acp` 的读写兼容标签；内部执行接口使用提供商中立的命名，不将 Codex 协议包装成 ACP。
- **CON-002**: 本批只替换当前支持的 Codex。Claude SDK 和其他 ACP 智能体不声明为已交付能力。
- **GUD-001**: 设置中的协议说明改为 Codex 连接，保持现有组件与布局。
- **PAT-001**: 不增加模型/工具循环。上层只等待官方智能体输出，真实业务报告沿现有 work_finish 合同处理。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 独立的进程传输和官方 Codex 协议适配器可验证。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 runtime/typescript/acp/client.ts 定义中立执行接口；新增 process.ts，实现受管理 stdio、8 MiB 单帧限制、请求关联、取消/超时、64 KiB stderr 和进程树退出。 | Yes | 2026-11-16 |
| TASK-002 | 新增 codex-app-server.ts，实现初始化、线程创建/恢复、异步轮次关联、事件归一、工具请求拒绝和停止；配置探测复用相同进程传输。依赖 TASK-001。 | Yes | 2026-11-16 |

### Implementation Phase 2

- **GOAL-002**: 现有任务和多人对话通过新适配器执行。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 修改 registry.ts、types.ts、catalog.ts，将 profile 升级 schema3/runtimeKind，增加旧配置 revision；仅检查与安装官方引擎；prepareLaunch 返回直接引擎参数。依赖 TASK-002。 | Yes | 2026-11-16 |
| TASK-004 | 修改 service.ts，以中立接口调用初始化、线程和轮次；保留私有工具桥、冻结模型、旧任务归属、幂等和派发阶段。更新设置连接文案。依赖 TASK-003。 | Yes | 2026-11-16 |
| TASK-005 | 移除 web-agent/package.json、pnpm-lock.yaml、运行时 tsconfig/build 中不再使用的 ACP SDK 依赖；更新协议夹具及已有宿主回归的接线。依赖 TASK-004。 | Yes | 2026-11-16 |

### Implementation Phase 3

- **GOAL-003**: 固定真实引擎和签名 Lake Dev 验证完成，可经 develop PR 评审。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | 添加进程/协议故障测试：分块、乱序、早于 turn/start 回应的通知、外来线程、重复终态、退出、超时和停止；迁移不得改写旧 Worker/run。依赖 TASK-005。 | Yes | 2026-11-16 |
| TASK-007 | 运行类型检查、宿主及前端回归、固定真实 Codex + 本地 Responses 端到端与边界检查；记录实际结果。依赖 TASK-006。 | Yes | 2026-11-16 |
| TASK-008 | 更新 agent.md、README 和兼容记录；提交候选后签名构建安装 Lake Dev，验证连接和执行，记录 tested SHA 并创建 develop PR，未经用户授权不合并。依赖 TASK-007。 | No | |

## 3. Alternatives

- **ALT-001**: 保留 codex-acp 并重命名界面不能实现直连，删除该包装路径。
- **ALT-002**: 同时复制 Tutti 的账号文件投影会改变 Lake 已确认的本机登录合同，本批保留源 CODEX_HOME。

## 4. Dependencies

- **DEP-001**: 官方 Codex 0.160.1 自带 app-server generate-ts 输出作为本批协议依据。
- **DEP-002**: 现有 Task/Worker、ToolExecutor、私有 MCP 桥和签名 Dev 构建。

## 5. Files

- **FILE-001**: runtime/typescript/acp/{client,process,codex-app-server,codex-local,codex-profile,registry,service,types,catalog}.ts。
- **FILE-002**: runtime/typescript/*test*、test-fixtures、build.mjs、tsconfig.json；web-agent/package.json、pnpm-lock.yaml、web/src/ExternalAgentSettings.tsx。
- **FILE-003**: agent.md、runtime/typescript/README.md、docs/validation/acp-agent-execution/compatibility.md 和本计划。

## 6. Testing

- **TEST-001**: 协议关联和故障终止；真实引擎同任务恢复无历史重放，取消无迟到业务写入。
- **TEST-002**: 真实引擎只接收 Lake 工具；伪造原生工具及继承 MCP/hooks/notify 陷阱不能执行；用户配置和登录文件不变。
- **TEST-003**: Worker/child/多人对话、原报告与权限回归；旧传输 revision 不可续跑。
- **TEST-004**: 类型、构建、命名与 ADK 边界检查；签名 Lake Dev 对应准确提交。

## 7. Risks & Assumptions

- **RISK-001**: App Server 的轮次通知可早于 RPC 应答或在取消后迟到，适配器须有界缓存并按准确线程/轮次处理。
- **RISK-002**: 断线时未明确结束的已派发请求仍为 unknown，不自动重放或切换后端。
- **ASSUMPTION-001**: 本轮授权包括实施和 Dev 验证；不包括合并、生产发布或生产重启。

## 8. Related Specifications / Further Reading

- [贡献规则](../CONTRIBUTING.md)、[开发流程](../docs/development-workflow.md)、[架构约定](../agent.md)。
- [本机登录合同](refactor-codex-local-login-1.md)、[当前任务报告合同](../docs/security/task-confirmation.md)。
- [Tutti Codex 提供商定义](https://github.com/tutti-os/tutti/blob/207beeea554435618dffd3b579d0ffe112b065c4/packages/agent/daemon/providerregistry/codex.go)、[会话适配](https://github.com/tutti-os/tutti/blob/207beeea554435618dffd3b579d0ffe112b065c4/packages/agent/daemon/runtime/codex_appserver_session.go)、[进程传输](https://github.com/tutti-os/tutti/blob/207beeea554435618dffd3b579d0ffe112b065c4/packages/agent/daemon/runtime/process_transport.go)。
