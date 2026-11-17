# 专员补充与 Pilot 问题入口验证

2026-11-17，macOS / arm64。实际构建、测试并安装的产品提交为 `824b0618341f38495af610179c836cba4c2104c9`，来源工作区干净，分支 `codex/specialist-followup-delivery`，基于 `origin/develop` 的 `a847fe0e2352b6c0f44af1dde2b67bb4e9780079`。后续仅补充 `docs/` 和 `plan/` 的证据；构建输入对照另行检查。

## 问题与修复

只读查看原 Dev 的路由元信息，确认两条后续补充都已登记给准确 Worker，但该 Worker 的本轮输入和已结算输入都仅包含最初要求。原实现只在 Worker 停泊且没有待答问题时才安排下一轮，等待问题恰好阻止这条路径。Codex 的 steer 入口原先也直接拒绝补充。原生 `AskUserQuestion` 的默认结果格式化还会丢掉“以补充继续”的上下文。

本次在 Pilot 协调成功后，将补充送入原任务当前执行的安全边界；原生使用 SDK 的真实 drain 事件，Codex 0.160.1 使用官方 `turn/steer` 以及对应 thread/turn/clientId 的 userMessage 事件确认读入。RPC/SDK 排队回执不算消费，未知或未读入的输入保留同任务后续续接。已等待的业务问题可以收到补充原文并重新判断；宿主不代填选项，不批准计划、操作或终端接管。

待答问题由宿主按原 Worker、generation、Session、question ID 投影到当前项目 Pilot。主输入框上方直接展示共享问题面板，包含真实专员姓名、头像和任务标题；答复回原会话，无需打开任务详情。多个问题以 Worker/question 稳定挂载，过期、停止或已继续的问题撤下，断连时保留草稿并禁用交互。

## 本地检查

以下均针对上述产品提交；测试使用独立临时 Home 和合成数据。

| 检查 | 结果 |
| --- | --- |
| 后端 TypeScript `tsc -p runtime/typescript/tsconfig.json --noEmit` | 通过 |
| 后端 `tsx --test runtime/typescript/*.test.ts` | 381 通过，4 项既有可选环境测试跳过；无失败 |
| 生命周期与 Codex 协议重点回归 | 120 通过；覆盖错误来源、晚到通知、重复通知、未消费回执、问题竞态、失败路由、停止、期限、旧 generation、计划与操作审批 |
| `node --test runtime/typescript/*.test.cjs` | 284 通过、8 跳过、1 项持久 PTY 启动超时；同一源码单独复测该项通过，再完整重跑 `server.test.cjs`，209 项全部通过 |
| `specialist-followups.test.cjs`，实际原生 SDK 与本地官方 Codex | 5 项全部通过；含原生业务提问、原生多选提问、原生运行中 guide、Codex 等待问题、Codex 运行中 guide |
| 以上 Codex 两项使用已签名 Dev SEA 的 MCP 子进程入口 | 2 项全部通过 |
| 前端 `pnpm --dir web-agent test:frontend` | 950 项全部通过 |
| `pnpm --dir web-agent build:web`、`node runtime/typescript/build.mjs` | 通过；保留既有大 chunk 提示 |
| `python3 scripts/check_adk_runtime_boundary.py` | 生产入口与 provider-call AST 检查通过 |
| `GOWORK=off go vet ./...` | 通过 |
| Go race | 其他包通过；`internal/web` 全包触及默认 10 分钟总时限，543 项按完整名单拆为 272/271 两组重跑，两组均通过（492.598s / 323.607s），保留全部用例与 `-race` |
| `git diff --check`、计划声明 ID 唯一性 | 通过 |

4 项 TypeScript 跳过涉及未提供的 Claude-Mem 运行环境和 Linux 扫描器。宿主全套的 8 项跳过中，6 项为既有真实 Codex 按需集成，另 2 项为本次新增的 Codex 补充场景；新增两项随后分别通过本地真实 Codex 和签名 SEA 入口独立验证。没有把可选跳过算作通过，也没有运行真实业务部署或远端资源操作。

## 签名 Lake Dev

使用 `scripts/build_lake_desktop.sh --dev --install` 构建并安装 `~/Applications/Lake Dev.app`，版本 0.3.33，bundle ID `com.cleanlakes.lake.desktop.dev`。`codesign --verify --strict` 校验应用和后端通过，后端签名为持久的 `Lake Local Development Code Signing`。实际安装后端 SHA-256：`052f97e06e97493f0f42842222b0dd78dde15c5b493a65efe08b0db61cdce6ca`。

原 Dev 没有活动 Worker 后才正常停止内核。验证时以显式独立临时 Home 启动已安装 Dev，由应用启动自己的已签名 SEA 后端；仅连接本机合成模型。原生窗口中直接完成：

1. 在 Pilot 同时看到发布测试专员和数据测试专员的问题及身份。
2. 给数据专员输入草稿，回答发布专员的原问题；只撤下发布问题，数据草稿保留。
3. 从 Pilot 主输入框补充数据专员的缺失信息；同一任务、同一 generation 继续并结束，旧问题自动撤下，没有再次填写或打开任务详情。

[原生结果元信息](native-result.json) 记录两位 Worker 都为 generation 1；发布 Worker 本轮输入 1 条、数据 Worker 2 条，补充回执为 `consumed / question`，两个任务 completed，资源操作总数为 0。额外的 Codex guide 场景分别验证匹配的真实消费事件和同一官方执行轮，没有新建 Worker 或第二个外部 run。

结束后停止合成测试内核和模型，恢复原 Dev Home、项目偏好和应用。原有 Worker、Goal、Operation、Input、Decision、Report、模型来源及资源的数量与内容摘要全部一致，见[保留性记录](dev-preservation.json)。没有读取 Keychain、复制正式凭据、重启正式版或操作业务资源。

## 可见界面与输入验证

使用 ego-browser 的独立验证空间检查实际前端和本地合成后端，结束后关闭空间。检查了 1512px 和 680px 窗口、浅色和深色、选中项、键盘焦点、面板曲线及裁剪。680px 下页面无横向溢出，问题标题、姓名、头像、输入和提交按钮可见。问题与输入框使用同一响应式内容列，最大问题区域内部滚动，主输入框保留可用。

真实键盘输入后，后续 workspace 快照仍保持同一 textarea DOM、草稿及输入焦点；回答另一位专员后保留原草稿。模拟离线时问题表单禁用，恢复连接后同一节点和草稿继续可用。从 Pilot 发送补充后，当前问题面板撤下。

- [浅色](pilot-questions-light.png) / [深色](pilot-questions-dark.png)
- [窄窗口浅色](pilot-questions-narrow-light.png) / [窄窗口深色](pilot-questions-narrow-dark.png)
- [键盘焦点](pilot-question-keyboard-focus.png)

截图均为合成问题和草稿；不包含用户原始补充、密码、令牌或业务配置。

## 范围与回退

本次验证本地官方 Codex 协议及实际模型请求中的上下文，模型响应由本地 fixture 控制；没有声称验证真实模型面对任意补充的判断质量。Windows/Linux 原生窗口和真实业务执行未新增验证。任务、资源、权限和确认归属不迁移；新增交付元信息不复制补充正文，Workspace 的 questions 为可选字段。

回退通过正常的 develop PR revert；原消息、操作和业务回执保留。回退后活动补充恢复旧的下一轮接续行为，不重放既有操作，不清理用户数据。此验证不是生产发布或合并授权。
