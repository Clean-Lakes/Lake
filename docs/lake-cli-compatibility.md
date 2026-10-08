# Lake CLI 与 Codex CLI 对照

2026-10-08。本机 Codex `--help`、`exec --help`、`resume --help` 和[官方参考](https://developers.openai.com/codex/cli/reference/)作为参数名称与调用习惯的基线。Lake 使用自己的 TypeScript runtime；JSONL、审批、任务完成和资源执行遵循 Lake 的领域协议。

## 已实现的入口

| 调用 | Lake 行为 |
|---|---|
| `lake` / `lake "目标"` | 默认进入交互会话；裸命令先询问目标。输出模型正文、专员进度和待审批行动。 |
| `lake exec` / `lake e` | 非交互执行；缺省 prompt 或 `-` 从 stdin 读取；显式 prompt 加管道输入则追加 `<stdin>`。 |
| `lake resume [SESSION_ID]` | 无 ID 时显示选择器；恢复未结束任务的模型历史、专员与终端。 |
| `lake resume --last` | 最近的同工作目录会话；`--all` 取消工作目录过滤。会话用 UUID 选择。 |
| `lake exec resume --last` | 同一恢复流程，使用非交互输出。 |
| `lake fork [SESSION_ID]` | 创建关联会话与新任务，沿用资源范围、历史摘要和执行策略。行动队列、已确认标准和终端控制权不会复制。 |
| 已完成会话输入新目标 | 创建关联任务；原任务保持结束状态。无新目标的 resume 展示历史结果。 |
| `lake review [PROMPT]` | 本地工作区只读审查；默认审查当前代码。当前没有 Codex 的 Git diff review 选择器。 |
| `lake models` / `lake doctor` | 查看模型元数据和运行能力；凭据内容不进入输出。 |
| `lake completion bash\|zsh\|fish` | 输出基础 shell 补全脚本。 |
| `lake features` | 返回真实功能清单。 |
| `lake help` / `lake exec --help` / `-h` / `-V` | 分层帮助与版本，不创建 home、不启动 daemon。 |

原有 `run`、`sessions`、`resources`、`services`、`grants`、`actions`、`artifacts`、`approve`、`cancel`、`budget`、`terminal`、`serve/open`、`credentials`、`secrets migrate` 保留。

## 参数

| 参数 | 行为 |
|---|---|
| `-m, --model` | 已配置 provider 别名或模型 ID；按会话保存。原始模型 ID沿用选定 provider 的窗口和 token 设置。 |
| `--provider` / `--local-provider` | 选取配置中的 provider ID。 |
| `-p, --profile` | `agent/config.json` 的 `cli.profiles` 命名预设；不与专员 profile 混用。 |
| `-c, --config key=value` | 可重复覆盖；支持 JSON 值、单引号字符串、裸字符串。支持字段见下方，不解释任意 TOML 文件。 |
| `-C, --cd` | 使用真实工作目录注册本地资源；不要求先输入湖/环境 UUID。 |
| `--add-dir` | 增加本次创建会话的工作区资源，作用域随会话冻结。 |
| `--lake --environment --resource` | 明确运维范围；不能仅传 resource。继续使用已有资源授权。 |
| `-s, --sandbox` | `read-only` 拒绝变更和人工终端输入；`workspace-write` 只允许已选本地目录变更；`danger-full-access` 可使用已经授权的运维资源。 |
| `-a, --ask-for-approval` | `untrusted` / `on-request` 均要求变更审批；只读的已注册 Power 自动执行。`never` 对选定本地目录的模板变更保存精确授权并自动执行，其他变更返回等待状态。 |
| `--full-auto` | `workspace-write` + `on-request`。 |
| `--dangerously-bypass-approvals-and-sandbox` | 对已有资源授权自动绑定行动 ID 和摘要。仍执行资源范围、锁、前置检查与验证。 |
| `--no-alt-screen` | 内联终端；Lake 当前默认如此。 |
| `--json` | `exec/chat/resume/fork/review` 输出 JSONL；原 `run --json` 保持单结果 JSON。 |
| `-o, --output-last-message` | 原子写入最终模型正文；没有正文时写证据报告/等待状态。新文件权限 0600。 |
| `--color auto\|always\|never` | 控制 stderr 进度的 ANSI 颜色；auto 仅在 TTY 上着色，JSON 输出始终无 ANSI。 |
| `--skip-git-repo-check` | Lake 默认允许非 Git 运维工作目录，因此此标志可省略。 |
| `--include-non-interactive` | Lake 的选择器默认包含交互和非交互会话，因此此标志可省略。 |

支持的 `-c` 字段：`model`、`model_provider`、`model_reasoning_effort`、`sandbox_mode`、`approval_policy`、`limits.sessionMaxModelCalls`、`limits.sessionMaxEstimatedTokens`、`lake`、`environment`、`resource`。

优先级：CLI defaults → 命名 profile → 重复 `-c`（后者覆盖前者）→ 显式参数。模型、推理级别、目录、策略和预算均属于单个会话，不改变其他客户端的模型设置。已有任务的执行策略与资源范围冻结；改变策略用 `fork`，增加目录用新会话。空闲时可切换模型或更新预算；活跃专员期间拒绝切换模型。

显式选择 `--lake/--environment` 的运维会话，在未指定 sandbox 策略时保留原有“资源授权 + 行动审批”行为，保存为 `danger-full-access` 且 `bypassApprovals=false`；本地工作区默认 `workspace-write`。显式 `-s`、profile 和 config 策略优先。

交互命令：`/help`、`/status`、`/resume`、`/model [名称]`、`/approve <行动ID> <摘要>`、`/cancel`、`/quit`。待审批行动展示参数和变更产物。`Ctrl+C` 请求取消任务；`/quit` 离开界面，后台任务可通过 resume 回到。

## 执行与输出契约

Lake 的 sandbox 参数是操作网关的目标与效果策略；它不是 Codex 的操作系统 sandbox。当前执行能力来自注册的 Powers（文件、隔离测试、SSH、K8s、数据库等），没有任意 shell 的通用执行入口。测试容器仍使用自身的只读与网络隔离规则。

JSONL 首行 `thread.started`，随后 `turn.started`、持久 Lake DomainEvent（包含 `sequence`、`sessionId`、`actor` 和 `data`），结束行为 `turn.completed` 或 `turn.failed`，携带任务状态及最终正文。内部 `reasoning_content` 不输出到事件、终端或 API 消息。此格式不冒充 Codex 的 item 协议；机器消费者按 Lake schemaVersion 解析。

退出码：成功 0、有证据但有限制 2、等待审批/依赖 3、失败 1、取消 130。`turn.completed` 代表此次 CLI 观察结束，任务是否完成以 `status` 为准。

未实现的 Codex backend 功能明确返回 `capability_unavailable`：cloud、remote/app-server、MCP/plugin 宿主、账号 login/logout、Codex patch apply、图像输入、web search、feature enable/disable、ephemeral、output-schema、OSS 自动配置、strict-config、ignore-user-config、ignore-rules。未知选项报错。`--` 后按 prompt 处理。后续扩展应先实现对应内核能力，再开放参数。

## 此机器的 DS 配置

从既有 v2 的 DS 模型元数据保留 `deepseek-v4-pro` 和 `deepseek-flash`、1M 上下文窗口。旧 Anthropic 兼容配置通过[官方 Chat Completions 端点](https://api-docs.deepseek.com/en/)接入本 TS 内核。默认 provider 为 `ds`（Pro），`ds-flash` 可通过 `-m` 或 `-p` 选择。最大输出 8192 tokens，思考模式开启，默认 high。价格未配置时成本以未知值展示。

配置保存于 `~/.lake/agent/config.json`，密钥只存放在 `~/.lake/secrets/models/deepseek`。旧 `~/.lake/secrets/model/deepseek` 与 v2 配置保留。目录 0700、凭据文件 0600，不读取 Keychain。按照[DS thinking 协议](https://api-docs.deepseek.com/guides/thinking_mode/)保留 assistant 的 reasoning_content，并在后续工具轮次回填。

```sh
bin/lake
bin/lake -m ds-flash "分析当前项目的部署风险"
bin/lake exec -s read-only --json -o /tmp/lake-result.txt "检查当前项目"
bin/lake resume --last
bin/lake -p ds -c model_reasoning_effort=low "检查当前项目"
bin/lake models
```

## 验证

新增解析/策略/入口测试覆盖：位置 prompt、短参数、重复 config、profile 优先级、帮助零副作用、stdin、JSONL、输出文件、模型隔离、真实路径恢复、精确自动审批、只读阻断、fork 无行动重放、流式与非流式 reasoning 回填。两个 DS 模型均使用无敏感内容的 mock echo 工具做真实流式两轮调用，usage 和 reasoning 回填成功；原始响应与密钥不写验证记录。
