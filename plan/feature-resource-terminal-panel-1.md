---
goal: 从侧栏资源打开带动画的右侧持续终端
version: 1
date_created: 2026-10-11
last_updated: 2026-10-12
owner: Lake
status: 'Completed'
tags: [feature, frontend, ssh, terminal]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

点击侧栏 SSH 或本机资源，选择“打开终端”，在右侧浅色面板连接真实交互 Shell。使用紧凑标签栏、Shell 提示符、Tab 补全及内存历史；完整命令审批入口保留在终端选项中。

## 1. Requirements & Constraints

- **REQ-001**: 资源菜单包含“打开终端”和“查看资源信息”，保留在线终端管理。
- **REQ-002**: 桌面布局从右侧动画展开终端并压缩会话区域；窄屏使用右侧覆盖面板；减少动画偏好禁用过渡。
- **REQ-003**: 打开资源终端不创建或切换聊天会话；既有手动 Shell 复用运行上下文，无会话项目使用按资源复用的内部终端上下文，独立订阅输出。
- **REQ-004**: 手动交互模式支持直接在真实 Shell 提示符后输入、Tab 补全、上下键历史及运行中输入；收起后复用同一终端。原有受管理命令接口保留单行约束及风险审批。
- **SEC-001**: 复用现有 SSH 主机指纹验证、输入持有者及命令风险审批；不输出模型密钥或私钥内容。
- **CON-001**: macOS 用户二进制仅使用 scripts/build_lake.sh 构建和验证签名。
- **PAT-001**: 终端事件和历史使用内部运行上下文，与用户聊天导航独立；收起面板不关闭远程 Shell。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 接入入口与会话选择。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | web-agent/web/src/resourceTerminalState.ts 实现按项目选择会话及复用终端；App.tsx 实现侧栏打开请求、连接进度与错误状态。 | ✅ | 2026-10-11 |
| TASK-002 | App.tsx 的资源行切换资源菜单，新增打开终端和查看资源信息按钮，处理 Escape 和点击菜单外部关闭。 | ✅ | 2026-10-11 |

### Implementation Phase 2

- **GOAL-002**: 实现右侧面板与验证；依赖 TASK-001 和 TASK-002。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | web-agent/web/src/TerminalSidePanel.tsx 管理动画期间挂载、隐藏内容的 inert 状态及 Escape；styles.css 实现 260ms 右侧面板过渡和窄屏覆盖。 | ✅ | 2026-10-11 |
| TASK-004 | App.tsx 将持续终端挂载到紧凑浅色面板；TerminalPane.tsx 聚焦真实 PTY 输入。terminal.go/shell_hooks.go/server.go 对手动创建的交互终端启用提示符与输入，保留持有者鉴权和受管理命令审批；运行完整命令入口继续走 reviewCommand。 | ✅ | 2026-10-11 |
| TASK-005 | web-agent/web/test/resource-terminal.test.ts 验证会话与终端选择、面板隐藏及可访问性；运行前端类型检查和测试、构建签名二进制。 | ✅ | 2026-10-11 |
| TASK-006 | 更新无执行中任务的 4177 服务；浏览器验证本机和 SSH 资源打开、只读命令输出、收起与重新打开。依赖 TASK-005。 | ✅ | 2026-10-11 |

## 3. Alternatives

- **ALT-001**: 新建另一套 SSH 连接和命令执行 API，会重复持有者与指纹验证，因此复用现有接口。
- **ALT-002**: 使用全屏终端页面，无法同时查看会话，因此采用右侧面板。

## 4. Dependencies

- **DEP-001**: 现有 createTerminal、terminalHistory、terminalCommands、terminalInput、terminalResize。
- **DEP-002**: 现有 xterm.js、FitAddon、React 19、CSS grid 和 ResizeObserver；不增加运行时依赖。

## 5. Files

- **FILE-001**: web-agent/web/src/App.tsx：资源入口、打开请求、终端布局和输入聚焦。
- **FILE-002**: web-agent/web/src/TerminalSidePanel.tsx：面板动画挂载与无障碍行为。
- **FILE-003**: web-agent/web/src/resourceTerminalState.ts：终端复用选择。
- **FILE-004**: web-agent/web/src/styles.css：面板、菜单和响应式样式。
- **FILE-005**: web-agent/web/test/resource-terminal.test.ts：状态选择和面板验证。

## 6. Testing

- **TEST-001**: 当前同项目会话优先，其他项目选择最近会话，无会话返回创建请求。
- **TEST-002**: 复用可用终端，断开记录不被复用；切换资源不输入到旧终端。
- **TEST-003**: 隐藏面板不可聚焦，关闭保留 Shell，动画结束后移除终端视图，窄屏和减少动画偏好适配。
- **TEST-004**: 签名二进制的浏览器实测 SSH 与本机终端、Enter 提交 pwd、输出可见、重复打开不新建连接。

## 7. Risks & Assumptions

- **RISK-001**: 打开 SSH 可能连接失败或需要确认主机指纹；面板显示实际状态，保留现有确认流程。
- **RISK-002**: 连接期间切换会话或收起面板可能产生异步结果；仅更新仍对应当前会话的结果，连接完成不强制重新展开。
- **ASSUMPTION-001**: 用户要求手动打开终端；此操作授权建立目标 SSH 连接，但不更改命令审批设置。

## 8. Related Specifications / Further Reading

[资源目录树](feature-resource-directory-tree-1.md)
[终端交互与持有者](feature-hexhub-terminal-parity-1.md)
[会话权限](feature-session-permissions-1.md)

## 2026-10-12 Resource terminals without chat creation

Completed: App.tsx opens a resource terminal without navigation or createSession; independent terminal context, SSE, input, command review and host-key prompts are preserved when navigating chats. Existing manual shells are reused. Empty projects use a persistent internal resource runtime scope excluded from the chat catalog. Empty legacy enhanced-terminal scopes are omitted; scopes with user messages remain visible. Verified with isolated Go race tests, 47 frontend tests, full Go web/AI race suites, signed build, and two native Chrome opens preserving seven chats, the active conversation and the two live terminal IDs.

## 2026-10-12 Reuse manual shells with hidden Lake output

Completed: Human chat creation or a resource-referencing message binds the selected idle manual Shell (or the unique eligible Shell). Exact IDs, generation, project, pending commands, and unfinished input are checked. Lake borrows input for the turn and returns it after outstanding commands finish. Manual console output omits Lake command echoes and results; command records remain in the requesting chat. Existing approval and access revocation rules continue to apply. Validated Shell state, output isolation, lifecycle and permissions under Go race tests, 47 frontend tests, signed build and native Chrome chat creation using the existing SSH terminal; the temporary empty validation chat was removed without changing the terminal count.

## 2026-10-12 Online terminal picker and multiple resource connections

Completed: Resource terminal API combines live connections across runtime owners. App.tsx switches the history/input/event owner when selecting another connection, omits disconnected tabs and menu entries, and labels connections with resource names and terminal ordinals. The resource menu, terminal header plus and list menu offer new connections to the same resource without creating chats. Verified with 48 frontend tests, targeted Go race tests, signed build, and native Chrome creation of an additional ready SSH connection (three to four live terminals). The user changed terminal state during verification; the current user-selected connection state was preserved.

## 2026-10-12 Spacious resource menu and compaction recovery

Completed: Terminal management opens beside the sidebar in a viewport-clamped 320px portal, with separate action cards, a scrollable live connection list, friendly chronological numbering and focus after positioning. Context summaries use independent low reasoning and one bounded retry after output truncation; failed summaries preserve original history and rollback checkpoints. Duplicate native system errors are suppressed and legacy transcript duplicates are filtered into one Chinese error. Verified with 50 frontend tests, full AI race suite, targeted conversation/resource web tests, signed build and native Chrome. The idle 4177 service was updated and five terminals reconnected without replaying commands. The current chat's disconnected binding was replaced with its existing owned Agent terminal on the same resource without changing permissions. Evidence: docs/validation/lake-compaction-recovery-menu.json.

## 2026-10-12 AI uses a background connection by default

The user's revised behavior supersedes automatic manual-shell reuse: creating a chat or referencing a resource no longer selects the open console or the sole manual connection. Core chats discard implicit manual bindings, retain the target resource and reuse their own managed connection. Explicit terminal references and the explicit reuse API remain available with existing generation and permission checks. The resource list, tab picker and counts show interactive manual terminals only, and closing all entries leaves background AI connections running. Approval handoffs do not automatically open an AI console. Tests cover multiple manual shells, unfinished manual input, expired foreign bindings, background reuse and list/close isolation.

Completed and deployed to 4177: full web race suite passed (131.786s), 51 frontend tests and typecheck passed, signed build verified. Two current idle manual connections were restored without replay; native Chrome showed only these user connections and verified menu autofocus/Escape. Evidence: docs/validation/lake-ai-background-terminal.json.

## 2026-10-12 Terminal names in tabs

Completed: visible tab text now uses the same resource name and terminal ordinal as the picker (for example, 36.151.150.63 · 终端 1), with tabs sized 220–280px rather than squeezing names into the previous short-label layout. Long names keep ellipsis and the full title. Signed build/typecheck passed and bundle index-D7l3lPCZ.js was deployed to 4177; two idle connections restored. Native Chrome confirmed both named tabs and the selected terminal remains usable.
