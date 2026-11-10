## TypeScript 迁移候选

用户已确认：后端直接使用 TypeScript，保留 Lake UI，**全部既有功能保留并验收后才进行完整切换**。当前不是完整替换版本。2026-11-05 用户进一步明确要求将 TypeScript Dev 覆盖现有 Dev，增加下面的显式 Dev 入口；2026-11-08 用户进一步明确选择当前 TS 用于本次 macOS 0.3.28 正式发布。默认 macOS 桌面包因此使用 TS，现有完整等价矩阵仍保持未通过。

源码从 [v3.17.2 release](https://github.com/zai-org/ZCode/releases/tag/v3.17.2) 的 tar.gz 下载；标签提交 `a9fe401eede6e6e5e01be9048679c206fe6f02d9`。发布页另列的安装包构建提交为 `e6b675b40abb79e1d38d98d4e8750d0859cfedd9`，两者不混用。依赖来源、归档 SHA-256、Node 版本见 `upstream.json`；上游名称仅用于依赖归属，不作为 Lake 后端身份。

候选路径为 Lake React → TypeScript HTTP/SSE 宿主 → Agent SDK `AgentRuntime` / Node adapters / SQLite。模型请求、工具、审批、取消和上下文在 TS 中执行，不经过 Go 模型代理。旧 Go 文件目前保留给现有完整产品；它们不是候选后端的依赖或 fallback。

### 项目命名与兼容

Lake 自身的目录、UI、提示词、构建产物与公开元数据使用 TypeScript / 原生 Agent 命名。`sdk.ts` 集中绑定上游公开 API；实际依赖命名、原始许可证、固定来源和源码引用保留真实名称。`python3 scripts/check_backend_naming.py` 扫描所有纳入版本控制和待加入的文件，报告例外分类并拒绝新的产品语义；候选构建先执行该检查。

旧会话档案通过 SQLite backup 复制为 `agent-sessions.sqlite`，包含已提交 WAL，校验逻辑内容后发布。原档案保留，重复启动不复制或重放；回退旧程序后若产生两条历史，下一次启动要求先核对，不自动覆盖。历史 child/control 标记在读取投影中兼容，原任务、业务回执与存储行不因展示改名而重写。公开会话配置统一返回 `agentRuntime: "typescript"`，不改写旧权限输入。

上游 UI、贡献者名单、头像和致谢页面没有打入 Lake UI。上游版权、LICENSE、NOTICE、第三方归属和 Node LICENSE 保留在生成的 `bin/lake-runtime/licenses/`。上游源文件保持原始内容，构建前逐文件核对归档。未经核验的删改不会被当成原版源码构建。

### 构建与隔离运行

```sh
pnpm --dir web-agent install --frozen-lockfile
scripts/build_lake.sh --ts-candidate
bin/lake-ts web --home "$HOME/.lake-ts-candidate" --port 0
```

macOS 候选使用同一个持久开发签名身份；Node 24.14.0 通过官方归档固定摘要取得，打入 Node SEA，所以运行时不依赖系统 Node。仅默认构建入口处理用户二进制，不安装桌面应用。

独立候选拒绝正式 `.lake`、日常 `.lake-dev` 及其符号链接目标。原生 TS Dev 通过显式 `--dev` 可以使用 `.lake-dev`，正式包通过显式 `--production` 才能使用 `.lake`，且禁止访问 Dev 目录；混合运行身份在写文件前拒绝。TS 使用单独的 `lake-typescript.sqlite` 和 `agent-sessions.sqlite`。明确 Dev 或生产身份的 `--migrate-legacy` 一次性事务迁入旧项目、会话、专员与频道身份，保留只读历史；不修改旧 Go 数据库，不恢复旧审批、不重派历史任务。测试使用临时 Home。

### 覆盖安装 TypeScript Dev（用户已明确授权）

先在现有 Lake Dev 选择“停止内核并退出”，备份 Dev 应用和 `.lake-dev`，然后运行：

```sh
scripts/build_lake_desktop.sh --dev --ts-candidate --install
open "$HOME/Applications/Lake Dev.app"
```

该选项只允许 Dev，使用相同 Dev Bundle ID 和安装路径，随包携带签名 Node SEA、React 和上游许可。原生客户端按包内元数据验证 `typescript` 与准确 Home/data，支持连接复用和正常停止。启动时一次性导入当前所选 Home 的 `providers.json` 中的公开模型配置，私有凭据保留原文件引用；不复制正式密钥，不改写旧配置。后续在 TS 中删除或修改配置不会在重启时被旧目录重新覆盖。

这是已授权的 Dev 预览覆盖，不表示所有功能已通过等价验收。回退使用备份应用；旧 Go 数据原样保留，TS 新会话不会自动反向同步。

### Magpie 模型来源

TS 后端动态读取当前显式 Home 下的 `secrets/magpie-agent.json`，使用插件的 `model`、`baseURL`、`key` 和 `catalog`，同步模型名称、上下文、输出限制、图片输入与明确的思考能力。启动时准备权限为 `0600` 的空配置，避免插件首次创建宽权限文件；后续读取拒绝非私有文件、符号链接、非法地址和不完整 JSON。只读取当前实例，Dev 不读取正式版的配置。

Magpie 与手动供应商共存。明确选择手动模型后保持该选择；切到 Magpie 后保留按其默认模型绑定的本地选择，插件默认模型变化时自动跟随新默认。断开时回到之前有效的手动模型，没有手动配置则显示未配置；重新接入保留来源偏好。配置和密钥变化在下一轮重新绑定 SDK，运行中的任务保留原模型快照，不重放历史。插件独占连接配置和密钥，TS 仅保存非敏感的选择偏好；旧 `magpie-selection.json` 只读导入一次。此接入不表示 CLI 或非 macOS 平台已完成等价验收。

### Super-agent 增量

`superagent.ts` 将真实 Pilot Router、长期专员管理、独立任务 Worker、连续频道、分页与当前权限接入公开 AgentRuntime。Pilot 与 Worker 共享通用 Agent 工具，Pilot 可直接执行并按需建立原 Task。Worker 可在本项目独立工作区使用 Read/Write/Edit、Glob/Grep、Bash、Todo、网页和真实文件清单及任务工具；Worker 已增量接入项目 MCP 目录/调用和 Skills 读取；本机手动 PTY 与 Worker 执行权限分开。SSH 手动 PTY、原 Dev 凭据/主机指纹和固定主机只读检查已增量接入；通用 SSH Bash 已通过原生执行端口接入，模型可使用实际远端 CLI；手动持续终端交接仍未接通；分层 Memory 的新入口见下文，不可绕过。职责按建单版本冻结，任务不受专员后续改名影响。

`tasks.ts` 保存原目标、步骤、独立尝试、实际派发操作及验收。普通任务自动注册计划；Plan 必须确认且始终只读。步骤验收和最终汇总核对真实操作回执、项目/任务/尝试、原修订、当前权限、资源连接修订与输出 hash。模型文字不能验收；只读失败可以在原目标建立带 retryOf 的新诊断尝试，写入不明仍为 unknown。停止和重启使原 owner/审批失效，旧操作不重放；报告使用事务 outbox 幂等进入 Pilot 与专员频道。

迁移优先读取旧 ADK state 指向的准确 artifact 版本并核验 hash；不选择最大 artifact 版本，旧 UI JSON 仅作前 ADK 兼容缓存。历史卡片分页保留，旧任务不成为新执行权威。原项目明确 Security 策略尚未完成 TS 适配时阻止资源执行；原安全 gate/epoch/reader 不兼容时只允许查看，不能改成 Agent SDK 默认放行。`security.ts` 是迁移屏障，完整 Security/grant/恢复合同仍待移植。

最初 24 项隔离集成验证与真实 Dev 目录副本演练见[Super-agent 验证记录](../../docs/validation/typescript-candidate/superagent.md)。该批是已有迁移候选的增量，不代表全量功能切换。

### 验证和切换门槛

```sh
node runtime/typescript/inventory.mjs
node third_party/agent-sdk/node_modules/typescript/bin/tsc -p runtime/typescript/tsconfig.json
node --test runtime/typescript/server.test.cjs
python3 scripts/check_typescript_parity.py --report
python3 scripts/check_typescript_parity.py
```

Node 命令须使用准备好的 24.14.0。测试经过真实 Agent SDK 源码与本地模型 HTTP 夹具，覆盖鉴权、Origin、单 Home、聊天/流式投影、写入批准与拒绝、取消不派发、重启历史和凭据隔离。会话置顶/排序、图标和标签已移植现有合同，并验证项目范围、乐观版本、并发冲突、持久化以及不改变活动时间；这些候选测试仍不代表原生 Lake Dev 的完整验收。

`api-inventory.json` 从现有前端 TypeScript AST 提取完整 API 操作表；`parity.json` 记录逐项与领域验收。最后一个检查目前**必须失败**：候选测试不等于功能等价。资产/SSH/数据库/终端、Pilot/专员/频道、任务/权限账本、工作流/日程、记忆、附件、MCP/Skills、队列/补充/压缩、历史迁移、CLI/Magpie、macOS/Windows 与 Lake Dev 主题/窄窗均需补齐。候选 API 的 501、空只读目录或关闭的开关不能作为已迁移证据。

完整等价验收继续逐项进行；0.3.28 macOS 正式分发是用户明确选择当前 TS 水位后的例外，不将缺口标为已完成。其发布仍需独立验证准确生产 SHA、迁移、签名包与更新回退。合并、生产安装和发布继续遵守仓库原有授权流程。

本轮准确源码 SHA、签名进程检查、界面截图与未验证项见[阶段验证记录](../../docs/validation/typescript-candidate/README.md)。

### 2026-11-07 切换缺口修复

已增量接通原安全 epoch 下的 MCP 继承/绑定迁移、原生自动记忆提取、准确资源引用、Plan 模式与原计划确认、持久消息队列、目录编辑/回收站、原 PostgreSQL/Redis 配置及工作流模板保留。模型思考能力优先使用供应商明确元数据，兼容旧版按准确模型版本匹配的 OpenAI/Claude/DeepSeek 注册表，可通过原 UI 选择，按供应商/地址/协议/模型身份校验，并冻结到任务及其子执行；默认不添加推理参数，未知模型不猜测能力。模型目录返回前端要求的名称数组，保留服务明确报告的上下文和思考能力；Gemini/Ollama 使用对应的 OpenAI 兼容入口。

队列支持暂停、编辑、排序、移除及空闲后继续发送；重启暂停未发送输入，准入结果不明时保留且不重发。准确的同轮补充协议尚未接通，因此返回 `pushSupported=false` 并禁用队列推送按钮。附件/图片、上下文压缩/回退/文件恢复、资源导入、Kubernetes 与旧本机执行适配、直接 PostgreSQL/Redis 查询、工作流运行/日程、完整安全恢复、CLI/平台能力仍有缺口。现有 API 不以空成功伪装支持；已保存配置不等于实际连接成功。完整切换门禁继续关闭，后续验证和未完成条目须与[修复记录](../../docs/validation/typescript-candidate/cutover-repair-2026-11-07.md)一起评审。

持续终端与 MCP/Skills 增量的实际范围、36 项隔离回归和 Dev 实测另见[验证记录](../../docs/validation/typescript-candidate/terminal-extensions.md)。本机 PTY 使用随包签名的 node-pty 1.1.0 原生 addon/启动程序，macOS 无需系统 Node；该记录保留当时的本机 PTY 水位；后续 SSH/确认入口修复见[SSH 增量记录](../../docs/validation/typescript-candidate/ssh-confirmation.md)，Agent 接管仍待移植。

## 普通任务与对话续派

### 任务 Worker 的原生子智能体与第三联

Pilot 与任务 Worker 使用 公开 SubagentPort/Runner 按需创建临时子智能体。子执行拥有独立 SDK Session，继承同一任务的有效业务工具、项目范围与当前权限，不创建长期专员或新的目标。根 Worker 加子实例累计最多 8 个，失败和继续任务不重置；子实例不能继续递归或调用父任务结清工具。

原生 `Agent`、`TaskOutput`、停止与消息工具只控制协作，不作为业务成功证据。后台子任务须汇合后才能提交 `work_finish`；父执行提前结束或用户停止时，经原生端口取消子任务并等待退出。真实子工具调用使用 child Session 命名空间，写入原 Task 的步骤/attempt/操作账本；同任务实际业务派发串行，子模型可并行。原审批、权限版本、未知效果核实及禁止重放继续生效。

点击任务清单或“执行详情”在第三联打开准确任务，保留中间对话。执行过程展示 Lake 分配的 Worker、真实子实例与工具输入/结果；结果页单独展示报告和业务回执。多资源按准确资源 ID 保留原项目目录；跨资源、无资源或无法定位的实例在任务层仅显示一次，各工具记录标注实际目标。旧 SRE 和历史记录保留原兼容路径。

旧 TS 卡片的资源、操作及尝试身份在读取时从同项目、同执行 Session 的原操作账本精确关联；子卡片另核验 child Session 命名空间与 Task。此投影不修改旧卡、目标、账本或验收，也不重执行。没有准确账本来源的原文只作为执行历史查看，不计为新的业务回执。

TS Dev 的 Router 工作集携带当前来源频道最近四轮对话、最新专员公开报告、准确任务引用、当前任务状态及实际适配器/项目资源能力摘要；旧阻碍单独标注为需重查的历史信息。工作集保持 16 KiB 上限，原 SDK 档案不删除。派单回执用 `handoff.recorded` 表达已记录交办，`dispatch` 及 `observedAt` 仅为当时的调度快照。普通接单正文只确认安排，排队、读取和等待由实时活动行展示；真实失败、限额和需要用户操作的事项仍说明。

未完成任务的补充要求继续使用原 Task/Worker、期限和轮数；运行中的补充只排入下一次执行，不同时注入当前 SDK 与下一轮。结清前有新输入时，宿主先保留本轮回执，延后完成验收，待路由结束后将准确输入交给同一 Worker。路由失败、停止和限额不会变成成功，失败输入不自动重放。已完成且验收通过、没有未决操作的任务，遇到用户要求重新检查时可新建任务并复用原专员；可选 `predecessor_task_id` 只携带有来源的历史目标上下文，不继承旧权限、批准或验收。

普通新任务采用 `host_managed`：模型直接选择业务工具，宿主自动建立步骤和 attempt、记录工具回执；`work_finish` 必须提供 completed/partial 和业务报告。completed 仍须当前 invocation 的真实成功业务回执，目录发现、失败、旧回执和自然语言不能制造验收；partial 保留具体业务结果而不附加机械流程回执。Plan 与旧显式复杂计划保持原步骤契约。只有旧 TS default 单步、未验收任务可通过留存原记录的兼容路径接管，旧 Go 任务不恢复执行。

未知副作用仍保留原操作身份并禁止重放；独立且宿主证明只读的诊断不再被整个任务/项目一刀切拦住。MCP 标注不能证明只读。具体执行继续核对当前权限、配置/凭据版本、主机指纹和实际审批。频道“需确认”仅来自真实待处理交互。

见 [实施计划](../../plan/refactor-typescript-conversation-runtime-1.md)及 [对话执行验收](../../docs/validation/typescript-candidate/conversation-runtime.md)。


## Pilot 停止与 MySQL 受控读取

Pilot 的输入区按当前项目真实活动计算停止状态：Router 回复结束后，排队、执行或等待交互的 Worker 仍可停止；有草稿时同时保留停止与发送，停止不丢草稿。停止先撤销待派发输入和路由批次，再取消当前项目活动 Worker 及原生 child。历史停泊任务、其他项目和原 unknown 操作不会被清除或重放。

Worker 及其原生 child 增量接入 `list_db_objects`（库/表目录）、`db_table_ddl`（表结构）、`read_db_table`（有界数据或行数）三项固定 MySQL 读取。每次使用独立只读事务，回滚后断开；最长 5 秒、最多 500 行表数据、96 KiB 结果和 512 KiB 网络预算，原策略可进一步收紧。分页须显式稳定排序；样本、行数和结构都不是跨库完整一致性的证明。这些专用工具不提供自由 SQL、数据库写入或 PostgreSQL；通用 SSH Bash 可按当前权限调查实际远端 CLI 和数据库入口。

启动时只读增量补充同一 Dev Home 已迁入资源的准确 MySQL 连接引用，不改旧 Go 数据、不覆盖已有 TS 配置、不继续历史比较。当前私有凭据、资源版本、连接摘要、项目/schema 范围和 Pilot 审批在派发及回执使用时重新核验，Memory 沿用同一 Operation 校验入口。元数据可独立作只读诊断；表数据读取保留原 unknown 对账屏障。资源目录中的 configured 只表示配置存在，不表示远端可达。实测范围见[停止与 MySQL 验证记录](../../docs/validation/typescript-candidate/pilot-stop-mysql-read.md)。

## 分层长期记忆

2026-11-06 用户授权接入 原生 Memory。用户明确保存的全局偏好、项目共享、稳定 RoleID 经验分别保存；新任务上下文独立，临时 child 的真实结果通过父任务回流。Provider 按当前资格投影少量知识，不把完整手册或其他任务 transcript 复制给 Worker。

项目及角色共用积累/使用开关，新 Home 默认关闭。原生提取在私有暂存运行，宿主校验来源、设置、权限及版本后发布；更正/遗忘先抑制旧读取和迟到写入。旧 Go 数据不自动导入，退役 V2 不启用。全局仅允许明确保存，聊天记忆管理以设置中的实际结果为准。

设计、接口和限制见 [分层记忆说明](../../docs/design/typescript-layered-memory.md)，准确检查与 Dev 水位见 [验证记录](../../docs/validation/typescript-layered-memory/validation.md)。此项不代表全量后端迁移或真实模型长期质量已经验收。

## 通用 Agent 能力

Pilot、专员 Worker 与临时 child 共享公开 Agent SDK 文件、Bash、搜索、Todo、网页、Skill、问题和计划工具。上游在 Bash 可用时隐藏原名 Glob/Grep；Lake 通过公开 handlers 以 `FindFiles/SearchText` 注册相同文件搜索能力，继续经过文件范围与原账本；`toolSearch.mode=auto` 复用上游本地/原生工具发现，不另建分发循环。图片读取使用公开 Jimp adapter；PDF/视频/音频输入按当前模型显式能力声明，PDF 分页另需已安装 Poppler。当前模型配置支持 `supportsImageInput/supportsVideoInput/supportsAudioInput/supportsPdfInput`。固定上游仅编码 Anthropic 原生 WebSearch，需对应协议及显式 `supportsNativeWebSearch=true`；其他供应商可使用项目有效 MCP 搜索。

本机 Bash 使用 macOS Seatbelt 隔离 Lake 私有数据、宿主 SSH 私钥及 Keychain；Shell 的环境只保留 PATH、工作区 HOME 与语言。通用 SSH 使用准确 `asset_ref/configuration_revision`、宿主私有凭据与首次/变化指纹确认，结果为真实退出状态。显式后台和前台等待超时转后台都保留同一实际进程，执行总时长至多十分钟。后台 Bash 保留原操作直到实际退出，TaskOutput 汇合，TaskStop 和项目停止取消真实执行。连接变化、权限撤回和停止会使旧证据失效；中断的不透明命令保留 unknown，不自动重放。

原生 Enter/ExitPlanMode 连接实际 SDK mode 和 Lake 审批；批准计划不扩大命令、文件或资源权限。模式切换重新注册工具时同样保留宿主包装。Todo 以 Task + 实际 SDK Session 存储，直接 Pilot 历史任务通过准确 taskId 检查，避免多任务共用展示入口导致错读回执。合格 Pilot 执行经验进入现有项目 Memory，专员仍归 RoleID，child 通过父任务回流。

`GET /api/agent-capabilities` 列出固定上游完整工具清单及实际连接状态。Cron/OffPeak、动态工作流、浏览器插件和跨会话上下文读取等还需要相应 Lake 宿主服务及范围适配，不注册成可成功调用的假工具。未连接项不被称为已完成，完整 TS 产品等价门禁保持原状态。准确检查、签名 Dev 来源和未验证项见[本批记录](../../docs/validation/typescript-candidate/agent-capabilities.md)。

普通命令/只读数据库免确认的缺省值与现有 Web 设置共用 shared/execution-preferences.ts，显式关闭仍询问。程序发现和有限容器查询包装按实际内部命令判断，不因 command 或 exec 这几个字一律升级；危险动作、动态或未识别脚本保留确认。此判定只影响追加确认，不构成 readonly 证据或 TaskGrant，仍受原策略和 unknown 约束。验证见上面的本批记录。

后续程序查找误锁修复单独将字面量 `command -v/-V` 识别为只读；可选程序不存在不会锁住后续普通执行。准确旧 SDK 调用及宿主失败回执可为有限的 hostname/程序查找链另存无写入核验凭证，原记录不改写、原调用不重放，不放行其他未知副作用或生成业务成功。范围和签名 Dev 验收见[程序发现误锁修复](../../docs/validation/typescript-candidate/program-discovery-recovery.md)。

## 六类服务资源连接配置

TS Dev 支持 MySQL、PostgreSQL、Redis、APISIX、Prometheus 和 VictoriaMetrics 的新增、目录归属、私有凭据、版本化编辑及显式限时连接测试。保存不访问目标；测试使用固定协议读取，不代表业务健康或任务验收。旧 Go 页面保留注册格式，不展示尚未接入的测试／编辑 API。专用 Agent 查询适配器保持实际已连接范围。实现与限制见 [验收记录](../../docs/validation/typescript-candidate/service-resources.md)。

### 0.3.28 macOS 正式分发

`scripts/build_lake_desktop.sh` 默认生成 TS 正式 ZIP/DMG；`--dev --install` 只安装 Lake Dev。用户运行包时无需系统 Node。更新器在旧进程退出后，使用准确 Home/data 执行 `--production --migrate-legacy --import-only`，最多等待 120 秒；该准备阶段不启动 Worker、队列或 Memory 提取。失败恢复旧应用，保留原数据库；成功后才进入 45 秒 UI 就绪确认。命令行单独运行须显式传入正确身份及隔离目录。旧 Go 不包含 TS 新历史，回退后两边产生分支历史须核对，不能将其当成双向同步。

从 0.3.27 或更早客户端自动更新时，执行的是旧客户端携带的安装器，仍受原 45 秒总就绪窗口约束，不能提前获得新版的 120 秒准备阶段。若首次迁移较大导致旧安装器回退，请保留备份并改用本版 ZIP/DMG 手动安装；本版安装器的单独准备与回退测试仅证明从本版开始的后续更新路径。

### 项目 ACP 执行后端

专员聊天框的原模型菜单默认选择独立 Codex Agent，普通模型选择保存为该专员的原生偏好。Codex 发送沿原显式新任务准入直接派发，不依赖 Router 推理；新 Worker 冻结当前执行配置，已有任务及原生偏好保持。原生 Worker 的 `Agent` 可选择 `codex-acp`，Worker 或已有原生 child 也可用 `run_external_agent(agent='codex')` 委派一段工作。外部 leaf 不再递归委派；任务仍最多 7 个逻辑 child。runtime-acp 生产启动与私有模型代理已删除，仅保留历史绑定的读取与明确拒绝，Lake 自身仍使用原公开 SDK。

在模型菜单选择“配置 Codex”后启用，自动识别 Node 22.22+ / 24.14+ 和配套 npm，在当前 Home 的私有目录安装固定 ACP adapter 2.2.2 与引擎 0.160.1，并完成模型无关的 ACP 握手。路径覆盖折叠在高级设置；主 TS 后端仍使用 Node 24.14.0。Codex 使用项目独立 API Key，不读取全局 Codex 登录或普通模型密钥，也不要求配置普通模型。用于工具托管的 SDK 在没有普通模型时采用不可推理的 Model 端口，原生 child 若需要推理会明确要求普通模型。Codex 原生执行工具关闭，业务调用走每次执行的私有 MCP 桥及原 Lake 审批/账本。具体支持、版本、认证和平台限制见 [兼容记录](../../docs/validation/acp-agent-execution/compatibility.md)。

修改 Agent 连接配置会终止使用旧 revision 的调用。停止或断线后已发送但未明确回答的 prompt 保留 unknown，不自动重放或回退其他引擎。外部完成报告不等于任务验收；只有原任务实际业务回执可以支撑验收。
