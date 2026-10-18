---
goal: 聊天任意文件附件与目标资源部署
version: 1
date_created: 2026-10-18
last_updated: 2026-10-18
owner: Codex
status: Completed
tags: [feature, attachments, desktop, adk]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

在 experiment/adk-runtime 保留现有迁移和修复，实现选择、拖入、粘贴文件，持久保存附件引用，并通过 ADK 工具传到明确指定的目标后解压部署。

## 1. Requirements & Constraints

- **REQ-001**: 支持任意文件类型，包括压缩包、空文件和未知 MIME；每个普通文件最多 512 MiB，每条消息最多 8 个文件，图片预览保留现有限制。
- **REQ-002**: 前端不把二进制转成文本或放进模型上下文；服务端流式保存私有原件，返回名称、大小、摘要及会话内标识。
- **REQ-003**: 待发送队列、发送后的历史及重启恢复均保留附件；附件只有明确的工具调用才传输或执行。
- **SEC-001**: 附件绑定项目与会话，拒绝跨会话访问、路径逃逸及原件篡改；传输沿用授权、目标校验、持久操作记录和未知结果防重放机制。
- **CON-001**: 不切换或清理当前分支，不读取或复制 release 凭据；macOS 使用签名 Dev 构建脚本。
- **GUD-001**: 遵守 docs/ui-guidelines.md，使用 Glyph、共享控件和主题变量，保留文本粘贴和光标行为。
- **PAT-001**: 元数据进入模型上下文，文件字节走独立上传/传输通道；现有 shell 工具负责目标上的解压、部署和验收。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 建立附件存储与可恢复的消息引用。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/web/attachments.go 实现私有流式上传、会话校验、下载、摘要校验及有界附件检查；internal/web/server.go 添加路由。 | ✅ | 2026-10-18 |
| TASK-002 | internal/web/message_queue.go、message_queue_store.go、store.go 规范化文件引用并在消息/队列持久保存；保留旧文本导入兼容。 | ✅ | 2026-10-18 |

### Implementation Phase 2

- **GOAL-002**: 打通 ADK 到目标资源的文件操作。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | internal/ai/catalog.go、tools.go、permissions.go 和 internal/web/agent.go 增加 inspect_attachment、stage_attachment；绑定原件摘要和目标授权。 | ✅ | 2026-10-18 |
| TASK-004 | internal/ai/attachments.go 与 runtime.go 实现流式本地、SSH、容器落盘、摘要校验及显式覆盖；通过现有 shell 解压部署。 | ✅ | 2026-10-18 |

### Implementation Phase 3

- **GOAL-003**: 完成聊天交互与验收。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | web-agent/web/src/App.tsx、fileAttachments.ts、api.ts、shared/contracts.ts 支持文件选择、拖放、剪贴板、附件状态和历史下载。 | ✅ | 2026-10-18 |
| TASK-006 | 为存储隔离、上传限制、队列恢复、文件完整性、审批拒绝、实际压缩包传输解压和拖放/粘贴添加测试；验证原生 Dev。 | ✅ | 2026-10-18 |
| TASK-007 | 测试通过后使用 scripts/build_lake_desktop.sh --dev --install 安装启动，记录分支、签名和验收证据。 | ✅ | 2026-10-18 |

## 3. Alternatives

- **ALT-001**: 不使用 base64 JSON 上传大文件，避免扩容消息请求及模型上下文。
- **ALT-002**: 不因附件存在而自动导入连接或运行部署脚本；操作依据用户消息及现有权限。

## 4. Dependencies

- **DEP-001**: Go 标准库、现有 ADK 工具执行与 runtime 通道、现有 React 工作台及 macOS WKWebView。

## 5. Files

- **FILE-001**: internal/web/attachments.go 及 attachments_test.go：存储、上传下载、检查与隔离。
- **FILE-002**: internal/ai/attachments.go 及 attachments_test.go：目标传输与实际内容校验。
- **FILE-003**: internal/web/server.go、agent.go、message_queue.go、message_queue_store.go、store.go、resource_import.go：入口与历史兼容。
- **FILE-004**: internal/ai/catalog.go、tools.go、permissions.go、runtime.go：工具路由及授权。
- **FILE-005**: web-agent/web/src/App.tsx、AIPanel.tsx、fileAttachments.ts、api.ts、styles.css 与 web-agent/shared/contracts.ts：聊天附件交互。

## 6. Testing

- **TEST-001**: 上传和下载二进制/压缩包/空文件；校验跨会话拒绝、篡改拒绝和超限清理。
- **TEST-002**: 队列和历史重启恢复附件元数据，原始文件校验不变；文本导入旧测试继续通过。
- **TEST-003**: ADK 审批拒绝不落盘、批准后字节一致；隔离目标实际解压部署并读取验收文件。
- **TEST-004**: 前端文件集合、文本/文件粘贴区分、选择器与拖放入口测试；原生界面验证文件附件。
- **TEST-005**: Go 竞态回归、前端测试、类型检查、边界检查、签名 Dev 安装及启动验证。

## 7. Risks & Assumptions

- **RISK-001**: 浏览器和 WKWebView 的 Finder 文件剪贴板行为不同；使用实际 macOS 复制/粘贴验收，必要时增加仅用户粘贴触发的原生桥。
- **RISK-002**: 压缩包内容可能有越界路径或链接；附件检查报告风险，解压前必须核对，并在独立目标目录操作。
- **ASSUMPTION-001**: 用户所说“任意文件”指任意文件类型；文件夹需先压缩，部署目标已有必要解压工具。

## 8. Related Specifications / Further Reading

- [工作区规则](../AGENTS.md)
- [UI 规范](../docs/ui-guidelines.md)
- [ADK 迁移方案](refactor-adk-official-runtime-1.md)
