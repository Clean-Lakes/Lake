# 专员过程与结论原位替换验收

用户反馈：进度更新像整页刷新、过程正文缺少持续跃动、结论先追加再刷新。本轮覆盖 Native 与 ACP/Codex 两条公开回复路径，PR #235 → `develop`。

## 原因与修复

实时专员行和正式报告原先属于两棵不同的消息树。报告到达时卸载实时行，再按报告时间插入普通消息；若期间有新的用户消息，还会改变结论所属的位置。现在按 Router、角色、Worker、会话、任务和已观测 SDK root 准确接替，同一次 render 从普通消息列表去重，报告继续使用原身份、正文容器和原用户轮次。未观测 root 的历史报告保留原正常路径，不猜测归属。

ACP 原先只提供累计正文，过程句和后来的结论累加在同一 operation 中。现在保存适配器实际 `messageId` 对应的公开片段，SSE 增量更新携带该片段；当前片段原位替换，原 operation 的累计执行记录仍保留。没有 message ID 的旧适配器沿用兼容路径，不按标点或工具事件猜段落。

思考、换段和正式结论只在当前正文做 160ms 过渡：不透明度 0.78→1、上移 2px→0，并平滑调整正文高度。普通流式追加不重播；追加或附件尺寸变化会释放旧高度限制，避免裁字。正式报告保留图片、文件和 Plan 展示。过程正文末尾最多 24 个可读字素持续做 1px 轻微跃动，4.2 秒一轮；等待、错误、隐藏、结束和减少动态效果停止。名字与状态原有 3.4 秒同步、从左向右光效保留。

## 测试版本与检查

- 产品及签名安装 SHA：`0a4a68c0faf1dc66cc11d9eb345f0b261e75c295`，`dirty=false`，Lake Dev 0.3.33 / TypeScript。
- 固定 Node 24.14.0，`pnpm --dir web-agent test:frontend`：**915/915** 通过。
- `tsx --test runtime/typescript/acp-public-text.test.ts runtime/typescript/external-reply-events.test.ts`：**7/7** 通过。
- 编译 runtime 后，`node --test --test-name-pattern='ACP|Codex|codex' runtime/typescript/server.test.cjs`：**17/17** 通过，覆盖分段与真实 ACP 协议 fixture。
- 前后端 TypeScript 检查、ADK 边界检查、`git diff --check` 通过；独立复核无遗留阻塞问题。
- `npm_config_offline=true scripts/build_lake_desktop.sh --dev --install` 成功，签名验证通过。保留既有 Web 大 chunk、Swift 构建选项弃用及 Node SQLite 实验性提示。

后续提交仅补充验收文档和证据，不改变上述产品 SHA。

## 浏览器逐帧验证

使用真实 AITranscript、公开回复投影、事件订阅与 FollowScroll 的隔离 fixture：`web-agent/web/test/fixtures/specialist-progress-transition.html`，不连接业务后端。

- ACP：首段→增量追加→工具→新段→最终段→报告→晚到累计更新→完成 message；Native：首段→工具→新段→报告。身份、正文、历史 20 个节点及另一位并行专员均保持原对象。
- 阅读历史时滚动位置始终为 180px，更新过程 `scrollDelta=0`。加入后续用户消息后报告仍位于原任务位置。
- 报告交接连续 36 帧：当前正文高度 264px 平滑降至 26.25px，最低不透明度 0.78；专员槽、身份、正文和历史节点均未卸载，结论始终只有一份。
- 工具等待期间，已有过程文字仍有持续 `lake-live-prose-rise` 动画。390px 深色页面无横向溢出。开启减少动态效果后，活动及最终正文运行中的动画均为 0。

证据：[采样 JSON](specialist-inplace-result/browser.json)、[浅色](specialist-inplace-result/light.png)、[390px 深色](specialist-inplace-result/dark-390.png)。

## Lake Dev 原生验证

通过 `scripts/verify_animal_thinking_dev.cjs` 启动已安装的签名 Dev，使用临时独立 Home/data、确定性回环模型和两个真实 Worker。

1. 水獭与猫头鹰分别显示动物思考状态；水獭首段正文出现后，猫头鹰继续思考。
2. 水獭执行本地 `work_wait` 后输出第二段。执行快照确认两张不同 message 卡属于同一 SDK root，主会话只显示最新段落。
3. 在没有新 token 的第二段公开进度上抓取 77 张原生截图、覆盖 4.985 秒。尾部 24 字逐字灰度重心振幅为 1.9898–2.0065 个截图像素，符合 2× 显示中的 1 CSS px 跃动；前半正文在全部帧中逐像素相同。
4. 水獭提交 `work_finish` 后只显示一份正式报告，猫头鹰继续运行。随后猫头鹰输出过程并完成；最终各有一份报告、两任务均为 completed/parked，Pilot 显示“已结束”。
5. 原生结论采样开始时报告已到达，未捕获 160ms 交接窗口；原位节点、高度与无重复的逐帧证据来自上述浏览器测试，不将其混称为 WebKit 逐帧结论。
6. 已结束 fixture、关闭隔离 Dev 内核，恢复日常 Dev 的原 Pilot 会话、模型和资源列表。未重新调用业务服务器。临时浏览器空间与 Vite 已关闭。

证据：[真实执行摘要](specialist-inplace-result/native.json)、[原生像素采样](specialist-inplace-result/native-motion.json)、[首段](specialist-inplace-result/native-first-progress.png)、[第二段帧 A](specialist-inplace-result/native-second-progress-a.png)、[第二段帧 B](specialist-inplace-result/native-second-progress-b.png)、[最终报告](specialist-inplace-result/native-complete.png)。

原生验证为 macOS 浅色；深色、窄窗口及减少动态效果由浏览器覆盖，Windows/Linux 原生未运行。ACP 使用协议集成测试与浏览器 fixture 验证，未为验收再次派发真实业务请求。普通 develop PR 无自动 CI，以上为本地检查和 Dev 验收。PR 未合并，未执行生产发布。
