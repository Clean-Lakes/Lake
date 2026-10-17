---
goal: 用继承主会话工具及权限的 SRE 专员替换普通会话的旧调查委派
version: 1
date_created: 2026-10-16
last_updated: 2026-10-16
owner: Lake
status: 'Completed'
tags: [refactor, sre, agents]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

普通对话关闭 SRE 时不再调度 Scout/Trace/Deep/Beacon。开启后统一使用 SRE Plan 与四个专员，专员继承主会话的工具、资源范围和实时权限，所有执行继续经过正常审批与持久记录。

## 1. Requirements & Constraints

- **REQ-001**: 正常聊天不提供或调度旧 delegate_investigation；已保存 auto 设置不得启用旧委派。
- **REQ-002**: SRE 实际工作专员提供主会话 Shell、终端、文件、SQL、Redis、Docker、MCP、Skills 工具，不再仅限固定观察探针。
- **SEC-001**: 授权继承取父会话实时权限的交集，资源和终端保持任务范围；具体操作审批、变更记录、结果不明禁止重放保持有效。
- **CON-001**: 保留历史消息和证据；不自动重放旧任务，不操作正式版数据；macOS 使用签名脚本构建并安装 Dev。
- **GUD-001**: 界面遵循 docs/ui-guidelines.md，去掉旧多 Agent 设置入口。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 替换会话入口及专员工具链路。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 修改 internal/web/agent.go、internal/ai/catalog.go 与普通提示词，关闭普通聊天的旧调查委派；旧历史保留。 | ✅ | 2026-10-16 |
| TASK-002 | 修改 internal/ai/sre_roles.go、multi_agent.go、tools.go、session_tools.go，继承完整工具目录、实时权限、桥接目标校验并记录实际证据。 | ✅ | 2026-10-16 |
| TASK-003 | 修改 internal/ai/sre_execution.go 与专员提示词，完整工具调用遵守已有审批及 durable operation 记录，冻结执行与验证条件保留精确约束。 | ✅ | 2026-10-16 |

### Implementation Phase 2

- **GOAL-002**: 统一可见入口、验证和 Dev 交付。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 修改 web-agent/web/src/AIPanel.tsx，移除旧多 Agent 配置；工作流入口使用 SRE 专员，SRE 关闭时不得调度旧调查。 | ✅ | 2026-10-16 |
| TASK-005 | 添加模式关闭、完整工具、实时权限收紧、跨目标拒绝、实际 Shell 与文件操作及审批回归；运行 Go、race 与前端检查。 | ✅ | 2026-10-16 |
| TASK-006 | 更新 docs/sre-collaboration.md；使用 scripts/build_lake_desktop.sh --dev --install 签名安装，空闲时重启 Dev 并确认数据保留。 | ✅ | 2026-10-16 |

## 3. Alternatives

- **ALT-001**: 仅隐藏旧卡片会留下旧调度链路，不采用。
- **ALT-002**: 仅补充固定探针不能提供主会话工具能力，不采用。

## 4. Dependencies

- **DEP-001**: 现有 SRE SQLite 仓库、Engine.Bridge、权限与审批控制器、持久签名身份。

## 5. Files

- **FILE-001**: internal/ai/{catalog.go,multi_agent.go,sre_roles.go,sre_execution.go,tools.go,session_tools.go} 负责工具、权限及实际执行。
- **FILE-002**: internal/web/{agent.go,workflows.go} 与 web-agent/web/src/AIPanel.tsx 负责模式入口。
- **FILE-003**: docs/sre-collaboration.md 与 docs/validation/ 记录行为和验收事实。

## 6. Testing

- **TEST-001**: 旧 auto 配置且 SRE 关闭时无委派工具、无子任务；开启时仅有真实 SRE 专员。
- **TEST-002**: 子专员实际执行普通 Shell／文件／数据库工具并产生证据，MCP／Skills 正确继承。
- **TEST-003**: 父权限收紧、跨任务终端或资源、拒绝审批、unknown 重试不越权或重复写入。
- **TEST-004**: 全量 Go、race、TypeScript、前端测试及签名 Dev 构建验证。

## 7. Risks & Assumptions

- **RISK-001**: 完整工具继承可能绕过旧只读子任务限制，必须在实际目标解析后复验范围与当前父权限。
- **ASSUMPTION-001**: 完整权限表示继承主会话已有授权和审批规则，不新增环境或凭据权限。

## 8. Related Specifications / Further Reading

- [SRE 协作](../docs/sre-collaboration.md)
- [UI 规范](../docs/ui-guidelines.md)
- [原 SRE 计划](feature-sre-collaboration-1.md)
