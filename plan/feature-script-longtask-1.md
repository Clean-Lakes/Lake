---
goal: 修复 Lake SSH 长任务执行、跟踪和断线恢复
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [feature, script, long-task, recovery]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

已登记脚本使用持久后台任务执行，主会话通过有界只读等待跟进至最终结果，避免模型反复生成 SSH 轮询命令。以同一服务器的 PG 集群执行超过五分钟的真实回归。

## 1. Requirements & Constraints

- **REQ-001**: 增加 lake_script_start/status/wait/cancel/jobs 工具与 CLI，记录任务 ID、脚本摘要、资源及 SSH 目标摘要；重启后能查询，启动结果未知时仅查询，禁止重复启动。
- **SEC-001**: 启动及取消保持资源冻结、实时授权、脚本归属/哈希、统一审批和 SSH 二次审批；查询使用固定控制程序与只读权限，用户不能传任意路径或命令。
- **CON-001**: Agent 保持 Go/Eino；不调整现有 SSH 20 秒及委派 5 分钟全局时限；wait 单次最多 60 秒。远端 Linux Python 3 是执行依赖。
- **PAT-001**: 任务独立进程、远端私有目录、状态原子替换、输出限额和到期/取消终止进程组；本机元数据 0600，不存脚本正文或凭据。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 原生任务执行、持久身份、短连接监视及明确终态。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | lake/store/script_job.go 实现原子创建和受保护加载/list；lake/operate/script_job.go 与 script_job_controller.py 实现后台启动、状态、取消、60 秒等待，明确未知状态。 | ✅ | 2026-10-01 |
| TASK-002 | cmd/lake/script_job_tools.go、script_job_cli.go 注册工具与 CLI，chat.go 加入长任务路由和进度，tool_registry.go/checkpoint.go 标记 status/wait/jobs 为只读。依赖 TASK-001。 | ✅ | 2026-10-01 |
| TASK-003 | lake/transport/ssh/client.go 区分未派发与未知执行，安全连接重试仅限未执行阶段；专员错误保留原因，父轮次失败不覆盖已返回专员的完成状态。依赖 TASK-001。 | ✅ | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 证明可控终止、断线继续及超过五分钟的实际主会话闭环。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-004 | store/operate/transport/CLI/专员测试覆盖重复启动、超时、取消、输出限额、进程退出后查询、丢失/损坏启动响应只查询、资源撤权与目标变更，断线重试不重复写。CLI 在真实资源关闭会话桥后重新查询验证。父轮次模型失败仍保留已返回专员完成状态的集成回归通过。 | ✅ | 2026-10-01 |
| TASK-005 | 签名构建成功；任务 3d1ad9071064e32b172e9cc40bfb527b 同一 Lake 轮次 435.96 秒、远端任务 383.67 秒，pgbench 内部 360 秒、17,981 事务、零失败；一次只读查询故障继续恢复、start 审计只有一次。原 8 个业务容器及两从库一致。 | ✅ | 2026-10-01 |
| TASK-006 | docs/migration-closure.md 与私有 REPORT.md/acceptance-summary.json 保存证据、能力边界及产物；桥 exit 0，重新进程查询 succeeded/exit 0，PG 集群保留。 | ✅ | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 只延长 SSH 或专员超时不能解决响应丢失和进程重启后的确认，保持短连接并以持久任务跟踪。

## 4. Dependencies

- **DEP-001**: 已登记资源与模型、Python 3、Podman 和此前保留的 lake-pglt-20261001 集群；本次只在测试库运行限速负载，不重启业务容器。

## 5. Files

- **FILE-001**: 本机 ~/.lake/script-jobs/ 保存不可变任务身份；远端 ~/.lake-script-jobs/ 保存执行脚本、配置、状态与有界输出。
- **FILE-002**: 本机 Application Support/Lake/test-reports/pg-longtask-retest-20261001/ 保存实际桥事件及验收结果。

## 6. Testing

- **TEST-001**: 模拟传输错误与本机控制程序集成测试，明确证明已运行脚本不会因响应丢失重复执行。
- **TEST-002**: 360 秒真实负载在一轮 Lake Agent 内启动、等待、成功返回；至少六分钟无新用户续跑请求，状态与 DB 复制独立核对。

实测一次 ask、一次具体脚本审批、一次最终 result，无续跑 ask。最低可用内存 2,744MiB；三节点 history 均为 `17981|869979`，2 个 streaming 连接；原业务容器 ID/StartedAt/Running 比对一致。`go test ./cmd/lake ./lake/...`、`go vet ./cmd/lake ./lake/...`、签名验证通过。压测正常路径使用 `Lake-20261001-110501-90644.app` 对应 CLI；后续补充“损坏启动响应仍为 unknown”的防护测试及最终签名产物 `Lake-20261001-110915-91908.app`，关闭桥后查询使用最终 CLI。

## 7. Risks & Assumptions

- **RISK-001**: 远端断电或工作进程消失可能留下未知状态；只报告事实，不自动重放任务。
- **ASSUMPTION-001**: 用户已授权修复长任务及复测，可在原测试库运行有界负载并创建独立任务目录；凭据内容仍禁止读取。

## 8. Related Specifications / Further Reading

[之前的 PG 实测](infrastructure-pg-longtask-1.md)

[迁移闭环](../docs/migration-closure.md)
