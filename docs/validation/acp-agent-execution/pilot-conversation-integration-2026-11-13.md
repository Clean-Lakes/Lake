# ACP 与 Pilot 多干员对话集成验收

已测试并安装的源码：`c270f6c8e1fe5797a96c4f633baad45d58dd5dba`，分支 `codex/acp-pilot-integration`。后续提交仅补充本记录、计划状态和截图，不改变应用构建输入。

在当前 `origin/develop` 上建立独立集成分支，保留 ACP `f62a11585edf95935e007d164536a53c0c459656` 和多人对话 `b81154536f4057954a08f13c11b4ba4aebec5544` 的完整历史。已安装旧 Dev 来源 `71af70b8441da1c1e39fba68505a97cab6baf766` 为本构建祖先；没有绕过构建来源保护。

## 组合行为

召集冻结名单、Agent、模型及头像。每位原生或 Codex 干员有独立会话，真实完整回复进入来源 Pilot 对话和角色频道。等待、失败、停止等状态使用同一干员署名与 Agent Logo。所有成员结清后，独立原生 Pilot 上下文汇总实际回执。

ACP 对话使用独立 `conversationId` 和参与者身份，不伪造业务 Task。无 Lake MCP 传输、业务工具、子 Agent、记忆读取或历史会话续载。配置不可用只令对应成员失败，不换用另一个后端。保留 ACP 最新的业务报告协议，不恢复已移除的独立验收/对账门禁。

## 自动检查

固定 Node `24.14.0`，公开 SDK `3.17.2`，Codex ACP `2.2.2`，Codex 引擎 `0.160.1`。

| 检查 | 结果 |
| --- | --- |
| `web-agent/node_modules/.bin/tsc --noEmit -p runtime/typescript/tsconfig.json` | 通过 |
| `tsx --tsconfig runtime/typescript/tsconfig.json --test runtime/typescript/*.test.ts` | 308 项：304 通过、0 失败；3 项可选 Claude-Mem、1 项 Linux scanner 测试跳过 |
| `node --test runtime/typescript/*.test.cjs` | 258 项：252 通过、0 失败、6 项需显式适配器的集成测试跳过 |
| 提供 `LAKE_CODEX_ACP_TEST_ADAPTER` 和固定 Node 的同套 CJS 检查 | 6 项真实 Codex 集成均通过；首次全量还发现 3 项旧路由测试断言，更新为当前 reportedOutcome 协议后，上行全量检查通过 |
| `pnpm --dir web-agent test:frontend` | 815 项通过，0 失败/跳过 |
| `pnpm --dir web-agent build:web` | 类型与生产资产构建通过，保留既有 chunk 大小提示 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `python3 -m unittest discover -s scripts -p 'test_dev_*py'` | 19 项通过 |
| `git diff --check`、Dev 祖先/来源检查 | 通过 |

新增回归覆盖混合原生/ACP 真实 HTTP 召集、角色后续修改不改变冻结 Agent/模型/头像、单成员配置失败、无工具与无业务任务、原生 Pilot 汇总、跨对话身份/带工具/借用 Task/续会拒绝。真实 Codex 使用本地合成 Responses 服务和合成登录夹具；检查继承的 MCP/Hook/notify 陷阱未运行，原配置和登录文件未改写，不使用真实业务资源。

## 已安装的 Lake Dev

旧 Dev 通过“停止内核并退出”停止，确认无活动后端后，使用 APFS 克隆完整备份应用和 `~/.lake-dev` 到：

`~/Library/Application Support/LakeDevBackups/acp-pilot-20261113-110313/`

备份目录权限为 0700。执行标准 `scripts/build_lake_desktop.sh --dev --install`，签名构建并安装 `~/Applications/Lake Dev.app`。Bundle ID 为 `com.cleanlakes.lake.desktop.dev`，版本 `0.3.32`，来源清单 `dirty:false`。应用及后端严格签名验证通过；后端 SHA256：

`3e675d8ea312c1b0070e92079f1e7635352845fa4f2369ddb1cf72d3ea27c002`

实际运行的是安装包内的后端，使用 `--dev --home ~/.lake-dev --data ~/.lake-dev/web-agent` 和单一 loopback 端口。没有运行第二个后台实例；正常操作未访问 Keychain，未复制正式版凭据。

## 真实模型与数据验证

在原有项目的原生 Lake Dev 窗口输入“全部干员给我报数！”，六位现有干员各自由真实 Codex 会话回答，全部为 `gpt-6.1-sol` / `max`。六个外部 Session ID 不同，均绑定独立对话用途，无 Task ID、工具事件或业务 Operation。每名干员在来源 Pilot 和自己的频道各有一次回复；最后有一条独立 Pilot 汇总，结果 6/6。河狸保留已选 beaver 头像，回复均显示实际 Codex Logo。原生窗口最后停留在这轮完整报到和汇总，草稿为空，可直接试用。

独立项目“多人对话集成验收 2026-11-13”创建两名仅回应讨论的测试干员：

- 两位均使用指定 Codex 模型实际报到并汇总 2/2。
- 仅禁用这个 QA 项目的 Codex 后再次召集，两人明确失败，未调用原生模型代答；Pilot 根据真实缺席汇总 0/2。随后恢复 QA 配置。
- 新召集在两位成员均为 running 时触发页面停止，最终两人均 cancelled、轮次 cancelled，0 条成员回复、0 条汇总。稍后再次核对没有迟到回执或残留外部运行。首次人工停止时该轮已自然结束，未计为停止通过；最终通过项来自按运行状态立即触发的独立一轮。

与安装前完整备份逐条比较，130 条原业务 Goal、130 条 Worker、403 条 Operation 和 162 条历史 acceptance 记录的 ID/内容完全一致；本次召集没有新增或改写这些业务记录。完整脱敏来源、实际回复和外部运行元数据见 [证据 JSON](pilot-conversation-integration/evidence.json)。

## 界面验收

使用已安装 Dev 的实际后端与生产构建资产，无额外 Vite 或共享 Home 后端。Ego 验证浏览器已关闭，原生 Lake Dev 保持运行。

- 浅色 1280×900 的真实 4/6 进展，以及 1280×1100 的完整 6/6 回复与汇总；等待者显示真实头像和 Agent 标识。
- 深色 1280×1100 的完整回复、干员署名悬停及 Tab 焦点。焦点进入发布专员入口，实际绘制主题 2px 描边，无裁切。
- 明暗 390×844：会话、输入框、状态和长失败原因无横向溢出；失败行右边界 358px，两条原因完整换行可见。截图前等待导航抽屉退出布局，避免把抽屉动画中间帧误计为窄窗通过。
- 390px 导航实际展开和收起。输入“输入验证”，显示折叠选区和可见 caret，继续键盘操作正常，随后清空草稿，未发送测试文字。工具对部分带 aria-disabled 的节点点击不稳定时，使用页面真实 DOM focus/click；未修改 React 状态或绕过实际 disabled 控件。

| 截图 | 内容 |
| --- | --- |
| [浅色进行中](pilot-conversation-integration/light-running.png) | 4/6，余下两位正在回应 |
| [浅色完整报到](pilot-conversation-integration/light-completed.png) | 六名真实作者与 Pilot 汇总 |
| [深色与焦点](pilot-conversation-integration/dark-completed-focus.png) | 悬停、主题与键盘描边 |
| [深色窄窗](pilot-conversation-integration/dark-narrow.png) | 实际回复、汇总及状态 |
| [浅色窄窗光标](pilot-conversation-integration/light-narrow-caret.png) | 输入焦点、caret 与圆角 |
| [窄窗缺席](pilot-conversation-integration/dark-narrow-absent.png) | 0/2 与两位成员实际配置失败原因 |
| [停止](pilot-conversation-integration/qa-stopped.png) | 独立 QA 轮次取消，两位已停止 |

## 范围与回退

本次平台为 macOS Apple Silicon；未运行 Windows/Linux 桌面、真实业务主机/数据库/发布操作或全量 Go/race/vet（本次组合差异没有 Go 文件）。超时、重启和迟到回调由受控时钟及真实 HTTP/SDK 回归覆盖，没有把这些描述为等待真实供应商超时或杀进程验收。

没有合并 develop/master、发布 Release/标签或安装正式版。普通集成 PR 仍需单独的合并授权，原 ACP 和对话 PR/分支保留。Dev 应用及完整 Home 的回退备份已保留；恢复前必须先停止 Dev，成对恢复备份，不能将数据库恢复与活动后端并行，也不重放旧操作。
