# Lake React 工作台

Web 服务、SQLite 会话存储、SSH 和 PTY 终端管理、AI 工具循环全部由 Go 实现。`bin/lake` 内嵌 React 静态资源，运行和分发不需要 Node.js、pnpm、node_modules 或 AI 子进程。

```sh
scripts/build_lake.sh
bin/lake web --open
```

访问 `http://localhost:4177`。`--open` 使用一次启动令牌建立 HttpOnly、SameSite=Strict Cookie；不带 `--open` 时终端提供本机访问链接。API 保持 Bearer/Cookie、Host 和 Origin 校验，只监听 `127.0.0.1`。

macOS 的用户二进制只通过上述脚本构建，并由持久 `Lake Local Development Code Signing` 身份签名。缺少身份时先运行 `scripts/setup_lake_signing.sh`。

## 构建与开发

Node.js 24 和 pnpm 仅用于 React/Vite 构建与前端测试。Go 构建需要 C 工具链（内置 SQLite），macOS 可使用 Xcode Command Line Tools。

```sh
pnpm --dir web-agent install --frozen-lockfile
pnpm --dir web-agent check
pnpm --dir web-agent test:frontend
pnpm --dir web-agent build:web
scripts/build_lake.sh
```

已生成 React 产物时，可用 `LAKE_REUSE_WEB_ASSETS=1 scripts/build_lake.sh` 构建签名二进制，该路径也不调用 Node。Go 代码开发可用 `go run ./cmd/lake web --port 4178 --home /absolute/private/test-home`；它不替代用户签名发布入口。默认直接提供已嵌入的页面；调试 Vite 时另开 `pnpm --dir web-agent dev:web`，Go 服务显式设置 `LAKE_WEB_DEV_ORIGIN=http://localhost:5173`。

## 数据与凭据

项目侧栏的“项目记忆”打开记忆面板。默认在同项目会话中加载有界索引，并在成功回复后异步提取可复用事实；面板可编辑／忘记条目、分别关闭使用和自动提取、查看任务状态并重试失败任务。聊天输入区可勾选“本轮忽略项目记忆”，该选项只作用于当前消息。记忆以 SQLite 为权威数据，并投影到 `<DataDir>/memories/projects/<projectId>/memory/`；删除投影文件后可从数据库重建。旧会话不会批量回填。历史记忆不是实时状态或操作授权，涉及主机和服务的结论仍需当前证据确认。

默认数据目录 `<LAKE_HOME>/web-agent/`，默认 Lake home 为 `~/.lake`。`lake web --home PATH` 使用独立数据目录。Go 原地读取既有 `lake-web.sqlite`、`model.json` 和 `ai/` JSON 状态。需要升级原型表结构时，先通过 SQLite `VACUUM INTO` 生成权限 `0600` 的一致性备份 `lake-web.before-go-*.sqlite`。同一目录只允许一个 Go 后端。

项目、资源、会话、消息、图片、旧专员/证据、审批、命令记录和事件游标全部保留。服务重启会断开旧终端、标记在途操作结果未知和取消旧 AI 审批；不会自动重放任何执行。`runtime.json` 为权限 `0600` 的本机 CLI 连接信息，正常退出清理。

模型设置可在界面保存，或由 `LAKE_WEB_MODEL_URL/NAME/PROTOCOL/KEY` 提供。新密钥仅保存在 `<LAKE_HOME>/secrets/` 私有文件中，模型元数据只含引用，接口不回传密钥。清空 API Key 与省略 API Key 的行为分别为删除与保留。

SSH 支持密码、未加密私钥和带口令的私钥。添加资源时可读取 `~/.ssh` 或指定本机目录的私钥文件列表；仅选中的私钥复制到 `<LAKE_HOME>/secrets/`，不会导入整个目录。目录须归当前用户所有且为 `0700`，私钥为 `0600` 或 `0400`。密码和密钥口令也写入私有凭据文件，SQLite、HTTP 返回值及 AI 配置只保存引用。系统 OpenSSH 通过签名 Lake 二进制的 askpass 助手获取凭据，密码不进入终端输入、进程参数或环境变量，无需 sshpass/Node。持续终端、AI 远程文件操作、SCP 和 SSH 隧道使用同一登录方式。首次连接未知 SSH 服务器时弹窗显示 SHA256 指纹，确认后写入 `<LAKE_HOME>/secrets/ssh-host-*.known_hosts`，按主机地址与端口在 Lake 全局复用，跨项目、会话及重启都生效。已受信任的 `~/.ssh/known_hosts` 记录可沿用；Lake 保存的指纹优先，后续连接严格匹配，变化时重新显示新旧指纹并确认。指纹探测不发送登录密码或私钥，拒绝确认不会建立终端。正常操作不读取 Keychain；仅显式签名 `lake secrets migrate --manifest FILE` 可迁移旧凭据。

## 操作和界面

- 新建会话无需选择资源，名称根据对话自动生成。同项目所有资源都可在任意会话中通过 @ 引用；后来添加的资源也自动可用。终端与命令记录仍归各自会话，资源使用范围限定在所属项目。
- 本地与 SSH 持久 `/bin/sh` 保留 cwd/env。Go PTY 支持流式输出、输入接管、交互按键、窗口尺寸、VT 屏幕读取、后台命令和中断。
- SSH 连接失败会暂停该会话对同一主机的重复创建和授权。错误区分主机密钥、认证、端口拒绝、超时与网络问题；“为什么连接不上”等诊断问题不会自动重连。明确要求“重试／重新连接／继续”，或连接配置、凭据及可信主机记录变化后，可重新请求一次终端授权。已有终端的启动失败记录也参与恢复，正常关闭的成功终端仍按原规则重新创建。
- 本机终端最多 16 个；每终端保留 32 KiB 近期输出、最近 500 条命令和最多 1000 行屏幕滚动记录。超时/接管/中断不声称已知执行结果。
- 只读命令由完整语法和参数分类，在已授权终端上默认直接执行，通过 `command -p` 运行。开启静默执行命令后，查询、普通修改、指定文件删除/移动、复杂 Shell 命令和所需终端创建不逐次授权；大范围删除（例如 `rm -rf ./*`、根目录/用户目录清空、动态删除目标）以及磁盘擦除仍需确认。关闭静默时遵循原有命令授权。静默不跳过目标归属、多个终端绑定、禁止本地执行、引用限制和 SSH 主机指纹校验；文件读写/SQL 工具仍遵循对应开关。AI 审批还校验终端拥有者和上下文指纹。
- 支持原有六种模型协议、三种 AI 场景，以及数据库/Redis/Docker/SSH 工具、图片、上下文压缩、预设和历史操作。
- 聊天底部不再显示折叠的“持续终端”汇总条。可从资源页或操作交接打开终端。
- 旧审批卡片按创建时间保留在原轮次，状态更新不挪动位置；Go 自己的工具操作不重复生成旧式审批卡片。

## 验证与范围

执行 `go test ./...`、`go test -race ./internal/web ./internal/ai` 和前端测试。Go 测试覆盖真实本地 PTY、临时 sshd/合成密钥、严格主机信任、HTTP/SSE 鉴权与恢复、旧 SQLite 升级、模型私有存储、AI 确认/中断/撤销和后台任务。发布验证使用签名二进制、隔离 home 和不含 Node 的 PATH。

当前目标是 macOS/Linux POSIX 终端；Windows PTY 未验证。系统 OpenSSH 和 Docker CLI 仍是对应能力的系统依赖。未以用户的生产模型密钥或远程服务器验证。

旧 Node Web 后端与测试归档在 `legacy/web-agent/`，不参与构建或运行。旧 `agent/` TypeScript Agent 的 grants/tasks/workflow CLI 合约不同，新 Go 入口不会回退加载它；其数据文件保留，没有自动跨合约迁移。新 CLI 命令见 `lake --help`。

[Go AI 说明](../docs/hexhub-ai/README.md) · [迁移计划](../plan/refactor-go-server-1.md) · [验证记录](../docs/validation/lake-go-server.md)

### 资源目录

项目资源区支持新建多级目录。目录右侧 `+` 创建子目录，`⋯` 重命名或移除目录；移除目录会将其内容提升到上一层，保留资源本身及会话引用。拖动左侧手柄可调整前后顺序、移入目录或拖回根层；点击手柄也可使用上移/下移和目录选择，支持键盘与触屏操作。层级与顺序保存到 SQLite，刷新或重启后复用；折叠状态保存在当前浏览器。目录只整理当前项目的资源，不影响各会话引用全部项目资源，不能跨项目移动或产生目录循环。

思考过程默认显示单行当前动作（例如“正在读取文件”），不自动展开长篇原始思考。点击进度行查看工具记录，再点击“原始思考记录”可查看完整内容。原始记录保留，运行中不重复显示通用思考横条和计时行；结束后保留操作数量和总耗时。

短确认与寒暄（例如“好的”“谢谢”“你好”）仍携带完整上下文交给模型，不使用固定回复；没有显式资源或图片引用时仅跳过自动主机采样。模型可以根据对具体步骤的确认继续任务，普通寒暄不应触发无关排查。后台 PTY 命令可读取中间输出，每次 `wait_shell` 最多等待 5 秒；连续三次没有新输出或状态变化会停止重复轮询并明确告知后台状态，不将未结束的命令伪报为完成。前台 Agent 命令遵循 `timeout_ms`，超时断开并报告结果未确认；已结束对话不因后台终端仍忙而保持停止按钮。

服务启动只处理当时仍执行中的会话、命令和专员任务。历史已保留的 `unknown` 操作不会再次把已结束会话标记为失败，也不会在每次重启时重复插入中断提示。

## 增强终端与资源 AI 会话

持续终端工具栏新增“终端 AI”，按项目/资源恢复 AI 历史，当前终端由精确 ID 与 generation 绑定。访问原聊天拥有的终端需要单独采用授权；执行前点击“将空闲终端交给此 Agent”。授权不转移原终端所有权，命令记录另存发起会话；同终端只允许一个 Agent 会话写入。人工接管、关闭、权限变化或重启后需要重新授权。

本地终端创建可选 sh/Bash/Zsh/Fish，SSH 资源可配置 shell。Bash/Zsh/Fish 使用受控 hooks 采集目录和命令块，sh 保留完成标记。动态工具集只暴露当前终端支持的操作；离线读屏标记历史及原采集时间，等待工具拒绝旧输出。

“停止本轮”只结束 AI 推理、审批和等待；已启动命令可继续观察。“中断命令”发送 Ctrl-C，终端可保留，未确认的退出结果保持未知；“关闭终端”显式结束 shell。等待超时也保留命令，不自动重放。后台完成结果仍更新原卡片。

终端 AI 使用当前 cwd 和最近 24 块命令上下文，每块保留尾部最多 12000 字符，会话文本总尾部最多 16000 字符；超过模型预算会标记旧证据裁剪。会话设置新增已引用/批准资源的访问记忆、清除入口及同项目终端采用入口。新终端 generation 不继承旧 shell 的 cwd/env。

[补齐计划](../plan/feature-hexhub-terminal-parity-1.md) · [验收记录](../docs/validation/lake-hexhub-terminal-parity.md)

本轮逐项复核补齐终端面板图片/上下文引用、实时采样时间及授权永久撤销，并拒绝终端与资源不匹配配置。[24 步验收清单](../docs/validation/lake-terminal-plan-step-audit.md)
