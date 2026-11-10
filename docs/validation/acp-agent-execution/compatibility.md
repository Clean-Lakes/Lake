## 首批 ACP 执行后端兼容记录

2026-11-10，macOS arm64，Node 24.14.0。用户已授权先接入 runtime-acp 与 Codex。本记录区分协议贯通、宿主业务回执和模型服务认证；未使用真实外部 API Key 进行付费推理。

| 项目 | runtime-acp | Codex |
| --- | --- | --- |
| Agent / 适配器 | 固定 SDK v3.17.2 的公开 AgentRuntime，Lake 薄 ACP 宿主 | `@agentclientprotocol/codex-acp@2.2.2` / `@openai/codex@0.160.1` |
| 模型与认证 | 复用 Lake 当前 Model 公开端口；密钥不进入子进程 | 项目独立 API Key、独立 Home；不读取用户全局 Codex 登录或 Pilot 密钥 |
| ACP | 稳定 v1 stdio；initialize/new/prompt/cancel/load | 真实固定版进程稳定 v1；实际 MCP 调用和报告返回已测试 |
| 整 Worker / ACP child / 外部执行段 | 三种入口以及 ACP Worker→ACP child 均有真实 SDK/HTTP 集成测试 | 共用宿主绑定和工具执行路径；真实 Codex→MCP 桥→宿主工具→结果已通过隔离夹具 |
| 工具边界 | 仅代理注册表，不提供本地执行端口；SDK bootstrap 不能替换成原始 built-in | 固定静态模型目录禁用 Shell、apply_patch、图像读取、搜索、原生子代理与 REPL；仅本轮私有 MCP 工具和 MCP 资源查询入口 |
| 审批 | 原 ToolExecutor / ManualPermissionBroker，写入批准前无落盘 | 已关联本轮 Lake MCP tool_call 的 transport permission 只准许进入桥；业务操作仍必须通过原 ToolExecutor 和 Broker |
| 继续会话 | 仅同项目/任务/Worker/generation/scope/profile revision 下明确 completed 的 session/load | 实现相同门禁；真实服务认证与多轮恢复仍需用户实际账户验证 |
| 运行中补充输入 | 私有 ACP 扩展转发公开 steerTurn | 暂不声明支持；拒绝当前 turn 的即时交付，不伪造 queued/steered |
| 停止/重启 | 真实待批准写入测试：停止后无文件，sent 保留 unknown，重启不重放 | 同一进程树与 IPC 撤销路径；真实进程正常退出/回收已测试 |
| Windows/Linux | 本批未验证 | Windows/Linux 执行拒绝，首批仅开放已验证的 macOS |

### 证据与当前限制

- `runtime/typescript/server.test.cjs` 覆盖三种宿主入口、ACP Worker 的子任务、真实 Read/Write 回执、原审批、停止、无重放、配置 CAS、凭据独立与角色快照。`externalRunId/externalSessionId` 只由宿主加入真实 Operation；外部报告没有业务 operation_id。
- `runtime/typescript/acp.integration.test.cjs` 是显式启用的真实 Codex 集成。固定 npm 包放入独立临时 Home，使用本地 Responses 协议夹具与合成凭据，捕获真实请求工具目录并确认没有原生执行工具，验证私有 MCP 只执行一次宿主 Read、返回输出及重复 requestKey 不重复执行。运行：`LAKE_CODEX_ACP_TEST_ADAPTER=/absolute/path/to/pinned-install <Node24> --test runtime/typescript/acp.integration.test.cjs`。普通测试不联网安装、不使用真实账户。
- Codex 静态模型元数据来源于 [OpenAI 固定版本目录](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/models-manager/models.json)，首批固定 `gpt-6.1-sol`，保留原模型指令和上下文信息，只限制本地工具能力。静态目录通过独立 `config.toml` 在 app-server 启动时读取；只传线程 config 无效，不能替代该设置。
- 认证文件用私有目录逐层校验和原子替换；固定依赖在本机操作者显式安装后使用。包安装使用 npm integrity 和精确的 adapter/engine 版本；项目不自动更新适配器，不接受模型指定可执行文件。
- 并发最多 4 个外部运行（父等待 child 仍计入），满额返回 busy，不进入互等；每个调用最多 15 分钟且不超过原任务 deadline。尚未实现计划的计算槽让渡与独立 8 进程容量。
- Codex 的推理直接由独立引擎调用其模型服务，Lake 不伪造它的 token/模型轮数；当前强制工具权限、租约、配置变更、截止时间、输出上限和进程回收。独立推理的逐轮计费预算、Watchdog 主动指导与完整输入交付审计仍属后续项。
- 只开放固定适配器的受管理工具路径；ACP 权限本身不是沙箱。首批只接收文本说明和报告，图片附件及跨任务文件注入未开放。自定义 Agent、Claude Code、任意 CLI、任意联网模型服务配置和无人值守发布均未因本批接入而启用。

### 本地验证

源码 `f75c5dde6ce4a58eea980d5a3d83137c68a14835`：TypeScript 类型检查、Web 构建、后端 184 项集成测试、前端 774 项测试、后端单元 251 项通过（4 项现有可选测试跳过）、ADK runtime boundary 与命名检查通过。macOS arm64 已经 `scripts/build_lake_desktop.sh --dev --install` 构建/签名/安装，build-origin 记录此 SHA 且 dirty=false；在 Lake Dev 实际打开 Agent 页并通过签名 SEA 子进程的 ACP 握手，没有启用既有项目的后端或改动模型凭据。

Web 设置页已用独立 Home 实际验证连接测试、专员 AppSelect、键盘焦点、浅/深色及窄窗；输入区域没有横向溢出。截图：[浅色](settings-light.png)、[深色](settings-dark.png)、[下拉选择与键盘焦点](settings-select.png)。

Go 补充回归：`go test -race ./internal/ai ./internal/web` 中 AI 包通过（550.995s）；Web 整包在默认全局 10 分钟上限处超时，未计为通过。超时时正在执行的 `TestSREVerifierKeepsFullLoopAndExactAcceptanceEvidence` 单独复验通过（18.113s）；`go vet ./internal/ai ./internal/web` 通过。本批没有修改 Go AI/Web 源码，没有放宽或跳过该测试。

后续修正将 session/load 的重放事件排除在本轮报告之外，并在执行结束时撤销工具信号；真实 Codex load/resume 已复验，旧工具不重放、旧报告不重复累计。

运行桥生命周期修正源码 SHA：`70b883538dab06866643efc7c3121faf84758533`。真实 Codex 固定版已复验握手、无原生工具、伪造补丁拒绝、MCP Read、requestKey 去重与 session/load 重放隔离；后端 ACP 重点用例 9 项复验通过。

最终 Dev 安装与复验源码：`0cd7e116f087db33b7a437dc5c94afa200b626d6`（相对 70b88353 仅有文档变化）。签名与 build-origin 核对通过，dirty=false；最终完整后端集成测试 184/184 再次通过。Dev 窗口重新打开正常，原生与既有任务未切换后端。

## 专员显式分配与执行回传（2026-11-10）

本批源码与实际 Dev 安装：`b508be56dda27866c2283045a661cfadf7dcd473`。这是前述首批后端的交互与接单补充，具体任务见 [实施计划](../../../plan/feature-specialist-agent-assignment-1.md)。

- 专员输入区提供普通对话及分配新任务给 Lake Worker / runtime-acp / Codex。显式分配由认证后的宿主直接创建原 Task/Worker，不调用 Router 模型猜测执行者；职责版本、连接版本和准确频道在接单时校验。相同 requestId/输入读取原回执，冲突输入拒绝，重启与重复点击不重放外部 prompt。
- 独立分配不改专员默认配置；新 Worker 冻结执行后端，已有任务不切换。未启用、未安装、缺少独立凭据或未通过当前 ACP 握手时，不写用户消息或任务，草稿保留，可跳到当前项目的 Agent 设置。连接测试不证明推理认证可用。
- 频道和详情按准确 project/task/worker/session 读取实际外部运行，显示执行者、派发、审批、已回传、失败与结果未知。没有运行记录不显示已调用；报告不产生业务 Operation 或独立验收。逻辑 ACP child 显示实际执行 Agent，原生 child 委派外部段保留原 child 身份。
- 整个 ACP Worker 的实际宿主调用使用独立 `acp_turn_` 身份聚合进度与最终报告；不伪造 SDK 事件。已验证同一执行只形成一条频道回复，原始记录与业务回执保留。
- 外部产品显示名集中在共享目录，命名检查仍只允许该准确常量行，不泛化允许旧后端名称出现在业务实现或正文中；新增命名边界回归通过。

| 检查 | 结果 |
| --- | --- |
| 后端 TypeScript、前端类型及 Web 构建 | 通过；Vite 保留已有大 chunk 提示 |
| 完整后端集成（提交后复验） | 188/188 |
| 完整前端（提交后复验） | 779/779 |
| 后端单元 | 251 通过，4 个现有可选测试跳过 |
| 真实 Codex 进程 | 2/2；固定 adapter 2.2.2 / engine 0.160.1，独立临时 Home、本地 Responses 夹具与合成凭据 |
| 命名与命名边界单测、ADK runtime boundary | 通过；命名单测 5 项 |
| 签名 Lake Dev | `scripts/build_lake_desktop.sh --dev --install` 成功；签名核验通过，build-origin 为上述 SHA、dirty=false |
| Lake Dev 实际界面与签名 SEA 握手 | 专员分配、Codex 未就绪提示、协调模型标签可见；runtime-acp 握手成功，既有两个外部 profile 均保持未启用 |

隔离 Web 联调通过键盘直接分配 runtime-acp，实际独立进程读取项目目录、提交原 work_finish 并回到频道；配置跳转保留输入，执行报告可展开并查看原任务。浅/深色、620px 窄窗、焦点与 Escape 返回入口实际检查，无横向溢出。截图：[浅色回传](assignment-light.png)、[深色](assignment-dark.png)、[窄窗口与未就绪提示](assignment-narrow-dark.png)、[窄窗口菜单](assignment-menu-narrow-dark.png)。

本批未使用用户的真实 Codex 推理凭据执行任务，未启用用户项目的外部后端，也未修改正式版。Codex 测试曾在并行完整回归期间遇到一次请求目录未包含 Read 的失败，原因尚未定位；未放宽工具断言，原用例单独复验及最终两项串行复验均通过，高负载初始化稳定性继续观察。未提供真实工具回执时，原任务不能被报告验收成功。

本批没有 Go 源码变化；上述 Go 补充结果属于前批记录，没有把旧 Web 整包超时改写为通过。原 ACP 首批的并发、平台、认证、附件、Claude Code 与主动指导限制继续适用。
