# Lake

Lake Agent 使用仓库内的 Eino 框架运行模型与工具循环。运行 `bin/lake`（不带参数）进入对话；现有数据管理命令继续可用。Lake 支持运维资源查询、受控 SSH 操作，以及绑定本地代码项目后的分析、设计和实现工作流。

Lake 核心直接在 eino 框架内实现，使用根目录 Go 模块 `github.com/cloudwego/eino`。桌面壳在 `client/desktop` 使用独立的 Wails Go 模块，复用 Lake CLI 进程：

- `cmd/lake/`：产品 CLI 入口；从根目录编译为 `bin/lake`。
- `lake/store/`：独立于 Agent 包的 SQLite 运维数据层。
- `lake/model/`：Anthropic Messages、OpenAI Chat Completions 和 Responses 模型适配器。
- `lake/operate/`、`lake/transport/ssh/`：授权、湖志与 SSH 执行服务。
- `lake/code/`：本地及远程代码项目的受限文件读取、修改和命令执行。
- `lake/workflow/`：运维工作流定义校验、依赖编排、执行与恢复。
- `adk/`、`components/`、`compose/` 等：Eino 底座源码。
- `docs/`：Lake 设计文档。
- `client/desktop/`：macOS 桌面客户端，React 界面使用 beUI 组件。

默认数据目录为 `~/.lake`，可用 `LAKE_HOME` 改到测试目录。

```sh
scripts/setup_lake_signing.sh   # macOS 首次开发构建时运行一次
scripts/build_lake.sh           # 编译并使用同一身份签名 bin/lake
bin/lake model configure --model mimo-v2.6-pro --base-url https://api.xiaomimimo.com/anthropic
bin/lake model login             # 新用户输入 API Key
bin/lake secrets migrate        # 旧用户从钥匙串迁移时运行一次
bin/lake model add --provider deepseek --model deepseek-v4-pro --base-url https://api.deepseek.com/anthropic
bin/lake model add --provider deepseek --model deepseek-flash
bin/lake model login --provider deepseek
bin/lake model ls
bin/lake model use deepseek-flash
bin/lake
bin/lake -m mimo-v2.6-pro -c model_reasoning_effort=high "看看当前湖的主机"

bin/lake add 订单
bin/lake ls
bin/lake use 订单
bin/lake res add prod-web-01 --ssh ops@10.0.0.5 --identity /absolute/path/to/id_rsa --env prod
bin/lake res k8s-contexts --kubeconfig /absolute/path/to/config
bin/lake res add-k8s 订单/测试集群 --kubeconfig /absolute/path/to/config --context demo --namespace default
printf '%s' "$DB_PASSWORD" | bin/lake res add-db 订单/主库 --kind mysql --host db.example.com --user reader --database orders --password-stdin
printf '%s' "$PG_PASSWORD" | bin/lake res add-db 订单/报表库 --kind pg --host pg.example.com --user reporter --database reports --password-stdin
printf '%s' "$STARROCKS_PASSWORD" | bin/lake res add-db 订单/分析库 --kind starrocks --host fe.example.com --user analyst --database analytics --password-stdin --tls disable
bin/lake res authz 订单/测试集群 on
bin/lake res identity prod-web-01 --file /absolute/path/to/id_rsa
bin/lake res ls
bin/lake res authz prod-web-01 on
bin/lake res authz --all on --lake 订单
bin/lake permissions --json
bin/lake permissions set ssh-command on
bin/lake journal --tail
bin/lake code add 订单 my-app --path /absolute/path/to/my-app
bin/lake code list
bin/lake -C /absolute/path/to/my-app "分析项目结构并设计实现方案"
bin/lake workflow list --lake 订单
```

模型配置在 `~/.lake/config.toml`，可登记多个模型并用 `lake model use` 切换默认模型；桌面客户端输入框底部也可切换。API Key 和导入的 SSH 私钥保存在 `~/.lake/secrets/` 中的本地文件，目录权限为 `0700`，文件权限为 `0600`。这些文件没有额外的应用层加密，应像原始私钥一样保护和备份。`lake model login` 会隐藏输入 API Key。旧版钥匙串凭据可运行一次 `lake secrets migrate` 迁移；迁移期间 macOS 可能要求最后一次钥匙串授权。对话入口支持 Codex 风格的 `-m/--model`、`-c/--config` 和 `-p/--profile`；`-m` 可临时选择已登记的模型，配置档是 `~/.lake/<名称>.config.toml`。模型协议可选 `anthropic`、`openai_chat` 或 `openai_responses`，未写 `wire_api` 的旧配置按 Anthropic Messages 读取。

Web 工具默认不加载。需要搜索时，在 `config.toml` 配置支持 JSON 响应的 SearXNG 地址；需要抓取时，明确列出可访问的域名，例如：

```toml
web_search_endpoint = "http://127.0.0.1:8080"
web_allowed_domains = ["docs.example.com"]
```

Web 搜索和抓取每次请求批准；抓取只访问列出的域名，不跟随跳转，响应上限为 1 MiB。代码会话绑定项目后可读取项目内 PDF 文本，单文件上限 8 MiB，每次最多 10 页、64 KiB 文本；PDF 字形间距可能无法完整还原。

Skill 放在 `~/.lake/skills/<名称>/SKILL.md`；绑定代码项目后还可读取项目的 `.lake/skills/<名称>/SKILL.md`，同名时项目级优先。文件须包含 `name` 和 `description` 的 YAML front matter，单文件上限 16 KiB。用 `bin/lake skill list [-C 项目目录]` 查看清单、`bin/lake skill show <名称> [-C 项目目录]` 查看正文；在 CLI 或桌面对话中输入 `/skill load <名称>` 才会把正文加入当前会话。每个会话最多加载 4 个、正文合计最多 32 KiB。重开会话时仅恢复内容哈希未变化的 Skill；修改后需再次显式加载。Skill 内容不授予工具权限，所有操作仍执行 Lake 原有的范围校验与审批。

本地插件使用 `lake-plugin.json` 清单，只能声明 `skills`、`mcp` 和 `hooks` 文件路径，不携带 Lake 运维资源或凭据。可先运行 `bin/lake plugin inspect <本地目录>` 查看版本和插件树 SHA-256，再用可信来源提供的校验值执行 `bin/lake plugin install <本地目录> --sha256 <校验值>`。安装目录为 `~/.lake/plugins/<名称>/<版本>/`，默认关闭；`bin/lake plugin enable <名称>` 校验文件和私有权限后启用，`disable` 关闭，`list` 查看状态。启用后，插件 Skill 可在清单中找到，并用 `/skill load <插件名>/<Skill名>` 显式加载。MCP 和 Hook 声明目前只记录与校验，不会因插件启用而自动执行；后续扩展阶段将接入受控运行。

工作区 Hook 使用项目 `.lake/hooks.json`，格式如 `{"version":1,"hooks":[{"event":"SessionStart","command":"scripts/start-hook"}]}`。支持 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure` 和 `Stop` 七类事件，最多 16 条声明；命令须为项目内可执行文件，不通过 Shell 解释。运行 `bin/lake hook status -C <项目目录>` 查看状态，`enable` 明确启用，`disable` 关闭。每次执行仍会请求批准；无交互批准时不运行。命令限时 5 秒，标准输出和错误输出各限制 8 KiB，只继承必要环境变量。Lake 只向 Hook 传递事件元数据和摘要，不传完整提示词或工具参数；输出不会成为模型指令。声明或命令文件变化会使原许可失效，需重新运行 `enable`。

Kubernetes 集群可作为 `k8s` 资源登记。`add-k8s` 从指定 kubeconfig 导入并压平所选 context，凭据复制到 `~/.lake/secrets/kubeconfig/`，不会在 SQLite 或资源列表中显示。桌面侧栏“资源”旁的 `+` 提供相同入口，可选择 context、默认 namespace，以及是否立即开启该资源的只读执行授权。Agent 的 `lake_k8s_get` 可查询 pods、deployments、services、nodes、namespaces、statefulsets、daemonsets、jobs、cronjobs 和 events；不提供 Secret 查询或集群写操作。Kubernetes 查询依赖本机安装的 `kubectl`；若 kubeconfig 使用外部认证插件，该插件也须继续可用。配置导入后可删除原 kubeconfig 文件，但外部认证插件或其他外部依赖仍需保留。

MySQL、PostgreSQL（`pg`）和 StarRocks 可作为数据库资源登记。桌面侧栏“资源”旁的 `+` 可选择类型并填写连接信息；CLI 使用 `res add-db`，密码仅从标准输入读取。密码复制到 `~/.lake/secrets/database/`，SQLite 和资源列表只保存连接元数据与凭据引用。默认端口分别为 3306、5432 和 9030；TLS 默认验证服务器证书，需要明文连接时显式选择 `--tls disable`。新资源默认关闭执行授权，可在添加时通过客户端开启，或运行 `lake res authz 湖/资源 on`。Agent 的 `lake_database_inspect` 只支持 `version`、`databases`、`tables` 固定元数据检查，不接受任意 SQL。`tables` 检查 MySQL 和 StarRocks 时应配置数据库名。

交互终端请求期间显示旋转进度图标和已等待时间，SSH 确认输入时会暂时收起；每轮模型回复后显示整轮耗时、模型请求耗时、工具及本地耗时、模型请求次数，以及服务商返回的输入、输出和合计 Token；工具调用期间产生的多次模型请求会合并统计。若服务商未返回用量，会明确显示“未返回用量”。直接询问资源清单时，Lake 从 SQLite 数据层生成答复，不调用模型：未指定湖显示所有湖的总数、资源总数和各湖数量；指定湖或询问“当前湖”则显示该湖真实登记的资源及当前执行授权状态。复杂问题仍可调用 `lake_overview` 和 `lake_resources`。对话中的 `lake use` 选择只决定 SSH 操作范围，不限定未指定湖时的概况查询。资源清单不包含授权时间或曾执行的命令，Agent 不应推测这些信息。

macOS 开发构建继续使用本地代码签名身份，确保桌面应用和迁移命令的身份稳定。`setup_lake_signing.sh` 只需在本机运行一次；之后使用 `scripts/build_lake.sh`。旧版凭据迁移必须由签名版的 `bin/lake secrets migrate` 执行。迁移后，正常对话与 SSH 操作不再访问钥匙串。

SSH 工具提供 `hostname`、`uptime`、`os`、`cpu`、`disk`、`memory` 固定只读检查；`cpu` 从 Linux `/proc/stat` 采样一秒计算占用率。静默权限默认允许这些只读检查直接执行，其他单行命令默认按写操作逐次确认。`lake permissions` 可查看或设置全局的 `ssh-read`、`ssh-command` 开关；桌面客户端输入框旁的盾牌按钮也可设置。开关存入 SQLite，对所有湖持久生效，并在当前对话的下一次 SSH 操作中生效。关闭只读静默权限后，固定检查也须逐次确认；开启命令静默权限后，其他 SSH 命令免去逐次确认，但仍受资源授权和内置阻止规则约束。目标必须属于进入对话时冻结的当前湖资源范围，且 `EXECUTE_AUTHZ=true`；主机密钥由 `~/.ssh/known_hosts` 校验。私钥从 Lake 本地凭据目录临时读取，不进入模型上下文。湖志记录命令摘要，避免把命令中的凭据写入 SQLite。当前不支持脚本执行和交互式 SSH shell。

Lake Agent 将 SSH 请求交给`lake_ssh_agent` 专员。外层负责接收问题和汇总结果；专员实际调用 SSH 工具。委派时终端进度会切换为“SSH 专员正在处理”，完成后会显示 `Lake Agent → SSH 专员 → Lake Agent` 的执行链路。可在对话中说“连接并保持测试湖的 36.151.150.63”，它会建立一条可复用的已认证 SSH 连接；之后的检查复用连接，每条命令仍单独校验授权，并创建独立的非交互执行通道。输入 `/sessions` 可立即查看当前挂起的连接、打开时间和最近使用时间；`/ssh open <资源名>`、`/ssh close <资源名>` 可在本地直接打开或关闭。连接只在当前 Lake 对话进程中保持，退出对话时全部关闭；没有启动远端 shell 或 PTY。

`execute_authz` 保存在数据层，设置后跨对话持续生效。可用 `lake res authz --all on [--lake 湖名]` 一次开启某个湖现有资源的执行授权；后续新增资源默认关闭，需要单独开启或再执行一次批量命令。在 `lake>` 对话提示符下也可直接输入 `lake res authz ...` 或 `lake res ls`，由 CLI 本地处理，不交给模型自行授权。

数据命令支持 `--json` 输出。原有湖与资源管理命令的数据变更及湖志事件在同一笔 SQLite 事务中提交。`--identity` 会将私钥内容复制到 Lake 本地凭据目录，SQLite 只保存凭据引用；导入成功后不依赖原私钥文件。

## 运维工作流

工作流由执行器管理依赖和历史，由模型专员执行复杂目标、处理明确的命令失败。桌面直接运行 v1/v2 后，Lake Agent 会在同轮分析真实运行结果，记录实际模型调用和 Token 用量。

- `ssh_task` 需要 `goal`，填写目标、操作边界和验证标准，不填写固定 `command`。专员可根据实际环境选择方法。
- 默认 `execution_mode=adaptive`：v1/v2 的 SSH 命令明确非零退出后，专员根据原输出诊断、选择替代操作并验证。v1 可显式设 `execution_mode=fixed` 关闭步骤自动恢复；桌面仍调用模型分析最终结果。
- v1 每次新运行先由 AI 检查执行计划，参考同一工作流、同一资源和操作的最近5次记录。AI 可自行延长执行等待（最多3600秒）、增加同资源成功步骤依赖以减少并行竞争；任务、命令、主机、已有依赖和分支保持原义。调整前后及证据保存到本次快照，卡片可展开查看。模型评估最多20秒、两次请求；不可用时明确说明并沿用原计划，取消则不执行。`fixed` 跳过规划，恢复沿用原运行计划；未知命令仍不自动重放。
- `lake workflow plan <工作流ID> --json` 只调用 AI 评估配置并返回调整原因，可用 `--resource` / `--target` 指定目标，或用 `--from-run <运行ID>` 评估历史失败时的配置，不运行 SSH、不修改保存定义或历史。
- 每次专员执行最多 16 轮、180 秒，只操作原步骤资源并沿用审批。恢复成功必须引用最后一次实际成功的验证工具调用，才能推进后续依赖。授权撤回、审批拒绝、结果未知均停止。
- 模型不能保证修复所有故障。达到上限、验证失败或未提交证据时保留失败状态；未知结果保留为 `unknown`，须先核对实际副作用。

目标任务步骤示例（资源须已登记）：

```json
{"id":"restart","name":"恢复测试服务","kind":"ssh_task","resource":"web","goal":"仅恢复已授权的测试服务；先确认实际启动方式和失败原因，选择适当的重启方法，最后验证进程和健康接口。不改动其他服务，不重启整机。"}
```

Lake 参考 [ZCode 的动态工作流编排](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/bundled-skills/skills/dynamic-workflows/SKILL.md)，在 Lake 内实现按湖归属的运维步骤图。创建时用 `target_mode` 选择目标方式：`fixed` 在步骤中写死已登记资源，运行时直接执行；`single` 运行时选择一台主机；`multiple` 运行时选择多台主机，每台独立执行整套步骤图。单选和多选可将步骤资源写成 `$host`。未写 `target_mode` 的旧定义继续按原含义运行。支持 `ssh_check` 固定巡检、`ssh_command` 已知命令及 `ssh_task` 目标任务；`depends_on` 指定依赖，互不依赖的步骤最多并行 4 个，`when` 可设为 `all_success`、`any_failure` 或 `always`。单次运行最多 32 个步骤，多选主机数因此受步骤数限制。创建和修改工作流只保存定义；运行时再次检查目标是否属于当前湖、资源授权、SSH 静默权限和主机密钥。运行记录保存解析后的实际资源快照；以后修改定义不会改变历史运行或恢复执行的目标。运行状态、步骤输出、错误与事件保存在 SQLite，SSH 湖志使用同一个运行 ID。Agent 可通过对话创建、修改、查询、运行当前湖的工作流；桌面侧栏在固定模式下直接运行，在单选或多选模式下选择目标。执行轨迹显示工作流执行器和每一步真实的 SSH 服务调用状态。

工作流 v2 的 JSON/YAML 解析、静态编译与持久化执行已接入 CLI 和 Agent，支持 `ssh_check`、`ssh_command`、`code_task`、`specialist_task`、`tool_call` 五种节点、类型化结果引用、依赖/条件及有界扇出；最坏情况下最多 32 个展开节点，并行上限为 4。v14 表在分派节点前保存输入快照、审批决定和运行状态；取消后的写节点标为未知，恢复须显式允许重试。`dry-run` 只输出节点顺序、目标、权限需求和估算模型调用，不执行模型或工具。桌面 v2 管理、运行、审批和恢复已接入；现有 v1 定义继续运行。

v2 示例（保存为 `inspect-v2.yaml`）：

```yaml
version: 2
name: 主机巡检-v2
nodes:
  - id: host
    kind: ssh_check
    target: {type: string, literal: web}
    check: hostname
  - id: health
    kind: ssh_check
    depends_on: [host]
    target: {type: string, literal: web}
    check: uptime
```

```sh
bin/lake workflow validate --file inspect-v2.yaml
bin/lake workflow dry-run 订单 --file inspect-v2.yaml
bin/lake workflow save 订单 --file inspect-v2.yaml
bin/lake workflow amend <v2工作流ID> --file inspect-v2.yaml
bin/lake workflow run <v2工作流ID>
bin/lake workflow status <v2运行ID>
bin/lake workflow events <v2运行ID>
bin/lake workflow resume <v2运行ID> --retry-writes
```

代码专员节点运行时需用 `--project <已登记项目ID>` 绑定当前湖的代码项目；恢复时仍需传入同一项目 ID。当前专员节点支持 `lake_ssh_agent`、`lake_code_agent`；工具节点允许 `lake_overview`、当前湖的 `lake_resources`、`lake_k8s_get` 和 `lake_database_inspect`。非交互运行到风险节点会停在 `waiting_approval`；交互终端以节点输入快照哈希供人工审批。Agent 工具也提供 v2 校验、预演、保存、修改、运行、状态、事件与恢复。

例如将以下内容保存为 `inspect.json`。`$host` 表示运行时选择当前湖的一台已登记主机：

```json
{
  "name": "主机基础巡检",
  "description": "并行检查 CPU 和磁盘，成功后查看系统版本",
  "target_mode": "single",
  "steps": [
    { "id": "cpu", "name": "检查 CPU", "kind": "ssh_check", "resource": "$host", "check": "cpu" },
    { "id": "disk", "name": "检查磁盘", "kind": "ssh_check", "resource": "$host", "check": "disk" },
    { "id": "os", "name": "查看系统版本", "kind": "ssh_check", "resource": "$host", "check": "os", "depends_on": ["cpu", "disk"] }
  ]
}
```

```sh
bin/lake workflow add 订单 --file inspect.json
bin/lake workflow update <工作流ID> --file inspect.json
bin/lake workflow list --lake 订单
bin/lake workflow run <工作流ID> --resource web
bin/lake workflow run <工作流ID> --bind host=web
bin/lake workflow run <多选工作流ID> --target web --target db
bin/lake workflow runs --lake 订单
bin/lake workflow status <运行ID>
bin/lake workflow events <运行ID>
bin/lake workflow resume <运行ID>
```

`fixed` 工作流无需目标参数。`single` 用 `--resource` 选一台主机；`multiple` 可重复传 `--target` 选多台主机。旧定义的不同步骤资源仍可重复传 `--bind` 做映射，例如 `--bind web=host-a --bind db=host-b`；这表示步骤映射，不表示在多台主机重复运行整套流程。`update` 接收完整的新 JSON 定义；对话中也可直接要求 Lake Agent 修改工作流。

v1 步骤可设置 `timeout_seconds`（1–3600，未设置的原始期限为20秒，adaptive模式可由AI自主延长）来配置单次 SSH 执行时间，例如全盘扫描设置300秒；连接建立期限和父任务取消保持原有行为。多个全盘扫描可以用依赖串行执行，减少磁盘竞争。执行轨迹按真实完成步骤显示成功数，超时、结果未知、跳过和取消不计入成功。

中断或失败后可恢复已完成步骤。重试任何可能产生副作用的 `ssh_command` 步骤前，须先核对远端实际状态，再显式使用 `resume <运行ID> --retry-writes`。如果执行进程被强制结束而记录仍为 `running`，确认原进程已退出后，先执行 `workflow recover <运行ID> --force`。

v2 工作流可创建一次性或五字段 cron 计划。计划保存工作流版本；定义变更后该计划停止执行。SQLite 事务认领到期点，租约过期将运行标记为未知并暂停计划；含写节点的失败运行也暂停后续计划。缺少精确预授权的风险节点保持 `waiting_approval`。`workflow dry-run --json` 提供固定 SSH 命令的 SHA-256；`schedule authorize` 只接受与当前版本、节点、已登记资源、命令哈希、到期时间和次数匹配的授权。`install` 仅在从 `Lake Local Development Code Signing` 签名的可执行文件运行时安装 macOS LaunchAgent。

```sh
bin/lake schedule add <v2工作流ID> --at 2026-10-01T09:00:00+08:00
bin/lake schedule add <v2工作流ID> --cron '0 9 * * 1-5' --tz Asia/Shanghai
bin/lake schedule list --lake 订单
bin/lake schedule status <计划ID>
bin/lake schedule runs <计划ID>
bin/lake schedule authorize <计划ID> --node <SSH写节点ID> --resource web --command-sha256 <预演所得哈希> --expires 2026-10-31T23:59:00+08:00 --max-runs 1
bin/lake schedule install
bin/lake schedule stop <计划ID>
bin/lake schedule uninstall
```

已登记脚本可按湖或资源列出、读取和运行；`script add` 把本机 `sh`/`bash` 文件复制到 Lake 私有脚本目录并保存 SHA-256。运行前重新读取并校验内容，脚本经 SSH 标准输入传输，不把正文拼进命令行、审批摘要或湖志。资源仍须开启执行授权，运行仍遵守 SSH 审批。`link list` 可查看资源间的依赖、包含和连接关系。Agent 提供对应的脚本/关系工具；v2 工作流的 `lake_script_run` 工具节点必须保存固定的脚本 ID、当前湖目标资源名和脚本 SHA-256，脚本变更会阻断运行。

```sh
bin/lake script add 订单/web --name health --file health.sh
bin/lake script list 订单/web
bin/lake script read <脚本ID>
bin/lake script run <脚本ID> --resource 订单/web
bin/lake link list 订单/web
```

`lake web serve` 在 `127.0.0.1:8765` 提供只读 Web 工作台和版本化的会话列表、完整消息、事件分页与 WebSocket 流；浏览器打开 `http://127.0.0.1:8765/` 即可查看同一会话。事件使用已持久化的会话序号；断线后以 `after=<最后序号>` 补取，不重复执行工具。Web 页面复用桌面的会话入口、消息、审批提示和模型状态组件；审批须在发起操作的入口处理。非回环监听必须提供私有 Bearer 令牌文件、允许的 HTTPS Origin 和 TLS 证书/私钥；页面只在内存中保存用户输入的令牌。可用 `lake web token-create` 建立私有令牌文件；令牌值不会显示在终端。修改 Web 源码后，先在 `client/desktop/frontend` 安装依赖，再在 `client/web` 运行 `npm ci && npm run build`，最后用 `scripts/build_lake.sh` 构建并签名包含 Web 资源的 CLI。

`lake tui` 使用同一版本化会话 API 以纯文字显示会话消息、工具、待审批动作与工作流进度。方向键或 `j/k` 选择会话，Enter 打开，`b` 返回，`r` 刷新，`q` 退出；无参数 `lake` 仍进入原有交互对话。TUI 不启动 HTTP 监听，也不在只读入口执行审批。配置允许的 Web 域名后，Agent 还可用显式浏览器会话工具打开、导航、读取和关闭页面；最多保留 4 个文本页面会话。每次打开和导航须批准，页面结果不可信，适配器不运行 JavaScript、不保存 Cookie，也不持有 SSH 凭据。

验证：从仓库根目录运行 `go test ./...` 和 `go vet ./...`。Lake 与 eino 共同编译，无需 `go.work` 或本地 `replace`。

## 桌面客户端

桌面客户端使用 Wails（Go + 系统 WebView）和 React。聊天消息及展开动画直接复用 [beUI](https://github.com/starc007/ui-components) 的 MIT 组件源码；湖、资源、代码项目和运维工作流侧栏由 Lake 实现。侧栏按湖显示会话、资源、代码项目与工作流；会话可新建、切换、重命名、归档和恢复。SSH 会话可在对话中创建、查询和关闭。对话内容保存在 `~/.lake/lake.db`，切回会话时会恢复消息和最近的模型上下文。每次只运行当前会话的一条 `lake bridge` 进程；切换会话或退出客户端会关闭该进程中的 SSH 连接。日常对话的模型和 SSH 凭据由 Lake CLI 读取，不传给模型上下文。

侧栏右边界支持左右拖动调节宽度，松开后在本机保存，重启自动恢复；双击分界线恢复默认宽度。分界线也可键盘聚焦，左右键微调，Shift 加方向键按更大幅度调整；Escape 取消当前拖动。缩窄窗口时侧栏会限制宽度，再放大窗口会恢复原偏好。

“运维工作流”同时展示 v1 和 v2 定义，支持每个湖下自建多级目录、重命名及删除空目录。拖到目录行中间可移入，拖到行的上下边缘可调整同级顺序，拖到湖标题可移回根目录；拖动目录会保留整个子树。层级及顺序保存在 SQLite，重启后恢复；移动只改变归类，不修改工作流定义、修订或所属湖。目录不能移入自身或子目录，也不能跨湖移动。

动态交互界面使用 [官方 A2UI](https://a2ui.org/quickstart/) React / Web Core 0.12.0 的 v0.9.1 协议。所有 AI 回复默认使用 A2UI，无需额外要求图形化；简单问答保持紧凑，标题自动分组，步骤展示为清单，代码可复制或填入命令框，表格可筛选，有明确百分比数据时自动组合图表与明细标签页。历史文字按原始正文生成相同视图，自动展示不增加模型请求、不修改已保存的正文。复杂布局和交互任务通过 `lake_ui` 组合卡片、指标、柱状图、表格、标签页、选择框和输入框；按钮将表单选择交回同一任务，结果在原面板增量更新。提交的输入和展示快照随会话保存，切回会话可恢复；只读 Web 可切换标签、筛选清单，表单和操作按钮禁用。Lake 注册自己的受限组件目录，不运行模型提供的界面代码。

输入“检查主机端口”可生成 `lake_port_inspector` 面板：选择当前湖已授权的 SSH 主机，点击“查询端口”，再选择清单中的 PID 查看进程详情和最近 40 条 journalctl 日志。打开面板不会连接远端；点击后使用原有资源作用域、授权和命令审批。端口清单最多展示 200 条，缺少进程权限、`ss` 或 `journalctl` 时显示实际缺失或错误；监听端口不等于服务健康。面板查询的命令及脱敏输出也保存在统一执行时间线中。

巡检和工作流分析使用当前会话的 A2UI 展示入口，实际指标、图表、异常和清单由 `lake_ui` 或自动正文界面呈现；不同时向模型提供旧报告与 A2UI 两套参数。已有 `lake_visual_report` 报告仍随会话保存和恢复，没有 A2UI 通道的调用方继续支持旧报告工具。工作流步骤和运行阶段默认折叠，执行完成不自动生成以步骤数量充当检查结果的报告。单个步骤使用紧凑行，多步依赖才展示流程图。

`lake_ui` 推荐直接提供 `components` 和可选 `data`，首次可省略 `surfaceId`，由程序封装协议版本、组件目录以及创建/更新消息，并返回面板 ID；已有面板可以仅提供 `surfaceId/data` 更新数据。原 `messages` 继续兼容，但不能与简单字段混用。组件仍通过目录、字段、数据和动作校验；常见的 `props` 封装与字面数值指标在校验前转换为标准形式，不能覆盖组件标识或已有字段，也不能更改受保护的原生端口面板。

界面格式错误会作为可修正反馈返回模型，不中断已完成的工作流。每轮最多两次无效展示调用，随后程序关闭本轮全部工具，保留模型上下文中的实际结果并请求直接输出正文，由客户端自动生成卡片、清单和表格；下一轮恢复正常工具。工作流执行后的分析和历史错误的“重新整理结果”只提供读取已保存工作流记录及展示界面的工具，不提供命令执行、远端查询或工作流运行工具。同轮相邻的格式修正尝试合并显示最终展示状态，每次调用结果仍可展开；持久记录只增加受限错误类别，不保存无效输入或任意错误内容，真实执行或存储失败仍按原错误显示。动态面板与正文共用 820px 最大列宽，指标与卡片使用紧凑字号和间距；静态结果明细默认折叠，交互查询和普通回复中的清单保持可见。

侧栏底部的“设置”包括模型、内置专员、MCP 服务器和扩展与权限。模型页展示已登记模型、Base URL、协议、上下文窗口、最大输出 Token 和 API Key 是否已配置；可添加、更新或移除模型。密钥不进入桌面 WebView，模型 API Key 须在本机终端运行 `bin/lake model login --provider <提供方>` 输入。内置专员页可修改用于分派的说明与补充提示词；Lake Agent、SSH 专员和代码专员的基础资源校验与审批规则仍由程序和内置提示词执行。上述更改在新对话中生效。扩展页仅展示 MCP、Skill、插件和当前绑定项目 Hook 的状态与摘要，可显式启停插件和 Hook；Hook 运行仍逐次请求批准。

MCP 页支持本地命令（stdio）和 Streamable HTTP，可配置启动参数并测试工具发现。环境变量和 HTTP 请求头须在本机终端分别用 `bin/lake mcp login --name <服务名> --env <变量名>` 或 `bin/lake mcp login --name <服务名> --header <请求头名>` 输入；命令只传名称，凭据值在交互提示中输入，不进入 WebView 或进程参数。官方 Go MCP SDK v1.7.0 优先协商 `2026-07-28`，并兼容旧协议。启用的服务器会在新对话启动时连接，其工具以 `mcp_<服务名>_<工具名>` 暴露给 Lake Agent；每次调用都会请求用户批准。桌面对话在调用时逐条显示 `MCP · 服务名 · 工具名`，运行中显示进度，完成或失败后保留记录；重开会话也会恢复这些调用行。服务配置和专员配置保存在 `~/.lake/settings.json`，其中 MCP 只保留凭据引用；MCP 环境变量与请求头单独保存在 `~/.lake/secrets/mcp/`，文件权限为 `0600`，连接时才读取，不在设置列表中回显。stdio 服务只继承必要的进程环境变量及明确配置的环境变量。设置请求经本地 CLI 的标准输入传送，不把密钥写入命令行参数。远程 MCP 需使用 HTTPS；本机可使用 HTTP。

调用 SSH 或代码专员时，对话中会出现紧凑的调用行；展开后显示 Lake Agent 委派、专员处理、交回汇总的阶段。调用记录随会话保存，切回会话仍可查看；状态表示委派流程，并不代替远端操作或测试本身的结果。两类内置专员现共用 Go/Eino 专员运行器：配置模型标识、工具白名单、最多 20 轮模型生成和湖/项目范围，运行范围与父任务取交集。v13 的 `specialist_task` 表记录委派、运行、完成或失败状态及请求/结果摘要，不保存原始工具参数；结果仍交给 Lake Agent 汇总，旧 `SpecialistCall` 时间线保持可读。

从侧栏运行已保存的工作流会直接向 Lake 桥接进程提交结构化目标，不再让模型从自然语言中猜测运行参数。`fixed` 使用创建时写入的资源且不弹出目标选择；`single` 运行时选一台；`multiple` 运行时勾选多台并为每台展开完整步骤。运行卡片会显示工作流执行器及逐步 SSH 服务状态，并随会话保存。执行器保留依赖调度和真实状态，执行结果在同轮交给 Lake Agent 调用模型分析。普通对话中的单步 SSH 请求仍由 SSH 专员处理。

对话框输入 `@` 可从已登记资源中选择目标，候选项显示所属湖、连接地址和授权状态，支持继续输入湖名、资源名或主机地址筛选，用方向键与回车选择。选中的资源只显示为输入框上方的标签；发送时客户端将其转换为 `@湖名/资源名` 引用，也可在一条消息中选择同一湖的多个资源。目标属于另一个湖时，客户端会切换到该湖的会话；一条消息不能跨湖引用多个资源。单独发送资源标签会直接显示数据层登记的信息；引用不授予 SSH 执行权限，远端操作仍走 SSH 专员及原有授权规则。

“代码项目”区域的 `+` 可选取本地目录并关联到所属湖；点击项目会把它绑定到该湖的当前会话，顶部 `×` 可解除绑定。Lake Agent 会将代码请求交给代码专员。它可列文件、读取与搜索代码、查看 Git 状态和差异、精确替换文本、新建文件、运行项目目录中的构建或测试命令。若只要求设计方案，它会保持只读；每次写文件或执行命令都会展示目标及内容并等待本次批准。文件工具拒绝项目外路径、符号链接逃逸和常见凭据文件；大型或二进制文件不在当前工具范围内。命令从项目目录启动，但 shell 命令本身没有文件系统沙箱，批准前须核对完整命令。这一工作流参考了 [ZCode](https://github.com/zai-org/ZCode) 的项目上下文和工具分工，在 Lake 的现有 Agent 与审批机制中独立实现。

绑定项目后，顶部“代码工作台”打开文件树、文本预览、Git 状态/提交图/差异和受控终端面板。工作台按项目 ID 校验登记范围；敏感路径不进入文件树或 Git 差异。终端按任务会话管理，使用持续的受控 Shell，保留 `cd` 和 `export` 状态；面板显示执行主体及实际目录，每条命令仍经 Lake 权限策略批准。收起工作台、切换会话或模型不会关闭工作终端；可在空闲时显式关闭，退出桌面应用会中止命令。终端按行执行，不提供交互式 TTY。湖志仅保存命令哈希；会话事件保存有界、脱敏的执行记录。Shell 命令可自行访问项目外路径，因此批准时须核对完整命令。

远程代码工作区要显式绑定同一湖中已登记的 SSH 主机和规范绝对目录。登记时通过 SSH 主机密钥校验探测物理目录，初始不授权；SSH 运维资源的执行授权不会替代代码工作区授权。CLI 示例：

```sh
bin/lake code remote add 订单 service --resource 订单/web --root /srv/service
bin/lake code remote list --lake 订单
bin/lake code remote authz <工作区ID> on
bin/lake code remote bind <会话ID> <工作区ID>
bin/lake code remote files <工作区ID>
bin/lake code remote read <工作区ID> src/main.go
bin/lake code remote run <工作区ID> --command 'go test ./...'
bin/lake code remote write <工作区ID> src/main.go --file ./main.go --expected-sha256 <远端原文件SHA-256|absent>
```

桌面侧栏也可添加、单独授权和绑定远程工作区；远程面板显示用户、主机、端口和目录，可读写不超过 64 KiB 的 UTF-8 文件并逐条运行命令。远端文件写入需要原文件 SHA-256 条件；新建文件使用 `absent`。写入及命令执行每次都要批准，非交互 CLI 不批准这些操作。SSH 断连后结果记为“未知”，Lake 不会自动重试；请先核对远端状态。远端命令和本机 Shell 一样没有额外文件系统沙箱，批准前须核对命令。私钥只从 `~/.lake/secrets/` 读取，不进入桌面 WebView 或湖志。远程会话绑定后，代码专员使用远程工具，不会把同一会话落到本机项目工具。

输入框底部的模型菜单显示已登记的模型。切换模型会重启当前会话的 Lake Agent 进程，关闭原进程保持的 SSH 连接；已保存的聊天内容和上下文会恢复，当前模型会持久保存。

桌面对话支持点击图片按钮选择文件、粘贴截图或拖入图片；发送前可预览和移除。支持 PNG、JPEG、GIF、WebP，每轮最多 4 张、单张最多 2 MB；图片随会话保存在本地 SQLite 中，重新打开会话仍可查看。`deepseek-v4-pro` 不支持图片输入，发送图片时请在输入框切换到 `deepseek-flash`；其他模型的图片能力以服务商实际支持情况为准。

图片按视觉输入预留本地预算，不把Base64编码当作文字Token，也不改变发送给模型的附件。长会话达到输入预算约80%时压缩较早内容，按剩余Token空间保留近期完整轮次（最多64条消息），并预留下一轮空间；单条超长历史支持分段摘要。交接记录包含背景摘要及独立的任务状态：用户目标、约束、已报告结果、未完成事项、下一步与记录引用；合计预算随输入空间调整，最高4096 Token。用户目标和约束采用可核对的用户原文及来源序号，既有约束不会因模型遗漏被移除，新明确更正按来源先后优先；结果和建议不能作为执行凭证或授权。格式不完整时保留可核对的原文约束并标记待核对，不反复调用展示或重跑任务。

交接记录和摘要原子保存到SQLite，重开当前会话或切换模型后恢复；v19升级保留旧文字摘要并在升级前备份已有v18数据库。当前请求、失败附件和固定资料保持原样。输入`/compact`可以只压缩本会话、不执行任务；配置`model_auto_compact_token_limit`可指定自动压缩Token阈值，0或省略使用默认值，例如`bin/lake -c model_auto_compact_token_limit=18000`。所有原始消息和附件仍保存在本地，模型仍受窗口限制；受保护资料本身超过可用空间时显示中文提示。这是适配已有Anthropic、Chat与Responses协议的可读交接机制，未伪造或跨模型复用OpenAI加密压缩项。

失败或中断的请求也进入下一轮模型上下文，保留有效图片和已回答的问题，并明确标记尚未完整回复；连续失败时优先保留起始请求与最近一次失败，防止“继续”接到旧任务。重开会话采用相同恢复规则，摘要仅覆盖实际纳入的来源事件。AI 可用只读 `lake_conversation_history` 按关键词、历史轮次和分页游标回查本会话原文；返回有界文字与图片数量，不返回图片编码或认证字段，也不自动重放失败操作。完整历史保存在本地，模型窗口仍然有限，历史图片在摘要中不等于已识别其内容。

模型服务返回成功 HTTP 响应却没有文本或有效工具调用时，Lake 最多自动重试一次当前模型生成，保留同样的上下文、图片、工具定义及已经取得的工具结果，不重跑整个 Agent。Anthropic 仅返回思考且因 `max_tokens` 截断时，只在这次重试中关闭思考，不更改用户配置或提高输出额度。空回复和重试均计入用量，失败轮次也保存用量事件。HTTP 错误、拒绝、无效工具调用、解析错误与取消不重试；流式输出已有可见内容后发生错误，也不重复生成。连续空回复会说明已恢复一次、请求仍保留，并提示稍后重试或切换模型。连接失败、HTTP 错误与可解析但无内容是不同故障；网关入口可达不能证明其上游模型正常。

桌面输入框的视频按钮使用 macOS AVFoundation 从用户选择的不超过 100 MiB、300 秒的视频中提取最多 4 张 JPEG 关键帧，最长边不超过 768 像素；PDF 按钮使用 PDFKit 提取首页 JPEG 预览，并把最多 12 KiB 的前 10 页文本作为不可信资料附在提问中。两者都只把派生预览送入模型和会话，原视频/PDF 不进入数据库。桌面和只读 Web 均显示、可下载这些预览；专员结果摘要与工作流步骤轨迹可下载为 JSON。Web 另有按会话事件序号更新的工作流时间线与运行状态。PDF/视频系统解码需要 macOS 的 Swift 工具链。

输入框旁的盾牌按钮打开“静默权限”面板。只读 SSH 检查默认开启静默，其他 SSH 命令默认关闭；所有变更立即持久保存，仍需每台资源各自的执行授权。普通回车换行，`⌘+回车` 或发送按钮提交消息。

```sh
go install github.com/wailsapp/wails/v2/cmd/wails@v2.15.0
scripts/build_lake_desktop.sh
# 按脚本输出的 Application Support/Lake/builds/Lake-<时间戳>.app 路径打开应用
# 明确需要安装时再运行：scripts/build_lake_desktop.sh --install
```

macOS 构建脚本先用稳定身份签名 `bin/lake`，再将它打入应用；默认把签名应用放在 `~/Library/Application Support/Lake/builds/`，不会覆盖已有安装。成功生成并验证签名后，构建目录只保留最新一份应用；构建失败时保留原可用版本。`--install` 会将旧 `~/Applications/Lake.app` 保留为带时间戳的备份后安装新包。请勿直接使用 Wails 生成的未附带 Lake CLI 的临时应用。完整验收运行 `scripts/verify_lake_release.sh`；旧库迁移样本与安全回归分别见 [迁移样本](lake/testdata/migrations/README.md) 和 [安全清单](docs/security-threat-regression.md)，第三方许可见 [说明](docs/third-party-notices.md)。

旧数据库升级前，Lake 在数据目录生成 `lake.db.pre-v*-<时间戳>.bak` 一致性备份，权限为 `0600`。若升级失败，先退出所有 Lake CLI、桌面、Web 和调度进程，保留失败的 `lake.db` 供排查，再将对应升级前备份复制回 `lake.db` 并保持 `0600`；用与该备份 schema 匹配的旧签名程序启动。不要让新旧程序同时打开恢复中的数据库，也不要把真实数据库加入测试样本或仓库。


### 四项迁移闭环

新增插件 MCP/Hook 实际运行、自定义专员注册与独立模型/白名单、专员执行检查点恢复、工作流 v2 桌面管理。侧栏“运维工作流”的 `+` 打开 v2 管理；“设置 → 自定义专员”管理配置与任务。恢复会复用已完成结果，未知写操作默认阻断。CLI、声明格式与验收边界见[四项闭环说明](docs/migration-closure.md)。

## 终端与 AI 工作会话

绑定本地项目或远程代码工作区后，输入框可明确切换“问 AI”和“执行命令”。手动与 AI 命令共用任务终端及执行时间线，执行卡显示目标、实际目录、执行者、输出、退出码与耗时。点击“问这次执行”将最多四条已完成记录作为引用标签加入输入框；后端按会话校验引用，模型收到的是脱敏、有界的不可信资料，聊天历史恢复时重建相同的引用上下文。“填入命令框”只编辑草稿，不执行命令。

AI 代码专员的命令显示为提案。可以“允许执行”，也可以“这一步我来”；接管后原工具调用保持等待，AI 不能同时输入。手动命令仍须批准，执行后“交回 Lake”把同一任务、同一工作区的新结果交回原调用，继续当前轮对话。切换或重开已结束的会话可以回看记录；应用重启后不会伪装恢复旧 Shell，未完成的历史执行显示为“结果未知”。SSH 断线或 Shell 协议中断不会自动重试。
