---
goal: 对接 Lake Items 资产中心、Lake Security 与 bearqy 的 Lake Memory，保留现有来源和权限边界
version: 1
date_created: 2026-11-01
last_updated: 2026-11-01
owner: Lake；Memory 对接负责人 bearqy
status: Planned
tags: [architecture, integration, items, security, memory]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

本计划是[三模块对接说明](../docs/design/items-security-memory-integration.md)的待实施任务清单。基线 `origin/develop@23363614c2ba8792077533878d73c98dee66ae5f`，与 `v0.3.24` 文件树相同。bearqy 的 N1–N5、C3/C4 和旧资产退出已合入；运维 V2 仍关闭。全部任务尚未执行，本轮只交付协作设计与文档，不授权合并、启用、模型调用或操作正式版。

## 1. Requirements & Constraints

- **REQ-001**: Items 拥有资产身份、入口和版本；Memory 拥有知识、来源与记忆版本；Security 拥有安全判定；任务运行层拥有目标/执行尝试/验收。统一约定见对接说明第 5 节。
- **REQ-002**: 复用 `MemoryTurnSnapshot`、`MemoryResourceBinding`、自然偏好和现有 outbox/worker；新关联字段兼容旧快照，缺少 goalID 的普通对话继续按现有偏好规则处理。
- **REQ-003**: 资产与访问入口分开；assetID 在 Items 稳定映射交付前可缺省，resourceID 不按名称/IP 自动合并；V2 generation 不替代通用 connectionRevision。
- **REQ-004**: 记忆索引、准确正文、采集、模型派发、提交、缓存和导出使用一致的宿主范围与资格检查，保留用户/项目使用及积累独立设置。
- **REQ-005**: 资产变更事件持久化、至少一次投递和幂等消费；最终读取/派发检查权威版本，事件漏送或迟到不能形成授权窗口。
- **REQ-006**: unknown、失败、孤儿和未验收结果保留真实状态；Memory 不签发权限、不改目标状态、不将一个目标的成功用于另一个目标结清。
- **SEC-001**: 模型参数不构造可信上下文、资产身份、资格或结构化证据；密钥和原始连接凭据不进入对接 DTO、记忆、日志、测试样本或模型输入。
- **SEC-002**: gate/身份错误拒绝受保护操作；可选记忆不可用仅可按现有规则省略记忆，不得变为资源操作的默认 allow。
- **SEC-003**: 关闭积累、来源撤回、资源变化、前台抢占及 epoch 变化后禁止迟到提交；遗忘保留无正文墓碑及原操作账本。
- **CON-001**: 只用既有官方 ADK、Go、业务 SQLite 和可重建 Markdown；不新增服务、模型/工具循环或并行学习器，不翻转 V2 门控，不恢复已退役策略资产 API。
- **CON-002**: 本计划不改 UI。任何需要 UI、专员/workflow 记忆启用或 V2 放量的变更单独设计、验收和授权。
- **CON-003**: 开发从最新 origin/develop 建短期分支，PR 指向 develop；遵守 CONTRIBUTING 与开发流程。只在签名 Lake Dev 或隔离 Home 联调，不读取/修改正式数据或复制正式凭据。
- **PAT-001**: 接桥 → 资产版本联动 → 任务/验收关联 → 平台验收，按依赖推进；待实现能力不使用宽松桩冒充已生效控制。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 冻结宿主契约并接入现有记忆路径，保留 N1–N5 兼容行为。退出条件：普通/Plan/Pilot 表达偏好仍可用，跨范围和来源撤回被拒绝，V2 保持关闭。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | 【共同确认】在 `internal/coordination/context.go`（拟新增、纯 DTO）定义 `ModuleContext/ResourceRef/MemoryPurpose/SourceRef`，字段按对接说明第 5 节；禁止导入 web/ai 建立循环，标记宿主专用字段。新增 `context_test.go`，验证资源集合规范化和可选任务字段；记录接口版本 1。无前置依赖。 | 否 | 未执行 |
| TASK-002 | 【Items/宿主】在 `internal/web/items_snapshot.go`（拟新增）实现 `ResolveItemsSnapshot`，复用 `Store.Resource/AssertResource` 与现有可见性检查；从会话解析项目，拒绝重复、跨项目及不可见入口，只返回去敏字段；assetID 未交付时为空。依赖 TASK-001。 | 否 | 未执行 |
| TASK-003 | 【Security/宿主】在 `internal/web/memory_security_adapter.go`（拟新增）实现 `AuthorizeMemoryAccess`，先接现有 SecurityHome gate、当前范围、来源及独立同意；分别判定 preference_use、knowledge_read、capture、consolidate、manage、export；返回对接说明原因码。完整 TaskGrant 未交付时保持原控制，不创建无条件 allow 或声称新内核已启用。依赖 TASK-001、TASK-002。 | 否 | 未执行 |
| TASK-004 | 【bearqy/Memory】在 `natural_recall.go:naturalRecallProvider`、`project_memory_retrieval.go:ResolveMemoryReadScope`、`project_memory_bridge.go:projectMemoryBridge`、`project_memory_v2_bridge.go` 与 `internal/ai/natural_memory_recall.go` 接统一上下文及资格；在索引、准确 revision 正文和 provider/工具续接前重验，保留原 N5 失效停止语义及角色范围。依赖 TASK-003。 | 否 | 未执行 |

### Implementation Phase 2

- **GOAL-002**: 提供与 V2 开关无关的资产入口版本，完成变更和后台提交联动。退出条件：事件未消费时仍能拒绝旧版本；改名不串资产，连接变化后缓存和迟到提交失效。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-005 | 【Items/宿主】在 `internal/web/items_revision.go` 与 `items_revision_schema.sql`（拟新增）定义通用 connectionRevision、changing/ready 状态及持久 outbox；在 `store.go:CreateResource`、`resource_edit.go:EditTerminalResource`、`resource_import.go`、`navigation_trash.go` 的实际入口完成新建、编辑、导入同步、归档恢复与依赖入口变化接入；修改前先用 rg 对照所有真实写入口补完整覆盖清单。assetID 映射不得按 IP/名称自动归并。依赖 TASK-002；Security 跨库派发 barrier 按原设计接入后才允许宣告原子派发保护。 | 否 | 未执行 |
| TASK-006 | 【bearqy/Memory】在 `internal/web/memory_asset_events.go`（拟新增）实现 `ApplyAssetChange`，按 eventID/aggregateID/revision 幂等失效索引、准确正文缓存和受影响资源绑定；沿用 `project_memory_scope.go` 的现有 V2 语义，增加与通用入口版本的显式映射，不改 generation 含义。依赖 TASK-004、TASK-005。 | 否 | 未执行 |
| TASK-007 | 【bearqy/Memory＋Security】在 `project_memory_outbox.go:EnqueueMemoryTurn`、`project_memory_worker.go:processOneMemoryJob`、`natural_consolidation_worker.go:processNaturalConsolidation/commitNaturalBatch` 的模型派发前和最终事务提交处重验上下文、同意、版本、来源与租约；保留前台抢占、预算与未知用量。增加关闭、撤回、乱序事件及模型迟到测试。依赖 TASK-003、TASK-006。 | 否 | 未执行 |

### Implementation Phase 3

- **GOAL-003**: 将执行与验收来源接入记忆，不制造第二套任务/证据权威。退出条件：有证据的观测保留原时间；未决、失败、孤儿或未验收结果不能被写为目标成功。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-008 | 【任务运行层＋bearqy】在 `internal/ai/project_memory_snapshot.go:MemoryTurnSnapshot/MemoryEvidenceContext` 添加可选 goal/step/attempt/operation/acceptance 引用；在 `internal/web/memory_source_adapter.go`（拟新增）实现 `CaptureCommittedSource`，核对 ADK 原操作/证据再入队；跨 ADK/Web 两库以来源身份/hash 幂等扫描重送，不假设跨库事务。依赖 TASK-007 及 Security 计划的任务/尝试/验收关联实际交付；依赖未交付时本任务保持未开始。 | 否 | 未执行 |
| TASK-009 | 【bearqy/Memory】在 `project_memory_v2_extraction.go` 与现有来源资格检查中引用验收而非模型结论；自然偏好可无 goalID，观测完成不等于目标完成，失败/unknown 仅作带状态线索；在 `project_memory_v2_files.go` 保持来源撤回后的 Markdown 清理。依赖 TASK-008；不单独打开 operationalMemoryV2Ready。 | 否 | 未执行 |
| TASK-010 | 【Security/宿主＋bearqy】在 `memory_security_adapter.go` 接完整 Security 的 PreparedOperation/任务资格与撤销/派发事务；在 `memory_asset_events.go` 对恢复 epoch、项目归档恢复和关系双端变化执行重新绑定与拒绝测试。依赖 TASK-005、TASK-009 及 Security 能力内核、任务授权和跨库 barrier 实际交付。 | 否 | 未执行 |

### Implementation Phase 4

- **GOAL-004**: 固定兼容与联调验收，给出可交接的 tested SHA 和平台边界。退出条件：下列 TEST 矩阵通过，未完成能力仍关闭，原任务/未知账本保留。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-011 | 【联合】新增 `internal/web/module_coordination_test.go`（拟新增），覆盖对接说明第 9 节全部场景；复用 NaturalRecall、MemoryV2、MemoryCapture、SecurityRecovery 与退休兼容测试，核对六类 native 账本不因记忆遗忘、迁移或接桥而伪造结果。依赖 TASK-010。Phase 1/2 PR 必须提前加入各自的对应子集测试，不等待本任务才测试。 | 否 | 未执行 |
| TASK-012 | 【联合】新增 `scripts/verify_module_coordination_dev.py`（拟新增），沿用 `dev_acceptance.py` 创建独立 Home、合成模型和无实际资产动作的 fixture；使用签名 Dev 验证读取/写入资格、版本变化、撤回和恢复。把命令、tested SHA、失败与平台缺口写入 `docs/validation/items-security-memory-integration.md`（拟新增）；V2 放量另走验收和独立 PR。依赖 TASK-011。 | 否 | 未执行 |

每个阶段内部已在任务中显式注明依赖；无依赖的独立契约审阅和测试样例整理可并行。实施前各负责人确认对接说明第 10 节的三个问题；未确认不会自动选择扩大权限的实现。

## 3. Alternatives

- **ALT-001**: 由 Memory 再建资产注册表。拒绝：与用户确定的 Items 职责重复，连接版本和资产合并会产生两个事实源；Memory 只消费资产引用。
- **ALT-002**: 直接打开运维 V2 作为三模块对接。拒绝：尚有质量/平台门槛，且代次不等于 Security 连接版本。
- **ALT-003**: 用异步事件代替实时版本校验。拒绝：漏送与消费延迟会形成越权窗口；事件只用于失效加速与持久协作。
- **ALT-004**: 重写 N1–N5 或恢复旧策略资产。拒绝：破坏已交付来源/撤回/角色边界；本计划只增量接桥。

## 4. Dependencies

- **DEP-001**: bearqy 确认现有 N1–N5/V1/V2 DTO、角色范围和 settings/epoch 适配；设计评审不意味着其本地工作已交付。
- **DEP-002**: Items 提供完整写入口清单、通用 connectionRevision 和真实资产/入口映射；逻辑资产映射未交付时不自动合并。
- **DEP-003**: [Security 计划](feature-lake-security-1.md)的任务闭环、能力内核、任务授权与跨库 barrier；第三阶段等待实际交付，第一阶段不依赖其未实现接口。
- **DEP-004**: 现有官方 ADK/native operation/evidence 身份、业务 SQLite、outbox、独立同意与持久本地签名构建流程。

## 5. Files

- **FILE-001**: `docs/design/items-security-memory-integration.md`：接口、进度证据、角色分工和验收矩阵。
- **FILE-002**: `internal/coordination/context.go`、`context_test.go`：拟新增的共享宿主契约及纯类型测试。
- **FILE-003**: `internal/web/items_snapshot.go`、`items_revision.go`、`items_revision_schema.sql`：拟新增 Items 快照与版本/outbox；实际变更入口沿用 Store、resource_edit/import 与导航归档实现。
- **FILE-004**: `internal/web/memory_security_adapter.go`、`memory_asset_events.go`、`memory_source_adapter.go`：拟新增的宿主适配，复用现有内核而非另造权限与执行账本。
- **FILE-005**: `internal/web/natural_recall.go`、`project_memory_retrieval.go`、`project_memory_bridge.go`、`project_memory_v2_bridge.go`：既有检索与正文读取接入点。
- **FILE-006**: `internal/ai/project_memory_snapshot.go`、`natural_memory_recall.go`、`internal/web/project_memory_outbox.go`、`project_memory_worker.go`、`natural_consolidation_worker.go`、`project_memory_v2_extraction.go`、`project_memory_v2_files.go`：来源、后台提交与投影接入点。
- **FILE-007**: `internal/web/module_coordination_test.go`、`scripts/verify_module_coordination_dev.py`、`docs/validation/items-security-memory-integration.md`：拟新增联合验收。

## 6. Testing

- **TEST-001**: 跨项目、准确 ID/版本、分页、导出和关系双端范围；所有读取路径先过滤，不泄露私有来源元数据。
- **TEST-002**: 改名、换连接、同名/IP 不同对象、依赖入口变更、归档恢复、事件重复/乱序/漏送；旧缓存/许可均不能绕过权威版本。
- **TEST-003**: 关闭使用/积累、来源删除、遗忘、前台抢占、epoch 改变、迟到模型结果；不提交失效记忆、不复活来源、不重发工具。
- **TEST-004**: 轮次结束/压缩/重启同源幂等、ADK/Web 入队中断重送与水位；摘要不变新来源，未处理部分不误报覆盖。
- **TEST-005**: 普通无 goalID 的自然偏好保持兼容；带 goal 的未验收、failed/unknown/orphaned 不形成成功经验或关闭目标。
- **TEST-006**: `operationalMemoryV2Ready` 保持 false，旧策略 API 保持 410，专员/workflow 不隐式获得 N5；只读旧 schema 恢复不创建新表或后台任务。
- **TEST-007**: 对实际实现变更运行相关 Go/race/vet、`python3 scripts/check_adk_runtime_boundary.py`、Memory 兼容工具及签名隔离 Dev 验收；变更前固定判据，不以 mock 代替真实质量/平台结果。

## 7. Risks & Assumptions

- **RISK-001**: Memory 与 Items 双方同时建资产身份系统；以 Items 所有权及显式映射解决，旧入口不按名称/IP 静默迁移。
- **RISK-002**: 两个 SQLite 的事件先后被误认为原子授权；最终判定依赖原 Security 事务/barrier，通知只辅助失效。
- **RISK-003**: 把偏好同意当作任意模型派发或资产操作授权；按 purpose、端点、范围和用途分别重验。
- **RISK-004**: 将 N1–N5 完成和 V2 fixture 通过误写为完整资产知识能力已上线；通过单独启用门槛与当前/拟新增标签防止。
- **ASSUMPTION-001**: 当前以一个本机 Home owner 为信任边界，不凭新字段推导远程多用户 IAM。
- **ASSUMPTION-002**: 本轮仅提交文档，全部运行测试和实施任务仍为未执行；后续修改前重新核对最新代码及 bearqy 的实际 PR 进度。

## 8. Related Specifications / Further Reading

- [三模块对接说明与架构图](../docs/design/items-security-memory-integration.md)
- [当前 Memory 使用说明](../docs/lake-memory.md)
- [自然记忆 N1–N5](feature-natural-memory-1.md)
- [运维 V2 门控及未完成验收](../docs/validation/lake-operational-memory-v2.md)
- [旧资产退出](../docs/design/legacy-asset-exit.md)
- [Security 设计](../docs/design/lake-security-v1.md)
- [贡献规范](../CONTRIBUTING.md)与[开发工作流](../docs/development-workflow.md)
