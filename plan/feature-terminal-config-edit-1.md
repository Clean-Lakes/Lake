---
goal: 支持本机与 SSH 终端资源配置编辑
version: 1
date_created: 2026-10-13
last_updated: 2026-10-13
status: Completed
tags: [feature, terminal, ssh]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

资源右键菜单、终端管理面板与资源详情提供配置编辑，凭据保留和替换均走正常私有文件路径。

## 1. Requirements & Constraints

- **REQ-001**: SSH 可编辑名称、地址、端口、用户名、Shell、认证方式和替换凭据；本机可编辑名称和默认 Shell。
- **REQ-002**: 已有密码、私钥和口令不回显；空凭据保留，换认证方式或上传密钥时丢弃不兼容旧引用。
- **REQ-003**: 连接变更要求项目 AI/工作流结束、终端关闭并处理活跃审批；名称变更允许在线。配置保存和终端准入串行，信任检查期间配置变化拒绝旧连接。
- **REQ-004**: 保留资源 ID、项目、目录和历史，前端缓存及名称同步；明确指定 Shell 后新连接遵循配置。
- **SEC-001**: 不读取 Keychain；凭据以私有文件保存、失败清理，不接受其他资源的凭据引用；鉴权/Origin 校验继续生效；不推送。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 保存终端配置并保障连接一致。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/web/resource_edit.go PATCH /api/resources/:id 合并凭据、更新配置；navigation_trash.go 共用空闲检查；terminal.go/shell_hooks.go 防止过期准入并应用默认 Shell。 | Yes | 2026-10-13 |
| TASK-002 | TerminalConfigEdit.tsx 与 SSHResourceFields.tsx 编辑弹窗；App.tsx 右键/终端管理/详情入口和缓存同步；api.ts PATCH 方法。依赖 TASK-001。 | Yes | 2026-10-13 |
| TASK-003 | resource_edit_test.go 密码保留/轮换、认证切换、密钥权限、拒绝越权引用、在线/AI 阻止、失败清理、并发准入；全量 Web race、签名构建和本地 UI 验证。依赖 TASK-002。 | Yes | 2026-10-13 |

## 3. Alternatives

- **ALT-001**: 原样回填密码/私钥会暴露凭据，采用保留引用及显式输入替换。
- **ALT-002**: 在线连接自动迁移会中断工作且掩盖目标切换，改为要求先关闭终端。

## 4. Dependencies

- **DEP-001**: prepareSSH、validateSSH、私有凭据目录、现有 modal 和 NavigationMenu。

## 5. Files

- **FILE-001**: internal/web/resource_edit.go、resource_edit_test.go、server.go、terminal.go、shell_hooks.go、navigation_trash.go。
- **FILE-002**: web-agent/web/src/TerminalConfigEdit.tsx、SSHResourceFields.tsx、App.tsx、api.ts。

## 6. Testing

- **TEST-001**: HTTP/SQLite/本机 PTY 测试与受控信任检查并发测试，不访问真实远程服务器。
- **TEST-002**: TypeScript/Vite、Web race、codesign strict 和浏览器预填/空凭据保留/取消验证。

## 7. Risks & Assumptions

- **RISK-001**: 旧私有凭据可能被其他配置或历史引用，成功替换不自动删除旧文件。
- **ASSUMPTION-001**: 此处终端配置指资源的本机/SSH 连接配置；数据库等服务配置不在本次范围。

## 8. Related Specifications / Further Reading

[会话编辑](feature-session-edit-1.md)
[SSH 凭据](feature-ssh-credentials-1.md)
