## 最新进度播报气泡

命名说明：本文路径和协议名称已映射到当前 TypeScript 后端；历史提交 SHA 保留，原始命令与输出以对应提交为准，此映射不表示重新执行历史验证。


2026-11-05。用户指出工具调用之间的文字出现在灰色等待气泡外。原因是 `liveTurnProgress` 将工具前的最新过程文字映射为进度预览，而 `TurnExecutionDetails` 只渲染裸单行 caption。模型正文已使用的回复气泡规则没有应用到这个分支。

进度预览现在复用 `ReplyIdentity` 和 `.ai-response > .ai-card.ai-message`，沿用主题底色与窗口连续曲线。Pilot 身份、专员隐藏头像/内部 Worker 隐藏身份继续沿用原语义。进度文字允许自然换行，不再单行省略；原始说明、执行记录、等待状态、正文接替和历史折叠仍使用既有生命周期。

前端 603 项回归、类型检查通过；相关 9 项进度回归覆盖真实正文接替、完成/失败、空流式占位、Plan/活动页、保留原记录及气泡结构。隔离 `thinking-bubble.html` 增加工具间进度状态，使用合成记录，无真实模型/后台连接。通过 ego-browser 检查 1000×700 浅色/深色及 390×740 深色；气泡背景/22px 连续圆角、文字换行和裁切可见，无横向页面溢出。

- [浅色](progress-bubbles/light.png)
- [深色](progress-bubbles/dark.png)
- [窄窗口](progress-bubbles/narrow.png)

已从干净源码 `a11c497420e082ba385c4df7a12229f8ef2a463f` 运行 `scripts/build_lake_desktop.sh --dev --ts-candidate --install`，覆盖并打开 Lake Dev。App 严格签名、ZIP/DMG SHA-256、Web 生产构建通过；包内后端 SHA-256 为 `cbabbd65862ba7613584288708a8e0ec4ba1d36304f9225665dac9a9452f52b7`，打包 JS/CSS 包含本次气泡及换行规则。原生窗口实际显示 Pilot、历史、输入区，无持续终端警告；认证 bootstrap 仍是 typescript/typescript/3.17.2、pty、非恢复只读，PID/Home/data 匹配。

本次没有向真实会话发送测试消息；工具间瞬态气泡的视觉检查来自上述隔离 fixture。安装前正常排空 Dev 后端并创建私有 APFS 备份，位置保存在本机 `/tmp/lake-progress-bubble-backup-location`。终端和其他 TS 迁移范围仍以[终端/扩展记录](terminal-extensions.md)为准，本次气泡修复不表示全部功能等价验收完成。
