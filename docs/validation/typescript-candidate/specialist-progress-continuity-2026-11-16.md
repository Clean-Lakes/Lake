# Pilot 专员进度连续更新验收

后续光效方向复验见 [从左向右同步光效验收](specialist-light-direction-2026-11-16.md)。本文保留当时测试 SHA 与结果；当前字间相位算法以复验记录为准。

用户反馈：进度更新时主会话的专员行先消失、随后突然出现。已复现活动快照缺口令整个行节点卸载的问题，并改为保留准确绑定的已见发言、原位更新内容。

## 候选与验证

- PR #235，目标 `develop`；测试与签名安装 SHA：`979c255a6829e1cb29a28638eec06a44b0de2ef0`，`dirty=false`。
- 固定 Node 24.14.0，`pnpm --dir web-agent test:frontend`：**901/901 通过**，比前一版增加 21 项回归。
- TypeScript 检查、Web 构建、`node --check scripts/verify_animal_thinking_dev.cjs`、`git diff --check` 通过；沿用既有大 chunk 提示。
- `npm_config_offline=true scripts/build_lake_desktop.sh --dev --install` 构建并安装签名 Lake Dev 0.3.33 / TypeScript。未修改执行、权限或持久化协议。

## 修复与边界

原 `pilotDispatchRows` 在活动字段缺失或任务先结束时立即过滤行，导致 React 卸载身份、正文及订阅。宿主启动执行到 controller 就绪，以及 `work_finish` 到报告投递之间，确实会出现这种快照间隔。

展示层现在只保留此前已见、且项目、Router、角色、Worker、会话、任务、执行目标、后端和用户来源完全一致的槽。活动缺口显示静态更新提示；已观测准确 SDK root 的任务先结束时保留真实终态，等待对应报告。审批、错误、断线状态立即可见并停止动效。准确报告接替后不再绘制实时行，终态订阅关闭；后续旧活动快照不能闪回空的思考行。保留期间不接收其他 SDK root 的正文或状态，必须先恢复明确的 Pilot 来源。删除、归档、换身份、换来源和 workspace 清空均清除缓存。

首个 SDK 快照尚未到达就结束的极短任务沿用原正式报告路径，不猜测 root 或永久保留未知终态。此分支不承诺消除首次观测之前的报告交接间隔。

思考转正文、换一段公开进度时，仅唯一正文容器做 160ms 轻微过渡：不透明度 0.78→1、上移 2px→0，始终可读。名字与光效时钟不重建；同卡流式追加、相同快照不重播，快速替换从当前视觉位置接续。首个公开片段直接挂载正文平滑组件，不插入“正在生成回复”中间态。减少动态效果、页面隐藏、等待和结束立即取消过渡；不复制旧文字或交互元素。

## 浏览器连续采样

使用真实 `AITranscript` / `PilotSpecialistConversation` 与内存协议 fixture：`web-agent/web/test/fixtures/specialist-progress-transition.html`，无模型或业务请求。

- 修复前：点击“活动快照空窗”后 `rowPresent=false`、原节点 `isConnected=false`。
- 修复后：思考→首段→追加→工具→新段→无关快照→活动缺口→恢复→完成待报告，逐帧检查行、身份按钮、正文容器始终为原对象，最低正文不透明度 0.78，缺口及终态期间为 1。
- 首段恰好一次过渡；新段再一次；流式追加、工具阶段、同文恢复、普通快照均不增加过渡。未出现“正在生成回复”中间帧。
- 正式报告到达后实时行 0 个、报告 1 份，空 wrapper 的 computed display 为 `none`。
- 等待和断线没有正文动画；减少动态效果时正文与名字动画均为 0。关闭减少动态效果后等待实际媒体 change，名字动画重新对齐 `startTime=0`。
- 390px 深色视图没有横向溢出，名字、换行正文和更新提示均清晰。

证据：[采样 JSON](specialist-progress-continuity/browser-sampling.json)、[390px 深色](specialist-progress-continuity/dark-390.png)。

## Lake Dev 原生验证

使用 `scripts/verify_animal_thinking_dev.cjs` 启动已安装的签名 Dev，独立临时 Home/data、确定性回环模型和两个真实 Worker，不连接业务资源：

1. 水獭与猫头鹰各自显示身份和动物专属思考文案。
2. `/stream?animal=otter` 输出第一段公开正文，猫头鹰继续思考。
3. `/progress?animal=otter` 执行真实 `work_wait`（本地 1 秒）后输出第二段；快照确认两张不同 message 卡属于同一 SDK root，工具已完成，第二段替换原进度。随后六次原生 AX 采样均保留两位专员，截图保留新的进度。该组原生采样从第二段已出现后开始；160ms 过渡期间的无空帧证明来自上述浏览器采样，不混称原生逐帧覆盖。
4. `/release-all` 后两位专员各交付一份真实宿主报告，活动文字消失，Pilot 显示“已结束”。
5. fixture 正常结束；按精确 PID、安装路径与隔离 Home 核对后停止测试后端。日常 Dev 已恢复原 Pilot 会话与模型；临时浏览器空间和 Vite 均已关闭。正式 Lake 与数据未改动。

证据：[思考](specialist-progress-continuity/native-thinking.png)、[第二段进度](specialist-progress-continuity/native-progress.png)、[正式报告](specialist-progress-continuity/native-complete.png)、[原生执行快照摘要](specialist-progress-continuity/native-state.json)、[原生采样](specialist-progress-continuity/native-sampling.json)。

本轮原生使用浅色，深色窄窗口在浏览器验证。Windows/Linux 原生未运行；虚构文字不代表业务资源验收。无数据迁移，可经回退 PR 撤销展示改动。未合并 PR 或执行生产发布。
