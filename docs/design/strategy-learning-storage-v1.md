# P2 策略资产与血缘存储 v1

日期：2026-10-21。实施基线：`origin/develop@39b3053b9b3fe0fe26c49561563eba2ff91b5466`，已包含 P1 PR #38。P2 交付 T07–T10 的业务存储；P3 API/UI/注入、P4 来源自动提取、P5 实验与 P6/P7 调度尚未接入。

## 迁移与兼容

新增 `internal/web/strategy_schema.sql`，在既有 Store.migrate 的项目记忆迁移后执行；不用通用 events 的 CHECK 新增通知类型。新库直接建表；旧库在任何旧 schema 执行、迁移和重启状态对账前，先用 `VACUUM INTO` 生成 `lake-web.before-strategy-v1-<id>.sqlite` 一致性快照，权限 0600、目录 0700，包含已提交 WAL 数据。

15 张组件表在一个事务内创建，并写入 strategySchemaMeta 的 version=1 与 DDL hash。失败回滚组件表，不写成功标记，保留快照；不会自动拿旧快照覆盖当前数据库。再次启动已升级库不重复迁移/备份。未知版本、无效标记或不同 DDL hash 在重启对账写入之前拒绝打开。DDL hash 仅归一 CRLF 为 LF，以免 Git 的平台换行设置被误认为数据库版本改变；其他修改需明确版本迁移。

已发布的旧二进制没有此版本检查，P2 无法让它们追溯获得拒绝能力。**回退到 P2 以前的程序时，只能在另一个隔离 Home 中离线打开迁移前的兼容副本；不能指向当前数据目录或把副本恢复覆盖当前数据库。**该要求是回退流程约束，不声称旧程序已具备服务端强制拒绝。未来带本检查的版本可以拒绝未知后继格式。ADK sessions.sqlite 和操作账本不参与业务库快照回滚。

## 数据结构与原子提交

| 表 | 实际职责 |
| --- | --- |
| strategySchemaMeta / strategyScopes | 组件版本；local 身份、user/project 范围和单调 generation |
| strategyAssets | 稳定 ID、范围、不可变 kind、当前标题、最新 revision、删除状态 |
| strategyRevisions | 不可变版本、父引用、正文/适用字段 hash、sourceSetHash、验证等级和创建者 |
| strategyRevisionContent | 正文和适用字段；逻辑删除时移除，保留不可变版本指纹 |
| strategyRevisionSources | 不可变的版本与来源关联 |
| strategyBindings | 精确版本采用、enabled、bindingRevision、priority/exclusionGroup；每资产/范围唯一 |
| strategySettings | 四开关、完整预算、revision、epoch；无记录时 0/0、默认全关 |
| strategySourceEvents | 手工确认或真实用户消息的引用、hash、非敏感固定摘要和 availability |
| strategyLineageNodes / strategyLineageEdges | 有类型节点与关系、实际归属、去重及审计元数据 |
| strategyJobs / strategyJobSources | 有界领取、来源集合、epoch、租约、稳定 runtime ID 和派发状态 |
| strategyEvents | 追加审计，同时作为持久 outbox；发布确认只允许设置 publishedAt |
| strategyReceipts | 范围内幂等键 hash、请求 hash 与最小结果引用，不存正文副本 |

计划中的 strategyExperiments/Runs/Evaluations 属于后续评估阶段，本期没有创建空表冒充实验实现。runtime 运行事实仍由 ADK 权威保存，P2 不创建另一份操作账本。

沿用 Store 单连接、进程锁和事务互斥：资产、版本、来源、血缘、绑定事件、幂等回执及 outbox 原子提交。SQL 触发器保护版本/来源关联/审计事件和核心身份；正文和适用内容不允许原地 UPDATE。标题为当前逻辑资产的名称，修改正文时可一起更新标题，不把同名视为相同资产。

修改采用 expectedRevision CAS；同 key 同请求返回原最小引用，异请求冲突。后台结果以 job ID 固定回执，事务失败不能留下候选或成功事件；重启后再次读取已提交结果不新增版本。手工修订标 local_user，后台修订标 job:<id> 且只能为 single_observation；不能传一个 verified 枚举升级可信度。保存候选不建立采用绑定。

绑定 adopt/disable/revert 均要求精确 revision/hash 与 bindingRevision；回滚只选更早版本。停用只记录停用，不伪造 adopted_as。固定规则和执行权限不由绑定改变；实际优先级解析/注入在 P3 实现。

## 权限、来源与删除

StrategyContext.ProjectID 必须由可信宿主解析，JSON 无法绑定该字段；空值是本机用户的全局视图，不能读取所有项目。所有读取/修改检查实际项目、归档状态和资产/来源归属，不信任调用参数自称的范围。P2 方法没有 HTTP/MCP/模型入口；P3 必须做同源认证、独立请求 DTO、未知字段/长度校验，不能直接解码这些宿主类型或将 worker lease 暴露到前端。

手工编辑由宿主登记持久确认事件，来源 hash 对应这次正文，不接收外部 sourceId、actor 或验证等级。它代表用户正文/偏好确认，不证明技术有效。消息来源仅允许真实 messages 表中当前项目的 user 记录，保存其稳定 ID/hash，读取、入队、领取、派发准备及结果提交时重新核对原消息归属和内容。模型/assistant 消息及虚构 ID 不合格。工具、任务结果、Skill、fixture 等类型只预留词汇，须由 P4/P5 的真实执行适配器登记，不能用通用 JSON 伪造。

全局手工正文是明确选择的用户确认资产。自动全局候选要求全局宿主上下文和全局来源；从项目私密来源自动扩大到全局在本期拒绝，后续跨范围推广必须显式重新确认通用正文。项目绑定可覆盖全局资产，其他项目读取其血缘时隐藏该绑定节点/边，不返回原项目 ID。血缘按 ≤50 边的游标分页，返回 Redacted 标记；不跨项目拉取原文。

当前支持的真实节点为 user_message/correction、asset_revision、adoption。derived_from 校验实际版本来源，supersedes 校验真实父版及向前版本关系；采用/回滚关系只由绑定事务生成。其他任务、运行、证据节点及关系词汇为后续权威适配器预留，P2 不接受任意构造。来源血缘表示记录关系，不声称证明因果。

撤回来源保留 hash/身份 tombstone 或 revoked，清空摘要并阻止新采用/提交。删除资产移除当前表内正文和适用字段、清空标题，保留版本 hash/血缘；相应手工来源同时 tombstone，依赖它的任务取消。独立消息来源不会因删除一个候选而误删原聊天。直接改动/删除原消息也会使旧来源动态显示缺失。这里是逻辑删除，不声称能擦除 SQLite 历史页、WAL 或备份的字节；快照必须按私有数据管理，不作为导出产物。

仓库拒绝私钥、常见凭据字段/Bearer/含密码 URL 等内容，校验 UTF-8、100000 字节正文和受限选择器；不读取任何密钥文件。模式检测不能识别所有无标识秘密，P3 宿主还必须使用实际配置的秘密检查。版本读取核对正文/适用字段 hash、来源集合 hash 和结构完整性，不能把存储损坏当作有效资产。

## 设置、epoch 与任务 outbox

用户设置为上限；项目无记录时继承，存在记录则逐开关相交、预算逐字段取较小值。保存偏好不等于生效，master 关闭时有效子能力均关闭。本期只是仓库存取，不把这些设置接入现有模型提示词。

scope generation 独立于配置存在性，记录范围、来源、绑定或归档变化；有设置记录时同步其 epoch。这样缺失项目配置仍可继承，同时撤销能产生持久 fence。任务冻结 user/project 两个 generation，任一变化、来源失效、目标版本变化、项目归档或资产删除，旧 worker 都不能提交。设置 revision 用于编辑 CAS，不充当操作授权。

任务仅保存 proposal / experiment 意图，不启动后台消费者。优化实验意图要求 apply+learn；仅手工资产试用的独立路径留在 P5。领取最多 3 次，租约最长 90 秒，不能超过任务硬截止；当前截止取入队时间加配置 maxActiveSeconds（默认最多 600 秒），包含排队等待，是初期保守上限，不能冒充 P6 的活动时间/Token 计量。实验并发上限 1，包括取消后仍未对账的派发。

状态流转与跨库协议：

1. queued → leased：核对权限、开关、双 generation、来源 hash、版本与截止，发放新 token。
2. 调用前 CheckStrategyJobLease；需延长等待用 Renew，在同一上限内。Complete 再次检查，并原子保存候选、来源/血缘、回执、job 成功和 outbox；从不自动采用。
3. 外部启动之前 PrepareStrategyDispatch 原子写 awaiting_reconciliation + intent 和稳定 runtimeId。这是预留的稳定执行 scope/关联 ID，不声称已创建原生 ADK SessionID。后续适配器必须用它查回实际 checkpoint/native ID，不能先执行后登记。
4. 重启只将“尚无派发意图”的 leased 重新排队；intent 变 unknown，已有派发绝不自动重新领取或创建替代运行。显式 AcquireStrategyReconciliation 只给查询/结算租约，Prepare 仍拒绝第二次派发。
5. Observe 的 started/unknown/complete 必须来自可信运行时查询，不是客户端/模型声称；它可以在取消/项目归档后记录原 ID 的终态，不返回来源、不重开任务或授予新执行权。未知保持阻塞；只有 complete 且有效租约/配置/来源仍合格，才允许提交已取得的结果。

strategyEvents 提供范围受控的 Pending/Acknowledge 供未来轮询发布；seq 是消费者去重身份。交付是可重复的通知，不声称网络 exactly-once。任务、副作用和通知身份彼此区分；关闭功能不会抹除派发状态或宣称外部效果已回滚。

## 验证与回退

单元/集成覆盖旧库快照与未来版本拒绝、迁移和结果事务失败、精确字节/版本、跨项目血缘、秘密拒绝、删除、来源变化、并发 CAS/领取及失效 worker。真实子进程在事务中、领取后、派发意图后和结果提交后直接退出，验证回滚、单次提交及未知运行不会重新派发。

回退经独立 revert PR；不要删除业务/ADK 历史或恢复旧快照覆盖后续操作记录。P2 前二进制的兼容限制和未验证平台按上文处理。具体命令与 Dev 验证见 [P2 验证记录](../validation/lake-strategy-learning-p2.md)，后续任务见 [主计划](../../plan/feature-strategy-learning-1.md)。
