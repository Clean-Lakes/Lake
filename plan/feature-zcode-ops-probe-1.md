---
goal: 验证 ZCode 通过 MCP 复用 LAKE 资源、固定 SSH 检查、审批与湖志
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [integration, zcode, mcp, verification]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

本次接入验证已完成。签名 Lake CLI 的绑定湖 MCP 服务通过实际 ZCode Agent 完成资源查询、单次真实 hostname 和关联湖志；模拟 SSH 验证批准、拒绝及审批中撤权。发现安装版 ZCode 未完成 LAKE MCP 表单审批，桌面界面尚未验收，结论见 docs/zcode-ops-probe.md。Completed 表示验证任务完成，不表示完整产品接入完成。

## 1. Requirements & Constraints

- **REQ-001**: MCP 提供绑定湖清单、冻结主机清单、固定只读检查和本次运行湖志四个工具；模型不能切换湖或传入任意命令。
- **SEC-001**: SSH 私钥与模型 API Key 不进入 MCP 内容、前端、日志或测试报告；正常操作仅使用本地私有凭据文件。
- **SEC-002**: 执行仍经 operate.Service，逐次复核 execute_authz 和目标；审批用 MCP elicitation，由客户端响应，工具参数不接受批准标志。
- **CON-001**: 用户可执行 bin/lake 只使用 scripts/build_lake.sh 构建和签名。
- **CON-002**: 拒绝、撤权和异常测试使用临时数据库；真实测试不改变用户全局权限。
- **PAT-001**: ZCode → MCP → operate.Service → SSH；工具结果和湖志通过 run_id 关联。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成小范围 MCP 接入，协议测试证明批准执行一次、拒绝和审批中撤权执行零次。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | 新建 lake/opsmcp/server.go 与 server_test.go，注册四个范围受限工具、MCP elicitation 和真实服务审计；使用模拟 SSH 计数验证审批、撤权、越界和不支持审批的客户端。 | ✅ | 2026-10-01 |
| TASK-002 | 新建 cmd/lake/ops_mcp.go，增加 ops-mcp --lake 命令，通过 scripts/build_lake.sh 构建签名 CLI。 | ✅ | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 使用实际 ZCode 客户端完成接入验证，明确原生审批是否支持。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-003 | 新建 scripts/test_zcode_ops.mjs；在私有临时工作区启动真实 ZCode，记录工具发现、固定检查及审批协议结果，阻止模型使用本地 Shell 或其他工具。 | ✅ | 2026-10-01 |
| TASK-004 | 在已授权测试湖运行 hostname；查询对应湖志，私有保存原始证据，在 docs/zcode-ops-probe.md 汇总通过及未通过项目。 | ✅ | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 直接让 ZCode 执行 ssh 无法验证 LAKE 的授权和审计接入，因此本次不用。
- **ALT-002**: 完整迁移 UI 和 Agent 不属于可行性验证范围。

## 4. Dependencies

- **DEP-001**: 已安装 ZCode 的真实 Agent 运行时及其公开源码；不更改已有账号或模型设置。
- **DEP-002**: 仓库固定的 Go MCP SDK v1.7.0、现有运维服务和签名构建身份。

## 5. Files

- **FILE-001**: lake/opsmcp/server.go、lake/opsmcp/server_test.go：协议适配与边界验证。
- **FILE-002**: cmd/lake/ops_mcp.go、cmd/lake/cli.go：签名 CLI 的 MCP 入口。
- **FILE-003**: scripts/test_zcode_ops.mjs、docs/zcode-ops-probe.md：可重复执行验证与结论。

## 6. Testing

- **TEST-001**: Go MCP 客户端的工具发现、批准、拒绝、审批等待期间撤权、范围外资源、任意命令注入、不支持审批、湖志关联。
- **TEST-002**: ZCode 实际 MCP 工具链与权限事件；模型使用本机模拟响应，避免把真实运维数据发送给外部模型。
- **TEST-003**: 单次真实 hostname 检查与本机湖志落盘；不能把模拟测试记为真实 SSH 或界面验收。

## 7. Risks & Assumptions

- **RISK-001**: 实测确认安装版 ZCode 未完成服务器 elicitation，完整桌面审批接入仍需二开；原型仅支持初始化式 MCP <= 2025-11-25，未实现更新协议的可恢复输入请求。
- **ASSUMPTION-001**: 已登记测试主机的授权和网络连接继续有效。

## 8. Related Specifications / Further Reading

- [当前迁移方案](architecture-zcode-lake-1.md)
- [ZCode 开源仓库](https://github.com/zai-org/ZCode)
- [Lake 运维执行](../lake/operate/ssh.go)
