# 增强终端计划逐项验收

2026 年 10 月 11 日，在 `claude/lake-web-agent-v1` 工作区按原计划重新核对全部 24 项。本轮修复授权开关恢复导致旧授权复活、采用绑定失败遗留访问权限、终端与资源配置不一致，以及实时读屏时间戳与采样不一致的问题；补齐终端面板图片和上下文引用，并增加之前不足的边界验收。

原完成标记重新打开后，按下表逐步完成；本表的任务编号是原计划的引用，不是新增任务。

| 步骤 | 原计划任务 | 实现位置 | 验收证据 | 结果 |
| --- | --- | --- | --- | --- |
| 01 迁移与 generation | `TASK-001` | internal/web/store.go 与 internal/ai/types.go | TestOriginalPrototypeSchemaMigration；重启与新终端 generation 验收 | 通过 |
| 02 结构化屏幕采样 | `TASK-002` | internal/web/terminal_observation.go:ScreenResult | TestLiveScreenTimestampDescribesCurrentSample；历史采样时间保持 | 通过 |
| 03 等待与 Ctrl-C/关闭 | `TASK-003` | internal/web/terminal.go:Wait/Interrupt/Close | TestPersistentPTYAndOwnership；TestWaitCancellationPreservesPTYAndHistoricalSource | 通过 |
| 04 停止与后台归属 | `TASK-004` | internal/ai/engine.go:Abort 与 shell.go:shellCard | TestLateBackgroundCompletionUpdatesOnlyOriginalCard | 通过 |
| 05 生命周期回归 | `TASK-005` | internal/web/terminal_lifecycle_test.go | 真实 PTY 环境保留、停止后命令完成、离线 expect 拒绝 | 通过 |
| 06 四种 shell 配置 | `TASK-006` | internal/web/ssh.go 与 shell_hooks.go:shellArgs | TestShellHooksPersistentStateAndCapabilities：sh/Bash/Zsh/Fish | 通过 |
| 07 hooks 与命令块 | `TASK-007` | internal/web/hooks/ 与 shell_hooks.go:hook | TestRawAgentInputHooksCaptureOutputAndCompletion；服务端命令 ID 与 generation 关联 | 通过 |
| 08 动态能力 | `TASK-008` | internal/ai/catalog.go:CatalogForConfig/sessionCatalog | TestDisconnectedTerminalDoesNotAdvertiseOrExecuteCommands | 通过 |
| 09 shell 异常与降级 | `TASK-009` | internal/web/shell_hooks_test.go | TestShellExitAndExecDoNotReplayUnknownCommands；TestHookFailureKeepsScreenButRejectsExecute | 通过 |
| 10 当前终端上下文 | `TASK-010` | internal/web/terminal_context.go:TerminalContext | 24 块、12000 Unicode 字符、当前 cwd、运行中/未知记录与跨终端隔离 | 通过 |
| 11 独立轮次输入 | `TASK-011` | internal/ai/turn_input.go 与 engine.go:ChatTurn | TestMaximumUnicodeUserMessageReachesModelWithoutDroppingContext | 通过 |
| 12 引用记忆 | `TASK-012` | internal/ai/turn_input.go:ReferencedAssets/RememberResource/ClearReferences | TestReferenceMemoryPersistsPrunesAndClears；原生采用记住目标资源 | 通过 |
| 13 上下文边界测试 | `TASK-013` | internal/web/terminal_context_test.go 与 internal/ai/reference_memory_test.go | 最大中文消息、超限拒绝、budget 裁剪、记忆恢复/过滤/清除 | 通过 |
| 14 采用授权 | `TASK-014` | internal/web/terminal_access.go:ResolveTerminalAccess/adoptTerminal | TestAdoptTerminalRequiresGrantAndExclusiveWriter | 通过 |
| 15 统一访问校验 | `TASK-015` | internal/web/agent.go:bridge 与 server.go 终端路由 | TestConfigurationRejectsTerminalResourceMismatch；跨项目及后台绕过拒绝 | 通过 |
| 16 跨 owner 审计 | `TASK-016` | internal/web/store.go:BeginCommand/AddAction | 采用后命令保留原 owner，originSessionId 和审批属于请求会话 | 通过 |
| 17 授权撤销测试 | `TASK-017` | internal/web/terminal_access_test.go | TestPermissionToggleDoesNotReviveOldTerminalGrant；失败绑定回滚与显式资源关闭 | 通过 |
| 18 持久 scope 映射 | `TASK-018` | internal/web/terminal_scope.go:ResolveTerminalAISession | TestTerminalScopeConcurrentRecoveryAndExplicitBinding；并发首次创建去重 | 通过 |
| 19 scope API 与绑定 | `TASK-019` | internal/web/server.go:ai-scope 与 terminal_access.go:adoptAndBindTerminal | TestFailedAdoptAndBindDoesNotGrantAccess；TestFailedBindingValidationRestoresPreviousGrant | 通过 |
| 20 终端 AI 面板与 composer | `TASK-020` | web-agent/web/src/TerminalAI.tsx 与 imageAttachments.ts | 浏览器图片上传、文件引用、消息发送、正文恢复；真实模型请求核对 | 通过 |
| 21 前端及 scope 回归 | `TASK-021` | web-agent/web/test/ 与 internal/web/terminal_scope_test.go | 36 项前端测试；图片格式/数量/大小上限、终端去重、scope 与 generation 隔离 | 通过 |
| 22 运行文档 | `TASK-022` | README.md、web-agent/README.md、docs/hexhub-ai/README.md | 补充本轮采样、授权撤销、composer 能力及逐步验收结果 | 通过 |
| 23 构建与检查 | `TASK-023` | scripts/build_lake.sh | go test ./...；go test -race ./internal/web ./internal/ai；类型检查与前端测试；签名验证 | 通过 |
| 24 独立发布验收 | `TASK-024` | 签名 bin/lake 与隔离 home/本地模型夹具 | 无 Node PATH 运行；浏览器 console 无错误；图片/文件/cwd 进入模型；临时资源清理 | 通过 |

## 本轮检查

- `go test ./...` 全量通过，`go test -race ./internal/web ./internal/ai` 全量通过。
- React 类型检查通过，36 项前端测试通过。
- `scripts/build_lake.sh` 完成 Go/前端构建与持久身份签名，`codesign --verify --strict` 通过。
- 签名二进制在独立 home、无 Node 的 PATH 运行；浏览器使用合成 PNG 和合成文件引用，实际模型请求包含图片字节、引用块和 cwd。消息图片持久化、回合完成及控制台无错误已确认。
- 新授权绑定中，失败不会扩大访问权限；修改权限后永久撤销旧记录，改回原值也必须重新授权。配置校验拒绝终端与资源不匹配。
- 实时 screen 文本与状态在同一锁下采样，`capturedAt` 表示本次采样；`outputUpdatedAt` 表示最近输出变化。历史读取继续保留原采集时间。

[结构化验收数据](lake-terminal-plan-step-audit.json) · [浏览器证据](lake-terminal-plan-step-audit.png) · [原计划](../../plan/feature-hexhub-terminal-parity-1.md)

## 保留范围

当前 4177 服务未切换。商业模型和生产 SSH 未被调用；SSH 验证使用原测试套件的临时 sshd/合成凭据。全部功能和验证均保留在工作区，原有未提交改动不回滚。独立测试服务和自建临时资源在本轮结束前清理。
