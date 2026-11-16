# 专员状态与进度文字定向替换验收

状态文案、公开进度换段和正式结论都在原文字容器内接替：旧文字用 80ms 从右向左退去，新文字用 160ms 从左向右展开。退场期间保留旧正文与高度，新内容入场时只调整当前区域高度。署名、执行过程入口、历史消息和其他专员不随正文更新而重建。

## 提交与检查

- 产品、回归与 fixture 提交：`09611a180f4f5bae527713f127722c3ec8312e0b`。
- 签名安装的 Lake Dev：同一提交，`dirty=false`，0.3.33 / TypeScript。
- `pnpm --dir web-agent check`：通过。
- `pnpm --dir web-agent test:frontend`：**942/942** 通过；定向过渡相关文件包含 14 项回归。
- `npm_config_offline=true scripts/build_lake_desktop.sh --dev --install`：Web、后端和原生构建通过，签名后安装到 `~/Applications/Lake Dev.app`。
- `codesign --verify --deep --strict` 与 `git diff --check`：通过。

同段流式追加和相同快照不重播替换动效。退场中的连续更新只提交最新段，不排队补播；入场被新段打断时，从实际绘制边缘与高度继续。等待确认、错误、断线、页面隐藏、焦点进入正文或减少动态效果时立即显示最新内容。正文仍只有一份，持续跃动与扫光沿用名字、状态和执行过程入口的共享时钟。

## 浏览器验证

通过真实 `AITranscript`、公开回复投影、SSE 与 `FollowScroll` fixture，运行以下八种场景，共记录 302 帧：

1. Native 思考提示切换到工具状态小字。
2. 工具状态切换到首段公开正文。
3. 同段流式追加，不产生 80/160ms 替换动画。
4. Native 长进度接替正式报告。
5. ACP 换段退场时收到报告，合并到最新结论。
6. 退场时收到等待审批，立即取消过渡。
7. 减少动态效果时接替报告，容器无动画。
8. 390px 深色视口下，进度接替结论。

逐帧计算样式显示，旧文右侧裁切比例从 0 增至 100%，新文从 100% 减至 0；对应右向左退场和左向右入场。动画结束后释放裁切与临时高度。全部场景保留原发言、正文外框、署名及并行专员节点；状态节点转为正文时，只更换其中的内容节点。

长段接替结论时，原 Markdown、历史和执行过程节点保持；停止末尾跟随后的阅读位置始终为 180px，`scrollDelta=0`。所有场景最多一份结论。底部跟随开启时，内容高度变化继续使用既有平滑跟随。

证据：[逐帧数据](directional-text-replacement/browser-frames.json)、[深色窄窗口](directional-text-replacement/browser-dark-narrow.png)。第一轮开发热更新期间的数据未用作本次验收证据。

## 签名 Lake Dev 验证

使用独立临时 Home、Web data 和确定性回环模型，实际运行两位 Native 专员。猫头鹰依次完成思考、首段公开正文、本地 `work_wait`、第二段公开进度及 `work_finish`。主会话在原发言位置显示唯一正式报告，期间水獭仍独立保持执行状态。

报告的 Worker、任务、角色和实际 SDK root 与来源匹配。点击保留的“执行过程”入口，可打开猫头鹰的准确任务；思考与公开进度共四条记录，以及已完成的 `work_wait` / `work_finish` 均保留。原生截图验证前后呈现；80/160ms 的精确方向与时序以浏览器逐帧证据为准。

证据：[签名构建与报告绑定](directional-text-replacement/native-evidence.json)、[首段进度](directional-text-replacement/native-first.png)、[第二段进度](directional-text-replacement/native-progress.png)、[最终结论](directional-text-replacement/native-conclusion.png)。

浏览器空间、Vite 与隔离验收均已结束，两位临时 Worker 完成，隔离原生进程退出。日常 Lake Dev 已恢复原 Pilot 会话与 gpt-6.1-sol；未复制日常凭据，也未连接业务资源。正式版 Lake 未操作。

本轮只修改前端显示与测试，不修改派单、权限、数据或后端协议。macOS 原生验证浅色；深色、窄窗口、ACP 显示与减少动态效果由浏览器覆盖，Windows/Linux 原生及真实 ACP 后端未重跑。普通 develop PR 无自动 CI；本记录是本地与 Dev 证据，尚未合并或发布。
