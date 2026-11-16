# Pilot 专员实际回复与文字跃动验证

按用户最新两张截图反馈，移除 Pilot 对话内没有公开正文时的动物思考卡片。实际正文到达后保留原来的专员头像、名称、Agent 标识和进入专员的按钮；正在运行的正文末尾加入轻微文字跃动。

## 候选与范围

- 开发基线：`88682744e8d5a1a336ae289cc98cbb59fcbb2bb3`（develop，含 PR #234）。
- 实际测试与签名 Lake Dev 安装源码：`7f3138af131ca54f0a3ca642d75098997273696f`，构建来源 `dirty=false`。
- 分支：`codex/specialist-live-text-motion`；普通 PR 目标 `develop`。
- 平台：macOS Apple Silicon，Lake Dev 0.3.33 / TypeScript 后端；Chromium 补充明暗、390px 和动态效果状态验证。
- 只改前端展示。隐藏占位时保留 Worker 订阅，未修改路由、任务执行、权限、持久数据或独立专员的动物思考气泡。

## 行为与回归

没有公开正文的纯思考阶段返回空内容，空容器不占 flex 间距；真实工具、排队、等待确认、断线和错误状态继续保留。实际正文到达后，最多 24 个可读字素在 4.2 秒周期内依次上移约 1px，并留出静止间隔。等待、断线、完成、隐藏页面和减少动态效果时恢复静止。

正文只有一份可选择的文字，保留正常换行。链接、代码、表格、资源引用和已有装饰节点不拆分；emoji 与组合字符按字素保留。采用专属 Markdown 渲染节点，避免动效尾部移动导致相邻资源引用的 React key 改变和焦点丢失。

| 验证 | 结果 |
| --- | --- |
| 固定 Node 24.14.0，`pnpm --dir web-agent test:frontend` | **867/867 通过** |
| `pnpm --dir web-agent build:web`（含 TypeScript 检查） | 通过；既有大 chunk 提示仍存在 |
| `python3 scripts/check_adk_runtime_boundary.py`、`python3 scripts/check_backend_naming.py` | 通过 |
| `git diff --check` | 通过 |
| 独立只读复核 | 引用 key 漂移问题已修复；相关测试 30/30、类型检查通过，无剩余阻塞问题 |

新增与更新的回归覆盖：隐藏纯思考但保留真实状态、正文动效状态门控、SDK root 去重、静态 Markdown 不变、24 字素总预算、中文/英文/emoji/组合字符、稳定偏移 key、引用 React key、链接/代码/表格/复制内容，以及独立动物气泡不受影响。

## 浏览器与已安装 Dev

浏览器使用真实 `PilotSpecialistReplyView` fixture（`web-agent/web/test/fixtures/specialist-live-text.html`），没有后台业务调用：

- 无正文时没有卡片，空 wrapper 为 `display:none`、高度 0。
- 23 字样例有 23 个动态字素，40 帧采样测得最大上移约 `0.999997px`。追加后总量不超过 24；15 个重叠字素保留原 DOM 和 CSSAnimation 对象，无关快照更新也不重启动效。
- 等待、断线、完成与 reduced motion 均为 0 个动画、字素回到基线。切换隐藏页记录到 `hidden:true / mode:still / animations:0`，返回后恢复活动。
- 390px 深色长句和 Markdown 无横向溢出；链接地址、代码与表格不变，正文复制不重复。Enter 可进入正确的专员，追加正文不使身份入口失焦。
- 浏览器检查后补充修复了引用 key 漂移，并用真实 react-markdown 元素树回归及独立复现验证；最终源码再次运行完整测试、构建和下述原生验证。

签名构建与隔离原生验收命令：

```sh
npm_config_offline=true scripts/build_lake_desktop.sh --dev --install
node scripts/verify_animal_thinking_dev.cjs /tmp/lake-live-text-native.json
```

构建前通过菜单停止空闲的日常 Dev 内核；使用完整本地依赖缓存，正常执行构建、来源检查和签名。验收脚本运行已安装的 `~/Applications/Lake Dev.app`，使用独立临时 Home/data 与确定性回环模型：

1. 水獭和猫头鹰两个真实 Worker 保持思考时，Pilot 内不显示任何动物占位卡片或额外身份头；侧栏和顶部仍显示运行状态。
2. 水獭收到公开正文后，正常头像/身份入口与正文出现，猫头鹰的纯思考占位仍隐藏。当前 Worker 快照确认 `replyStatus=running`、正文卡 `running`、公开正文 241 字符，见 [stream-check.json](specialist-live-text/stream-check.json)。
3. 明暗主题正文均正常换行；点击身份入口进入准确的水獭专员页面，显示任务记录 1，返回 Pilot 后正文仍在。
4. 完成两个 Worker 后，正式报告接替实时发言，顶部显示已结束，没有思考卡片残留。
5. 恢复跟随系统主题，结束 fixture 并停止其独立后端；重新启动日常 Dev，恢复原项目、原 Pilot 会话与模型。临时 Vite 已停止。

## 画面

- [原生纯思考无占位](specialist-live-text/native-hidden.png)
- [原生实际正文](specialist-live-text/native-stream.png)
- [原生深色正文](specialist-live-text/native-dark.png)
- [原生完成状态](specialist-live-text/native-complete.png)
- [浏览器身份入口焦点](specialist-live-text/fixture-light.png)
- [390px 深色 Markdown](specialist-live-text/fixture-dark-390.png)

Windows/Linux 原生客户端未运行；原生验收使用虚构文本，不代表真实业务资源验收。无数据库迁移，可经回退 PR 撤销前端改动。此验证不授权新 PR 合并或生产发布。
