# Pilot 与专员过程入口、状态动效验收

本次修复主会话过程入口缺失：Pilot 公开回复后继续思考、执行工具或等待时仍展示真实状态；专员的实时回复、原位接替的最终报告以及冷恢复历史都有对应任务的“执行过程”入口。大段过程正文保持静态，持续跃动与扫光放在下方的“执行过程”文字上，名字沿用已有动效。

## 版本与检查

- 最终产品 / 已安装签名 Lake Dev：`3b25c76bda116f24c9549afc63cd477d51d1fbf5`，`dirty=false`，0.3.33 / TypeScript。
- 过程恢复提交：`3f859efc204986d30fe9bcfa6d09141dced39c73`；后续产品提交仅调整正文和过程入口的动效位置及相关测试。
- `pnpm --dir web-agent test:frontend`：**939/939**。
- `pnpm --dir web-agent check`、`git diff --check`：通过。
- `npm_config_offline=true scripts/build_lake_desktop.sh --dev --install`：通过，包含 Web 类型检查/构建与签名 TypeScript 后端、原生 Dev 安装。
- 独立审查修复了已完成 Pilot 历史过程误跳结果页、重复点击未加载入口后请求取消却未重发两处问题；没有遗留审查项。

## 过程恢复

1. `TurnExecutionDetails` 仅在真正输出公开正文时使用结论预览；后续思考、工具、压缩、等待恢复活动状态。被动文件差异附件不打断实际正文流。
2. 已完成的专员协商不会隐藏 Pilot 仍在执行的当前轮，也不会隐藏已保存的过程入口。等待补充信息、外部结果和排队状态一并覆盖。
3. 专员入口位于动画正文容器之外，打开准确的项目 / Worker / 会话 / 任务 / 角色对应的执行页。初次读取和刷新都校验归属，关闭或切换目标后旧回包不能重新打开或覆盖面板。
4. Canonical task 即使没有 goal 投影，也可查看现存执行记录。Native 已保存的思考、公开进度按真实 task 与 SDK root 收集到默认折叠的“思考与过程记录”；ACP 继续通过原累计 operation 查看过程，不重复追加到公开结论。
5. 无明确任务归属的旧卡不会被借给当前任务；当前 workspace 已不存在的历史 Worker 会提示刷新，不跳到同一专员的新任务。

## 浏览器验证

使用真实 `AITranscript`、`SessionInspectorProvider`、`SessionInspector` 和 `WorkerExecutionTree`，所有源快照和传输事件均为本地合成数据。独立 Ego 任务空间与 5187 Vite 已关闭。

- Pilot 公开说明后继续思考，展开过程可读前后两段已保存的思考。
- 专员实时 → 追加 → 最终报告：行、署名、正文、过程按钮、历史和 Pilot 六类节点保持同一对象；侧栏保持展开，最终结论只出现一份。
- 冷恢复仍有对应任务入口，能读取同一任务的旧/新 SDK root 共 6 条 Native 记录。
- 286 字正文的持续动画数和 motion 字素数均为 **0**。
- “执行过程”四字使用共享 `lake-live-text-glow-rise`：周期 **3400ms**、起点 **0**，从左到右 delay 为 `-109.5/-36.5/36.5/109.5ms`。
- 等待、断线、完成、冷恢复和 reduced motion 的入口动画数均为 **0**；恢复动态后重新对齐共享起点。
- 结论接替时，过程文字及四个字素节点不变，入口焦点和已展开记录保留。Escape 关闭侧栏后焦点返回过程按钮。
- 浅色、深色外观通过；主会话换段/结论的原位过渡保留。

证据：[过程访问 QA](pilot-process-access/process-access-browser.json)、[最终动效 QA](pilot-process-access/process-motion-browser.json)、[实时浅色](pilot-process-access/browser-live.png)、[完成深色](pilot-process-access/browser-completed-dark.png)。

## Lake Dev 验证

用 `scripts/verify_animal_thinking_dev.cjs` 启动临时 Home / Web data 与确定性回环模型，真实创建并派发两位专员。脚本发送的思考文字是明确编写的合成验收数据，不使用业务资源或真实模型请求。

- 在最终 `3b25c76b` 安装版本中，从 Pilot 主会话打开猫头鹰专员“执行过程”；侧栏选择执行页，显示准确任务。
- 首段正文期间保存 1 条思考和 1 条公开回复；经真实 `work_wait` 后主会话原位显示第二段，已展开过程保留并增至 4 条。
- `work_finish` 后结论接替正文，过程入口继续存在；侧栏仍展开，保留 4 条思考/公开记录及 `work_wait`、`work_finish` 两项工具记录。
- 大段正文不再产生持续逐字跃动，下面过程入口沿用共享动效。动画时序与减少动态效果的精确值以浏览器测量为准。
- Pilot 原始思考入口在前置 `3f859efc` 安装中展开，已保存的两段合成思考可读；最终版本该链路未修改，浏览器再次覆盖。
- 完成隔离任务并退出对应原生进程后，恢复日常 Dev 原 Pilot 会话及原模型。现场打开已有 Codex 专员历史报告下的“执行过程”，确认 ACP 累计记录同时保留公开进度和最终回复，资源工具回执仍可查看。此操作只读历史，没有再次派发业务检查。

证据：[最终构建与记录元数据](pilot-process-access/native-evidence.json)、[最终实时正文与过程](pilot-process-access/native-live.png)、[最终完成及保留的过程](pilot-process-access/native-completed.png)、[Pilot 原始记录](pilot-process-access/native-pilot-records.png)。截图均来自隔离合成数据；日常业务会话未附截图。

本轮原生验证为 macOS 浅色；深色与 reduced motion 由浏览器覆盖，未运行 Windows/Linux 原生。普通 develop PR 无自动 CI，以上是本地检查和 Dev 验证，不将缺少 CI 当作通过证据。后续证据提交不改变已安装产品源码；没有合并或发布生产。
