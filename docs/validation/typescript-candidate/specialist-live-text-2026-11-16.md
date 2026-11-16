# Pilot 专员思考提示、文字跃动与光效验证

专员尚未输出公开正文时，主会话保留普通头像、名称、Agent 标识和身份入口，下面显示动物专属思考文案并轻微逐字跃动。移除思考卡片外框与边框角色；真实正文到达后，在同一署名下原位接替，正文末尾沿用轻微跃动。运行中的专员名字和下方思考小字叠加柔和光脉冲，名字使用淡蓝高光，小字从次级文字色逐渐提亮。

## 候选与范围

- 开发基线：`88682744e8d5a1a336ae289cc98cbb59fcbb2bb3`（develop，含 PR #234）。
- 最终测试与签名 Lake Dev 安装源码：`3ac6ff0b2078dec2a5d19951a41333ec0dd4fb32`，构建来源 `dirty=false`。
- 分支：`codex/specialist-live-text-motion`；PR #235 目标 `develop`。
- 平台：macOS Apple Silicon，Lake Dev 0.3.33 / TypeScript 后端；Chromium 补充明暗、390px 和动态效果状态验证。
- 只改前端展示，保留准确 Worker 订阅、任务/SDK root 绑定、权限和执行逻辑；独立专员页面原有动物气泡保持原行为。

## 行为与回归

侧栏显示运行中的专员，只有在真实思考阶段才使用对应动物文案；公开正文出现前仍能在其原始用户轮次看到署名和思考提示。工具、排队、等待确认、整理上下文、断线和结束状态保留各自真实语义，不能冒充思考。已收到正文或正式报告时不重复插入思考提示。

文案与正文最多装饰末尾 24 个可读字素，在 4.2 秒周期内依次上移约 1px，并留出静止间隔。保持原过程文字和正文的各自字号、行距与换行；完成、等待、断线、隐藏页面和减少动态效果时停止运动。原文字只有一份，链接、代码、表格、资源引用和特殊装饰不拆分；emoji 与组合字符按字素保留。专属 Markdown 渲染节点避免动效尾部移动造成引用 React key 改变。名字只装饰前 24 个完整可读字素，避免长名字省略后光效全部被裁掉；其余名字保留静态后缀和完整无障碍名称。光效只作用于名字和思考小字，Agent Logo、箭头及背景不受影响，正文不扩散光效。工具阶段小字沿用共享状态扫光。强制色模式使用系统 CanvasText，减少动态效果时停在基线并恢复静态颜色。

| 验证 | 结果 |
| --- | --- |
| 固定 Node 24.14.0，`pnpm --dir web-agent test:frontend` | **875/875 通过** |
| `pnpm --dir web-agent build:web`（含 TypeScript 检查） | 通过；既有大 chunk 提示仍存在 |
| ADK 边界与后端命名检查 | 本 PR 前序检查通过，本轮未改对应代码 |
| `git diff --check` | 通过 |
| 独立只读复核 | 思考门控、身份稳定性、状态播报与动效停止规则通过；相关测试 42/42、类型检查通过，无阻塞问题 |

回归覆盖普通署名与无框思考、头像解析优先级、同名角色隔离、真实非思考状态、公开正文接替、SDK root 去重、可见性门控、纯文本文案、名字前段/正文尾段 24 字素预算、显式光效 opt-in、Unicode 完整性、静态 Markdown、引用稳定 key、链接/代码/表格/复制及独立动物气泡。

## 浏览器验证

使用真实 `PilotSpecialistReplyView` fixture（`web-agent/web/test/fixtures/specialist-live-text.html`），没有业务调用：

- 无正文时显示普通署名与“正在独立凝神中”；名字和状态小字均为光效 active，1 个身份头、1 个状态播报区，没有动物卡片。Logo 不在光效容器内。
- 280 帧采样：名字首字有 30 种颜色，小字首字有 28 种颜色，均有 30 种阴影状态，最大上移约 `0.999731px`；文字填充始终不透明。可见页触发无关快照更新后，身份按钮、字素 DOM 与 CSSAnimation 对象均保持，见 [glow-sampling.json](specialist-live-text/glow-sampling.json)。
- 正文到达后思考文字消失、正文原位接替；名字保持光效，正文没有光效包装。身份按钮仍是同一 DOM，键盘焦点保留；Enter 打开正确专员。
- 无正文工具、无正文等待、断线和排队分别显示“正在检查资源”“等待确认”“进度暂未更新，正在重连”“排队中”。工具阶段名字保持活动；等待、断线、完成、排队的名字为 still，文字动画均为 0。
- reduced motion 为 0 个文字动画且全部回到基线、无阴影。隐藏页最终记录到 `hidden:true / glows:[still,still] / animations:0`，文字仍保留；返回后恢复。
- forced-colors 下名字和小字的 color 与 `-webkit-text-fill-color` 均为系统 CanvasText，无光影；forced-colors 与 reduced motion 同时开启时，animation 为 none、top 为 0。
- 390px 深色长名字（43 个 Unicode code point）正常省略：总计 24 个动效字素，其中 19 个在可见区域，Logo 仍可见，没有横向溢出。原字号、布局、完整名称和入口不变。

## 已安装 Lake Dev

```sh
npm_config_offline=true scripts/build_lake_desktop.sh --dev --install
node scripts/verify_animal_thinking_dev.cjs /tmp/lake-glow-native.json
```

构建前通过菜单停止空闲的日常 Dev 内核；使用完整本地依赖缓存，正常执行构建、来源检查和签名。验收脚本运行已安装的 `~/Applications/Lake Dev.app`，使用独立临时 Home/data 与确定性回环模型：

1. 水獭与猫头鹰两个真实 Worker 同时运行时，主会话各自显示普通署名与“正在搓爪琢磨中”“正在歪头推敲中”，没有思考卡片外框和边框角色；名字与思考小字都有光效。
2. 水獭收到公开正文后，其思考文案被实际文字接替；猫头鹰仍保留独立的思考文案，与侧栏运行标记一致。快照确认水獭为 `running`、公开正文 241 字符且卡片 root 匹配；猫头鹰同为 `running` 且公开正文为 0，见 [stream-check.json](specialist-live-text/stream-check.json)。
3. 明暗主题均正确显示正文与另一位思考提示。原生深色画面连续采样 72 帧（约 4 秒），猫头鹰名字区域淡蓝像素从 0 变化到 1301，小字区域峰值亮度从 163 变化到 234，确认两行实际绘制出光效；已保留峰值帧。点击猫头鹰身份入口进入准确专员页面，任务记录为 1。
4. 两个 Worker 完成后，Pilot 显示正式报告与已结束状态，思考文案不残留，正式报告的名字恢复静态。
5. 恢复跟随系统主题，结束 fixture 并停止对应独立后端；重新启动日常 Dev，恢复原项目、Pilot 会话与模型。临时 Vite 已停止。

## 画面

- [两位专员在主会话思考](specialist-live-text/native-thinking.png)
- [一位输出、另一位继续思考](specialist-live-text/native-stream.png)
- [深色名字与状态光效峰值帧](specialist-live-text/native-dark.png)
- [完成后正式回复](specialist-live-text/native-complete.png)
- [浅色无框思考](specialist-live-text/fixture-light.png)
- [390px 深色长名字与无框思考](specialist-live-text/fixture-dark-390.png)

Windows/Linux 原生客户端未运行；原生验收使用虚构文本，不代表真实业务资源验收。无数据库迁移，可经回退 PR 撤销前端改动。此验证不授权 PR 合并或生产发布。
