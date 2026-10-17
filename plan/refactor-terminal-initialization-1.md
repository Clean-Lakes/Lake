---
goal: 新终端进入主目录并修复提示符重叠与中文乱码
version: 1
date_created: 2026-10-14
last_updated: 2026-10-14
owner: Lake
status: Completed
tags: [terminal, bug, encoding]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

修复本机和 SSH 终端的初始化、提示符宽度和 UTF-8 分片处理。

## 1. Requirements & Constraints

- **REQ-001**: 每个新终端执行 `cd -- "$HOME"`；sh、Bash、Zsh、Fish 在主目录提示符显示 `~`。
- **REQ-002**: 初始化仅执行一次复合命令，完成后只出现一个可见提示符；隐藏协议不计入 Readline 的提示符宽度。
- **REQ-003**: 选择目标上已安装的 UTF-8 locale，并恢复 Bash Readline 的八位输入与输出设置。
- **REQ-004**: PTY 不接收长初始化脚本；输出残缺 UTF-8 字节在编码为 JSON 前缓冲。
- **SEC-001**: 不读取真实私钥、模型密钥或 Keychain；SSH 测试仅使用新生成的隔离密钥。
- **CON-001**: 保留已有修改；用户二进制必须由 `scripts/build_lake.sh` 签名构建。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 初始化、目录与编码一致。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/web/shell_hooks.go 的 terminalInit 加入主目录、UTF-8 locale、Readline 设置，单次 eval 初始化并清理 __lake_init。 | ✅ | 2026-10-14 |
| TASK-002 | internal/web/terminal.go 的 open 在 reader 启动后发送短 eval，完整脚本传入环境；internal/web/ssh.go 的 sshArguments 用远端命令通道设置初始化环境。依赖 TASK-001。 | ✅ | 2026-10-14 |
| TASK-003 | internal/web/terminal.go 的 receive 缓冲 UTF-8 不完整尾部，完整字符才进入 hooks、输出和屏幕。 | ✅ | 2026-10-14 |

### Implementation Phase 2

- **GOAL-002**: 验证后签名交付。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | interactive_terminal_test.go、terminal_encoding_test.go、ssh_test.go 验证四种本机 Shell、真实隔离 SSH、缩放及逐字节中文输出。依赖 TASK-001、TASK-002、TASK-003。 | ✅ | 2026-10-14 |
| TASK-005 | terminal_browser_test.go 隔离浏览器验证中文输入、提示符和终端面板；scripts/build_lake_desktop.sh 生成签名 App/ZIP/DMG。依赖 TASK-004。 | ✅ | 2026-10-14 |

## 3. Alternatives

- **ALT-001**: 多条初始化命令会暴露中间提示符；长脚本通过 PTY 粘贴还可能被终端队列截断。

## 4. Dependencies

- **DEP-001**: 已有系统 Shell、stty、locale、awk、OpenSSH、vt10x 和 xterm。

## 5. Files

- **FILE-001**: internal/web/shell_hooks.go、terminal.go、ssh.go。
- **FILE-002**: internal/web/interactive_terminal_test.go、terminal_encoding_test.go、ssh_test.go、terminal_browser_test.go。
- **FILE-003**: web-agent/README.md、docs/validation/lake-terminal-home-encoding.md。

## 6. Testing

- **TEST-001**: 四种本机 Shell 启动后一个主目录提示符，缩放及命令历史行为正常。
- **TEST-002**: 隔离 SSH 的 sh/Bash 在无 UTF-8 启动环境下输入中文成功，缩放不重复提示符。
- **TEST-003**: 中文、Emoji、CSI/OSC 按单字节传输，每次落库仍是有效 UTF-8。
- **TEST-004**: Go 竞态回归、真实浏览器输入和签名构建。

## 7. Risks & Assumptions

- **RISK-001**: 目标未安装任何 UTF-8 locale 时无法凭空提供系统 locale；仍保持八位输入。
- **ASSUMPTION-001**: 请求指新建及重连的终端；已有终端 cwd 不会被后台强制改动。

## 8. Related Specifications / Further Reading

[终端功能](../web-agent/README.md)
