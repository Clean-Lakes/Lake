## 最新进度播报气泡

2026-11-05。用户指出工具调用之间的文字出现在灰色等待气泡外。原因是 `liveTurnProgress` 将工具前的最新过程文字映射为进度预览，而 `TurnExecutionDetails` 只渲染裸单行 caption。模型正文已使用的回复气泡规则没有应用到这个分支。

进度预览现在复用 `ReplyIdentity` 和 `.ai-response > .ai-card.ai-message`，沿用主题底色与窗口连续曲线。Pilot 身份、专员隐藏头像/内部 Worker 隐藏身份继续沿用原语义。进度文字允许自然换行，不再单行省略；原始说明、执行记录、等待状态、正文接替和历史折叠仍使用既有生命周期。

前端 603 项回归、类型检查通过；相关 9 项进度回归覆盖真实正文接替、完成/失败、空流式占位、Plan/活动页、保留原记录及气泡结构。隔离 `thinking-bubble.html` 增加工具间进度状态，使用合成记录，无真实模型/后台连接。通过 ego-browser 检查 1000×700 浅色/深色及 390×740 深色；气泡背景/22px 连续圆角、文字换行和裁切可见，无横向页面溢出。

- [浅色](progress-bubbles/light.png)
- [深色](progress-bubbles/dark.png)
- [窄窗口](progress-bubbles/narrow.png)

签名 Dev 的准确安装 SHA 与构建结果将在安装后追加。终端和其他 TS 迁移范围仍以[终端/扩展记录](terminal-extensions.md)为准，本次气泡修复不表示全部功能等价验收完成。
