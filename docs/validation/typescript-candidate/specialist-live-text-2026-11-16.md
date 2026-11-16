# Pilot 专员思考提示、文字跃动与光效验证

后续光效方向复验见 [从左向右同步光效验收](specialist-light-direction-2026-11-16.md)。本文保留当时测试 SHA 与结果；当前字间相位算法以复验记录为准。

专员尚未输出公开正文时，主会话保留普通头像、名称、Agent 标识和身份入口，下面显示动物专属思考文案并轻微逐字跃动。移除思考卡片外框与边框角色；真实正文到达后，在同一署名下原位接替，正文末尾沿用轻微跃动。运行中的专员名字和下方思考小字叠加柔和光脉冲，名字使用淡蓝高光，小字从次级文字色逐渐提亮。

本页记录光效与频率同步阶段；后续进度更新连续性修复、最新 SHA 与 901 项回归见[进度连续性验收](specialist-progress-continuity-2026-11-16.md)。

## 候选与范围

- 开发基线：`88682744e8d5a1a336ae289cc98cbb59fcbb2bb3`（develop，含 PR #234）。
- 频率同步阶段测试与签名 Lake Dev 安装源码：`70de4d58593e9b39a644a2ba8c7c379d864f7787`，构建来源 `dirty=false`。
- 完整光效/布局初验为 `3ac6ff0b2078dec2a5d19951a41333ec0dd4fb32`；本轮频率与相位同步复验见下文，原始截图保留对应初验版本。
- 分支：`codex/specialist-live-text-motion`；PR #235 目标 `develop`。
- 平台：macOS Apple Silicon，Lake Dev 0.3.33 / TypeScript 后端；Chromium 补充明暗、390px 和动态效果状态验证。
- 只改前端展示，保留准确 Worker 订阅、任务/SDK root 绑定、权限和执行逻辑；独立专员页面原有动物气泡保持原行为。

## 行为与回归

侧栏显示运行中的专员，只有在真实思考阶段才使用对应动物文案；公开正文出现前仍能在其原始用户轮次看到署名和思考提示。工具、排队、等待确认、整理上下文、断线和结束状态保留各自真实语义，不能冒充思考。已收到正文或正式报告时不重复插入思考提示。

文案与正文最多装饰末尾 24 个可读字素，依次上移约 1px 并留出静止间隔。最终版本的顶部柔光、名字和思考小字共用 3.4 秒周期与页面时间原点；正文微动维持 4.2 秒。保持原过程文字和正文的各自字号、行距与换行；完成、等待、断线、隐藏页面和减少动态效果时停止运动。原文字只有一份，链接、代码、表格、资源引用和特殊装饰不拆分；emoji 与组合字符按字素保留。专属 Markdown 渲染节点避免动效尾部移动造成引用 React key 改变。名字只装饰前 24 个完整可读字素，避免长名字省略后光效全部被裁掉；其余名字保留静态后缀和完整无障碍名称。光效只作用于名字和思考小字，Agent Logo、箭头及背景不受影响，正文不扩散光效。工具阶段小字沿用共享状态扫光。强制色模式使用系统 CanvasText，减少动态效果时停在基线并恢复静态颜色。

| 验证 | 结果 |
| --- | --- |
| 固定 Node 24.14.0，`pnpm --dir web-agent test:frontend` | **880/880 通过** |
| `pnpm --dir web-agent build:web`（含 TypeScript 检查） | 通过；既有大 chunk 提示仍存在 |
| ADK 边界与后端命名检查 | 本 PR 前序检查通过，本轮未改对应代码 |
| `git diff --check` | 通过 |
| 独立只读复核 | 思考门控、身份稳定性、状态播报与动效停止规则通过；相关测试 50/50、类型检查通过，无阻塞问题 |

回归覆盖普通署名与无框思考、头像解析优先级、同名角色隔离、真实非思考状态、公开正文接替、SDK root 去重、可见性门控、纯文本文案、名字前段/正文尾段 24 字素预算、显式光效 opt-in、Unicode 完整性、静态 Markdown、引用稳定 key、链接/代码/表格/复制及独立动物气泡。

## 光效与布局初验（3ac6ff0b）

使用真实 `PilotSpecialistReplyView` fixture（`web-agent/web/test/fixtures/specialist-live-text.html`），没有业务调用：

- 无正文时显示普通署名与“正在独立凝神中”；名字和状态小字均为光效 active，1 个身份头、1 个状态播报区，没有动物卡片。Logo 不在光效容器内。
- 280 帧采样：名字首字有 30 种颜色，小字首字有 28 种颜色，均有 30 种阴影状态，最大上移约 `0.999731px`；文字填充始终不透明。可见页触发无关快照更新后，身份按钮、字素 DOM 与 CSSAnimation 对象均保持，见 [glow-sampling.json](specialist-live-text/glow-sampling.json)。
- 正文到达后思考文字消失、正文原位接替；名字保持光效，正文没有光效包装。身份按钮仍是同一 DOM，键盘焦点保留；Enter 打开正确专员。
- 无正文工具、无正文等待、断线和排队分别显示“正在检查资源”“等待确认”“进度暂未更新，正在重连”“排队中”。工具阶段名字保持活动；等待、断线、完成、排队的名字为 still，文字动画均为 0。
- reduced motion 为 0 个文字动画且全部回到基线、无阴影。隐藏页最终记录到 `hidden:true / glows:[still,still] / animations:0`，文字仍保留；返回后恢复。
- forced-colors 下名字和小字的 color 与 `-webkit-text-fill-color` 均为系统 CanvasText，无光影；forced-colors 与 reduced motion 同时开启时，animation 为 none、top 为 0。
- 390px 深色长名字（43 个 Unicode code point）正常省略：总计 24 个动效字素，其中 19 个在可见区域，Logo 仍可见，没有横向溢出。原字号、布局、完整名称和入口不变。

## 原生完整交接初验（3ac6ff0b）

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

## 频率与相位同步复验（70de4d58）

按追加要求稍微加快文字光效，并与顶部 Pilot 柔光同步：统一 `--live-light-period:3400ms`，名字与状态小字保留 1px 位移和原配色。顶部与文字使用相同文档时间原点，文字光峰对齐到周期 50%；字内原有错相保留。只同步指定光效，普通正文、头像及历史署名不加入。

- 新增 5 项共享时钟回归，覆盖不同时间挂载、新字素、无关更新保持对象、暂停/恢复、强制色和非目标动画过滤；全量前端 **880/880**，独立定向 **50/50**、类型检查、Web 构建及差异检查通过。
- 浏览器直接读取顶部、名字首字、状态首字：duration 均为 3400ms、startTime 均为 0、currentTime 与 progress 完全相同；后挂载状态和新名字的 24 个字素均接入同一原点。两个周期的 animationiteration 实测间隔分别约 3392/3425ms，三者事件间隔完全一致（帧调度误差），见 [sync-clock.json](specialist-live-text/sync-clock.json)。
- 普通快照更新保留原 DOM 和 CSSAnimation 对象。等待时顶部暂停并保留 700ms 淡出，随后移除；重新运行后顶部与两行文字 startTime 都为 0。隐藏页暂停/静止，恢复可见后三者重新对齐。减少动态效果时目标动画为 0；关闭减少动态效果后的立即采样早于媒体 change，未单独记录等待该事件后的样本，不将它记为已实测通过。
- 使用已安装签名 Dev（上述最终 SHA，dirty=false），通过隔离 Home/data、回环模型验证两位真实 Worker 的主会话光效、正文接替及完成后静止；观察并保留原生光效帧。日常数据与模型未用于验收。
- 本轮未改主题配色与几何；390px 深色联合预览正常，原生明暗完整矩阵沿用初验，最新原生复验使用浅色。无新增依赖或后台计时循环。

本轮画面：[同步思考](specialist-live-text/native-sync-thinking.png)、[正文接替](specialist-live-text/native-sync-stream.png)、[完成](specialist-live-text/native-sync-complete.png)、[390px 深色同步预览](specialist-live-text/fixture-sync-dark-390.png)。

## 初验画面

- [两位专员在主会话思考](specialist-live-text/native-thinking.png)
- [一位输出、另一位继续思考](specialist-live-text/native-stream.png)
- [深色名字与状态光效峰值帧](specialist-live-text/native-dark.png)
- [完成后正式回复](specialist-live-text/native-complete.png)
- [浅色无框思考](specialist-live-text/fixture-light.png)
- [390px 深色长名字与无框思考](specialist-live-text/fixture-dark-390.png)

Windows/Linux 原生客户端未运行；原生验收使用虚构文本，不代表真实业务资源验收。无数据库迁移，可经回退 PR 撤销前端改动。此验证不授权 PR 合并或生产发布。
