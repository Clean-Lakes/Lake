## 持续终端与扩展增量

2026-11-05。用户指出 Dev 顶部“服务端不支持持续终端”。此前 TS bootstrap 为 command，真实 PTY 未移植。此次接入实际本机 PTY 和 Lake 现有终端 API；没有修改前端提示的显示条件。

### 实现范围

- macOS 本机手动终端使用固定上游依赖 node-pty 1.1.0，native addon 和 spawn-helper 在构建产物中单独签名；Node SEA 从同包资源加载，不依赖系统 Node。依赖包的 helper 原始权限是 0644，构建副本设置 0755；不修改固定上游源文件。
- 支持 Bash、Zsh、macOS sh，以及已安装 Fish 的入口（本机未验 Fish）；显式 Home、项目工作区、最小环境、无用户启动文件。终端 scope 不进入聊天侧栏；同资源可复用或新建连接。
- 原生交互输入、尺寸调整、Shell cwd/状态、命令块回执、Ctrl+C、断开、输出/命令历史持久化和 SSE 更新。结构化命令沿用现有 TS 分类器、变更确认和准确目标的危险操作确认；不接受冒充 agent 的 HTTP 命令。
- 会话/项目、generation、采用授权、当前连接修订及 Home gate 在写入时校验；Agent 交接/绑定明确拒绝。部分输入未提交时不混入命令块。关闭仅操作本进程创建的真实子进程句柄。重启将连接标记 disconnected、未完成命令标记 unknown，不恢复命令或根据旧 PID 杀进程。
- 对真实 PTY 的累计原始输出遮蔽模型/MCP 凭据和私钥，分段凭据前缀不先写入 UI/SQLite。transport 包装命令不绘制到用户终端。历史 GET 不写事件，避免 SSE 自激刷新。
- MCP 使用固定 ZCode 依赖中的公开官方 Client/SSE/HTTP/stdio SDK；设置读取不会连接或调用工具。配置、目录、项目绑定及权限在审批后和派发前再次校验，opaque 调用不自动重发。认证 HTTP 重定向与跨 origin 发送被拒绝，原 Dev 凭据保留私有文件引用。
- Skills 支持受管编辑/启停及外部根目录只读；拒绝符号链接越界、凭据目录和正式 Home。Worker 读取后的内容 hash/启用状态在模型派发和验收前复核。普通 Pilot 问候/身份问题直接完整回复，无需先提交 respond 路由。

### 已运行验证

固定 Node 24.14.0：严格 TypeScript 检查、bundle，以及 `node --test runtime/zcode/server.test.cjs` **36/36 通过**（最初 24 项加扩展/普通聊天 7 项及旧 MCP 全局屏障 1 项、真实 PTY 4 项）。PTY 测试不调用模型/远程主机，经过实际 PTY 和 Shell：

1. `test -t 0`、连续输入保留变量/cwd、实际 `stty size`、命令退出码/输出、重启保留输出且拒绝旧连接输入。
2. 跨项目隔离、采用的准确 generation、写入所有者、actor 冒充拦截、变更/危险确认、实际 sleep 中断并得到 130。
3. 真实进程分两次输出合成测试 key，检查中间视图、最终视图与重启后的 SQLite 均不包含完整原密钥。
4. 部分输入阻止混入命令块、Ctrl+C 恢复、传输包装不显示、重复历史读取不新增事件。

旧 MCP 全局屏障额外验证：归档项目、未进入目录 v1 迁移的旧 unknown 调用，在新调用待批之后出现，批准也不能派发；原 descriptor 身份未经核验时保守视为未知服务。

MCP 使用本地真实协议夹具，验证初始化、分页 tools/list、审批后的真实 tools/call、回执验收、私有头保护、配置重启、事务导入、跨站跳转拒绝和显式服务禁用覆盖继承。Skills 验证受管/外部、编辑/启停/重启与越界链接。

ADK runtime boundary 和 16/16 Dev 脚本回归通过。无前端布局修改。完整门禁继续 BLOCKED：候选测试覆盖不是 118 项 API 的完整等价验收。

### 仍未交付的范围

SSH 凭据/主机身份、远程 PTY、Agent 终端接管/借用/屏幕工具、旧 Go 终端历史导入、Windows/Linux PTY 仍待移植。旧不可用资源没有因支持新本机终端被自动解锁。Fish、终端子进程忽略信号等完整恢复场景未验收。

MCP 原项目绑定/authority 的增量迁移尚未完成，旧配置不会自动获得 TS 项目授权；精确旧协议版本配置须与实际协商结果一致，否则连接失败。stdio 完整子树清理、现有任务/业务观察、插件和全部 Skills 上下文失效恢复尚未等价验收。没有用通用 SDK 权限替代完整 Lake Security/grants/对账。Memory、远程资产/服务、工作流/日程等原有缺口继续保留。

### 签名 Dev 实测

已从干净源码 `f7b1b399f46fb596515b80ab62c2d6496d6e0452` 执行 `scripts/build_lake_desktop.sh --dev --ts-candidate --install`，覆盖并打开 `~/Applications/Lake Dev.app`；版本 0.3.27，持久开发签名。包内后端 SHA-256：`a805c075cfe0b0f8371799ab5e78958fa96add1454a5776f82fb5cfef82b18c5`。App、PTY addon、spawn-helper 的严格签名与 ZIP/DMG 摘要均通过；Web 类型检查/生产构建通过。

原生窗口实测顶部提示消失，原 Pilot/4 个现有专员/历史和资源仍显示。从“TS 项目工作区”打开真实 Bash PTY，经 xterm 的键盘/粘贴输入执行 `printf 'Lake TS PTY ready\\n'; test -t 0 && printf 'REAL_TTY\\n'`，界面实际显示两行结果并回到提示符。认证 history 记录真实输出、命令、cwd 与 ready/user/interactive 状态；cwd 位于 Dev 项目工作区。没有发送模型消息或连接远程服务。

认证 bootstrap 为 typescript/zcode/3.17.2、terminalMode=pty、recoveryReadOnly=false；lifecycle PID、home 和 dataDirectory 与 Dev 运行记录一致。目录保留 5 项目/82 侧栏会话/144 资源条目，资源终端的私有 scope 不进入侧栏。原 Dev 中 2 个 MCP 配置可安全读取公开信息，未发起连接；已登记 Skills 为空。

正常停止旧 Dev 后创建私有 APFS 应用/Home 备份，位置保存在本机 `/tmp/lake-pty-dev-backup-location`。覆盖启动后，原 Go Web/ADK 数据库、providers.json 和 security/control.json 的文件 SHA-256 均与备份一致。TS 新终端数据只进入 TS SQLite；原 Go Dev 和前次 TS Dev 备份均保留。正式 Lake 未操作。

本机真实终端可用不代表 SSH、Agent 接管或全量迁移完成。未运行真实供应商、远程主机/数据库、Fish 或 Windows/Linux 验收；全量门禁仍为 BLOCKED。
