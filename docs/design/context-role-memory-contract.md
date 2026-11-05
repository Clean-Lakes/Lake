# 上下文与角色知识契约：CM 首批

2026-11-05。对应 [总方案](../../plan/architecture-context-role-memory-1.md)的首批实现。当前交付的是 Pilot 请求工作集与基础身份契约；角色长期知识的提取、文件发布、使用和遗忘仍依赖 FM 流水线，未启用。

## 已接通的请求链路

`RunPilotRouter → BuildRouterContext → 官方 ADK → BuildPilotWorkingSet → streamWithManifest → provider`。前台自动整理和 SDK 整理回调使用同一请求投影判断是否需要压缩；Router 闲置恢复不再强制摘要整段档案。显式手动压缩和普通会话的恢复策略继续使用原入口。

Router 包仍最多 16 KiB、16 个事件，任务部分改为最多 8 条短摘要。默认先列需要答复、阻塞、运行、等待外部、暂停、待执行的任务，再列最近终态任务。总包按实际 JSON 序列化字节检查；事件占用较大时减少任务摘要并设置 `tasksMore`，其余任务沿 `search_super_tasks` 的项目范围分页读取。角色列表继续使用原 `list_specialists` 分页工具，本批不另建角色索引。

每次真正请求模型前，省略已消费的旧 Router 消息组及其工具回执，仅发送当前输入、当前消息组、短目录和最近最多 8 个原事件 ID。被省略组须同时满足：

- 当前确实是该项目 Router，当前轮有真实宿主锚点。
- 旧消息具有宿主 SourceMessageID/HostTurnID，其信封事件 ID 和原用户文字尾部与当前项目原始事件匹配。
- 原事件已是 `routed`；失败或未消费事件仍保留。
- 整组工具调用/结果完整，组内没有无锚点用户补充或 system 边界。

未满足条件的旧内容保守保留，超预算时沿原恢复/失败路径处理，不丢弃约束后执行。投影不清理用户消息、原 ADK 事件、任务、操作、审批、证据、验收和累计用量。之前的历史目录修复仍仅缩短旧宿主 task 快照；原始 SDK 档案不删除。

当前轮准确读出的正文与工具配对始终保留。下一轮不默认重放它们，需要详情时从原任务或事件重新读取；跨任务证据仍须使用已有显式登记和资格检查，摘要不会赋予读取其他 Worker 完整会话的权限。

## Context 协议 v1

类型位于 `internal/ai/superagent_context_contract.go`，由宿主生成。

| 类型 | 当前字段与来源 |
| --- | --- |
| `ContextRefV1` | `kind/id/revision/hash`；准确对象 ID、正 revision、完整 SHA-256。引用是定位信息，不是许可。 |
| `TaskAssignmentV1` | `projectId/roleId/roleRevision/taskId/workerId/sessionId/originRootTurnId/originalRequirementRef`；`BuildTaskAssignment` 从原 Worker 与创建时冻结的 RoleSnapshot 解析，原要求指向真实 event。职责编辑不改旧 assignment。 |
| `TaskDigestV1` | `version`、上述执行身份、`canonicalRevision/observedAt/state/acceptanceState/nextAction/title/summary/refs/truncated`；从原 WorkGoal 和 GoalClosure 投影，不持久保存第二份完成状态。 |
| `TaskWorkingSetV1` | 目前只定义 assignment、steeringRefs、pendingRefs 的基础 DTO；当前步骤、知识版本及重建游标在后续 Task 工作集阶段扩展，尚未替代 Worker 原请求组装。 |

摘要单条总长 ≤1536 bytes、说明 ≤512 bytes、最多 4 个引用；标题预览 ≤128 bytes。截断按 UTF-8 边界，JSON 转义后的完整大小仍须通过总长检查。不能放入身份/状态/引用时返回错误，不裁掉关键字段。`DecodeTaskDigestV1` 拒绝未知字段、不支持的版本、尾随 JSON、无效 UTF-8、非法状态/验收值及越界字段；它不是可信作用域解析器。

`canonicalRevision` 沿用原目标 revision；`observedAt` 是本次投影所依据的目标更新时间，旧数据退到 Worker 创建时间，缺失时拒绝制造时间。它不是动态资源的实时观测时间；查询当前数量、健康等仍需实际工具。`roleRevision=0` 仅表示旧 Worker 没有冻结职责快照，不能据此补造职责版本；assignment 的严格契约要求准确正版本。

摘要的 task ref 指向原 `ReadSuperObject(kind=task)` 全文，包括原要求、sourceEventId 和原任务投影。`kind=task_digest` 可准确分页读取同一摘要；Worker 仅能读自己任务的摘要/对象，Router 仅能读当前项目。新增可选 `expected_hash`，与 revision 一起在返回任何页和推进事件读取游标前检查；变化时返回 conflict，调用方重新取当前对象。省略 hash 保留旧调用兼容性。

`BuildTaskAssignment` 生成引用不计为模型已经读完事件。默认 Router 预览和准确分页继续沿原读取游标与派发约束；本批不提前 ACK 原事件。

摘要无持久缓存，报告 outbox 保留原正文、幂等身份和投递回执。每次取摘要从原记录重建，更旧摘要无法覆盖原任务状态；不新增摘要更新队列或竞争发布者。

## 请求预算

`BuildContextBudgetView` 公开 `version/serializedBytes/estimatedInputTokens/estimateMethod/windowTokens/maxOutputTokens/overBudget`。沿现有 `historyCost` 的 JSON 字节与每图 8192 bytes 兼容估算，加工具定义，按 2 bytes/token 换算；`estimateMethod=legacy_json_bytes_div2_with_image_estimate`。这不是精确 tokenizer 或网络传输长度，未将它描述为真实计费 token。

Router 最终 provider 入口在完成 system、工具、图像和自然记忆组装后检查单次输入预算及输出预留，越界保留原要求和账本并退出；没有单任务累计 token 限额。自动整理沿既有 80%/60% 阈值，不新增模型循环。ContextMeasurement 对投影请求记录原档案大小锚点，界面用本次工作集加后续增量估算占用，实际 provider usage 和累计费用不改写。

## Role Knowledge 基础契约（尚未接通）

`internal/memory/role_scope.go` 只提供类型和校验，不创建目录、运行学习器或开放 Worker 召回。

- `RoleKnowledgeScopeV1` 的稳定 key 为 SHA-256(`storeId + NUL + projectId + NUL + roleId`)；名称、头像、WorkerID、SessionID 不参与身份。
- `RelativeDirectory` 只从通过校验的宿主不透明 ID 映射到 `projects/<project>/roles/<role>`；不接受模型路径。根目录与文件 IO 由后续 FM 单一发布者负责。
- `RoleKnowledgeSettings` 分开表达积累/使用，两者默认 false；本批没有新增设置 API 或改变当前项目开关。
- `KnowledgeRefV1` 校验 scope key、entryId、正 revision、SHA-256；后续补齐来源/可见性/观察时间，不作为当前可读知识的凭证。
- `RolePublishFenceV1` 匹配准确 scope、设置 revision、recoveryEpoch、基础文件 revision、withdrawalRevision 和 commitId。它是后续 CAS/抑制检查的契约，当前没有实现发布事务、租约、撤回清理或跨库原子提交。

同一 FM 发布者和文件成品继续由 Memory 主线维护。Worker 的 `MemoryEnabled=false`、`IgnoreNaturalMemory=true` 与 `task_knowledge_view_unavailable` 保持；N5/V2 不放开。文件知识跨任务持久、纠正/遗忘/角色删除及权限变化重验将在 FM/CM 后续阶段独立验收。

## 本批验收与后续

自动回归包括：100 个终态任务、各自 256 KiB 档案及 Pilot 历史详情页；真正冷关闭/恢复后，当前输入及本轮准确工具结果进入两次真实 HTTP provider 请求，原大输出不进入请求，原档案仍在。另覆盖摘要总长/UTF-8、原始要求与 hash、伪成功、冻结职责版本、跨任务读取、未消费输入及未知消息保护。结果和源码 SHA 见 [验收记录](../validation/lake-context-role-memory.md)。

本批不宣称完成全部 CM/FM 计划：Task 完整工作集、角色文件发布/读取/生命周期、迁移和真实模型记忆质量集尚未实现；不把 fake provider 的协议测试当作长期知识质量验收。
