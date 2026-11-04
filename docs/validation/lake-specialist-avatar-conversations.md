# 专员头像会话动效验证

2026-11-04，会话动效代码提交 `db4285b6b1d53d96268dc2d9e9a4bc5fa2891ea2`；签名安装并运行的干净 Dev 集成提交 `c46d63698c74d67181e25efc670f8f3f50121b92`。本记录提交仅补文档，未更改已测代码。

## 行为与范围

- 同一个 `conversationActivity` 投影实际回复状态，优先使用 `replyStatus`，保留旧服务的 `status` 兼容；接单、思考、工具执行、生成回复时显示工作动作。
- 侧栏与顶部使用准确频道/Worker SessionID。Pilot 自身活动独立于专员，不能因其他专员工作而自动显示 Pilot 工作。
- 当前轮只让最新正文回复的头像进入工作动作，历史正文及持久专员报告保留闲时动作。等待问题或操作确认时静止；真实回复可覆盖旧任务的 paused/blocked 外观状态，但不更改任务状态或执行权限。
- 100 款图形、RoleID 分配、CSS 动作及页面隐藏/减少动态效果机制沿用已交付实现。没有新增请求轮询、帧定时器或依赖，没有修改后端、权限、审批与数据库。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| `pnpm --dir web-agent check` | 源分支及 Dev 集成通过 |
| `pnpm --dir web-agent test:frontend` | 源分支 593/593，包含 3 项新增会话状态/身份隔离/真实回复渲染回归；Dev 集成 594/594 |
| `pnpm --dir web-agent build:web` | 通过；现有大 bundle 提示仍存在 |
| `scripts/build_lake_desktop.sh --dev --install` | 通过，持久开发身份签名，仅安装 `~/Applications/Lake Dev.app` |
| `git diff --check` | 通过 |

本次只改前端状态投影及文档，没有重复后端全量测试；前一阶段后端 RoleID 来源投影的证据保留在[原头像记录](lake-specialist-avatars.md)。

## 浏览器与原生验证

使用 `ego-browser` 检查 `web-agent/web/test/fixtures/specialist-avatars.html`。夹具使用真实 `PilotWorkspace`、`SuperRoleAvatar`、`AITranscript` 和 `ReplyIdentity`，状态输入为受控测试数据，不连接模型或资源。

- 100 个不同 RoleID 对应 100 个不同形象；正在回复时 100/100 存在运行中的 `lake-avatar-work`，400ms 两次采样的身体 transform 全部变化。
- 顶部、当前侧栏、Pilot 正文同步工作；历史报告 idle；其他专员 idle。旧任务 paused 期间实际回复仍为 working。
- 等待确认时 100/100 为 still 且没有子动画；真实 `AITranscript` 的 Pilot 回复头像同样 still。完成后回复头像及历史报告回到 idle。
- 浅/深色、560px 窄窗查看，未出现水平溢出；减少动态效果下头像动画为 0。页面隐藏冻结沿用原组件，此次未重复其模拟路径。
- 原生 Lake Dev 可正常启动，4 个不同专员头像、顶部身份及原会话可见。没有发送真实模型请求或执行 MCP/SSH/SQL 操作。

## Dev 来源与持久数据

安装前停止旧 Dev 内核，确认旧原生进程与 runtime 均退出；签名安装完成后才启动新应用。

- 磁盘 `build-origin.json` 为上述干净集成 SHA；实际运行后端的 `lsof` 文本映射指向安装后的 `Lake Dev.app/Contents/Resources/lake`，未占用旧备份包。
- 实际 HTTP 返回 `/assets/index-DT2Jx_u2.js`，SHA256 与该构建的本地 Web bundle 相同，排除只看磁盘元数据而运行旧资源。
- `messages`、`superagentInputs`、`native_operations`、`native_approvals`、`superagent_decisions`、`superagent_events` 的只读全表指纹与安装前一致。
- 49 条历史报告去尾注投影保留，4 个频道存在，32 条持久报告的 RoleID 仍与原 Worker 一致。
- 当前项目仍继承 gos、zmy知识库两个已启用全局 MCP，另外 4 个项目未被自动扩大继承。
- Dev 保留 #171–#174 的既有候选；派单消息、右键删除及其他功能的冲突在本地集成分支解决，未推送该集成分支。

## 限制

未验证 Windows 原生、真实模型流和远端资源操作；工作/等待/完成的状态切换在真实共享回复组件的受控夹具中验证。PR #175 保持开放，未执行合并或生产发布。
