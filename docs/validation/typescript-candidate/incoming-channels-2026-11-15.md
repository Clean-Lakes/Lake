# Super Agent 接入渠道验证（2026-11-15）

范围：将原专员 MCP 入口扩展为项目绑定的接入连接，按用户选定的「消息与任务」设计实现连接管理、Pilot 自动路由 / 固定专员、来源会话和准确任务报告。已有单专员 CLI 和凭据保持兼容。PR 仍指向 `develop`，未获授权合并或发布。

## 源码与本地检查

最终功能源码 / 已安装 Dev 来源：`97a3bd6de1d516bfc3737d7e2857464a75dd5531`。后续提交只整理文档和验证证据，不改变应用源码。固定 Node `24.14.0`。

| 检查 | 结果 |
| --- | --- |
| Runtime TS 全量 | 325 项：321 通过、4 项环境依赖跳过；最后 gateway/stdio 定向 16/16 通过 |
| HTTP / 真实 SDK 集成全量 | 281 项：275 通过、6 项环境依赖跳过 |
| 前端全量 | 839/839；含最近消息 / 历史展开和关闭 disclosure 的焦点回归 |
| 渠道与焦点定向 | 19/19 |
| Runtime / Web TypeScript 与生产构建 | 通过；Web 有既有 bundle 大小提示 |
| ADK runtime boundary / backend naming | 通过，命名违规为 0 |
| Dev build origin 单元回归 | 3/3 |
| `git diff --check` | 通过 |

合计前端 839、runtime 596 项通过，10 项外部 Codex、Claude-Mem 或平台环境依赖测试跳过。跳过不计为通过，也未据此声明真实外部服务验证完成。

主要命令：`pnpm --dir web-agent test:frontend`、`tsx --test --test-concurrency=4 runtime/typescript/*.test.ts`、`node --test --test-concurrency=4 runtime/typescript/*.test.cjs`、runtime / web TypeScript 检查与生产构建，以及 `python3 scripts/check_adk_runtime_boundary.py`、`python3 scripts/check_backend_naming.py`、`python3 -m unittest discover -s scripts -p test_dev_build_origin.py`。

全量日志位于本机 `/tmp/lake-channels-runtime-types-2026-11-15.log`、`/tmp/lake-channels-runtime-http-verified-2026-11-15.log`、`/tmp/lake-channel-keyboard-frontend-2026-11-15.log`；gateway/stdio 定向日志为 `/tmp/lake-channels-gateway-types-final-2026-11-15.log`。

## 回归覆盖

- 连接 CRUD、私有文件权限、重启持久化、固定项目、角色范围、旧凭据不扩权、配置版本冲突、孤立连接的停用与重命名。
- 新旧入口异步准备期间吊销 / 停用，准入事务再次授权；长轮询在返回前重新验证连接状态。
- 并发幂等、同键正文冲突、连接 / 线程范围、准确 `reply_to`、消息与回执原子写入。
- Router 单消息批次与模型历史隔离；当前输入锚点缺失拒绝发送；任务查询 / 操作只限已关联范围。
- 同一消息的两个 Worker、先到的报告与 Pilot 提前回复不能使消息提前结束；报告按执行时冻结的来源事件记录，并能重启读取。
- 固定专员真实路由及越角色 / 多角色绕过拒绝；无任务的多专员讨论保留独立回应。
- MCP 工具 / CLI 的新旧兼容、UTF-8 限长、真实截止时间、带空格的自定义 data 路径、连接测试不调用模型。
- 前端准确任务导航、部分报告、内联 Pilot 报告、讨论与任务区别、迟到响应隔离、分页和配置参数。
- 设置焦点排除关闭的 `<details>` 子项及其嵌套子项，也排除负 tabIndex、禁用、hidden/inert 与不可见元素，保证正反 Tab 不进入背景。

此前七项可靠性修复的旧回归仍在全量中执行，详见 [上一轮验证](external-specialist-mcp-fixes-2026-11-15.md)。

## 已安装 Lake Dev 验证

从干净 detached worktree 执行 `scripts/build_lake_desktop.sh --dev --install`，安装至 `~/Applications/Lake Dev.app`。最终 `build-origin.json` 为上述 SHA、`dirty: false`、TypeScript backend、版本 `0.3.33`。应用及 `Contents/Resources/lake` 的 `codesign --verify --strict` 均通过；日志为 `/tmp/lake-incoming-dev-build-final-ui-2026-11-15.log`。

执行仓库中的 `scripts/verify_incoming_channels_dev.cjs`，使用全新临时 Home、带空格的 `custom web data` 目录和确定性的本地模型服务，通过已安装原生应用、实际 MCP stdio 与官方客户端验证。结果见 [安装包 SDK 证据](incoming-channels/installed-sdk.json)：

- 四项 MCP 工具可用；准确复制自定义 data 配置；`test_connection` 不调用模型。
- 8 个并发重复发送只接纳一条消息，其余返回重复回执。
- 一条消息产生两个真实 Worker；第一份报告到达仍为 running；1 秒等待约 1005 ms 返回；两份报告到齐后结束，任务与执行会话身份准确。
- 其他连接不能读取或续接该消息，同一客户端键在不同连接独立；澄清消息通过准确 `reply_to` 继续。
- 连接停用立即拒绝新请求；固定专员方式只产生该专员的一个既有任务。

验证不连接业务资源。模型夹具验证调度、状态、隔离和界面，不代表真实服务器运维验收。本轮未运行真实 Codex / Claude Code 应用对接、外部模型服务或 Windows/Linux 安装验收。

## 视觉与交互

参考：[用户选定渲染图](incoming-channels/design-reference.png)。最终截图来自签名安装版 `97a3bd6d`，没有样式注入。桌面为 1538 × 1022 CSS px、窄窗为 390 × 844 CSS px，均 deviceScaleFactor 1；原生 WebKit 截图保留实际屏幕密度，不用于一比一像素对齐。最终结论见 [design-qa.md](../../../design-qa.md)：passed，无未解决的 P0–P2。

| 证据 | 验证内容 |
| --- | --- |
| [深色桌面](incoming-channels/dark-desktop.png)、[浅色桌面](incoming-channels/light-desktop.png) | 两栏、对齐字段、来源消息与两项任务、1/2 报告、首屏完整汇总 / 测试 / 管理入口 |
| [深色窄窗](incoming-channels/dark-narrow.png)、[窄窗任务](incoming-channels/dark-narrow-tasks.png)、[浅色窄窗任务](incoming-channels/light-narrow-tasks.png) | 上下堆叠、文字换行、滚动、无横向溢出 |
| [路由菜单](incoming-channels/dark-routing-menu.png)、[悬停](incoming-channels/dark-hover.png) | AppSelect 选中 / 焦点 / 悬停、圆角与裁切 |
| [完成状态](incoming-channels/dark-complete.png)、[任务详情](incoming-channels/task-detail.png) | 随后释放第二个 Worker，1/2 → 2/2，准确打开既有任务会话 |
| [原生 Lake Dev](incoming-channels/native-installed.png) | 已安装原生 WebKit 中任务、汇总及底部控件可见 |

实测连接创建、固定专员选择、重命名、启停、删除、复制配置及成功反馈、只读测试接入、旧凭据创建与吊销；默认显示最新一条，展开四条历史并收起。测试后只保留设计夹具三条连接，无临时旧凭据。初轮操作记录见 [initial-ui-checks.json](incoming-channels/initial-ui-checks.json)；最终任务状态、准确跳转、主题、viewport 和 0 条控制台错误见 [final-ui-checks.json](incoming-channels/final-ui-checks.json)。

最终键盘实测：管理区收起时从关闭按钮反向 Tab 到 SUMMARY，正向返回关闭；展开后的末尾按钮 Tab 同样回到关闭。路由菜单 ArrowDown / Escape 正常，Escape 只关闭菜单，保持设置弹窗和 Pilot 路由。见 [keyboard-checks.json](incoming-channels/keyboard-checks.json)。

[desktop-metrics.json](incoming-channels/desktop-metrics.json) 采集于 `3c238995`，其 CSS 与最终版一致：弹窗 1248 × 940，页脚 bottom 937.98、管理入口 bottom 976.48 均小于弹窗 bottom 981，字段 top 相等。最终版再次采集截图；连接 / 来源卡片 14px、控件 10px，共享 corner-shape 支持时生效。

## 环境恢复

四轮隔离验证均已结束，Ego TaskSpace 已关闭。最后一轮退出时，浏览器 Helper 残留的一条 loopback TCP 连接使隔离后端排空停滞；其监听端口已关闭、夹具任务已完成、MCP 客户端已关闭。核实 PID、父子关系与临时 Home 后，仅终止该轮测试后端并关闭对应原生窗口，没有终止共享浏览器进程。此为测试环境收尾限制，未据此声明后端在该情形下能自然退出。

重新打开日常 `~/Applications/Lake Dev.app`，使用 `~/.lake-dev`，恢复「HexHub 服务器」：136 个资源、6 位专员和原有会话 / 任务状态；全局 20 个项目、162 个资源、21 位专员。见 [restoration.json](incoming-channels/restoration.json)。正式 `Lake.app` 与 `~/.lake` 未操作。临时构建 worktree 和隔离数据在验收后清理。

## 交付边界

当前适配器为同机、同系统用户下的 MCP stdio。未实现 Webhook、IM 或跨机服务，也不把结果可查询等同于客户端已收到 / 阅读。启停连接不会自动取消已接收任务。任务执行、审批和报告仍归现有 Super Agent / Lake Security 管理。

[PR #232](https://github.com/Clean-Lakes/Lake/pull/232) 继续指向 `develop` 并保持打开；本轮未触发 CI、未合并或发布。保留其 topic 分支供后续审阅。
