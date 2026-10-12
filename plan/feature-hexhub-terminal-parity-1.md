---
goal: 补齐 HexHub 5.4.1 AI 增强终端与当前 Lake Go 工作台的功能差距
version: 1.0
date_created: 2026-10-11
last_updated: 2026-10-11
owner: Lake
status: 'Completed'
tags: [feature, terminal, ai, hexhub, golang]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

本计划基于 `docs/hexhub-ai/HexHub_AI增强终端逆向分析报告.docx`、对应 R01–R34 发布代码证据及当前工作区源码。基线分支为 `claude/lake-web-agent-v1`，HEAD 为 `785a5419`；基线包含未提交的 Go 后端和 React 工作台实现，不能仅从 HEAD 判断功能是否存在。实施前重新读取受影响文件，不覆盖已有工作区改动。

补齐六项已确认差距：终端内 AI 入口与资源 scope、用户 shell hooks、当前终端上下文、跨 owner 终端采用授权、会话引用记忆、按终端能力降级工具。另完善断线历史输出标识，以及停止本轮与终端进程生命周期分离。后两项属于 Lake 改进；报告未证明 HexHub abort 必然保留 shell，也未证明其每轮执行固定主机快照。

执行顺序为阶段 1 至阶段 6。每阶段完成后执行指定验收并提交可独立评审的结果；用户已授权实施；按阶段推进并记录实际验收。

## 1. Requirements & Constraints

- **REQ-001**: 保留已实现的 5 个当前终端工具、7 个交互 SSH 工具、3 个读屏模式、持久历史、压缩、图片和用量统计，不重写旧 TypeScript Agent。
- **REQ-002**: 分离三种操作：停止 AI 本轮只取消模型和本轮等待及审批；Ctrl-C 中断前台程序；关闭终端显式结束 PTY 和进程。停止 AI 后仍跟踪正在执行的命令，禁止自动重放。
- **REQ-003**: 屏幕读取返回 `source: live|historical`、`capturedAt`、`terminalId`、`generation`、`status`；历史输出不能满足等待新输出的 expect 条件，也不能被展示为实时屏幕。
- **REQ-004**: 支持本地和 SSH 的 `sh`、`bash`、`zsh`、`fish`；配置新增 `shell: sh|bash|zsh|fish`，旧资源默认 `sh`。Bash/Zsh/Fish hooks 采集 preexec、cwd、提示符和退出状态；sh 保留现有完成标记机制。
- **REQ-005**: 命令块包含 `cwd`、`startedAt`、`finishedAt`、`status`、`originSessionId`、`generation`；当前终端上下文取最近 24 块，包括运行中和结果未知的记录，每块输出尾部最多 12000 Unicode 字符，会话文本总尾部最多 16000 字符，自动附加当前 cwd。
- **REQ-006**: 原始用户消息仍最多 100000 字符；新增的服务端上下文单独传递，不能因封装超过旧限制而丢弃全部上下文。结构化上下文最大 2 MiB UTF-8；超过时先截断最旧块输出，再删除最旧块，并标注截断原因。模型容量不足仍经过既有上下文压缩路径。
- **REQ-007**: 终端 AI 会话 scope 为 `enhanced-terminal`，持久映射键由项目 ID、资源类型和资源 ID 组成。映射键不包含终端 ID；重建终端恢复历史但必须明确提示新 shell 的 cwd/env 不继承。相同资源多终端通过明确终端 ID 切换当前绑定，不允许并行输入。
- **REQ-008**: 同项目其他聊天拥有的在线终端可请求精确 ID 的采用授权，授权绑定请求会话、资源、终端 generation 和权限版本。采用不转移原终端及记录所有权，不自动抢占用户输入或另一个正在执行的 Agent。
- **REQ-009**: 持久记住本会话显式引用资源和通过目标授权的资源；`blockUnreferencedAssets` 检查有效记忆集合。新增、重命名资源不扩大授权；删除资源、跨项目、清空会话记忆必须移除对应记录。
- **REQ-010**: `terminal2` 动态工具集依据当前终端能力生成。命令块集成不可用时撤下 `terminal_execute_command`，在线时保留 read/input/key/expect；离线时仅保留明确标记历史的读取及文件工具，不以后台 SSH 代替可见终端。
- **SEC-001**: 每次读写、等待、关闭、后台任务查询和审批执行都在 Go 重新校验项目、请求会话、终端 ID、generation、holder 和授权；前端 scope、模型文本、hooks 和历史数据均不构成授权。
- **SEC-002**: Hooks 与退出标记仅用于状态观测，不能作为可信权限边界。人工接管撤销 Agent 写入租约；终端关闭、重建、服务重启撤销采用授权。停止后的旧审批和回调不得改变新轮次状态。
- **SEC-003**: 不打印、记录或提交模型密钥、密码、SSH 私钥内容。凭据继续使用 `~/.lake/secrets/` 私有文件；正常流程不读取 Keychain；SSH 主机信任保持严格校验。
- **CON-001**: 用户二进制仅通过 `scripts/build_lake.sh` 构建和签名。缺少签名身份先运行 `scripts/setup_lake_signing.sh`，不得回退到未签名用户构建。
- **CON-002**: 以实施开始时工作区的静默命令及灾难性操作确认规则为准，保留用户已有调整；采用授权独立确认，当前审批阻止新轮次；本计划不将这些设计差异改为 HexHub 权限规则。
- **CON-003**: 旧 SQLite 和 AI JSON 必须兼容读取；修改表结构前使用既有一致性备份流程。升级、刷新和重启不重发命令，不复用旧采用授权，不删除历史操作。
- **PAT-001**: 使用 Go 服务、SQLite、内进程 `ai.Engine`、现有 PTY/vt10x 和 React/SSE；保留当前 HTTP 鉴权、Origin/Host 校验及跨项目隔离。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: P0，修复停止与读屏语义。完成标准：停止等待命令不关闭 shell；Ctrl-C 与关闭结果不同；断线读取标记历史且 expect 拒绝历史匹配。无前置阶段依赖。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 `internal/web/store.go` 的建表/迁移、`CreateTerminal`、`History`、`Output` 和 `web-agent/shared/contracts.ts` 增加终端 `generation`、`outputCapturedAt` 及命令状态字段。新进程使用新的 generation；contextVersion 继续表示执行上下文变化。旧记录无采集时间则返回 null，不伪造当前时间。更新 `internal/ai/types.go` 的审批字段。 | Yes | 2026-10-11 |
| TASK-002 | 修改 `internal/web/terminal.go` 的 `Screen` 返回结构化屏幕结果；修改 `internal/web/agent.go` 的 read/expect 分支及 `internal/ai/tools.go` 的 regex expect，全部保留来源和采集时间。离线 expect 返回 `terminal_disconnected`，不匹配持久旧输出。依赖 TASK-001。 | Yes | 2026-10-11 |
| TASK-003 | 修改 `internal/web/terminal.go` 的 `Wait`，取消只结束等待者；将 `Interrupt` 改为向前台 PTY 发送 Ctrl-C，保持 PTY，命令完成标记恢复 ready；若无法确认退出则保持 busy/unknown，不能伪报成功。修改 `Execute` 的 120 秒计时器为结束该等待预算而非关闭 PTY；实际断线及显式 `Close` 继续终止进程。依赖 TASK-001。 | Yes | 2026-10-11 |
| TASK-004 | 修改 `internal/ai/engine.go` 的 `Abort` 和 `internal/ai/shell.go` 的 `cancelShells`、`trackBridgeShell`，区分本轮取消、停止命令和服务 shutdown。停止本轮不终止已启动后台/前台任务；跟踪任务归属原轮次，完成事件不改变后来轮次的卡片和状态。`kill_shell` 仍为显式终止。更新 `App.tsx`、`api.ts` 的按钮为“停止本轮”“中断命令”“关闭终端”。依赖 TASK-002、TASK-003。 | Yes | 2026-10-11 |
| TASK-005 | 在 `internal/web/terminal_lifecycle_test.go`、`internal/ai/engine_test.go`、`internal/ai/services_test.go` 增加取消、后台继续运行、晚到完成、Ctrl-C 与 close、离线 expect 测试；确认停止后的新轮次仍能使用相同终端的 cwd/env。依赖 TASK-004。 | Yes | 2026-10-11 |

### Implementation Phase 2

- **GOAL-002**: P0，补齐用户 shell、hooks 和能力探测。依赖阶段 1；完成标准：四种 shell 状态可观察，hooks 失败有明确降级，工具集与能力一致。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | 在 `internal/web/ssh.go` 的配置校验、`internal/web/terminal.go` 的 `Open` 和 `SSHResourceFields.tsx`、`App.tsx` 增加明确 shell 配置。本地使用已存在的 shell 绝对路径；SSH 使用显式 shell 名启动，未安装返回错误，不自动切成本机或其他 shell。 | Yes | 2026-10-11 |
| TASK-007 | 新增 `internal/web/shell_hooks.go` 和 `internal/web/hooks/{bash,zsh,fish}.txt`，通过 go:embed 提供服务端自有 hooks，在 `Open` 初始化后安装；`receive` 解析 OSC 9003/9004，更新 cwd、开始/结束时间、退出状态。以 generation 和 hook 命令序列 ID 关联块，合并 Execute 已创建记录；人工输入创建新块。单个 hook frame 上限 16 KiB，残缺帧不阻塞后续输出。依赖 TASK-006。 | Yes | 2026-10-11 |
| TASK-008 | 在 `internal/web/terminal.go` 增加 `Capabilities`，字段为 screen/input/key/expect/commandBlocks；sh 完成标记正常时支持 commandBlocks，其他 shell 需 hooks 握手确认。在 `internal/ai/catalog.go` 增加 `CatalogForConfig`，由 `engine.go` 每次模型请求通过 bridge 刷新能力并筛选工具，`tools.go` 在执行时再次检查能力，避免配置与实际状态漂移。依赖 TASK-007。 | Yes | 2026-10-11 |
| TASK-009 | 新增 `internal/web/shell_hooks_test.go` 与能力测试，覆盖 bash/zsh/fish 正常、重复相同命令、人工输入、交互程序、ANSI/Unicode、部分帧、`exec`/`exit`、hooks 不可用及断线；缺少 shell 时明确记录 skipped，最终发布验收必须完成三种 hooks shell 的本地或合成 SSH 测试。依赖 TASK-008。 | Yes | 2026-10-11 |

### Implementation Phase 3

- **GOAL-003**: P1，补齐终端上下文和引用记忆。依赖阶段 2；完成标准：24 块上下文含当前 cwd、不会混用其他 shell，引用记忆可恢复及清除。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-010 | 在 `internal/web/store.go` 增加 `TerminalContext`，按当前精确终端 ID 查询最近 24 块并携带 generation、cwd 和采集时间；新增 `internal/web/terminal_context.go` 构造 `[TERMINAL_CONTEXT]` 与受限命令块文本，按 REQ-005、REQ-006 裁剪，历史 generation 明确标记。`agent.go:runTurn` 的 terminal2 路径使用该上下文；core 路径保持现有语义。 | Yes | 2026-10-11 |
| TASK-011 | 在 `internal/ai/types.go` 增加 `TurnInput`，分离用户文本、引用、图片和服务端上下文；`engine.go` 新增统一 `ChatTurn` 并保留旧 Chat 方法包装；`stdio.go` 对用户文本与内部上下文分别校验，`internal/web/agent.go` 删除“封装超过 100000 后丢弃上下文”分支。上下文仍作为不可信数据参与模型预算与压缩。依赖 TASK-010。 | Yes | 2026-10-11 |
| TASK-012 | 在 `internal/ai/types.go:State` 新增持久 `ReferencedAssetIDs`；`engine.go:ChatTurn` 合并明确引用，`tools.go:invoke` 在有效目标批准后记录资源 ID，`permissions.go:approvalKind` 使用当前项目有效集合。`Engine.Clear` 清除该记忆；删除资源时过滤失效 ID；`AIPanel.tsx` 增加查看/清除资源记忆入口，不从模型历史猜测授权。 | Yes | 2026-10-11 |
| TASK-013 | 新增 `internal/web/terminal_context_test.go`，更新 `internal/ai/permissions_test.go` 与 `engine_test.go`，验证长中文输出裁剪、最大用户消息、运行中块、跨终端污染防护、压缩后引用保留、刷新/重启恢复、资源删除/跨项目拒绝和清除记忆。依赖 TASK-011、TASK-012。 | Yes | 2026-10-11 |

### Implementation Phase 4

- **GOAL-004**: P1，补齐跨 owner 采用授权。依赖阶段 1、阶段 3；完成标准：同项目显式授权后可采用指定在线终端，未批准或撤销后所有入口都拒绝访问。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-014 | 新增 `internal/web/terminal_access.go` 定义 `TerminalAccess{RequestSessionID,OwnerSessionID,ResourceID,TerminalID,Generation,PermissionsVersion}` 和内存采用授权表。`ResolveTerminalAccess` 默认只允许所属会话；其他 owner 必须同项目且持有精确授权。新增 `adopt_terminal` 审批种类，仅在申请通过后记录授权，不更改 terminal.sessionId。关闭、重建、重启和权限变化撤销授权。 | Yes | 2026-10-11 |
| TASK-015 | 修改 `internal/web/agent.go:bridge`、`host_session.go:verifyTerminalBinding`、`server.go` 终端路由及 `internal/ai/tools.go`，通过同一 resolver 校验所有读写/等待/关闭与后台路径。采用时holder为 user 或终端 busy则只允许读；写入需用户明确交给 Agent且无其他写入租约。授权后的参数冻结包含 owner、请求会话和 generation。依赖 TASK-014。 | Yes | 2026-10-11 |
| TASK-016 | 在 `internal/web/store.go` 增加跨 owner 命令审计字段和访问方法；终端及命令记录保留原 owner，操作审批保留请求会话，`BeginCommand` 通过已验证 TerminalAccess 关联两者，不能通过放宽原 `Terminal(id,tid)` 校验实现共享。共享读取只返回授权终端记录，不返回 owner 的其他聊天消息。前端 `AIPanel.tsx` 显示采用目标、owner 和只读/写入状态。依赖 TASK-015。 | Yes | 2026-10-11 |
| TASK-017 | 新增 `internal/web/terminal_access_test.go`，覆盖跨项目拒绝、未经批准读写、拒绝与重复采用、用户接管、同终端两个 Agent 并发、权限变更、旧审批、新 generation、重启及所有后台/HTTP绕过入口。验证两会话审计归属和历史隔离。依赖 TASK-016。 | Yes | 2026-10-11 |

### Implementation Phase 5

- **GOAL-005**: P1，补齐终端内 AI 入口和资源 scope 恢复。依赖阶段 2、阶段 3、阶段 4；完成标准：终端中直接聊天，切换资源恢复各自历史，切换终端只改变明确绑定。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-018 | 在 `internal/web/store.go` 迁移增加 `aiScopes(scope,projectId,resourceKind,resourceId,sessionId)` 并设复合唯一索引；新增 `ResolveTerminalAISession` 事务复用或创建普通 WorkSession，profile=terminal2。并发首次创建同资源只返回一个 scope 会话；删除 scope 会话/资源/项目时清理映射。现有会话保持原 ID 和普通入口。 | Yes | 2026-10-11 |
| TASK-019 | 在 `internal/web/server.go` 添加 `POST /api/sessions/:id/terminals/:tid/ai-scope`，入口会话及终端首先通过 TerminalAccess 校验，再返回 scope 会话 ID、绑定终端、generation及是否需要采用授权。scope 会话访问不同 owner 的终端仍走阶段 4；首次生成聊天会话不表示允许执行命令。`api.ts` 增加 typed client。依赖 TASK-018。 | Yes | 2026-10-11 |
| TASK-020 | 新增 `web-agent/web/src/TerminalAI.tsx`，在 `App.tsx` 的 terminalDrawer 增加 AI 面板入口并复用 AITranscript/AIControls、现有 SSE 和 composer。面板以 scope会话 ID+终端 ID+generation 标识请求，切换时取消旧请求且拒绝晚到结果。多终端共享资源历史，切换先停止旧轮次或等待审批处理，原 shell 命令仍按阶段 1 跟踪。新 generation 提示 shell 已重建并重新采集 cwd。依赖 TASK-019。 | Yes | 2026-10-11 |
| TASK-021 | 新增 `web-agent/web/test/terminal-ai.test.ts` 与 `internal/web/terminal_scope_test.go`，验证首次创建去重、刷新恢复、不同资源独立历史、相同资源不同终端明确绑定、切换时异步结果隔离、审批期间切换、关闭重建、删除会话及所有采用授权流程。依赖 TASK-020。 | Yes | 2026-10-11 |

### Implementation Phase 6

- **GOAL-006**: P2，完成集成回归、文档和签名发布验证。依赖阶段 1 至阶段 5；完成标准：指定检查全部通过，隔离环境的签名二进制及 UI 验收完成，文档说明一致。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-022 | 更新 `README.md`、`web-agent/README.md`、`docs/hexhub-ai/README.md`，删除已失效的 Node worker 发布说明，说明 scope、四种 shell、历史屏幕、停止/中断/关闭、采用授权及保留的权限差异。创建 `docs/validation/lake-hexhub-terminal-parity.md`，逐项记录六项差距和两项完善功能的证据。 | Yes | 2026-10-11 |
| TASK-023 | 顺序执行 `go test ./...`、`go test -race ./internal/web ./internal/ai`、`pnpm --dir web-agent check`、`pnpm --dir web-agent test:frontend`；通过后运行 `scripts/build_lake.sh` 生成签名用户二进制。失败只修复本次相关问题，不改动无关工作区文件；shell 缺失不能被算作完整验收通过。 | Yes | 2026-10-11 |
| TASK-024 | 用签名 `bin/lake`、独立临时 `--home`、端口 4180 和合成 SSH 凭据启动验收，先确认端口未被占用，若已占用使用第一个空闲的 4181–4190 端口；不切换用户 4177 服务。浏览器检查 scope 恢复、真实 cwd/env、停止后命令继续可查、Ctrl-C、关闭、历史提示、采用授权与用户接管。完成清理自建进程和临时资源，记录二进制版本及签名；更新本计划状态。依赖 TASK-022、TASK-023。 | Yes | 2026-10-11 |

## 3. Alternatives

- **ALT-001**: 原样恢复 HexHub WebSocket、Vue 组件和后台 RPC。现有 Go/React/SSE 已有等价传输与恢复能力，采用行为补齐，不增加第二套后台。
- **ALT-002**: 将跨 owner 采用实现为终端所有权转移。会破坏旧会话审批和审计归属，采用显式访问授权和独占写入租约。
- **ALT-003**: 按终端 ID 创建永久独立 AI 历史。关闭重建会丢失资源会话连续性，采用项目/资源 scope 与独立 generation 绑定。
- **ALT-004**: 把删除静默和原始输入权限直接改为报告里的 HexHub 规则。会改变 Lake 现有产品行为，按 CON-002 保留并在文档中说明。
- **ALT-005**: 停止 AI 时无条件发送 Ctrl-C 或 kill shell。无法区分停止推理与停止执行，按 REQ-002 提供独立操作。

## 4. Dependencies

- **DEP-001**: 现有 `creack/pty`、`hinshun/vt10x`、SQLite、Go AI 引擎、OpenSSH、React/xterm 和 SSE；本计划不要求新增云服务。
- **DEP-002**: Bash/Zsh/Fish 测试环境及临时 sshd，均使用合成凭据和独立 known_hosts；缺少 Fish 时需准备测试安装或隔离测试镜像再完成发布验收。
- **DEP-003**: 持久 `Lake Local Development Code Signing` 身份、`scripts/build_lake.sh`、Go 工具链及前端构建依赖。只制定计划时不执行构建或安装。
- **DEP-004**: 阶段 1 → 阶段 2 → 阶段 3；阶段 4 依赖阶段 1/3；阶段 5 依赖阶段 2/3/4；阶段 6 依赖全部功能阶段。同一任务表内仅无显式依赖的任务可独立实施。

## 5. Files

- **FILE-001**: `internal/web/{terminal,store,agent,host_session,server,references,ssh}.go`，处理生命周期、迁移、上下文与终端桥接。
- **FILE-002**: 新增 `internal/web/{shell_hooks,terminal_context,terminal_access}.go` 与 `internal/web/hooks/{bash,zsh,fish}.txt`，实现 hooks、上下文和采用授权。
- **FILE-003**: `internal/ai/{engine,types,tools,catalog,permissions,shell,stdio}.go`，处理取消、动态工具、轮次输入和持久引用。
- **FILE-004**: `web-agent/shared/contracts.ts`、`web-agent/web/src/{App,AIPanel,TerminalPane,SSHResourceFields}.tsx`、`api.ts`、`styles.css` 及新增 `TerminalAI.tsx`。
- **FILE-005**: 新增 Go 终端生命周期/hooks/上下文/访问/scope 测试，更新 AI 与现有 Web 回归测试，新增前端 terminal-ai 测试。
- **FILE-006**: `README.md`、`web-agent/README.md`、`docs/hexhub-ai/README.md`、新增 `docs/validation/lake-hexhub-terminal-parity.md` 和本计划。

## 6. Testing

- **TEST-001**: 真实本地 PTY：先 cd/export，再启动长命令并停止 AI；命令仍可观察，完成后同终端 cwd/env 不变。Ctrl-C 结束前台而 shell 可继续使用；close 才使 generation 失效。
- **TEST-002**: 断线与历史：read 明确返回 historical 和原采集时间；contains/regex expect 均不能用旧输出成功匹配；重建后旧 generation 的审批、读写和后台任务访问失败。
- **TEST-003**: 四种 shell：状态保持、hooks 初始化、cwd 更新、退出码、重复相同命令和人工输入命令块；unsupported shell 明确失败；hooks 降级后撤下 execute 工具且保留可用能力。
- **TEST-004**: 模型夹具校验实际请求：24 块、每块 12000 字符、会话文本总计 16000 字符、当前 cwd、截断标签、最大用户消息、压缩预算以及其他终端和凭据不进入该上下文。
- **TEST-005**: 引用记忆：引用/批准资源跨轮次及重启保留；开启阻断时可用有效集合；无依据的新资源、跨项目、已删除资源拒绝；清空记忆后再次要求引用。
- **TEST-006**: 跨 owner 访问：所有工具/HTTP/后台入口无 grant 时拒绝，同项目精确批准后允许；holder 改变、两 Agent 并发、撤销/重启/generation/参数漂移不能绕过；审批与命令保留请求者及 owner 审计。
- **TEST-007**: scope 与 UI：首次创建并发去重、刷新恢复、资源历史隔离、多终端明确绑定、停止/审批/切换竞态、重建提示、原聊天功能及删除恢复回归。
- **TEST-008**: 发布：TASK-023 指定检查通过后，只用签名二进制在独立 home 验收；运行不依赖 Node，不接触用户生产模型和远程资产，不替换当前服务。

## 7. Risks & Assumptions

- **RISK-001**: shell hooks 与终端控制流可能被远端输出伪造；依照 SEC-001/SEC-002 不能用观测字段扩大权限，采集失败保持未知。
- **RISK-002**: Ctrl-C 不保证任意程序响应，也不能保证程序自行留下的子进程已终止；等待明确完成，否则保持未知，用户可显式关闭。
- **RISK-003**: hooks 与用户自定义启动配置可能冲突；提供受限自有 hooks，检测失败降级并显示原因，不重写用户 shell 配置文件。
- **RISK-004**: 24 块上下文可能超过小模型容量；按 REQ-006 裁剪并使用既有压缩，UI 显示裁剪，不能把估算值宣称为精确 tokenizer 用量。
- **RISK-005**: 跨 owner 访问扩大权限校验面；所有入口必须共享 resolver，通过阶段 4 全量访问回归后才接通终端 AI scope。
- **RISK-006**: 同资源多个终端共享 AI 历史，历史证据可能来自旧 shell；每块携带终端 ID/generation，UI 提示明确绑定变化，系统提示禁止将旧证据视为当前状态。
- **ASSUMPTION-001**: 当前目标为 macOS/Linux POSIX PTY；Windows PTY 不纳入本次验收。
- **ASSUMPTION-002**: 用户已授权按计划实施、测试及签名构建；使用隔离环境验收，不替换当前服务。
- **ASSUMPTION-003**: 报告的原生停止和交互输入最终校验仍有限制；未确认的 HexHub 行为不作为一比一复刻验收标准。

## 8. Related Specifications / Further Reading

- [HexHub AI 增强终端逆向分析报告](../docs/hexhub-ai/HexHub_AI增强终端逆向分析报告.docx)
- [发布代码证据 R01–R34](../docs/hexhub-ai/rea-current/source-evidence.md)
- [报告文字版及分析范围](../docs/hexhub-ai/rea-current/README.md)
- [Go Web 迁移计划](refactor-go-server-1.md)
- [会话权限计划](feature-session-permissions-1.md)
- [终端命令策略计划](feature-terminal-command-policy-1.md)
- [当前运行与构建说明](../web-agent/README.md)

六阶段已实施并通过对应验收。Go 全量回归、全套竞态检查及后续针对性竞态回归通过；前端 35 项测试与类型检查通过。已生成签名二进制，完成独立 home、无 Node PATH 的 API/浏览器及重启恢复验收；详见 [验收记录](../docs/validation/lake-hexhub-terminal-parity.md)。当前 4177 服务不切换，临时测试服务验收后停止。

## 逐项复核进度

2026-10-11 已按 24 项逐一复核并补齐授权恢复、失败绑定、精确目标、实时采样和 composer 缺口；新增后台完成、exec/exit、hooks 降级及图片引用的实际验收。全部步骤通过，逐项代码位置和证据见 [24 步验收清单](../docs/validation/lake-terminal-plan-step-audit.md)。本轮前端测试 36 项通过。
