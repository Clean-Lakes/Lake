---
goal: 在 Lake Dev 将 Grafana 资源接通授权范围内的只读查询
version: 1
date_created: 2026-11-18
last_updated: 2026-11-18
owner: Lake
status: 'Completed'
tags: [feature, grafana, resources, observability]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

Grafana 资源保存实例地址与服务账号令牌。Lake 可按需读取仪表盘、数据源、正在触发的告警和受支持的数据源查询。Webhook 收件历史继续绑定原资源 ID。

## 1. Requirements & Constraints

- **REQ-001**: 新建和编辑提供 Grafana 基础地址、服务账号令牌和测试连接。保留只配置 Webhook 的已有 Grafana 资源。
- **REQ-002**: 资源详情读取仪表盘及详情、数据源、Grafana 告警，并提供 PromQL 和 LogQL 查询。
- **REQ-003**: Pilot 和专员通过同一只读适配器使用明确的项目资源和当前连接配置。
- **SEC-001**: 令牌沿现有 Items 私有凭据存储。切换地址须重新填写令牌。访问使用绑定地址上的固定 GET 路由，拒绝重定向，限制请求时间和返回大小。
- **SEC-002**: 派发前、远端请求之间及交付结果前核对资源、项目、配置版本和当前权限。Agent 查询沿原 Task 操作账本。
- **CON-001**: Prometheus 数据源提供指标查询，Loki 数据源提供日志查询。每次查询必须限定时间范围，最大 24 小时。
- **GUD-001**: 连接表单复用 ServiceResourceFields 和 AppSelect。设置与浏览用资源详情的主题和原有弹窗。
- **PAT-001**: 复用 LakeServiceResources 的私有凭据、版本和资源生命周期。

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: 实现可配置、可测试且无真实服务写操作的 Grafana API 适配器。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | 在 `runtime/typescript/grafana.ts` 实现固定路径查询和只读投影，并以 `LakeServiceResources` 绑定凭据和配置版本。 | ✅ | 2026-11-18 |
| TASK-002 | 在 `runtime/typescript/server.ts` 和前端资源表单接通测试、保存和资源详情查询。依赖 TASK-001。 | ✅ | 2026-11-18 |
| TASK-003 | 在 `runtime/typescript/superagent.ts` 注册同项目只读查询并接入任务授权和账本。依赖 TASK-001。 | ✅ | 2026-11-18 |

### Implementation Phase 2

- GOAL-002: 用隔离 Grafana 和签名 Lake Dev 验证后安装。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-004 | 在 `runtime/typescript/grafana.test.cjs` 验证合法查询、权限拒绝、凭据边界和原 Webhook 兼容。依赖 TASK-001 和 TASK-002。 | ✅ | 2026-11-18 |
| TASK-005 | 构建签名 Dev，验证真实 11.1.4 容器与 Dev 窗口，并按安装来源检查替换日常 Dev。依赖 TASK-003 和 TASK-004。 | ✅ | 2026-11-18 |

## 3. Alternatives

- **ALT-001**: 通用数据源代理可接受任意路径。本适配限定到可确定为只读的 Grafana、Prometheus 和 Loki 路径。

## 4. Dependencies

- **DEP-001**: 已有 Lake TS 服务资源、原生 SDK 工具权限和 Task 账本。
- **DEP-002**: Grafana 11.1.4 服务账号 API 与数据源代理。

## 5. Files

- **FILE-001**: `runtime/typescript/{grafana,service-resources,server,superagent}.ts` 提供连接、查询和授权。
- **FILE-002**: `web-agent/web/src/{App,ServiceResourceFields,GrafanaResourceRead}.tsx` 提供配置和读取界面。

## 6. Testing

- **TEST-001**: 使用本地 HTTP 固定数据查询资源列表、详情、告警、PromQL 和 LogQL。验证现有来源收件、令牌不回显、跨资源调用拒绝与重定向停止。
- **TEST-002**: 以 Grafana 11.1.4 Viewer 服务账号联调，再运行现有前后端回归和 Dev 安装保护。


2026-11-18 Lake Dev 验证

- 安装提交 `506c73ec8998a326912bdf09b6e2a76f1ca8ec50`。执行 `scripts/build_lake_desktop.sh --dev --install` 后重新打开原生应用。签名与 ZIP、DMG 校验均通过。
- 用隔离 Grafana 11.1.4 的 Viewer 服务账号验证 8 种读取操作。指标和日志由测试数据源提供，由 Grafana 代理返回。使用合成模型验证 Pilot 从项目资源目录取得配置标识并成功调用 `query_grafana`，任务账本保存一条只读记录。
- 原生表单显示地址、服务账号令牌、测试连接。独立工作台验证仪表盘浏览、键盘打开详情和 390px 深色布局的输入边界。
- 安装后核对同一 Dev Home 中的 21 个项目、192 个资源、307 个会话、任务和凭据关联，以及 1 个既有 MCP 连接。
- 前端 951 项通过。TypeScript 后端 383 项通过，4 项按条件跳过。HTTP 后端 336 项通过，9 项按条件跳过。Grafana HTTP 和收件专项 7 项通过。Dev 保护 19 项通过。

## 7. Risks & Assumptions

- **RISK-001**: Grafana 的组织、文件夹、告警和数据源权限决定实际可见范围，前端显示具体读接口的权限结果。
- **ASSUMPTION-001**: 日志或指标历史由所选数据源管理，Lake 在限定时间内按需查询。

## 8. Related Specifications / Further Reading

[接收 Grafana 告警](../docs/grafana-event-receiver.md)

[Grafana 数据源 HTTP API](https://archive.grafana.com/docs/grafana/v11.1/developers/http_api/data_source/)
