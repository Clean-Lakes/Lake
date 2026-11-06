---
goal: 修复 Pilot 后台任务停止入口并接入 TS MySQL 受控读取
version: 1
date_created: 2026-11-06
last_updated: 2026-11-06
owner: Lake Runtime
status: 'Completed'
tags: [feature, zcode, mysql, superagent]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

在 develop `90aa1274` 上修复 Pilot 回复结束而 Worker 仍活动时缺失停止按钮的问题，并补充当前 TS 候选缺少的 MySQL 只读业务工具。复用已保存 Dev 连接、原任务/操作账本和公开 SDK，不修改上游、不执行旧任务、不放宽完整后端迁移门禁。

## 1. Requirements & Constraints

- **REQ-001**: TS Pilot 聚合的真实 Worker 活动计入输入区停止状态；空草稿显示停止，有草稿仍保留独立停止入口及原草稿。
- **REQ-002**: Pilot 停止只影响当前项目正在执行、排队或等待实际交互的 TS Worker 和待派发输入；保留历史停泊任务、其他项目、操作及 unknown 状态，阻止迟到 Router 决策重派。
- **REQ-003**: MySQL 提供 list_db_objects、db_table_ddl 和 read_db_table 固定读取（有界行、行数统计、偏移与排序），不提供任意 SQL、写入、SSH Shell 或 Kubernetes 入口猜测。
- **SEC-001**: 资源必须属于当前项目；每次派发及验收重验连接/凭据内容摘要、资源版本、当前 Pilot 权限与原项目策略；凭据仅解析当前 Dev Home 私有引用并加入脱敏。
- **SEC-002**: 每次使用单独连接、只读事务、五秒期限、有界网络/结果字节，最后回滚并关闭。元数据可证明只读；表数据读取不借此绕过原 unknown 对账。
- **CON-001**: 旧 Go 数据库只读增量导入准确 MySQL 连接引用，保留身份/目录，不覆盖已有 TS 配置；未支持驱动与缺失连接继续明确不可用。
- **CON-002**: 签名安装及验证仅 Lake Dev；不自动继续用户此前的数据比较，不操作正式 Home，不合并 PR。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 停止入口和宿主取消形成一致闭环。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 新增 App.tsx 独立停止状态并修改 stopCurrentTurn（不改变续输入队列条件）；新增 superagent.ts stopWorkspace，server.ts 的项目 stop 路由及 api.ts 入口，取消当前项目活动集合并拦截迟到决策。 | ✅ | 2026-11-06 |
| TASK-002 | 复用 super-pilot-activity/connection 回归并扩展 superagent-lifecycle/server 测试，验证回复结束后停止、排队取消、其他项目/历史保留、真实活动不由旧状态推断。依赖 TASK-001。 | ✅ | 2026-11-06 |

### Implementation Phase 2

- **GOAL-002**: 当前连接可通过真实 MySQL 协议执行受控读取。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 固定 mysql2 依赖及 bundle/license 接点，新增 runtime/zcode/mysql.ts 的私有配置解析、摘要、固定查询构建、事务和取消/结果预算；新增 Security database 范围检查。 | ✅ | 2026-11-06 |
| TASK-004 | 新增 migration.ts 增量连接导入，接通 server 创建/编辑与启动；superagent 注册工具和原 Operation 绑定，assets/router-context 展示实际能力，Memory 复用新的连接摘要。依赖 TASK-003。 | ✅ | 2026-11-06 |
| TASK-005 | 新增 mysql.test.cjs 的合成 MySQL 协议、只读/回滚、参数/路径/凭据/权限/跨项目/取消/超限/连接变化测试，扩展真实 SDK Worker 集成及迁移回归。依赖 TASK-004。 | ✅ | 2026-11-06 |

### Implementation Phase 3

- **GOAL-003**: 在签名 Dev 中交付可验证结果。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | 运行 TS、前端、后端、MySQL、任务与边界检查；签名安装 Dev，使用合成活动任务验证输入区停止；只读核对已保存 MySQL 连接状态，记录准确 SHA 与未验证的 K2 入口。依赖 TASK-002、TASK-005。 | ✅ | 2026-11-06 |
| TASK-007 | 更新 README、验证记录及本计划，创建 develop PR，记录本地验证和回退方式。依赖 TASK-006。 | ✅ | 2026-11-06 |

## 3. Alternatives

- **ALT-001**: 只显示按钮并终止 Router。无法停止独立 Worker，不采用。
- **ALT-002**: 通过自由 Shell/mysql CLI 或放行任意 SQL 补能力。缺少固定依赖和可核验读取范围，不采用。

## 4. Dependencies

- **DEP-001**: 原 LakeStore、LakeSecurity、TaskLedger、ZCode ToolEntry/取消协议和 Dev 连接引用。
- **DEP-002**: 固定 mysql2 3.24.6（MIT），公共 createConnection/query/stream API，锁文件和许可一并保留。

## 5. Files

- **FILE-001**: runtime/zcode/mysql.ts、mysql.test.cjs、security.ts、migration.ts、server.ts、superagent.ts、tasks.ts、assets.ts、router-context.ts、agent.ts。
- **FILE-002**: web-agent/package.json/pnpm-lock.yaml、runtime/zcode/build.mjs/tsconfig.json、App.tsx/api.ts/superPilotActivity.ts 及相关测试。
- **FILE-003**: runtime/zcode/README.md、docs/validation/zcode-typescript-candidate/pilot-stop-mysql-read.md、本计划。

## 6. Testing

- **TEST-001**: 原生模型回复结束后仍有真实 Worker 活动时显示停止，停止不会取消其他项目或历史目标，不清除 unknown，迟到路由不能继续派发。
- **TEST-002**: 合成 MySQL 服务观察真实驱动的事务/参数/回滚；超时/取消/超限无越界发布，凭据不进入模型或操作输出。
- **TEST-003**: 跨项目、原策略/schema 范围、连接与凭据变化、原权限及验收来源都重新核验；开启能力不重放旧任务。
- **TEST-004**: Lake Dev 明暗/窄窗空草稿及有草稿停止入口、焦点和静态历史；记录真实供应商/远端/K2/Windows 未验证项。

## 7. Risks & Assumptions

- **RISK-001**: 两个资源的数据可能不在同一事务快照；分页或统计不能被冒称完整一致性证明。
- **RISK-002**: MySQL 连接配置存在不代表当前服务可达，K2 集群不会从名称推断成可连接 MySQL。
- **ASSUMPTION-001**: 当前请求授权两处修复、受控 MySQL 读取接入和 Dev 验证；不授权自动继续历史比较、修改远端数据或正式发布。

## 8. Related Specifications / Further Reading

- [架构约定](../agent.md)
- [Security 范围与适配器](../docs/design/lake-security-v1.md)
- [TS 候选边界](../runtime/zcode/README.md)
- [MySQL2 公共 API](https://sidorares.github.io/node-mysql2/docs/examples/connections/create-connection)
- [贡献流程](../CONTRIBUTING.md)
