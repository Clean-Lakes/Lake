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
| 运维 Memory V2 | 第一批时 worker、存储、API 与前端都有条件调用；第二批已移除自动提取/候选生成/模型派发实现，门控继续关闭。第三批继续移除手动管理/UI/客户端；剩余历史存储、迁移及范围读取/遗忘条件分支仍需隔离后退役，不据此宣称 V2 全部删除 |
| 原任务、审批、操作、unknown、验收与压缩 | 属于任务和安全主链；本次记忆替换不退役，不以新记忆结果覆盖原状态 |

## 当前有效链路与后续顺序

1. AI 真实消息/压缩捕获（`natural_memory_capture.go`）→ 当前 Memory outbox → Web `runMemoryWorker` / `processOneMemoryJob` → 自然偏好或项目记忆存储。后台保留 Security、同意、前台优先与重启幂等。
2. 自然偏好经 `natural_memory_recall.go`、项目知识经当前项目记忆工具/ADK memory 适配器读取，继续校验项目和独立使用开关。Worker 未验收范围的知识仍不可用。
3. FM-01 第二批已删除 V2 自动提取（#167），第三批移除手动管理/UI，再收敛历史存储和读取/遗忘兼容边界，冻结共享模块、来源 DTO、工作区、单写者、文件发布与删除恢复协议。此次不新建占位 `internal/memory`，不把目录建好算协议已完成。
4. FM-02 每批先检查被替代的算法和辅助代码，交付两阶段后台能力。FM-03 迁移后立即停旧写入/注入并清理旧入口，FM-04 负责最终复核，不再承担全部积压清理。

旧自然记忆和 V2 不是重新开发目标。仍需保留的内容以实际调用和审计义务为准，清理不以文件名或行数为验收标准。

## 第二批：V2 自动提取退役

基于 PR #164 合入后的 develop `f59d377c6c71e2e61306ae1c218002a70c547ca9`。

- 删除 `project_memory_v2_extraction.go` 与 `project_memory_v2_worker.go` 中的提取提示词/解析、来源分类与 typed claim 提升、候选写入、请求预留/结算及自动 worker。继续删除失去 caller 的资源快照校验、资源变动取消入口、自动提交分支和 `MemoryMutation.Claim`。
- 自然记忆仍需要的 `PauseMemoryExtractionForForeground` 原样移到 `project_memory_scheduling.go`；当前自然批处理、关闭/撤回、前台优先与 V1 项目记忆保持原链路。
- 新收到的 schemaVersion=2 outbox 仅记录 `blocked / memory_v2_retired` 回执。恢复与领取任务前将旧 queued/retry/budget/running 队列停止调度，清除旧租约，但保留来源 JSON/hash、尝试次数和已记用量。自然来源已撤回时沿原语义只留 hash，正文不落盘，coverage 保持 withdrawn。当前 V1 提交器拒绝迟到的 V2 输出，V2 Store 不再领取自动任务；旧手动重试不能重新激活 V2 来源（版本拒绝为 410），不重置次数、用量或来源 hash。
- 停止把 V2 未完派发在重启时重置为 interrupted、减少尝试次数后重排队；保留原 `projectMemoryJobAttemptsV2` 全部历史行，停止自动裁剪。`blocked` 是调度退役状态，不能解释为原派发未执行、结果已核实或应退款。
- 九项依赖已移除自动执行能力的正向测试退役，换成不派发、跨重启不复活、未知派发不改写、V1 队列不被阻塞和 AST 边界回归；历史候选的过期时间测试改为直接构造旧记录，继续验证审核不能刷新观察时间。
- 保留原 schema/迁移 marker、拒绝不兼容 Home、历史读取/删除与 Security 恢复；手动 V2 API/UI 和候选旧数据管理仍是下一批清理项，本批不把旧数据迁入新文件记忆。

执行结果见 [V2 自动提取退役验收](../validation/agent-file-memory-v2-retirement.md)。FM-01 新工作区、来源 DTO 和发布/删除恢复协议仍未冻结。

## 第三批：V2 手动入口与界面退出

基线为 PR #167 合入后的 develop `caab241e89bc93f38e6395b69f3e85a285637296`。本批 UI 完整矩阵仍有缺口，不能作为已完成全部原生验收的声明。

- 删除 V2 页面、编辑/分类/候选审核组件、状态/草稿算法、专用 CSS、客户端方法和候选类型。当前访问记录仍用到的日期格式化独立为 `memoryTime.ts`，当前 N5 的“准备/索引/读取/遵从未知”语义继续保留。
- 删除 V2 专用来源 HTTP 跳转、无 caller 的 `RecordedMemoryEvidenceAvailable` 以及 App/对话页的旧来源自动分页回调；现有对话目录和手动历史分页保留。
- 删除 `project_memory_v2_routes.go` 的分类、候选采用/拒绝、来源解析与 V2 编辑处理器；删除工具分类参数解析/范围补全和已无 caller 的允许无绑定验证分支。旧分类/候选/来源 URL 的所有方法在认证、有效项目检查后 410，正文不解析、不修改历史记录。
- V2 的 HTTP 正向写入及模型 `save_project_memory` 拒绝；GET 历史读取和 DELETE 遗忘继续走既有范围与安全边界。当前 V1 UI/API/工具保留，旧 V2 blocked 任务在 V1 列表只显示停用说明，不再提供重试按钮。
- 前端只有当前项目的 V1 响应（含旧 V1 缺省版本字段兼容）可挂载编辑器；V2 显示停用说明，未知格式/加载/错误都不降级挂载旧编辑器。停用态只有关闭入口，保留焦点、Tab 和 Escape 行为。
- 三项旧 Go 管理正向验收、四项旧前端编辑/草稿验收随入口退出；新增拒绝/鉴权/项目隔离、历史不改写、遗忘清正文与派生内容、格式隔离回归，并扩展 AST 退役边界。

仍保留 `MemoryDetails`、V2 历史正文/来源/版本、资源绑定与范围读取、投影、迁移标记/拒绝旧格式、Store 内历史格式写入辅助及 Security 恢复遗忘。当前通用 `CommitProjectMemory -> CommitMemoryV2` 和历史 fixture 仍依赖 Store 辅助，不能因管理页删除就直接删表或丢 tombstone。下一批先将这些兼容职责与测试造数解耦，明确迁出/删除边界；FM-01 新文件协议仍未冻结。

验证结果见 [V2 入口与界面退役验收](../validation/agent-file-memory-v2-entry-retirement.md)。

## 验证与回退

重点验证：固定历史 JSON/hash 可读且篡改拒绝；JSON 缓存删除后 ADK 投影仍恢复旧 outbox/manifest/unknown；读取和新任务均不重放旧操作、不生成新纠错/实验清单；退役 API 不复活；来源撤回、当前自然记忆与任务主链不回归。

本批不改数据库格式、真实开关或现有正文，不删除历史审计数据。回退可经 develop PR 恢复删除的代码，无需回滚数据；不要运行旧版去接管正式 Home。执行证据和平台缺口见 [本批验收记录](../validation/agent-file-memory-legacy-cleanup.md)。
