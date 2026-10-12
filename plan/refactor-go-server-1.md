---
goal: 将 Lake Web 后端与发布入口迁到 Go，保留 React 静态前端
version: 1.0
date_created: 2026-10-10
last_updated: 2026-10-10
owner: Lake
status: 'Completed'
tags: [refactor, golang, migration]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

将现有 Web API、SQLite 数据、PTY/SSH 终端和 AI 桥接整合为 Go 服务。发布二进制内嵌 React 构建产物，不包含 Node 或 node_modules。保留历史源代码供参考，但启动路径不得回退到 TypeScript。

## 1. Requirements & Constraints

- **REQ-001**: 兼容 web-agent/web/src/api.ts 的全部 HTTP API、事件游标和共享 JSON 合约。
- **REQ-002**: 原 lake-web.sqlite、model.json 与 AI JSON 状态原地可读；重启不得重放命令或审批。
- **REQ-003**: 本地与 SSH 持久终端支持 cwd/env、接管、交互输入、resize、屏幕读取、中断和关闭。
- **REQ-004**: bin/lake 的运行路径使用 Go，无 Node/TypeScript fallback；Node 仅用于构建 React 静态文件。
- **SEC-001**: 保留本机绑定、Host/Origin 验证、Bearer/HttpOnly Cookie、凭据私有权限和日志脱敏。
- **CON-001**: 用户二进制只经 scripts/build_lake.sh 构建与持久身份签名；正常操作不读 Keychain。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 建立兼容数据与持久执行层。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/web/store.go 迁移 SQLite 表结构、原型升级、事务事件、会话资源/消息/命令/操作持久化与恢复。 | ✅ | 2026-10-10 |
| TASK-002 | internal/web/policy.go、terminal.go、ssh.go 移植命令风险分类、PTY、VT 屏幕和严格 SSH 信任与权限检查。 | ✅ | 2026-10-10 |

### Implementation Phase 2

- **GOAL-002**: 提供 Go HTTP 服务与直接 AI 集成；依赖 TASK-001、TASK-002。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | internal/web/server.go、model.go、agent.go、references.go 实现全部 HTTP/SSE、模型配置、ai.Engine 内进程调用和终端桥接。 | ✅ | 2026-10-10 |
| TASK-004 | assets/web/embed.go、cmd/lake/main.go、scripts/build_lake.sh 改为静态 React 内嵌 Go 二进制；删除运行时 Node 启动和打包路径，保留显式签名迁移。 | ✅ | 2026-10-10 |

### Implementation Phase 3

- **GOAL-003**: 验证迁移与独立发布；依赖 TASK-003、TASK-004。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | internal/web/*_test.go 验证 HTTP/SSE 鉴权、旧库迁移、真实 PTY/SSH、AI 审批与恢复；更新 README 和 docs/validation。 | ✅ | 2026-10-10 |
| TASK-006 | go test -race、React 类型/构建检查、签名构建、隔离 HOME 且 PATH 无 Node 的真实二进制启动与浏览器验收；切换本机 4177 服务。 | ✅ | 2026-10-10 |

## 3. Alternatives

- **ALT-001**: 继续以 Node HTTP 桥接 Go AI 无法满足独立运行要求，不采用。
- **ALT-002**: 使用 Go 的 SSH 客户端读取私钥增加 Lake 接触私钥内容，采用系统 OpenSSH，Go 管理 PTY 生命周期。

## 4. Dependencies

- **DEP-001**: 已有 mattn/go-sqlite3、internal/ai；新引入 creack/pty 与 hinshun/vt10x。
- **DEP-002**: React/Vite/pnpm 仅构建时使用；macOS Security 用于签名和显式旧凭据迁移。

## 5. Files

- **FILE-001**: internal/web/*.go、assets/web/embed.go 为新 Go 服务和静态嵌入入口。
- **FILE-002**: cmd/lake/main.go、scripts/build_lake.sh、web-agent/package.json、README.md、web-agent/README.md 更新运行和构建说明。

## 6. Testing

- **TEST-001**: Go 真实 PTY 命令/接管/中断/VT 与临时 sshd 合成密钥测试。
- **TEST-002**: HTTP 全路由、SSE 恢复、跨会话隔离、原型 SQLite 升级、模型凭据权限和 AI 本地模型夹具。
- **TEST-003**: 已有 internal/ai 回归及 race；签名二进制在 PATH 无 Node 的目录运行，静态资源和全部后端均工作。

## 7. Risks & Assumptions

- **RISK-001**: 中断终端结果可能未知，持久化 unknown 并禁止自动重放。
- **RISK-002**: 历史 agent TypeScript CLI 与当前 Web 合约不同；新入口仅使用 Go 合约，旧源码保留且旧数据不删除，命令差异需要明确记录。
- **ASSUMPTION-001**: 目标为当前 macOS 与 Linux 的 POSIX PTY；Windows PTY 未验证。

## 8. Related Specifications / Further Reading

[已有 AI 后端计划](feature-go-ai-backend-1.md)
[前端 API](../web-agent/web/src/api.ts)
[PTY 文档](https://github.com/creack/pty)
[VT 文档](https://github.com/hinshun/vt10x)
