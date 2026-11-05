# ZCode TypeScript 迁移候选验证

2026-11-05。用户确认后端直接使用 TypeScript / ZCode v3.17.2，保留 Lake UI，并要求**保留全部既有功能后再切换**。本记录是隔离候选的阶段证据，迁移尚未完成。

- 测试的后端源码提交：`215556c5292183dead6b89c169819239d2a33356`。
- 当前对照基线：`origin/develop@16ef70750bf63a9fc6b800ce6cac674c7194257e`。
- 前端 603 项测试、类型检查与构建提交：`22b2a8e8233c0c692ec64c15b30fb0f4ef14d1e6`。从该提交至后端测试提交，前端文件未变化。
- 平台：macOS / Apple Silicon；Node 24.14.0；候选由 `scripts/build_lake.sh --ts-candidate` 构建，并使用持久 `Lake Local Development Code Signing` 身份签名。

后续增量：已授权覆盖 Dev 的 [Super-agent 记录](superagent.md)，以及本机真实 PTY/扩展、36 项回归与安装提交 `f7b1b399` 的[终端与扩展记录](terminal-extensions.md)。后续气泡修复与安装提交 `a11c4974` 见[进度气泡记录](progress-bubbles.md)，水波恢复及 Dev 安装提交 `66920079` 见[水波记录](loading-waves.md)。最新 SSH 连接恢复、真实远程 PTY、确认来源修复、43/604 项回归与安装提交 `7b85928c` 见[SSH 与确认记录](ssh-confirmation.md)。本文保留最初隔离候选的历史证据，以下未安装说明仅描述该轮。

## 源码与运行路径

回复表达与专员汇报增量、46 项后端回归、三个真实模型合成措辞场景和 Dev 安装提交 `13ce5ce2` 见[表达验证记录](conversation-style.md)。

正常内部协调不再插入执行气泡，608 项前端回归、连续帧实页检查与 Dev 安装提交 `fc4018c3` 见[思考衔接记录](thinking-transition.md)。

上游归档、标签提交与 SHA-256 固定在 [upstream.json](../../../runtime/zcode/upstream.json)：`v3.17.2` / `a9fe401eede6e6e5e01be9048679c206fe6f02d9`。发布页另列的安装包构建提交不作为源码标签提交。构建前验证归档摘要和上游原文件内容。

候选实际路径为 Lake React → TS HTTP/SSE 宿主 → ZCode `AgentRuntime`、Node adapters 和上游 SQLite 会话存储。模型与工具执行不经过 Go 代理。上游 UI 和可选贡献者展示未打入；版权、LICENSE、NOTICE、第三方归属及 Node LICENSE 保留。

## 已运行的检查

| 检查 | 结果与范围 |
| --- | --- |
| `node third_party/zcode/node_modules/typescript/bin/tsc -p runtime/zcode/tsconfig.json` | 通过，候选严格类型检查。使用固定 Node 24.14.0。 |
| `node --test runtime/zcode/server.test.cjs` | **7/7 通过**。真实 ZCode + 本地合成模型 HTTP 服务；覆盖鉴权/Origin、同 Home 不同数据目录互斥、流式消息、重启历史、Write 批准/拒绝、取消后不派发、分块凭据在事件和上游正文存储前脱敏，以及会话导航/标签。 |
| 会话导航与标签 | 验证跨项目拒绝、图标/颜色/重复标签校验、过期版本、并发排序仅一次成功、置顶分组、已删除目标、重启持久化、事件和活动时间不变；无请求体 DELETE 与现有前端调用兼容。 |
| `go test ./internal/web -run 'TestSession(Presentation\|Navigation)' -count=1` | 现有 Go 对照合同测试通过；未运行全量 Go/race/vet，不作为全量迁移验收。 |
| `pnpm --dir web-agent check`、`test:frontend`、`build:web` | 前端类型检查/构建通过，**603/603 测试通过**，对应上面记录的前端 SHA。 |
| `scripts/build_lake.sh --ts-candidate` | 上游所需 15 个包构建通过；Lake TS 检查、源码打包、Node SEA 注入与持久签名通过。 |
| `codesign --verify --strict bin/lake-ts` | 通过。 |
| 签名 SEA 独立进程烟测 | 临时独立 Home / 随机 loopback 端口启动，读取实际打包 React 页面和 TS bootstrap，创建项目/标签，正常关闭并重启验证持久化，执行无请求体标签删除，再正常关闭。未连接正式或日常 Dev 数据。 |
| 默认二进制校验 | 候选构建前后 `bin/lake` SHA-256 相同；默认构建、桌面打包与 Dev 入口未切换。 |
| `python3 scripts/check_adk_runtime_boundary.py` | 现有生产入口与 provider AST 检查通过。 |
| `node runtime/zcode/inventory.mjs` | 当前前端 **118 项 API 操作**与清单一致。 |
| `python3 scripts/check_zcode_parity.py --report` | 11 项有候选测试；完整等价验收 **0/118**，20 个领域均待完整验收。 |
| `python3 scripts/check_zcode_parity.py` | **预期退出 1 / BLOCKED**。不具备切换条件，不将候选测试当作完整等价证据。 |
| `git diff --check`、shell 语法、Python 编译检查 | 通过。 |

## 界面证据与限制

[核心聊天截图](core-chat-light.png)来自前一轮隔离签名候选的 Lake 原有浅色 UI：以合成模型发送文字并显示流式回复。截图仍有终端能力提示，Pilot 也未迁完；它仅证明早期聊天联通，不是当前最终 SHA 的安装版 Lake Dev、深色/窄窗或全功能验收。

终端/SSH/服务资源、Pilot/长期专员与频道、任务与验收、安全范围/撤销/unknown 账本、工作流/日程、记忆、附件/图像/引用、MCP/Skills、队列/补充/压缩/回退、历史迁移、CLI/stdio/Magpie、macOS/Windows 原生启动/安装/更新，以及 Lake Dev 主题和窄窗仍需逐项交付和验证。通用 ZCode 工具审批不能代替 Lake Security；候选返回 501、空目录或关闭开关的接口均未完成迁移。

未安装或重启 Lake Dev / 正式 Lake，未发布、未合并 PR。现有完整应用继续使用原后端。候选仅创建自己的隔离数据；停止候选即可退出本轮试用。全部功能等价验收完成后，才单独修改默认入口并进行最终 Lake Dev 验证。
