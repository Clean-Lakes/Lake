# 从左向右同步光效验收

顶部扫光、专员名字和动物专属思考小字统一从左向右，共用 3.4 秒周期与 document 时间起点。原文字按 UTF-16 offset 设置递减负延迟，导致右侧先亮，长文本还会取模折返；现在仅 glow 标签按完整可见字素依次延后 73ms，并把整段波峰居中于周期中点。普通正文的跃动规则不变。

## 候选与检查

- 产品与签名安装 SHA：`1781be6757446b3fb4ac0fb3e1bc40205c208d85`，`dirty=false`，PR #235 → `develop`。
- 固定 Node 24.14.0，全量前端测试 **905/905 通过**；新增 4 项覆盖完整字素、空格、长文本首尾 24 字素窗口、单字/静态标签与普通正文兼容。
- 独立复核 26 项定向测试、TypeScript 检查和 `git diff --check` 通过。
- `npm_config_offline=true scripts/build_lake_desktop.sh --dev --install` 成功，安装签名 Lake Dev 0.3.33 / TypeScript。Web 构建通过，保留原有大 chunk 提示。

## 浏览器

使用真实 HeaderSweep 与专员回复组件的本地 fixture，连续采样一个完整周期（101 帧）。顶部 translateX 由负向正；名字与状态各字波峰按阅读顺序依次出现。三处 duration 均为 3400ms、startTime 均为 0。不同字数围绕同一中点展开，最长 24 字素不会跨周期折返。

同一可见页面内无关快照更新保留原节点与 CSS Animation 对象；跨工具点击若经历可见性切换，恢复后的动画仍对齐 startTime=0。减少动态效果时三处光效动画数量为 0。390px 深色长名称显示、省略和状态布局正常。

证据：[采样 JSON](specialist-light-direction/browser-sampling.json)、[深色窄窗口](specialist-light-direction/dark-390.png)。

## Lake Dev 原生

通过 `scripts/verify_animal_thinking_dev.cjs` 启动已安装的 Dev，使用独立临时 Home/data 和回环模型。Pilot 中水獭、猫头鹰两位真实 Worker 同时思考，展示各自的名字与动物专属文案。

连续保存 8 秒、120 张原生截图。顶部下沿扫光、两行名字的蓝色高亮、两行状态的深色高亮均由左向右移动；两个周期重复，两个状态同步。选取 +2591ms、+2779ms、+2992ms 的局部画面可直接比较亮区从左到右。像素质心仅辅助方向观察，精确周期和起点由上述浏览器动画采样证明，不把截图时间当作 CSS 帧时钟。

`release-all` 后两位专员各形成一份正式报告，思考文案消失、Pilot 显示“已结束”。fixture 正常结束，核对精确 PID 与隔离 Home 后停止测试后端。已恢复日常 Dev 原 Pilot 会话、136 个资源与原模型；浏览器验收空间和 Vite 已关闭。未修改正式 Lake 或其数据。

证据：[三帧方向对照](specialist-light-direction/native-direction.png)、[原生思考](specialist-light-direction/native-thinking.png)、[结束状态](specialist-light-direction/native-complete.png)、[原生采样摘要](specialist-light-direction/native-sampling.json)。

原生验证使用 macOS 浅色；深色窄窗口由浏览器覆盖。Windows/Linux 原生未运行。本轮未合并 PR 或执行生产发布。
