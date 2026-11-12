# Pilot 中的专员实时对话

2026-11-12。最终测试源码和签名 Lake Dev：`71af70b8441da1c1e39fba68505a97cab6baf766`。页面流式与布局验收基线为 `00cd76a6676e35b0046a2e272d2ba386ccff0f26`；后续提交补齐 Codex 公开文本的事件载体，布局未变，使用针对性单元回归验证。后续验证文档和截图不改变构建输入。

## 行为与边界

移除 Pilot 对话底部独立的灰色专员进度条。派单后的专员在原用户轮次内使用现有回复布局，显示湖生态头像、专员名称、冻结的 Agent Logo，以及当前执行的公开回复。尚无正文时在该角色发言内显示等待状态；提交正式报告后由报告接替，同一 root turn 不重复显示。

来源按项目、角色、Worker、执行会话、任务／共同执行目标和原用户消息绑定；排除旧 root turn、其他任务、子 Worker、思考和工具输出。原生回复使用已有公开消息；Codex 根 Worker 的公开 ACP 文本仅在准确 execution run、后端、任务和 root turn 均匹配时投影为发言，原 operation 审计卡及存储不变，不把任意 operation 变为消息。

角色正文通过只读快照和 SSE 订阅更新，文本前缀按帧合并。健康 SSE 不逐 token 重新取完整快照；结构变化合并刷新，断线时按间隔重连并保留已有正文，页面不可见或父连接断开时暂停订阅。没有新增会话、派单、权限或任务写入。

## 最终源码检查

| 检查 | 结果 |
| --- | --- |
| 前端和 TypeScript 后端类型检查 | 通过 |
| 全部前端单元测试 | 812 项通过，0 失败／跳过，含准确来源、Codex 根公开文本、拒绝工具／子任务文本、前缀更新、正式报告替换回归 |
| `external-reply-events.test.ts` 与 `superagent-lifecycle.test.ts` | 75 项通过，0 失败／跳过 |
| `scripts/check_adk_runtime_boundary.py` | 通过 |
| Web 生产资产构建 | 通过，保留既有 chunk 大小提示 |
| `scripts/build_lake_desktop.sh --dev --install` | 已签名构建并安装 |
| 深度严格签名、`dev_build_origin.py check` | 通过 |

未重跑完整后端／Go／race／vet、其他平台或真实模型 ACP 业务。纯事件助手覆盖 Codex 文本事件范围；没有将这项单元验证描述为真实 Codex 请求验收。

## 页面验收

Ego 使用实际 App 的内存夹具 `specialist-task-list.html?session=demo-session-0&agent-logos&live-specialists&plain`，不连接模型或业务主机。两位专员作为独立角色显示在对话中。前缀突发更新保持同一回复 DOM 节点和宽屏键盘焦点，额外 Worker 快照请求为 0；旧灰色进度条为 0，私有思考标记未进入 DOM。

断线时保留公开正文、停止运动头像并显示重连状态，恢复连接后继续更新。一位专员完成时，其实时发言消失并出现一条正式报告，另一位专员继续显示。全部完成后实时槽位清空；浏览器结束时仅观察到第一条报告，未将未等待完成的第二条报告刷新计为通过。最终前端回归使用两条不同的 completed 报告，验证各出现一次。

浅色和深色 1280×900、深色 380×820 均无横向溢出，窄窗两个正文右边界均为 348px。窄窗导航使用 DOM 点击检查展开和收起；键盘焦点保留检查来自宽屏，不将模拟点击描述为原生键盘验收。

- [浅色角色对话](specialist-conversation-light.png)
- [深色角色对话](specialist-conversation-dark.png)
- [窄窗角色对话](specialist-conversation-dark-380.png)
- [浏览器指标与准确源码基线](specialist-conversation-browser.json)

## 签名 Lake Dev

正常停止旧 Dev 内核后，按规范构建、安装并打开 `/Users/lingyunxieqing/Applications/Lake Dev.app`。Bundle ID 为 `com.cleanlakes.lake.desktop.dev`。私有认证生命周期只读检查确认实际安装后端、PID、TypeScript runtime、独立 `~/.lake-dev` Home／data 和非退出状态；未输出认证 token。已安装后端 SHA256：`ab668116f0d2c99f4c24a88166e180da0ef403430bfd2290f43fd0b41c1b6212`。

原生窗口确认原“gos多少个项目”轮次中的发布专员报告直接显示头像、名称、Codex Logo 和正文，旧灰条不存在。该任务在检查时已经完成；本轮原生观察证明安装后历史报告布局，实时流式行为依据上述夹具和单元回归，没有新发真实模型消息或业务任务。

标准安装器沿用既有迁移入口，原 Go 数据库与执行账本保留；本功能没有数据库迁移或历史消息改写。测试浏览器和专用 Vite 已关闭，Lake Dev 保持运行。普通 PR 继续指向 develop 并保持草稿，未合并、未触发生产发布或安装正式版。

回退通过撤回本轮源码并重新签名构建 Dev；保留原报告及操作账本，无需回灌数据库或重放任务。
