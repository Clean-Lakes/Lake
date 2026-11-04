# 文件记忆迁移：遗留依赖与首批清理

2026-11-04，审计基线 develop `fe119f4f930e58ad7d95e7440b9170dd138f6c7a`（PR #163）。对应 [主计划 FM-01](../../plan/feature-agent-file-memory-1.md#3-分批实施)。历史遗留清理优先于新增记忆能力；本文是首批清理记录，不是 FM-01 全部完成或新文件记忆已启用的声明。

## 本批删除

源码检索覆盖仓库全部 Go caller，并检查宿主、HTTP、前端及测试。以下接口没有生产调用；旧队列读取与 ACK 仅有测试 caller，其余五项没有 caller，产品 usage 查询入口也已退出。删除运行实现与失效的 ACK 测试，改由恢复与格式兼容回归覆盖保留数据。

| 删除项 | 原用途 | 删除依据 |
| --- | --- | --- |
| `Engine.StrategyOutbox`、`AckStrategyOutbox` | 旧学习队列读取、确认 | 当前 outbox 使用 Memory 捕获链路；旧 Strategy 队列已停止生产与消费，测试无需保留产品队列 API |
| `PendingStrategySessions`、`PersistedStrategyOutboxes` | 扫描内存会话和 JSON 缓存中的旧学习任务 | 无生产或测试 caller，不再后台扫描、恢复旧学习任务 |
| `StrategyLearningInputBytes` | 旧学习输入估算 | 无 caller，当前上下文预算已有原生实现 |
| `StrategyUsageHistory`、`StrategyUsageRequest` | 按会话查询旧实验 prompt manifest | 无 caller；旧 usage HTTP 入口已 410，历史 artifact 原记录不删除 |

`strategy_learning.go` 缩为 `legacy_strategy_snapshot.go`：只保留历史类型、JSON 字段与 hash 校验。`strategy_usage.go` 整个删除。新增固定历史 JSON/hash 与篡改回归，扩展生产 AST 边界以禁止上述函数重新进入运行层；测试通过内部锁读取历史状态，不再提供可用队列 API。

## 必须保留与退出条件

| 保留项及实际依赖 | 本批处理 / 后续退出条件 |
| --- | --- |
| `State`、`nativeProjection.StrategyOutbox` 与历史快照校验 | 保留原字段和 hash。ADK 投影在 JSON 缓存丢失时仍需恢复；Web `strategySource` 在来源撤回/隐私清理时验证原来源。移除需另交付历史迁出与等价隐私处理，不能直接丢字段 |
| `strategy_online.go` 历史纠错解码与恢复、`native_corrections` | 保留只读审计和退役恢复。原派发身份、用量和结果未知不重置、不重放；不恢复在线纠错控制器 |
| `strategy_jobs.go`、`strategy_optimization_store.go` | 保留单向退役恢复：停旧任务，未决派发转入待核实。不能把 unknown 当未执行或重新派发 |
| `strategy_experiment_store.go`、`strategy_review.go`、`strategy_store.go` 所需方法 | 仍服务来源可用性、撤回与派生正文清理；退出前须有等价来源链清理。文件名含 strategy 不代表没有生产依赖 |
| 旧 SQL/hash、归档导出、设置强制关闭、旧 API 的鉴权与 410 | 保留准确旧格式和安全退出。禁止修改冻结 DDL/hash 来消除兼容报错；旧入口拒绝仍需范围鉴权 |
| `internal/strategy` 中的范围、hash、提示词组合与历史报告结构 | 当前自然记忆、提示词装配及上述兼容仍有生产 import；不能删除整个包。已退役评测实现继续仅在 `internal/testsupport/legacystrategy` 供测试使用 |
| 自然记忆采集、有效 Memory outbox、租约、来源删除与同意 | 当前活跃链路。优先复用，不与 Strategy 旧队列混为一谈；新提取链路接管并对账后，才移除原算法 |
| 当前自然偏好召回、项目记忆读取、文件投影及 UI/API | 当前用户仍在使用。FM-03B 按范围迁移、单写者切换、停止旧注入后移除；新链路尚不可用前不关停 |
| 运维 Memory V2 | `operationalMemoryV2Ready=false`，但 worker、存储兼容、API 与前端仍有条件调用及测试依赖。先隔离生产分支和兼容读者，再分批删无依赖实现；不打开 V2，也不将整组盲删留给末期 |
| 原任务、审批、操作、unknown、验收与压缩 | 属于任务和安全主链；本次记忆替换不退役，不以新记忆结果覆盖原状态 |

## 当前有效链路与后续顺序

1. AI 真实消息/压缩捕获（`natural_memory_capture.go`）→ 当前 Memory outbox → Web `runMemoryWorker` / `processOneMemoryJob` → 自然偏好或项目记忆存储。后台保留 Security、同意、前台优先与重启幂等。
2. 自然偏好经 `natural_memory_recall.go`、项目知识经当前项目记忆工具/ADK memory 适配器读取，继续校验项目和独立使用开关。Worker 未验收范围的知识仍不可用。
3. FM-01 下一批先完成 V2 条件调用隔离与可删除清单，再冻结共享模块、来源 DTO、工作区、单写者、文件发布与删除恢复协议。此次不新建占位 `internal/memory`，不把目录建好算协议已完成。
4. FM-02 每批先检查被替代的算法和辅助代码，交付两阶段后台能力。FM-03 迁移后立即停旧写入/注入并清理旧入口，FM-04 负责最终复核，不再承担全部积压清理。

旧自然记忆和 V2 不是重新开发目标。仍需保留的内容以实际调用和审计义务为准，清理不以文件名或行数为验收标准。

## 验证与回退

重点验证：固定历史 JSON/hash 可读且篡改拒绝；JSON 缓存删除后 ADK 投影仍恢复旧 outbox/manifest/unknown；读取和新任务均不重放旧操作、不生成新纠错/实验清单；退役 API 不复活；来源撤回、当前自然记忆与任务主链不回归。

本批不改数据库格式、真实开关或现有正文，不删除历史审计数据。回退可经 develop PR 恢复删除的代码，无需回滚数据；不要运行旧版去接管正式 Home。执行证据和平台缺口见 [本批验收记录](../validation/agent-file-memory-legacy-cleanup.md)。
