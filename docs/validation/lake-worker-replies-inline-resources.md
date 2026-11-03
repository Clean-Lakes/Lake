# 专员直聊状态与行内资源引用验收

2026-11-03。内核被测提交为 `7b0b33aa372d9239df7891dfa34805647100c59c`；最终界面及 Lake Dev 被测提交为 `1e81d6b8a597c01259da3211e69bc87b3f47e2d2`，其后仅补充验证文档。

## 最终行为与原因

专员补充沟通没有普通 Pilot 的持久回复计时行。原快照会用目标的 blocked 等业务状态覆盖正在运行的模型状态，前端因此无法显示等待动画。现在引擎以独立的 `replyStatus` 投影实际回复活动：仅当调用仍持有 cancel 且处于 running/waiting_approval 时有效；Web 回复视图使用该活动状态，目标及 Super-agent 任务状态保持独立。结束后不因业务受阻而继续显示三点。

按最新设计，专员在聊天中只显示名称，正文及等待气泡均不显示头像；专员独立沟通页收回头像列。Pilot 的聊天头像和侧栏、页眉角色图标保留。此要求取代此前三点验收中“专员显示聊天头像”的设计，历史验证记录不改写。

已发送资源采用类型图标加彩色名称，背景透明、无边框和横向内边距，字号字重跟随原句，黑色用户气泡中的类型色提亮。助手正文的可点击引用悬停只给名称加下划线，保留键盘焦点和只读详情。输入框内仍使用 24px 可删除引用块；软件和未关联文件的展示保持原规则。

## 检查结果

| 检查 | 被测内容与结果 |
| --- | --- |
| Go 全量，7b0b33aa | `go test ./... -json -count=1 -timeout=12m`：1,956 项通过、15 项跳过；11 个包通过、4 个包无测试，0 失败 |
| Race，7b0b33aa | `go test -race ./internal/ai ./internal/web -run 'TestSuper\|TestSnapshotReply\|TestReplyTiming\|TestReplyDuration\|TestStream' -json -count=1 -timeout=8m`：90 项、2 个包通过，0 失败 |
| 静态检查，7b0b33aa | `go vet ./...`、`python3 scripts/check_adk_runtime_boundary.py` 通过；之后只有资源 CSS 和文档变更 |
| 前端，1e81d6b8 | Node 24.14.0，`pnpm --dir web-agent check`、`pnpm --dir web-agent test:frontend`：578 项通过，0 失败；签名桌面构建包含 Web 构建 |
| 业务与回复分离 | `TestSnapshotReplyActivityDoesNotChangeBlockedGoal` 验证目标仍 blocked、回复活动为 running；停止调用后回复活动为空 |
| 实际 HTTP/ADK 路径 | `TestSuperWorkerDirectReplyProgress` 用本地受控模型创建 Worker、阻塞模型响应并提交专员补充消息；GET snapshot 返回 running 回复活动，任务状态不被提升；放行后正常结束 |
| 前端直聊回归 | 没有持久计时、沿用原任务 root、原目标 blocked 时仍显示三点；结束后无残留。初始、空 message/text、reasoning 状态均覆盖 Pilot 和专员 |
| 浏览器实际 React 组件 | 五阶段 fixture 使用当前源码：专员前三阶段均为 3 点、0 头像、0 旧波纹；正文与完成后 0 点。Pilot 初始状态保留 1 个头像和 3 点。等待气泡实测 76×44px |
| Lake Dev 真实项目 | 原生 WKWebView 实看；浅色 1280px、深色 600px 浏览器实看。项目仍为 135 个资源；专员聊天头像 0 个、头像列 0px，名称保留；侧栏和页眉角色图标保留 |
| 资源引用 | 明暗主题透明背景、0px 边框、22px 高，类型色可读；窄窗口无横向溢出，包括窗口曲线回退。悬停名称有下划线、背景仍透明；键盘 Enter 打开只读详情，Escape 关闭后保留 2px 焦点轮廓 |
| 输入与光标 | Pilot 空草稿中通过 @ 候选及 Tab 插入资源，24px 引用块保留淡底；可继续输入，焦点和折叠选区在编辑器内，光标颜色可见。删除引用后继续输入成功，最终恢复空草稿，未发送测试消息 |

## 安装、边界及回退

从干净 `1e81d6b8` 运行 `scripts/build_lake_desktop.sh --dev --install`，只安装并启动 `~/Applications/Lake Dev.app`，使用固定 `~/.lake-dev`。来源记录 dirty=false，应用及后端均通过严格代码签名验证，后端 SHA-256：`e978b1061bfaca90f2cbdf51083a226a4d25bf1c06fa7f4b9526bce7fa0bbca4`。

没有为动画重建任务、扩展资源范围、签发许可、重放远端操作或清除账本。受控 HTTP 模型验证不调用真实供应商；没有重新运行真实服务器巡检，也不代表旧受阻任务已经恢复或验收通过。生产应用和数据未更动。

本机日志与测量位于 `/tmp/lake-worker-chat-*`、`/tmp/lake-inline-resource-*`、`/tmp/lake-worker-reply-animation-*`；真实项目截图和认证令牌不提交仓库。临时前端 fixture 服务已停止，浏览器验收空间已结束。

可通过后续 PR 回退本次只读活动投影和界面变更，无新增持久数据迁移。累计 token 策略仍以[其独立验证](lake-superagent-token-limit-removal.md)为准。PR #142 指向 develop，未合并或发布。
