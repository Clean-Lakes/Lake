---
goal: ACP Codex 复用本机既有登录和模型配置
version: 1
date_created: 2026-11-10
last_updated: 2026-11-10
owner: Lake
status: 'Completed'
tags: [refactor, codex, acp, authentication, typescript]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

按用户明确要求，Codex ACP 直接使用宿主 CODEX_HOME（未设置时为 ~/.codex）的既有登录与模型/服务配置，删除 Lake 项目独立 Key 表单和准入要求。Codex 自己读取与续签登录；Lake 不复制登录文件、不修改本机 config.toml。任务仍使用原权限、私有工具桥、执行绑定与真实业务验收。

## 1. Requirements & Constraints

- **REQ-001**: 支持既有 ChatGPT 登录、Codex API 登录及本机配置的 provider；模型、思考参数与服务地址由 Codex 加载，不使用 Lake 普通模型凭据或旧项目 Key。
- **REQ-002**: ACP initialize 后读取认证状态，仅保存不含账号秘密的状态；缺登录时要求在本机 Codex 登录，不再要求单独填写 Key。
- **REQ-003**: 全局配置和账号身份变化须使当前连接验证失效；令牌在同一账号正常刷新不改变任务身份。旧 schema1 profile 迁为 schema2 并增加 revision，已有 Worker/run 不静默转用本机认证。
- **SEC-001**: 不打印或持久化登录 token、API Key、provider 头或配置正文；秘密仅在内存加入既有脱敏器。Codex 自己访问其原登录存储，Lake 不调用 Keychain API。
- **SEC-002**: 复用连接配置仍禁用原生业务工具、全局 MCP、hooks、notify 和原生递归；任务工具通过原 Lake 私有 MCP/ToolExecutor。模型目录继续固定于已验证版本，未知模型明确拒绝，不猜测工具能力。
- **SEC-003**: 全局 mcp_servers={} 经固定引擎实测不会清除已配置服务；必须先解析本机与系统配置中的服务 ID，再通过 config/read 得到有效服务 ID；在启动与完整线程表内逐个添加 enabled=false。适配器收到 ACP mcpServers 时会重建 MCP 表，因此 Lake 私有桥和禁用项一并写入线程配置，ACP mcpServers 留空。测试必须证明继承的 MCP/hook/notify 陷阱没有执行。
- **CON-001**: Codex SQLITE_HOME、日志与 Lake 执行产物使用当前 Lake 私有目录，不修改用户配置或跨读正式 Lake 数据。登录刷新由 Codex 原机制处理。
- **CON-002**: 继续使用已验证 adapter 2.2.2 / engine 0.160.1，签名 Lake Dev 联调；普通 PR 继续指向 develop，未经授权不合并或发布。
- **GUD-001**: 删除独立 Key 字段；设置与模型菜单显示本机配置来源、认证方式、实际模型及具体未就绪原因，使用既有 AppSelect/Glyph/ProviderIcon 和几何。
- **PAT-001**: 使用原 ACP 服务、官方 Codex 配置读取及原 Task/Worker 账本，不增加模型/工具循环。隔离测试显式传入专用 Codex Home，不使用真实用户登录。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 实现本机配置加载和受管理启动。任务顺序执行。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 新增 runtime/typescript/acp/codex-local.ts：解析宿主 Home、计算配置/账号身份指纹、注册秘密脱敏；通过固定 Codex app-server 的 config/read 读取有效模型/provider/MCP 配置，不发送模型任务。 | Yes | 2026-11-10 |
| TASK-002 | 修改 codex-profile.ts 与 registry.ts：生成私有模型目录和无秘密的启动器；在原 CODEX_HOME 下应用受管理启动覆盖，逐个禁用继承 MCP；保留本机模型/服务/思考参数。依赖 TASK-001。 | Yes | 2026-11-10 |
| TASK-003 | registry.ts 的 profile 升级 schema2、本机来源指纹及 revision；service.ts 增加缓存的本机认证 probe/status；旧绑定继续受 revision 限制。依赖 TASK-002。 | Yes | 2026-11-10 |

### Implementation Phase 2

- **GOAL-002**: 将本机认证接入任务准入与设置。依赖 Phase 1。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | agent.ts / server.ts 支持程序化 codexHome 依赖注入；GET 状态、显式分配及任务工具目录使用 service.status 自动确认当前连接。superagent.ts 在路由准入前准备连接，并以本机认证 probe 取代项目 Key 门禁。 | Yes | 2026-11-10 |
| TASK-005 | 修改 shared/external-agents.ts、acp/types.ts、ExternalAgentSettings.tsx、ComposerModelSelect.tsx 及 composerAgentModel.ts：移除独立 Key 草稿和保存参数，显示本机登录、实际模型、来源路径及重新连接入口。 | Yes | 2026-11-10 |

### Implementation Phase 3

- **GOAL-003**: 验证复用与交付。依赖 Phase 1/2。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | 更新 server.test.cjs、acp.integration.test.cjs 和协议夹具，所有普通测试显式使用隔离 Codex Home；新增来源变化、账号刷新、旧 profile、无登录以及拒绝旧 Key 输入用例。 | Yes | 2026-11-10 |
| TASK-007 | 真实固定 Codex 通过本地 Responses 验证 provider/模型/思考继承、仅受管理工具及全局 MCP/hook/notify 不执行；按用户授权在独立任务用本机既有登录完成一次小型只读回传验证，不访问业务服务器。 | Yes | 2026-11-10 |
| TASK-008 | 执行类型、构建、前后端回归与边界；验证 Web 明暗/窄窗和原生模型菜单，提交干净源码后签名安装 Lake Dev，确认当前项目无需 Key 即可就绪。 | Yes | 2026-11-10 |
| TASK-009 | 更新 agent.md、runtime/typescript/README.md、docs/lake-pilot.md、ACP 验证记录和 PR #222，记录准确源码 SHA、认证来源、回归结果及未验证范围。 | Yes | 2026-11-10 |

## 3. Alternatives

- **ALT-001**: 复制 auth.json 到 Lake Home 会产生另一份需同步的凭据，不采用。
- **ALT-002**: 直接使用全局配置且不加启动覆盖会暴露原生执行/MCP，不能保持原任务工具边界，不采用。
- **ALT-003**: 覆盖本机 config.toml 或切换本机账号会干扰用户原 Codex，不采用。

## 4. Dependencies

- **DEP-001**: 已固定 Codex 引擎的 config/read 和 account/read。适配器旧 authentication/status 会把内置 openai 当作 gateway，不能单独作为认证证据。
- **DEP-002**: 既有 AcpProcess、私有目录、秘密脱敏、任务 revision 与工具桥。

## 5. Files

- **FILE-001**: runtime/typescript/acp/{codex-local,codex-profile,registry,service,types}.ts。
- **FILE-002**: runtime/typescript/{agent,server,superagent}.ts 与 web-agent/shared/external-agents.ts。
- **FILE-003**: web-agent/web/src/{ExternalAgentSettings,ComposerModelSelect}.tsx、composerAgentModel.ts 及相关回归。
- **FILE-004**: runtime/typescript/{server.test.cjs,acp.integration.test.cjs}、test-fixtures/codex-acp.cjs、本机配置单测与 docs/validation/acp-agent-execution/。

## 6. Testing

- **TEST-001**: 同账号 token 刷新不改变指纹；账号/API 登录身份和 config 改变使原 profile/probe 失效；旧 Worker 不改写或重放。
- **TEST-002**: 空登录拒绝新 Task，已有本机登录或有效自定义 provider 不需要 Lake Key；接口不再保存独立凭据。
- **TEST-003**: 源 config/auth 不被复制或改写，秘密不在 JSON/事件/错误/UI；原生工具与继承 MCP/hook/notify 陷阱不可执行。
- **TEST-004**: 实际 Codex 经宿主 Read/work_finish 回到原频道并验收，取消、审批和幂等保持原回归。
- **TEST-005**: UI 不出现 Key 输入，模型与认证来源可见，Pilot/专员入口正确，明暗、窄窗和原生浮层可用。

## 7. Risks & Assumptions

- **RISK-001**: 全局配置包含可执行扩展，必须验证逐 ID 禁用及固定模型工具边界，不能只通过握手判断。
- **RISK-002**: Codex 账号过期、网络或组织要求可能阻止读取；保持准确未就绪状态，不注销或替用户登录。
- **ASSUMPTION-001**: 使用本机持久化的 Codex 默认配置；临时 CLI --profile 等单次参数不作为持久化配置来源。
- **ASSUMPTION-002**: 用户本轮授权允许复用其现有 Codex 登录，并做小型本地只读联调；不授权真实服务器写入或生产发布。

## 8. Related Specifications / Further Reading

- [现行架构](../agent.md)
- [ACP 兼容记录](../docs/validation/acp-agent-execution/compatibility.md)
- [官方认证说明](https://learn.chatgpt.com/docs/auth)
- [官方配置覆盖与目录](https://learn.chatgpt.com/docs/config-file/config-advanced)

验证源码与签名安装：`219636df81270129a1a47279e86ee2b29ead33e4`。后端集成 192、后端单元 259（4 个既有可选跳过）、前端 786、真实固定 Codex 3 项通过；实际 ChatGPT 登录独立只读任务已验收，当前 Dev 项目就绪，148 个旧 Worker 保持。当前证据与未验证范围见 [兼容记录](../docs/validation/acp-agent-execution/compatibility.md)。
