---
goal: 保留现有 LAKE 前端，接入源码构建的 ZCode 主 Agent 与 LAKE 运维工具
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'In progress'
tags: [zcode, runtime, integration]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

用户要求提交并推送当前代码，创建新分支导入 ZCode 开源版进行二开，前端继续使用当前 LAKE 界面。按 docs/zcode-runtime.md 的契约替换桌面主 Agent 循环，复用 LAKE 的工具、审批与持久数据服务。

## 1. Requirements & Constraints

- **REQ-001**: 当前基线提交保存到 codex/zcode-migration；新实现位于 codex/zcode-lake-runtime，分别推送，不改远端 main。
- **REQ-002**: 现有 Wails/React 前端及 bridge v1 事件兼容；主 Agent 使用源码构建的 ZCode app-server。
- **SEC-001**: 模型 Key 留在 Go 回环代理，SSH 凭据只由 LAKE 服务读取，不写 Node 配置或日志。
- **SEC-002**: 只导出当前 LAKE 注册工具，保留原审批和执行前授权复核，不开放 ZCode 内置副作用工具。
- **CON-001**: macOS 的 bin/lake 只使用 scripts/build_lake.sh 签名构建。
- **PAT-001**: ZCode 负责单轮 Agent 循环；LAKE 保持会话、审批、工具执行和湖志唯一所有权。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 保存现有实现并固定可复现 ZCode 源码。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | 提交当前 LAKE 基线、推送 codex/zcode-migration，创建 codex/zcode-lake-runtime。 | Yes | 2026-10-01 |
| TASK-002 | 导入 third_party/zcode 官方提交 29628c9acdb81b703bbd4080c207a0e7ce5e276e，保留许可，在 third_party/ZCODE-UPSTREAM.md 记录来源。 | Yes | 2026-10-01 |
| TASK-003 | 新建 scripts/build_zcode_agent.mjs，按锁文件构建 CLI 并复制运行时到 bin/zcode，桌面构建脚本打包该目录。 | Yes | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 兼容现有界面完成主 Agent、工具审批、结果与持久化接入；依赖 TASK-003。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-004 | 新建 lake/zcode/，实现 adk.Agent 接口、隔离子进程、MCP 工具注册与模型代理；更新 cmd/lake/chat.go 的 Agent 工厂及 bridge 运行时选择。 | Yes | 2026-10-01 |
| TASK-005 | 增加模拟服务和真实源码 Agent 集成测试，覆盖批准、拒绝、撤权、取消、代理凭据和旧前端协议；更新文档后提交推送新分支。 | | |

## 3. Alternatives

- **ALT-001**: 换用 ZCode 前端不符合用户要求。
- **ALT-002**: 安装版 ZCode 的服务器审批不完整；本分支直接复用 LAKE 主机侧审批回调。

## 4. Dependencies

- **DEP-001**: 固定 ZCode CLI 0.16.9 源码、Node 24.14.0、pnpm 锁文件。
- **DEP-002**: LAKE 现有 Go 工具注册表、MCP SDK、Wails 桥接与签名构建身份。

## 5. Files

- **FILE-001**: third_party/zcode、third_party/ZCODE-UPSTREAM.md：固定上游源码。
- **FILE-002**: lake/zcode/：Agent、进程协议、回环工具和模型代理。
- **FILE-003**: cmd/lake/chat.go、bridge.go、cli.go：主 Agent 选择与前端兼容入口。
- **FILE-004**: scripts/build_zcode_agent.mjs、scripts/build_lake_desktop.sh、docs/zcode-runtime.md：构建、打包与契约。

## 6. Testing

- **TEST-001**: 当前 Go 运维/CLI/桌面测试及前端测试构建；前端源码不替换。
- **TEST-002**: 源码 Agent 的模型/工具 fixture 及 bridge v1 审批、工具事件、结果和会话持久化。
- **TEST-003**: 代理认证、工具名校验、Key 隔离、取消和错误终态。

## 7. Risks & Assumptions

- **RISK-001**: 远端 main 属于另一套 ZCode 历史；本地基线与新分支独立保存，不强推或合并 main。
- **RISK-002**: 既有 Go 专员和摘要仍依赖 Eino，不声称全部专员已迁移。
- **ASSUMPTION-001**: 使用当前工作区的 Wails/React 界面作为用户要求保留的前端。

## 8. Related Specifications / Further Reading

- [运行时契约](../docs/zcode-runtime.md)
- [接入实测](../docs/zcode-ops-probe.md)
- [ZCode 来源](../third_party/ZCODE-UPSTREAM.md)
