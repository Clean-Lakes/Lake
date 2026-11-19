---
goal: Lake 本机接收 Grafana 内置 Alertmanager 的 Webhook 通知
version: 1
date_created: 2026-11-18
last_updated: 2026-11-18
owner: Lake
status: 'Completed'
tags: [feature, grafana, alerting, ingress]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

在项目下新建「Grafana」资源，在资源详情生成 Webhook 凭据并查看收到的批次和逐条告警。首期范围截至收件和查看记录。运行环境为本机 Lake，网络部署地址后续确定。

## 1. Requirements & Constraints

- **REQ-001**: 一个来源固定绑定资源及其所属项目。提供启停、凭据轮换、最近投递查询和投递详情。改名、移动及回收站恢复保留来源身份和投递记录。
- **REQ-002**: 接受 `POST /api/ingress/v1/grafana/:sourceId` 的 Grafana 默认 Webhook JSON v1。验证批次及各告警的 `firing` 或 `resolved` 状态。保留 `alerts[]`、发送时的分组、截断数、上游时间和其他 JSON 字段。
- **REQ-003**: 每次有效投递单独登记。SQLite 提交后才返回 HTTP 200 和投递 ID。接收列表按本机收件顺序分页。业务关联、合并、触发及派单留给后续阶段。
- **SEC-001**: 每个来源生成独立 Bearer 凭据，数据库只保存校验摘要。凭据只在新建或轮换响应返回。收件前和入库前核对来源启停、凭据、配置版本、项目存在及 Lake 安全状态。管理和查询继续使用工作台认证。
- **SEC-002**: 接收限制为 1 MiB、10 秒、JSON 最大 16 层。脱敏后保存结构化通知，详情以普通文本显示。项目与来源身份取自本机记录。接收过程不构造用户消息、模型输入、权限或任务。
- **CON-001**: 沿用 Lake 的回环监听。Grafana 所在网络到 Lake 的部署配置由使用场景另定。
- **GUD-001**: 从项目的资源列表进入，复用 AppSelect、Glyph、主题圆角和投递详情控件。早期独立来源仍在接入渠道管理。
- **PAT-001**: 使用当前 TypeScript LakeStore 持久化投递。工作台的事件列表读取同一份记录。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成来源配置、认证、持久接收及查询。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 `web-agent/shared/contracts.ts` 定义事件来源、凭据和投递列表/详情 DTO。在 `runtime/typescript/event-receiver.ts` 实现来源配置、凭据校验和 Grafana 通知存储。 | true | 2026-11-18 |
| TASK-002 | 在 `runtime/typescript/server.ts` 注册限定路径的 Webhook 和工作台管理/查询路由，绕过消息、模型及任务处理。依赖 TASK-001。 | true | 2026-11-18 |

### Implementation Phase 2

- **GOAL-002**: 在接入渠道完成来源配置和实际收件查看。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 调整 `GatewaySettings.tsx` 的来源选择及添加流程。用 `GrafanaEventSource.tsx` 显示本机 URL、凭据控件、投递摘要及详情。在 `api.ts` 接入 API 并更新清单。依赖 TASK-002。 | true | 2026-11-18 |
| TASK-004 | 增加端到端 HTTP 回归，在隔离环境用 Grafana 11.1.4 的测试通知验证接收。检查 Dev 界面，并记录接入步骤和实际验证。依赖 TASK-003。 | true | 2026-11-18 |
| TASK-005 | 按用户反馈，将新增 Grafana 入口和 Webhook 管理放进 Items 资源详情。验证回收站、原有独立来源兼容性和已安装 Lake Dev。 | true | 2026-11-18 |

## 3. Alternatives

- **ALT-001**: Grafana 的 Alertmanager 集成用于向另一套 Alertmanager 发告警。Lake 使用 Webhook 接收当前内置 Alertmanager 的通知。
- **ALT-002**: 常驻中继对应桌面离线期间的收件需求，部署地址确定后再单独设计。

## 4. Dependencies

- **DEP-001**: Lake TypeScript 后端、私有 SQLite 和工作台设置。
- **DEP-002**: Grafana 内置 Alertmanager 及其 Webhook 通知渠道。

## 5. Files

- **FILE-001**: `runtime/typescript/{event-receiver,server}.ts`、`runtime/typescript/event-receiver.test.cjs`。
- **FILE-002**: `web-agent/shared/contracts.ts`、`web-agent/web/src/{api.ts,ModelSettings.tsx,GatewaySettings.tsx,GrafanaEventSource.tsx,gatewaySettings.css}`、`runtime/typescript/api-inventory.json`。
- **FILE-003**: `agent.md`、`docs/grafana-event-receiver.md` 和本计划。

## 6. Testing

- **TEST-001**: 用真实 HTTP 接收批次、恢复和重复投递。检查准确来源/项目、分页、重启后记录、凭据隔离、停用/轮换、请求拒绝，以及接入不创建 `superInputs` 或任务。
- **TEST-002**: 用隔离 Grafana 11.1.4 的 Contact point Test 检查实际请求格式、Bearer 认证、确认响应和入库记录。
- **TEST-003**: 执行前后端类型检查、相关现有回归、API 清单和签名 Dev 联调。界面核对主题、窄窗、凭据配置和记录详情。

2026-11-18 验证记录

| 范围 | 结果 |
| --- | --- |
| 最终代码 | `5cb4737fdfaf6e114f390b0e67526ec9a446885d`，基于 `ae5de678`。macOS arm64 使用 `scripts/build_lake.sh --typescript` 构建，签名校验和前后端类型检查通过。 |
| 后端 | 收件、MCP 接入和后端服务回归 234 项通过。最终签名版本重新运行 3 项收件 HTTP 集成测试。覆盖混合批次、恢复、重复投递、凭据范围、停用时的在途请求、写入失败及重启。 |
| 前端 | 前端回归 949 项通过。最终版本复查新增来源、凭据轮换、展开投递及保存后的记录。浅色、390px 深色窄窗和键盘焦点通过。 |
| 实际发送 | 隔离 Grafana 11.1.4 的 Contact point Test 返回成功。短时回环转发承接容器到 IPv6 回环的连接。两次测试原始告警均在 Lake 显示，跨重启仍可查询，任务记录数为 0。 |
| 检查与范围 | API 清单及 ADK 边界检查通过。日常 Lake Dev 正在运行，本轮在独立临时 Home 验证签名后端及工作台 Web 页面。已安装的原生客户端与真实 Grafana 网络地址留待对应环境联调。 |

## 7. Risks & Assumptions

- **RISK-001**: 桌面 Lake 只监听回环地址，远端 Grafana 需要能够访问的转发入口。Lake 退出或休眠时无法接收该地址上的请求。
- **RISK-002**: Grafana 可能按通知策略重发相同告警。每次收件独立保存，原始通知状态及存在的截断数作为来源观测展示。
- **ASSUMPTION-001**: Grafana 使用默认 JSON 通知体，凭据配置在 Webhook 的 Authorization 请求头。

## 8. Related Specifications / Further Reading

- [Grafana 11.1 Webhook 通知](https://archive.grafana.com/docs/grafana/v11.1/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/)
- [接入渠道](refactor-superagent-incoming-channels-1.md)
- [Lake 架构约定](../agent.md)
