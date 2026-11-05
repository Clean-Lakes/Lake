# Pilot 历史目录与整理失败验收

2026-11-05。修复代码 `b8a03a72`，签名安装/实际运行的干净 Dev 集成提交 `ba7744d48f59604b68c2b9b9aa9ec6ad38e7a986`；本文仅补验证记录。

## 故障定位

只读检查 Dev 的真实来源与模型历史：207 条模型消息，序列化约 85 万字符；55 个历史 Router 目录信封，其中重复任务快照字段约 613KB。一次普通追问在派单前触发摘要，45 秒后超时。其后两次自动路由重试命中一分钟摘要冷却期，三次失败后该事件被阻断；该事件无路由决定，尚未派发工具查询。没有模型配置错误的证据。

## 修复边界

每轮原生 ADK 投影恢复后、追加新输入前，将旧的宿主任务快照正文替换为明确省略标记，保留任务 ID、版本和 hash；当前轮仍建立新目录，并从原任务读取当前状态。匹配同时要求 Router 运行身份、当前项目的原始用户事件、宿主消息/轮次锚点、原文尾部及宿主信封标志。保留事件页、原用户文字、引用、入口目标、未知扩展字段及工具配对；普通文字、无来源/篡改/跨项目内容不参与投影。

原生 SDK 保留旧会话与事件，新的模型投影沿已有 ADK 导入链路建立；不改用户对话、任务、决策、操作、审批、证据或 unknown 记录。旧失败事件不自动解除、重放或伪装完成，后续用户要求沿原接单流程处理。

同一轮正文只显示首个整理失败，原始重试原因继续在执行记录中；普通用户/助手引述不受影响。Watchdog 新失败回复不再无证据地建议检查模型配置；既有历史回复保持原文。

## 自动验证

- 源分支类型检查、589/589 前端测试通过。
- `go test -race ./internal/ai -run 'TestRouterHistoryProjection|TestSuperRouter|Test.*Compaction' -count=1` 通过；最终保留未知字段后再次执行两个新增历史投影测试通过。
- 新增回归覆盖来源/项目边界、约束与引用、未知字段、工具配对、幂等性；真实官方 ADK 持久恢复后继续 Router，无摘要请求，不向 provider 发送旧快照，旧 ADK 会话与操作卡仍在。
- `go vet ./internal/ai` 及 ADK runtime boundary 通过。
- 最终 Dev 集成：600/600 前端测试，`go test -race ./internal/ai ./internal/web -run 'TestRouterHistoryProjection|TestSuperRouter|Test.*Compaction|TestExistingSpecialistMention' -count=1`、`go vet ./internal/ai ./internal/web`、ADK boundary 均通过。
- `scripts/build_lake_desktop.sh --dev --install` 通过，使用持久开发签名，仅更新 Lake Dev。

## Lake Dev 验证

安装前确认 Pilot 和专员无活动回复，通过原生菜单停止旧内核后安装。原生窗口恢复原会话；失败轮次只显示一条超时提示，未显示两条冷却期重复提示。实际 HTTP 页面同样确认一条提示；原始三条引擎错误仍在快照和执行记录中。此轮未发送真实模型请求或执行远端资源操作。

实际后端文本映射指向安装后的 Resources/lake，HTTP bundle 与本地构建字节一致，SHA256 `9eba312fbacea3fe7b4c5c3cb7696b685537e0bb4b84c8c6b5a6c2ace3818a83`。安装前后原 messages、superagentInputs、native_operations、native_approvals、superagent_decisions、superagent_events 全表只读指纹一致。

Dev 同时保留专员引用菜单等既有开放 PR；集成分支不推送。未重复真实 provider 的摘要时延、用户这条失败事件的派单、远端 MCP 或 Windows 验证。模型上下文恢复由隔离官方 ADK 及假 provider 验证，不把 UI 投影或安装当作真实查询成功。

## 回退

回退本 PR 的 Router 投影与错误显示即可。无数据库迁移，原始消息、任务、事件及旧 ADK 会话仍保留；不清理操作账本或自动重试副作用。
