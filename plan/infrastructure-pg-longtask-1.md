---
goal: 使用 Lake 在已登记服务器部署 PostgreSQL 复制测试集群并验收长任务
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [infrastructure, postgres, integration, long-task]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

通过 Lake 已登记脚本、Agent 与 SSH 专员，在测试湖资源 36.151.150.63 建立同机 1 主 2 从流复制集群，运行 300 秒有界负载并验证节点重启恢复。每一步保存进度及证据。

## 1. Requirements & Constraints

- **REQ-001**: 真实远端操作全部经签名 bin/lake；会话 6da54021-4c1a-4ebc-b6c8-14dc2ca1481d 保存预检、任务与验收。
- **REQ-002**: 创建 lake-pglt-20261001-primary、standby1、standby2 容器及专属网络；端口仅绑定 127.0.0.1:25432–25434。
- **CON-001**: 使用 Podman；主库内存 512MiB/CPU 0.5，从库各 384MiB/CPU 0.25，shared_buffers=64MB；不得改动既有业务容器、端口、目录、SELinux 或防火墙策略。
- **SEC-001**: 凭据仅在远端随机生成，权限 0600，通过密码文件传递，不进入模型、日志或仓库；网络认证使用 SCRAM，容器本地管理使用 peer。
- **PAT-001**: 长步骤在专属目录记录状态，Lake 通过短检查观察；脚本哈希固定，恢复不得重复创建或重放未知写操作。
- **GUD-001**: 官方 PostgreSQL 17.11-bookworm amd64 镜像内容 ID 固定为 sha256:248efd5e58cd743f2a0e0daec8ea4649e5580145ec2a12e2345bc710d4a77201，源 manifest sha256:91eb910c44c7ed13f7f1a4ccadaa9ca72ef14cddc04cacb6e070e48eb44731a3；镜像代理须保持相同内容。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 确认资源边界及可执行部署脚本。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Lake SSH 专员只读采集 CPU、内存、磁盘、运行时、现有 PG、端口、目录；证据保存到本机 test-reports/pg-longtask-20261001/pg-preflight-result.json。 | ✅ | 2026-10-01 |
| TASK-002 | 在本机私有报告目录创建 pg_worker.py 与 launch.sh，脚本绑定测试湖/36.151.150.63；检查 Python/Bash 语法、凭据标记、文件长度与哈希。依赖 TASK-001。 | ✅ | 2026-10-01 |
| TASK-007 | 修复 cmd/lake/policy.go 与 script_tools.go 的资源执行绑定；script_tools_test.go 覆盖审批允许/拒绝、冻结范围及授权撤回，保持 SSH 服务的二次校验。签名构建后重开原会话再执行。依赖 TASK-002。 | ✅ | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 完成真实部署、长负载及恢复验收。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Lake Agent 调用 lake_script_run 执行已审核 launcher；远端 /opt/lake-pg-longtask-20261001/worker.py 持有独占锁，创建受限容器、复制角色、物理槽、pg_basebackup 从库，验证状态与数据一致性。依赖 TASK-002、TASK-007。 | ✅ | 2026-10-01 |
| TASK-004 | 只在新建 lake_bench 库运行 pgbench -s10 初始化及 -T300 -c2 -j1 -R50 负载；监控可用内存，低于 768MiB 时仅停止测试容器；记录计数、延迟及失败数。依赖 TASK-003。 | ✅ | 2026-10-01 |
| TASK-005 | 仅重启测试 standby1 及 primary，核对追加记录追平、两个 streaming 副本、健康与持久化，并比较原有业务容器的 ID/启动时间/运行状态。依赖 TASK-004。 | ✅ | 2026-10-01 |
| TASK-008 | 根据真实收尾失败修复 SSH 执行前拒绝与执行结果未知的分类；仅本次网络由 internal 改为 bridge/no_default_route=1/isolate=true，保留全部 PG 数据和已完成检查点，通过 Lake Agent 审批执行。依赖 TASK-005。 | ✅ | 2026-10-01 |
| TASK-006 | 用独立 Lake SSH 检查复核最终状态，保留测试集群及本机私有报告，写出端口、数据位置、耗时与产品问题；完成后关闭本次桥。依赖 TASK-005、TASK-008。 | ✅ | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: Patroni 自动切换需要额外组件，本次默认使用 1 主 2 从功能测试；用户明确选择 Patroni 时再调整实现。

## 4. Dependencies

- **DEP-001**: 已登记模型 deepseek-flash、Lake 凭据保险库与资源授权、Podman 5.8.2、远端 Python 3 和可达的官方镜像源或保持摘要的代理。

## 5. Files

- **FILE-001**: 本机 ~/Library/Application Support/Lake/test-reports/pg-longtask-20261001/ 存放驱动、脚本及事件，目录 0700、文件 0600。
- **FILE-002**: 远端 /opt/lake-pg-longtask-20261001/ 存放专属配置、三份数据、凭据、阶段检查点及结果；数据库凭据不得复制到本机报告。

## 6. Testing

- **TEST-001**: 主库 pg_is_in_recovery=false；两从库为 true，拒绝写入；pg_stat_replication 有两个 streaming 项；同一探针表行数与校验值一致。
- **TEST-002**: pgbench 实际持续 300 秒，完成事务并记录失败率、TPS、延迟及资源水位；不以后台启动作为完成。
- **TEST-003**: 重启测试节点后追平新增记录，持久数据不丢失，原业务容器保持原 ID 和启动时间。
- **TEST-004**: Lake 实际调用、进度、专员任务及最终结果保存于同一会话；若父工具超时或任务提前结束，记录为产品问题并先核对远端状态再恢复。

实测压测持续 300.23 秒，14,903 事务、零失败、49.683585 TPS、平均延迟 2.751ms；最低可用内存 2,760MiB。修复网络后远端部署全程 643.29 秒，独立 Lake 检查 19 项通过：主从角色、探针与压测数据复制、健康、CPU/内存限额、版本、回环端口、只读从库、两个 streaming、专属网络、凭据权限、持续压测、恢复及原有 8 个业务容器状态。

原长轮询遇到一次 SSH transport error，按未知写保护停止；远端受控任务继续完成压测和节点恢复。首次宿主机端口校验失败来自 rootful Podman internal 网络不转发端口，通过专属网络修复后验收成功，未重放压测或业务写入。第二次收尾模型提交含换行的命令，在执行前被拒绝，但旧专员错误地视为未知写；TASK-008 修正这一分类。原轮次与错误证据保留，不把首次运行记为无中断成功。

最终 `pg-final-acceptance` 在原会话完成：同一专员拒绝无效命令后继续 hostname 检查成功，登记验收脚本审批后 19 项通过，Lake Agent 最终回答与原错误事件均持久保存；桥正常退出，耗时 71.06 秒、6 次模型调用。签名产物 `Lake-20261001-104813-88806.app`；完整结果在本机私有目录 `REPORT.md`、`remote-result.json`、`independent-verification.json`、`known-rejection-continuation.json`、`pg-final-acceptance-result.json`。Go 回归与 vet 通过。

## 7. Risks & Assumptions

- **RISK-001**: 无 Swap 且已有业务占用约 4.1GiB；测试容器需限额并持续监控，禁止无界压测。
- **RISK-002**: SSH 单次默认 20 秒、委派工具 5 分钟；长步骤用受控后台工作进程与持久状态，不改全局超时或授权策略。
- **ASSUMPTION-001**: 用户要求部署并测试长任务，已授权本次测试目录、容器与库的创建及故障恢复；同机副本不提供主机级高可用。

## 8. Related Specifications / Further Reading

[迁移闭环](../docs/migration-closure.md)

[PostgreSQL 17 流复制](https://www.postgresql.org/docs/17/warm-standby.html)

[官方镜像摘要](https://raw.githubusercontent.com/docker-library/repo-info/master/repos/postgres/remote/17.11-bookworm.md)

[Podman 容器运行参数](https://docs.podman.io/en/latest/markdown/podman-run.1.html)
