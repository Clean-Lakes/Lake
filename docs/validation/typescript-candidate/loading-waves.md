## 恢复水波加载动画

命名说明：本文路径和协议名称已映射到当前 TypeScript 后端；历史提交 SHA 保留，原始命令与输出以对应提交为准，此映射不表示重新执行历史验证。


2026-11-05。用户明确选择恢复“原来的水波加载动画”。恢复原有 `Glyph waves` 和 `lake-surface-wave` 的 2.4 秒错相动效，替换模型等待、上下文整理及专员接单的小浮标，使用共享 `LoadingWaves`。保留 Pilot 的身份列、专员隐藏头像、已修复的灰色文字气泡和原始执行记录；等待状态为透明背景及共享文字扫光。思考期间收起已完成工具的旧步骤预览，不遮蔽真实工具、审批或异常。正文到达后取消模型等待动画，结束后不保持忙碌。

删除无调用者的小浮标组件、绘制和动画 CSS 及专用圆角选择器。水波在页面隐藏时暂停，减少动态效果时静态显示；不改后台任务状态、权限、账本或 TypeScript 运行路径。

### 验证

- 前端类型检查、603/603 回归通过。原有等待生命周期测试更新为水波，覆盖首包前、空文本、思考、压缩、专员补充、审批、停止、完成及真实正文接替；增加已完成工具不能继续作为思考步骤预览的断言。
- 使用隔离 thinking-bubble fixture，经 ego-browser 检查 1000×700 浅色/深色及 390×740 深色。可见水波与文字分开，文字进度仍在灰色气泡内，没有横向溢出；小浮标节点为 0。
- 实际采样水波 path 的 opacity 随时间变化；减少动态效果的浏览器 emulation 下 animationName=none。模拟 document.hidden/visibilitychange 后 animationPlayState=paused，恢复可见后 running。后者是模拟应用可见性事件的验证，不是 OS 窗口后台行为验收。
- 实际正文开始后水波节点消失。记录与状态不依靠测试消息或真实模型/远程服务；fixture 使用合成数据。

[浅色](loading-waves/light.png)、[深色](loading-waves/dark.png)、[窄窗口](loading-waves/narrow.png)。

已从干净源码 `66920079cce6130fd8d7e026d2ee11b0338cfaa3` 执行 `scripts/build_lake_desktop.sh --dev --ts-candidate --install`，覆盖并重新打开 Lake Dev。严格 App 签名与 ZIP/DMG SHA-256、Web 类型检查/生产构建通过。包内后端 SHA-256：`5c3e29e8a7ce7f78d9f8048b1bd06acbebd147cabe19ed5a83f298ebeb8dc97d`。新 JS/CSS 含水波及隐藏暂停规则，不含 thinking-buoys，保留 turn-progress-reply 气泡规则。原生工作区正常显示 Pilot、历史与输入区；bootstrap 为 typescript/typescript/3.17.2、pty、recoveryReadOnly=false，PID/Home/data 匹配。

安装前正常停止并备份 Dev 应用和 Home，本机路径保存在 `/tmp/lake-loading-waves-backup-location`；正式 Lake 未操作。未向真实会话发送测试消息；等待过程与动效视觉证据来自上述隔离 fixture。完整 TS 功能迁移仍未完成，本次只恢复显示动画。
