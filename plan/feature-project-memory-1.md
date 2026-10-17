---
goal: 为 Lake Go 工作台实现项目范围的跨会话记忆、索引加载和可恢复的后台自动提取
version: 1.1
date_created: 2026-10-13
last_updated: 2026-10-13
owner: Lake
status: In Progress
tags: [feature, memory, project, persistence, go, zcode]
---

# Introduction

![Status: In Progress](https://img.shields.io/badge/status-In_Progress-yellow)

参考 ZCode 的项目 Markdown 记忆、`MEMORY.md` 索引和成功轮次后的后台提取，为 Lake 当前 Go 后端增加跨会话记忆。实现后，同项目普通聊天和资源／终端 AI 可以复用用户反馈、项目约束和外部参考；后台提取支持中文输入，并在后端重启后恢复尚未完成的工作。

本文件是实施方案，代码层正在落地。首版不实现长期无人值守调度、自动执行恢复、向量检索、语义召回、Dream 整理或跨项目用户全局记忆。

当前代码层进展与实际验证记录见 `docs/validation/lake-project-memory.md`；尚未通过全部验收项，因此本计划仍标记为 In Progress。

参考基线为 ZCode `main` 提交 `aac4755666d09fdcd70272fcf063c077a639015f`。该版本实际默认使用索引加载，Semantic Recall 的开关为 `false`，Dream handler 未自动接入产品链路。Lake 仓库的 `third_party/zcode/` 与该提交存在差异，实施时以本方案规定的行为和固定上游链接为准。

2026-10-13 对照复核：`git ls-remote` 确认上游 main 仍为上述提交；同时检查上游 Memory 设计 v4、主 Agent 提示词、提取调度、Custom Agent Memory 和 Dream 接线。1.1 补齐有限前文、主动查询、临时停用、时效与来源、请求预算、过期任务与数据保留规则；对照差异见 1.8。本文仍为待实施方案。

## 1. Requirements & Constraints

- **REQ-001**: 记忆按 Lake `projectId` 隔离，目录为 `<DataDir>/memories/projects/<projectId>/memory/`。不使用项目名称、cwd、SSH 路径或资源地址计算身份。同项目的新会话、资源 AI 和终端 AI 共享项目记忆；不同项目不共享。旧会话历史不做全量自动回填。
- **REQ-002**: 支持 `user / feedback / project / reference` 四种类型，四种类型在首版均属于当前项目。主 Agent 在每轮请求前加载项目索引，按需要调用专用记忆读取工具获取正文。支持明确记住、修改和忘记；只有持久提交成功后才能报告“已记住／已忘记”。
- **REQ-003**: 成功且最终状态已持久保存的主 Agent 轮次生成自动提取任务；失败、取消、中断、子 Agent、后台提取自身、纯系统上下文与压缩摘要不生成任务。工作流主会话正常完成后可以生成一个任务，专员不单独生成。后台提取不调用 `ChatTurn`，不追加用户聊天、不触发自动提取递归。
- **REQ-004**: 中文触发使用 Unicode 字符类别与真实用户文本，不使用空格分词或英文“三个词”门槛。普通有效文本达到 4 个 Unicode 字母／数字／汉字时可进入提取；明确记住／忘记意图绕过长度门槛。`ai.IsBriefConversation` 中的短确认和寒暄默认不触发，具有明确记忆意图或实际记忆工具调用时例外。长度判断仅用于控制提取成本，不决定是否有内容值得保存。
- **REQ-005**: 未完成提取、提取尝试次数、结果、消息边界和处理进度全部持久化。崩溃于回复完成、队列入库、模型返回、事务提交或文件发布之间，都能恢复；恢复提取不得重放会话工具或远程命令。同一 `(projectId, sessionId, turnId)` 的提取只能提交一次逻辑结果。
- **REQ-006**: Markdown 格式、索引和有来源的记忆条目可查看及编辑。SQLite 存储规范化条目、完整 Markdown 原文、版本、提交记录和任务状态，作为事务提交与崩溃恢复的权威数据；磁盘 Markdown 是可重建的持久投影。所有首版编辑通过 Lake API／记忆工具提交，不支持直接编辑投影目录自动导入。
- **REQ-007**: 普通回答正常完成后不等待模型提取；后台失败不将回答、回复耗时或会话状态改成失败。页面显示独立的记忆任务状态和错误类别；新会话在尚未提交时只能读到此前已提交的版本。明确记住和忘记使用同步工具提交，不依赖后台任务是否成功。
- **REQ-008**: 首版自动保存长期偏好、用户反馈、项目约束和外部参考。运行时健康、进程 PID、实时主节点、瞬时指标、某命令已完成等状态不自动成为永久知识；模型推测、计划和未经确认的结论不得写成已验证事实。需要描述一次观测时必须保留采集时间并明确标记其历史性质。
- **REQ-009**: 项目提供“使用项目记忆”和“自动提取”两个持久开关，均默认开启，这是 Lake 的产品选择，不代表 ZCode 桌面默认启用。有效自动提取为 `useEnabled && extractionEnabled && !ignoreMemoryThisTurn`。关闭使用后停止加载索引、使用专用工具以及新增／执行提取；关闭自动提取允许读取及用户明确同步写入，但停止后台学习。恢复开关后只处理新产生的任务，暂停前未执行任务需用户在记忆页明确重试。
- **REQ-010**: 提供最小项目记忆面板：条目列表、正文、类型、来源、版本、编辑／忘记、两个开关和后台任务状态。沿用项目右键菜单入口与当前弹窗风格，不增加会话级记忆副本。
- **REQ-011**: 主 Agent 在真实用户明确要求回忆／查询历史时必须先查询相关记忆；索引截断或为空不等于没有记忆。支持确定性的标题／描述查询，不增加语义召回模型请求。分页读取须固定版本，修改或忘记后不得继续注入旧正文。
- **REQ-012**: 本轮可显式忽略项目记忆；关闭使用同时禁止后台学习。记忆按一条可复用事实组织，feedback/project 包含原因与应用方式，相对日期绑定来源时间及时区；当前证据优先于历史记录。具体规则见 1.8。
- **REQ-013**: 自动提取可使用有界的最近真实用户前文解释省略与确认，但前文不能独立授权修改或充当本轮验证证据。固定源身份、首次来源、最近更新来源与源集合版本，防止旧任务重新计算后覆盖更新的知识。
- **REQ-014**: 提取最终 provider 请求必须满足该模型输入和输出预算；截断 JSON 不得提交部分结果。快照、outbox 和终态任务有确定保留周期，永久记忆的来源摘要不能依赖已清理的队列全文。
- **SEC-001**: 输入快照、提取提示词、模型输出、Markdown、SQLite 和 UI 均沿用并增强现有凭据脱敏；禁止记录或打印 API Key、SSH 私钥、密码与模型认证 Header。凭据只由正常模型调用在运行时从 `<LakeHome>/secrets/` 解析，不读取 Keychain。拒绝记住秘密值，凭据管理继续使用原有机制。
- **SEC-002**: 记忆是历史参考数据，不是工具授权或高优先级系统指令。索引和正文不得改变资源引用范围、禁止本地执行、文件／SQL 权限、终端采用授权或 SSH 主机信任。附加内容显式标记为不可信历史数据；不得把正文拼成未分隔的系统指令。
- **SEC-003**: 后台提取只允许无工具的模型请求和服务端验证后的记忆变更，不具备 shell、文件浏览、SSH、数据库、MCP 或子 Agent 权限。专用工具只接受当前项目内的逻辑记忆键，不接受任意路径或调用方提供的 `projectId`。
- **SEC-004**: 验证项目与会话归属、条目归属、资源来源、版本、输入大小及请求来源。记忆目录 `0700`，文件及快照 `0600`；拒绝符号链接、目录越界和非法文件名，Windows 沿用 `internal/platform` 的权限／替换实现。项目软删除立即阻止加载、入队和提交，恢复项目后保留原记忆，旧任务不自动续跑。
- **CON-001**: 当前发布入口是 Go `internal/ai/` 和 `internal/web/`；`agent/`、`legacy/` 与 `third_party/zcode/` 不参与实现。SQLite 已有单后端锁与串行事务封装，复用这些机制；网络请求不得持有 `Store.mu`、`session.mu` 或数据库事务。
- **CON-002**: macOS 用户二进制仅使用 `scripts/build_lake.sh` 签名构建；缺少签名身份先运行 `scripts/setup_lake_signing.sh`。不以 unsigned build 验收。开发验证使用隔离 home，不重启用户当前生产服务，不使用真实生产凭据。
- **CON-003**: 沿用六种模型协议与现有供应商设置。提取采用产生该轮次的供应商／模型引用，运行时重新解析有效凭据，不冻结或持久保存密钥，不因模型移除而隐式切换到另一供应商。
- **PAT-001**: 使用“成功轮次持久 outbox → SQLite 幂等入队 → 租约认领 → 无工具提取 → 版本校验事务提交 → Markdown 发布”处理链路。对模型请求允许至少一次执行，对已提交的逻辑记忆变更保证幂等。

### 1.1 当前代码接缝

| 现有位置 | 当前行为 | 接入要求 |
|---|---|---|
| `internal/web/server.go`：`New / Start / Close` | 创建 Store、Models、Engine；退出前取消并等待后台工作 | 增加记忆服务、恢复与 worker 生命周期；Store 最后关闭 |
| `internal/web/agent.go`：`configure / runTurn / event` | 从 session 推导项目资源；调用 `ChatTurn`；同步聊天状态 | 从服务器推导 Memory 配置；通知 outbox 入队；不复用 `done` 表示提取成功 |
| `internal/ai/engine.go`：`ChatTurn / save / compact` | AI 状态通过临时文件和原子替换保存；压缩会替换 History | 在最终成功保存中一并写入 outbox；快照独立于压缩后的 History |
| `internal/ai/types.go`：`Config / State / Message` | Config 保存会话选项，Message 尚无稳定消息 ID | 新增项目记忆配置和 outbox 类型；以 `RootTurnID` 和快照内局部 source ID 标识边界，不以 History 下标当游标 |
| `internal/web/store.go`：`OpenStore / migrate / update` | SQLite 会话数据；启动中断在途操作；迁移已有一致性备份 | 新表迁移前备份；只恢复记忆任务，不改变命令恢复语义 |
| `internal/ai/context.go / context_compaction.go` | 估算请求预算并压缩 | 索引和正文计入实际请求预算；保留最新用户指令和工具配对 |

### 1.2 文件格式与容量

文件路径只由服务端根据验证后的 `projectId` 和记忆键构造。键满足 `^[a-z][a-z0-9-]{0,63}$`，文件名为 `<key>.md`；`MEMORY.md` 为保留名。项目重命名和资源 shell 的 cwd 改变不迁移记忆目录。

规范化条目示例，以下值是方案示例，不代表用户真实偏好：

```markdown
---
name: release-preflight
description: 本项目发布前的确认习惯
metadata:
  type: feedback
  projectId: example-project
  originSessionId: example-session
  originTurnId: example-turn
  revision: 1
  updatedAt: 2026-10-13T08:00:00Z
  verification: user-stated
---

发布前先确认本次目标版本和验证结果。

**Why:** 用户明确提出这一工作习惯。
**How to apply:** 准备发布方案时列出目标版本及已有验证结果。
```

Frontmatter 由服务端生成，模型和客户端提交结构化字段而非任意 YAML。`verification` 取 `user-stated / observed / reference`；自动提取的 `observed` 必须引用快照内已完成且结果可验证的 evidence，不能把 assistant 文字本身当验证。首次来源／最近来源、observedAt、validUntil 按 1.8 生成并渲染，name 固定为逻辑 key。首版条目允许资源来源引用，但加载范围仍是项目，资源引用不产生授权。

`MEMORY.md` 每条一行：`- [名称](key.md) — 描述`；不保存正文。按类型 `feedback / project / reference / user`、更新时间降序、键字典序稳定排序。规范文件最多 200 行、25,000 个 Unicode 字符；实际注入同时最多 24 KiB UTF-8 字节与 200 行，超限保留完整行并说明通过 `list_project_memories` 查询剩余索引。

固定首版容量：项目最多 500 个活动条目；描述最多 160 个 Unicode 字符且只允许单行；单条正文最多 16 KiB；`read_project_memory` 每次模型注入最多 4 KiB／200 行，可通过明确 offset 分页；提取单次最多 5 个 upsert/delete 变更；快照最多 128 KiB。容量超限返回明确错误，不静默丢弃已提交条目。

每轮索引额外上限为 `min(24KiB, floor(剩余请求字节预算 × 0.10))`。剩余预算采用现有 `historyCost`／`ContextWindow` 估算口径，先扣除用户文本、工具目录及输出预留；无剩余空间时跳过索引并标记原因，不挤掉用户输入。记忆文字按实际序列化长度参与 `contextUsage`、`fitToolContext` 和压缩。

### 1.3 SQLite 状态与事务边界

所有时间为 UTC RFC3339Nano 字符串；租约和重试比较统一使用 Unix 毫秒整数。JSON 列在服务端解码并做完整类型／范围检查。

| 新表 | 主键／唯一键 | 必需字段与职责 |
|---|---|---|
| `projectMemorySettings` | `projectId` FK | `useEnabled, extractionEnabled` 布尔；`epoch, revision, settingsRevision, publishedRevision` 非负整数；`updatedAt`。epoch 是清除／编辑／开关／项目删除的失效边界，revision 是项目文档集合版本，settingsRevision 单独用于开关的乐观锁 |
| `projectMemories` | `(projectId,key)` | `type, description, body, markdown, revision, projectRevision, contentHash, originSessionId, originTurnId, lastSourceSessionId, lastSourceTurnId, sourceIdsJSON, sourceSummaryJSON, resourceIdsJSON, verification, observedAt, validUntil, createdAt, updatedAt, deletedAt`；首次来源保持不变，最近来源单独更新；忘记时清空正文、markdown、描述、来源摘要，只保留键、哈希与必要版本／时间墓碑 |
| `projectMemoryTurns` | `sequence INTEGER PRIMARY KEY AUTOINCREMENT`；`UNIQUE(projectId,sessionId,turnId)` | `epoch, knowledgeBaseRevision, snapshotJSON, snapshotHash, modelRefJSON, outcome, createdAt, processedAt`。outcome 为 `pending / applied / no_op / skipped / failed`；快照仅脱敏文本和有界证据 |
| `projectMemoryJobs` | `jobId`；`turnSequence UNIQUE` FK | `status, attempts, nextAttemptAtMs, leaseOwner, leaseToken, leaseUntilMs, baseRevision, lastErrorCode, usageJSON, createdAt, updatedAt`；status 为 `queued / running / retry_wait / blocked / succeeded / no_op / skipped / failed` |
| `projectMemoryCommits` | `commitId`；`jobId UNIQUE` 允许 manual commit 的 jobId 为 NULL | `projectId, revision, mutationKeysJSON, sourceTurnSequence, createdAt, publishedAt`；与条目和 job 的逻辑结果同事务提交，供文件投影重建 |

不增加“某会话所有历史都已消费”的全局高水位。每个成功轮次有独立 sequence、job 和处理结果，某个任务失败不吞掉其他任务。source ID 为快照内的 `user:0 / assistant:0 / evidence:<callId>`，并与 session／turn 联合使用，不能单独跨轮次引用。

数据库是权威提交点。`CommitMemoryExtraction` 在一个 `Store.update` 事务中校验当前 epoch、项目 revision、leaseToken、job 非终态、来源及容量，更新条目，插入 commit，结算 turn/job；空变更结算 `no_op`。事务失败不会修改任何条目。网络请求在事务外完成。

`PublishProjectMemory` 根据已提交 revision 生成规范化 Markdown 与索引，采用同目录临时文件、Sync 和 `platform.ReplaceFile`；删除旧条目投影，文件权限为 `0600`。所有内容完成后更新 `publishedRevision`。磁盘无多文件事务，因此任何索引／正文加载必须经过记忆服务读取当前数据库版本；不得直接读取“可能发布一半”的磁盘集合。发布失败显示“记忆已保存，文件同步待重试”，启动时按数据库重建，不重复调用模型。发现不匹配文件或符号链接时不采纳其内容；异常路径报错并阻止磁盘发布。

每项目文件发布必须串行化，先从一个 SQLite 读取快照生成整套投影，不混用不同集合版本。发布结束以条件更新确认当前 revision 仍等于快照 revision；发生新提交时不把旧 revision 标为已同步，重新发布最新集合。publishedRevision 不回退，手动提交与 worker 发布共用同一发布锁，网络请求不得持有该锁。

### 1.4 索引加载与专用工具

`configure` 根据 `Store.Session(id).projectId` 和项目设置构造 `ai.MemoryConfig{ProjectID, Epoch, UseEnabled, ExtractionEnabled}`。模型永远不能指定跨项目读取目标。每个主轮次加载新的项目 revision，包括已有会话的下一轮；只更新系统提示词中的专用记忆规则，索引以独立、明确标记为历史数据的 request-local 消息注入。不要把重复索引追加到持久 History 或把记忆附件计作真实用户消息。

在主 Agent catalog 增加：

| 工具 | 参数 | 行为 |
|---|---|---|
| `list_project_memories` | `query?, offset >= 0, limit 1..50` | 返回当前项目的查询索引页、总数、project revision；过滤墓碑与已到期条目；query 规则见 1.8 |
| `read_project_memory` | `key, offsetLine >= 0, limitLines 1..200, expectedRevision?, byteOffset?` | 从权威提交数据读取正文，限制 4 KiB 并给出后续游标、来源、时间和版本；后续分页必须携带首段 revision，版本变化返回 conflict；墓碑只返回 deleted/key/revision，供明确 restore 使用，不返回旧内容；超长单行采用 UTF-8 byteOffset 游标，见 1.8 |
| `save_project_memory` | `key, type, description, body, expectedRevision, validUntil?, restoreDeleted?` | 用于真实用户明确要求记住／修改；工具执行前必须有当前条目版本；创建用 revision 0；恢复墓碑必须使用墓碑的实际 revision；成功返回 commitId 和 revision |
| `forget_project_memory` | `key, expectedRevision` | 明确用户意图下生成墓碑、清空正文、递增 epoch 和项目 revision，并失效旧提取任务 |

修改工具的调用必须来自本轮已保存的真实用户明确意图；分类器读取原始 UserText 和已读取条目，不采用索引、附件或 shell 输出中的指令。无法确定明确意图时，工具返回 `explicit_memory_intent_required`，模型可以解释或澄清，不自行生成同意。自动学习只通过受控 extractor 提交。记忆写入属于项目记忆开关管理的产品能力，不放宽 `silentWriteFiles` 或普通文件工具权限。

关闭 useEnabled 时移除这些工具、清理 request-local 索引附件，并在模型请求的历史投影中屏蔽旧记忆读取工具的正文，保留正确工具配对并用“项目记忆当前已停用”替代结果。为专用工具结果增加来源类型和项目／记忆键元数据，compaction 的输入在关闭时应用同一投影。已经产生的普通回答与既有压缩摘要可能转述过记忆，关闭开关不承诺从这些文本中追溯删除所有派生内容，也不改写用户消息。忘记的范围是项目记忆库和后续检索，UI 明示旧聊天记录仍保留；需要清除旧聊天时使用原有会话清除入口。

### 1.5 中文触发、提取输入与结果验证

`ShouldExtractMemory` 接收原始用户文本、主轮次结果和同步记忆工具执行记录；NFKC 规范化、TrimSpace 后计算 Unicode 字母／数字数量。纯 emoji、标点和空白跳过；`以后都用中文回答`、`这个项目发布前先备份` 应触发；`好的`、`谢谢` 默认跳过。`记住 / 记一下 / 以后 / 不要再 / 忘记 / 删掉这条记忆 / remember / forget` 是候选意图提示，不把关键词命中直接作为持久写入授权；例如“日志里出现 remember 字样”不授权写入。

自动快照包含本轮原始用户文本、最终回答、本轮完成工具／观察的摘要，以及 1.8 规定的最近真实用户前文。剔除思考、图片字节、认证信息、完整原始日志、项目索引、被读取记忆正文和主上下文的其他旧会话内容。输入按 source ID 区分 user／assistant／evidence／context；assistant 的确认性表达不能替代成功工具记录。用户文本最多 64 KiB UTF-8，超限以 `input_too_large` 结算失败，不截掉明确要求保存的内容；人工重试仍使用冻结快照，精简后必须作为新的真实用户轮次提交。最终回答最多 24 KiB、证据合计最多 24 KiB／24 项、最近用户前文最多 8 KiB，预留 8 KiB 给元数据及 JSON 转义；以最终序列化后的 128 KiB 总上限为准，可按完整 UTF-8 边界裁剪可选内容并标记 `truncated`；不得把未包含的数据当作证据。

同轮已通过专用工具持久保存／忘记的主题从后台提取候选排除，其他主题仍可提取。快照同时保存起始 epoch 和同步记忆操作后新的 epoch，入队采用最后有效 epoch；manual commit 后旧轮次的自动提取不得覆盖手动修改。

Extractor 请求包含快照、现有索引、最多 5 条相关已有正文及墓碑键；无工具，maxOutput 为 `min(4096, 当前模型输出上限, floor(ContextWindow/4))`，模型未给输出上限时沿用现有 8192 默认值；关闭图片输出，采用该协议支持的最低思考级别。已有正文由确定性检索选出：明确主题键精确匹配优先，其次描述与用户文本的 Unicode 二元组重合数，降序取 5，同分按键排序。不把全部项目记忆装入请求。

模型仅返回 JSON：`{schemaVersion:1, mutations:[{operation:upsert|delete,key,type,description,body,sourceIds,verification,expectedRevision,validUntil?}]}`。空 mutations 是正常无内容可存。JSON schema 为服务端契约，不要求所有供应商提供原生 strict schema；解析允许一层外围 json 代码围栏，拒绝未知字段、重复记忆 key、重复 JSON 对象成员、无效来源、任意路径和超限。模型生成的 metadata／revision／projectId 不被接受。自动 delete 只能对应本轮真实用户明确忘记或明确纠正；没有明确来源时禁止删除。validUntil 的来源与预算验证见 1.8。

### 1.6 持久 outbox 与重启恢复

在 `ai.State` 增加版本化 `MemoryOutbox []MemoryTurnSnapshot`，旧 JSON 缺字段保持兼容。快照包含 project/session/turn、时间、epoch、modelRef、脱敏内容、snapshotHash 和 eligibility；不保存 Model.Key、Header、SSH 配置或认证文件路径。单会话最多 20 个待入队完整快照，达到上限时为新轮次保存小型 `backlog_full` 结果标记而不静默丢失；后台故障需在记忆页可见。已有记录不能被新轮次覆盖。

成功路径必须在 `ChatTurn` 的最终 `e.save(s)` 中同时保存 completed 状态和 outbox。独立快照通过 turn-local collector 收集，`compact` 不删除它；只有最终保存成功才通知服务入队。入队与 outbox ack 在锁外顺序执行：SQLite `INSERT ... ON CONFLICT` 成功后，再按 `(turnId,snapshotHash)` 从 AI 状态删除已入队 outbox；崩溃导致重复投递时以唯一键核对哈希，哈希不同报 `snapshot_conflict`，不得覆盖。

| 崩溃点 | 下次启动的处理 |
|---|---|
| 成功状态与 outbox 保存前 | 按现有逻辑中断会话，不提取未完成轮次 |
| outbox 已保存，SQLite 尚未入队 | 扫描会话 outbox，验证现存项目／会话／epoch 后幂等入队 |
| 入队完成，outbox 尚未 ack | 相同唯一键与快照哈希匹配后 ack，不新建第二任务 |
| queued／retry_wait | 按持久 nextAttemptAtMs 继续 |
| running 且旧 bootId 的租约 | 单后端锁取得后回收为 queued，不等待旧进程续租 |
| 模型已返回，事务尚未提交 | 可重新请求模型；变更在一次事务中幂等提交 |
| 事务已提交，Markdown 未完整发布 | 只重建文件与索引，禁止重复请求模型 |

启动顺序：取得现有后端锁 → 迁移／备份 → 初始化 Engine → `ReconcileMemoryOutbox` → `RecoverMemoryJobs` → `ReconcileMemoryFiles` → 开放 HTTP／启动 worker。单个无效旧状态文件产生有界错误记录，不阻止其他项目服务；不得通过 `Engine.get` 加载 outbox 而隐式恢复执行。检查已删除 session 时丢弃其尚未入库 outbox；已提交记忆保留来源 ID 与“来源会话已删除”标记。

worker 默认全局并发 1，每项目最多 1 个 running。使用数据库 claim、bootId 与随机 leaseToken；租约 90 秒，20 秒续租；模型请求总 timeout 60 秒，最多 3 次调用尝试，失败后 30 秒、120 秒退避。project revision 冲突不是模型失败：重新加载并最多重算 2 次，仍冲突置 `blocked/conflict`；总模型调用仍不得超过 3 次。429／网络／5xx 重试；凭据失效或模型停用置 `blocked/model_unavailable`；重复解析失败最终 `failed/invalid_output`。用户重试创建新 attempt 批次且保留累计用量，不制造新的 source turn。

后台请求复用 Engine 模型并发额度，并仅在没有主会话正在运行且额度可用时开始；已开始的请求最长 60 秒，新前台请求仍可使用剩余额度。唤醒间隔 5 秒，入队立即唤醒；等待时不持有 Store/session 锁。UI 切换／关闭页面不取消提取；后端退出取消网络请求、释放租约、等待 worker 最多 5 秒，之后旧 leaseToken 永远不能提交；队列留待下次启动。

项目手动编辑、忘记、关闭开关或软删除时递增 epoch，事务失效旧 queued/retry/running 任务；取消请求后再次校验 epoch/token，迟到结果不能写回。首版没有整项目清空 API，逐条忘记按相同规则执行。删除墓碑保留键及原内容哈希，自动提取不能重建同键；明确用户要求重新记住且携带 `restoreDeleted:true` 和墓碑实际版本的同步操作才解除该墓碑。首版不承诺通过文本相似度完全识别换名复述的旧事实，因此旧快照隔离、来源约束和墓碑同时使用。

### 1.7 API 与产品状态

API 全部沿用现有 Bearer/Cookie、Host、Origin 校验；projectId 从已校验 URL 取得，session 工具从服务端 session 取得。请求拒绝未知字段，正文体积限制 32 KiB。

| API | 契约 |
|---|---|
| `GET /api/projects/:id/memory` | settings、settingsRevision、projectRevision、最多 50 条索引、total、publication 状态；支持 query/offset/limit；默认过滤到期条目，面板可用 includeExpired=true 查看；可显式 includeDeleted 查询仅含键／revision 的墓碑 |
| `GET /api/projects/:id/memory/:key` | 完整脱敏正文、类型、首次／最近来源摘要、时间、validUntil、expired 和 revision；面板可查看已到期正文，模型读取工具只返回 expired 状态；墓碑返回 404 |
| `PUT /api/projects/:id/memory/:key` | `{type,description,body,expectedRevision,validUntil?,restoreDeleted?}`；创建 revision 0，恢复墓碑使用其实际 revision；冲突 409 |
| `DELETE /api/projects/:id/memory/:key` | `{expectedRevision}`；写墓碑并失效旧任务 |
| `PATCH /api/projects/:id/memory-settings` | `{useEnabled,extractionEnabled,expectedRevision}`；单独设置版本冲突 409 |
| `GET /api/projects/:id/memory-jobs` | offset/limit，最多 50；返回状态、时间、错误类别、usage；不返回快照全文／密钥 |
| `POST /api/projects/:id/memory-jobs/:jobId/retry` | 只接受本项目 blocked／failed／开关暂停的 skipped job，验证当前设置和 epoch；请求携带 expectedProjectRevision；人工确认重新基于当前 epoch 和集合版本提取，冲突 409，墓碑仍生效；快照已清理则返回 410 snapshot_expired，须新用户轮次提交 |

记忆页面初版打开时刷新，提取有活动任务时每 5 秒刷新，关闭页面停止轮询。无需为 `events.type` 加新值或给每个会话写事件。状态文字区分“等待提取、正在提取、已更新、无新记忆、已跳过、等待处理、提取失败”和文件同步状态，不展示模型原始思考。项目记忆使用说明明确“同项目会话共享；后台提取会使用当前轮次模型产生额外用量”。

### 1.8 ZCode 对照复核与补充契约

| 对照能力 | ZCode 固定基线 | Lake 首版决定 |
|---|---|---|
| 项目身份与四类记忆 | workspace identity／路径散列；user/feedback/project/reference | 已覆盖；用 Lake projectId，四类均限当前项目；无有效项目时不创建默认共享库、不入队 |
| 开关生效 | CLI 默认启用；桌面 app-global 总开关默认关闭；根 Runtime 创建时冻结 | 有意不同：项目两个开关默认开启、每轮重读；关闭使用同时禁止学习，并展示额外用量提示 |
| 索引刷新 | 初始化／cold resume 读取，同会话冻结 | 有意不同：每轮及同轮成功写入后刷新请求附件；不复制进 History |
| 写入与恢复 | 文件为权威；内存 cursor 和 latest-pending，不持久恢复队列 | 有意增强：SQLite 权威、文件投影、outbox／租约／幂等事务 |
| 提取输入 | 冻结成功分支及完整 Main provider context | 原方案过窄；增加最多两条真实用户前文作为解释资料，保留无工具 JSON 提取 |
| 读取与时效 | 主提示词要求核验文件／函数；相关条目链接；召回分支含陈旧提示 | 补主动查询、版本分页、关联链接、绝对日期／到期过滤与使用前核验 |
| 来源 | originSessionId 首次写入后保留 | 补首次来源与最近更新来源分离，并保留独立脱敏来源摘要 |
| Semantic Recall / Dream | 前者默认关闭；后者 handler 保留但未自动接线 | 有意延期，不能据此称“自动语义检索／整理已支持” |
| Custom Agent Memory | 自定义 Agent 独立 user/project/local 三种 scope | 有意延期；首版子 Agent 不直接读写项目记忆，主 Agent 仅传任务需要的有界背景；后续与多 Agent 方案另立契约 |
| 无人值守／失败调查 | 项目 Extraction 在成功 Main turn 后触发；任务恢复另有机制 | 有意延期：失败／输出超限不自动变成成功记忆；证据检查点由会话／任务持久化负责 |

**读取与忽略。** `list_project_memories.query` 最多 160 个 Unicode 字符，NFKC＋小写规范化。精确键匹配优先，其次名称／描述的子串匹配，再按 Unicode 二元组重合数降序；只返回正匹配项，同分按键排序。它只查本项目索引字段，不调用模型或跨项目扫描。无 query 沿用 1.2 的稳定排序。普通相关问题按需读取；真实用户要求“查记忆／以前约定／之前说过”时必须查询，不从索引缺项推断不存在；结果为空就说明未找到。允许正文 `[[key]]` 关联，关联不是授权，不自动递归展开，不存在的目标只显示缺失。单条超长行的分页须返回完整 UTF-8 边界的 byteOffset，并继续向前推进；每次最多 4 KiB/200 行，后续请求固定 expectedRevision。每轮已加载正文按 `(key,revision)` 去重，每次 provider 请求前按当前库版本屏蔽已失效／忘记的旧工具正文；同轮成功保存或忘记后刷新附件。

`ai.TurnInput` 与排队消息增加 `ignoreProjectMemory` 布尔值（默认 false，持久化在该轮输入而不是 session 默认）；聊天输入菜单提供“本轮忽略项目记忆”。`ResolveTurnMemoryPolicy` 同时识别真实 UserText 去空白后以独立首句 `本轮不要使用项目记忆`、`这次忽略项目记忆` 或 `Do not use project memory this turn` 开头的输入（句尾只接受句号、换行或文本结束），置 ignore=true；不在整段任意搜索，不解析引用／附件／工具指令。其他自然语言停用要求由主 Agent 遵循不引用记忆的规则，但不承诺其请求前已移除索引；UI 开关是明确的预注入控制。忽略时移除本轮索引、记忆工具及旧记忆工具正文，不运行本轮提取、不加入最近用户前文；下一轮恢复项目开关行为。不得宣称能从旧普通回答／摘要消除所有派生知识，沿用 1.4 的边界。记忆面板自身的人工管理操作仍可使用。

**事实与日期。** Prompt 规定一条一个可复用事实；feedback/project 要有事实、Why、How to apply；不自动复制代码结构、Git 日志、既有项目文档或当前调查进度，保留非显然的原因／约束与可复用外部运维经验。当前文件／资源观测优先；建议使用记忆里的路径、函数、服务状态前，通过正常只读工具核验，无法核验时说明仅为历史记录。此规则不额外授权访问资源。快照保存来源轮次的 UTC 时间与 IANA timeZone（用户会话时区，缺失固定 UTC，不能用 worker 运行时区替代）。相对日期换成确定的绝对日期；有歧义时保留来源原句及日期不确定标记，不猜测。`observedAt` 由实际 evidence 时间生成，没有 evidence 的条目为空；`updatedAt` 不是验证时间。`validUntil` 可空，只接受本轮用户明确给出的截止时间，禁止模型自行捏造 TTL；`now >= validUntil` 的条目不注入索引，不作为提取现有候选，工具返回 expired 状态，面板可查看／修改。未提供截止时间的事实也不能省略使用前核验。

**前文与来源。** 在 State 增加 `MemoryRecentUserInputs`，最多保留同项目／epoch 的两条已成功、未忽略记忆的真实用户输入（各 4 KiB UTF-8，合计 8 KiB，含 session/turn/timeZone），与成功状态一起保存；不含 assistant、tool、思考、摘要或读入记忆，清除会话／开关关闭／项目归属变化时清空。快照冻结前两条与本轮，并分配 `context:<turnId>`；context 仅帮助解释“按刚才说的习惯来”，每个变更仍须引用至少一个本轮 user/evidence 来源，不能只据 context 授权 delete／同步 save 或编造 observed。前文不足时 no_op，不猜测指代。除最近两条前文外不回填旧历史。

创建时固定首次 originSessionId/originTurnId；更新只改变 lastSourceSessionId/lastSourceTurnId 和最近 sourceIds。UI 人工操作记录来源 kind=manual-ui 及操作时间，不假装来自模型会话。`sourceSummaryJSON` 保存最多 8 项脱敏来源摘要，每项最多 1 KiB，合计 8 KiB，包括 kind、原会话／轮次／sourceId、时间、truncated 与摘录；正文不因任务快照清理而失去来源。来源摘要供用户核对，不能证明语义推断正确。忘记时同时清除它；来源会话删除只标记失联，不删除已提交的项目知识。分页的面板应能定位首次／最近会话，若现有 UI 无定位能力则展示来源 ID 和删除状态。

**预算、过期结果与保留。** 保存快照大小不等于请求可用预算。`FitMemoryExtractionInput` 在最终序列化请求上扣除系统提取 prompt、索引、已有正文、JSON schema 说明及 MaxOutput 预留，沿用模型 ContextWindow 估算；不足时依次减少已有正文、无关索引、旧前文、assistant 摘要、evidence 项，保持 sourceIds 与截断标记一致。本轮真实用户文本不得裁剪；仍放不下则 blocked/context_budget，不请求模型。收到 ErrModelOutputLimit、未完成流、无效 JSON 均整批拒绝，不解析前半段写库；至多按既有三次总调用限额重试，输出超限重试要求最多 2 项、短正文，输出预算不超过供应商上限。额外调用与失败用量计入 job Usage，不改变前台状态。

快照捕获 `knowledgeBaseRevision`（本轮开始时项目集合版本）与完成时间，后台 job 的 baseRevision 是执行时版本，两者不可混用。自动 upsert/delete 触及的已有条目若 `projectRevision > knowledgeBaseRevision`，且最新事实并非与候选完全一致，置 blocked/conflict；相同规范化内容为 no_op，不再修改来源。不得仅重取 expectedRevision 就覆盖较新知识。无关键变化可以在总三次调用内重算；人工重试界面必须提示冲突条目并显式以当前集合版本重新冻结基线，墓碑与明确来源规则仍生效。项目归属变化立即使相关会话 outbox／最近前文失效，既有快照不转投新项目；新的真实用户轮次重新确定归属。

worker 空闲每小时运行 `PruneMemoryArtifacts`：终态任务 7 天后清空 snapshotJSON/outbox 标记和已结算的完整模型引用，保留 snapshotHash、来源 ID 与用量；不清理 queued/running/retry_wait/blocked。终态 job 的详细数据 30 天后可清理，但先满足 outbox 已 ack、对应 commit 已发布、首次／最近来源摘要已落库；turn 唯一键与 snapshotHash/outcome、commit 的 job 去重身份保留为最小回执，直到源会话删除或源成功轮次被显式清除，使 applied/no_op/skipped/failed 的迟到 outbox 都不能重新生成任务。若 commit 引用 job 则保留 job 最小行，只移除详情，不破坏 FK。墓碑无自动 TTL。未 ack 完整快照最多 20 项，backlog_full 小标记也最多 20 项，更多失败累计到固定计数器及最近时间，避免 AI 状态无限增长。SQL 删除顺序须遵循 FK；删除会话的 outbox／原 AI 文件遵循现有生命周期。

## 2. Implementation Steps

任务表中的路径均相对仓库根目录，现有代码接缝见 1.1。未列出的运行模块不改动；任务仅在依赖完成后执行。每阶段均需通过本阶段列出的测试才能进入后续阶段。

### Implementation Phase 1

- **GOAL-001**: 建立可恢复的数据模型与 Markdown 投影。完成标准：TEST-001、TEST-002、TEST-003、TEST-010、TEST-021、TEST-026 通过；项目内提交有版本且可重建磁盘文件。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 创建 `internal/ai/project_memory_types.go`，定义 MemoryConfig、MemoryModelRef、MemoryTurnSnapshot、MemoryMutation、MemoryExtractionResult；创建 `internal/web/project_memory_types.go`，定义设置、条目、job、commit 及本方案容量／状态常量。字段与 1.2–1.8 一致，schemaVersion 固定为 1（本计划文档版本 1.1 不改变数据 schemaVersion）。无前置任务。 | No | — |
| TASK-002 | 依赖 TASK-001。在 `internal/web/store.go` 的 migrate 增加 `migrateProjectMemory` 前置检查和一致性备份；新表不得在原 schema 预执行时绕过备份。创建 `internal/web/project_memory_store.go` 的 MigrateProjectMemory、ReadProjectMemory、ListProjectMemories、CommitManualMemory、CommitMemoryExtraction，使用现有事务并实现版本／归属／容量校验。 | No | — |
| TASK-003 | 依赖 TASK-002。创建 `internal/web/project_memory_files.go` 的 RenderMemoryMarkdown、RenderMemoryIndex、PublishProjectMemory、ReconcileMemoryFiles；规范 frontmatter 和稳定索引，使用 platform 原子替换、权限和路径防护；从 SQLite 读取权威版本，文件失败不回滚已提交记忆。 | No | — |
| TASK-004 | 依赖 TASK-002、TASK-003。创建 `internal/web/project_memory_store_test.go / project_memory_files_test.go`，实现 TEST-001、TEST-002、TEST-003、TEST-010 中数据／投影检查；证明升级重复执行无重复表、无用户历史改写。 | No | — |
| TASK-021 | 依赖 TASK-002、TASK-003。在 `internal/web/project_memory_store.go / project_memory_files.go` 实现 ResolveMemoryValidity、BuildMemorySourceSummary，增加 1.8 的首次／最近来源、条目集合版本、observedAt/validUntil；RenderMemoryMarkdown 输出这些服务端字段；面板人工编辑来源标记 manual-ui；补 TEST-021、TEST-026。 | No | — |

### Implementation Phase 2

- **GOAL-002**: 同项目新会话和既有会话下一轮可加载索引，明确记住／忘记有同步结果。完成标准：TEST-004、TEST-005、TEST-006、TEST-022、TEST-023 通过。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | 依赖 TASK-001、TASK-002。在 `internal/web/agent.go` configure 注入服务器推导的 MemoryConfig；创建 `internal/web/project_memory.go` 的 BuildProjectMemoryContext 和 ResolveSessionMemoryProject；创建 `internal/ai/project_memory_context.go` 的 BuildMemoryAttachment、FitMemoryIndex，按 1.4 生成 request-local 消息；更新 engine.go/context.go/context_compaction.go 的预算与压缩接缝。 | No | — |
| TASK-006 | 依赖 TASK-005。创建 `internal/ai/project_memory_tools.go` 的 ProjectMemoryCatalog、ValidateMemoryToolArgs、HasExplicitMemoryIntent；更新 tools.go/catalog.go/tool-catalog.json 与 web bridge，提供 1.4 四个工具；同步修改持久化前后更新 epoch；只向主 Agent 暴露。 | No | — |
| TASK-007 | 依赖 TASK-005、TASK-006。创建 `internal/ai/prompts/project-memory.txt`，规定索引读取、历史事实、来源与授权边界及明确保存后才能确认；创建 `internal/ai/project_memory_context_test.go / project_memory_tools_test.go` 和 Web 接入测试，实现 TEST-004、TEST-005、TEST-006。 | No | — |
| TASK-022 | 依赖 TASK-006、TASK-007、TASK-021。在 `internal/ai/project_memory_context.go / project_memory_tools.go / turn_input.go` 实现 ResolveTurnMemoryPolicy、QueryProjectMemories、ProjectMemoryReadCursor，落实忽略本轮、query 排序、版本与长行分页、最新版本投影和同轮刷新；在 `internal/web/agent.go / message_queue.go / message_queue_store.go` 透传冻结的 ignoreProjectMemory；补 TEST-022、TEST-023。 | No | — |

### Implementation Phase 3

- **GOAL-003**: 中文有效输入产生有界快照，后台提取无执行权限并严格验证结果。完成标准：TEST-007、TEST-008、TEST-009、TEST-011 的提取部分与 TEST-024、TEST-025 通过。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-008 | 依赖 TASK-001、TASK-006。创建 `internal/ai/project_memory_trigger.go` 的 ShouldExtractMemory、CountMemorySignalRunes，使用 x/text/unicode/norm 和 unicode 类别；意图与长度分开，覆盖中文、混合语言和引用文本。 | No | — |
| TASK-009 | 依赖 TASK-008。在 `internal/ai/project_memory_snapshot.go` 实现 CollectMemoryTurnSnapshot、SanitizeMemorySnapshot；在 ChatTurn 和工具完成接缝维护 turn-local collector，保留原始 user、最终 assistant、限定 evidence，不从被压缩的 History 下标推导边界；State 增加 MemoryOutbox。 | No | — |
| TASK-010 | 依赖 TASK-001、TASK-009。创建 `internal/ai/project_memory_extraction.go` 的 ExtractProjectMemory、ValidateMemoryExtraction；创建 prompts/project-memory-extraction.txt；调用现有 stream 且 tools=nil，不建立聊天会话；实现相关条目选择、JSON 验证、来源／类型／删除规则、超限错误与独立 Usage 返回。 | No | — |
| TASK-011 | 依赖 TASK-009、TASK-010。在 `internal/web/model_providers.go / model.go` 实现 CaptureMemoryModelRef、ResolveMemoryModel，按固定 provider/model/fingerprint 解析现有模型及正常凭据；旧环境变量／旧单模型只允许 fingerprint 相同的配置，失效时 blocked，不静默切模型。 | No | — |
| TASK-012 | 依赖 TASK-008–TASK-011。创建 `internal/ai/project_memory_trigger_test.go / project_memory_extraction_test.go / project_memory_snapshot_test.go`，补 Web model 测试，实现 TEST-007、TEST-008、TEST-009、TEST-011；检查提取不会调用 bridge、审批或 shell。 | No | — |
| TASK-023 | 依赖 TASK-009、TASK-010、TASK-021、TASK-022。在 `internal/ai/project_memory_snapshot.go / project_memory_extraction.go / types.go` 实现 CaptureMemoryRecentUserInputs、FitMemoryExtractionInput、ValidateMemorySourceScope、RejectDuplicateJSONMembers；冻结有限前文、knowledgeBaseRevision、source UTC/timeZone；更新两份记忆 prompt 的日期、Why/How to apply、核验与整批失败规则；补 TEST-024、TEST-025。 | No | — |

### Implementation Phase 4

- **GOAL-004**: 完成回复到提取提交全链路持久化与重启恢复。完成标准：TEST-012–TEST-017、TEST-027、TEST-028 通过，故障注入后任务不丢失、变更不重复提交。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-013 | 依赖 TASK-002、TASK-009。在 engine.go 最终成功保存中写 outbox；创建 `internal/ai/project_memory_outbox.go` 的 ListMemoryOutbox、AckMemoryOutbox；创建 `internal/web/project_memory_outbox.go` 的 EnqueueMemoryTurn、ReconcileMemoryOutbox，唯一键与哈希校验；outbox 20 项上限及 backlog_full 可见标记按 1.6 实现。 | No | — |
| TASK-014 | 依赖 TASK-002、TASK-010、TASK-011、TASK-013。创建 `internal/web/project_memory_jobs.go` 的 ClaimMemoryJob、RenewMemoryLease、RecoverMemoryJobs、SettleMemoryFailure、InvalidateMemoryJobs；创建 project_memory_worker.go 的 StartMemoryWorker、RunMemoryJob、StopMemoryWorker，执行 1.6 的额度／超时／重试／epoch／leaseToken 规则。 | No | — |
| TASK-015 | 依赖 TASK-003、TASK-014。在 server.go New/Start/Close 接入恢复和退出顺序，在 agent.go／workflows.go 通过 outbox 通知唤醒 worker；在 navigation_trash.go 的项目软删除／恢复接缝使任务失效；后台提取不得调用 Store.Status/FinishReplyTiming 改变原回答状态。 | No | — |
| TASK-016 | 依赖 TASK-013–TASK-015。创建 `internal/web/project_memory_recovery_test.go / project_memory_worker_test.go`，在真实临时 SQLite 和 AI JSON 状态间注入每个崩溃点，实现 TEST-012–TEST-017；覆盖跨会话冲突、forget 后迟到结果、重启与退出。 | No | — |
| TASK-024 | 依赖 TASK-014、TASK-015、TASK-021、TASK-023。在 `internal/web/project_memory_jobs.go / project_memory_store.go / project_memory_outbox.go / project_memory_worker.go` 实现 ValidateMemoryKnowledgeBaseline、PruneMemoryArtifacts 和终态回执；落实旧任务覆盖拒绝、当前版本人工重试、项目迁移失效、7/30 天清理及 outbox 标记容量；补 TEST-027、TEST-028。 | No | — |

### Implementation Phase 5

- **GOAL-005**: 项目记忆可查看、编辑、停用与重试，完成签名构建和隔离环境验收。完成标准：TEST-018–TEST-020 及新增 TEST-021–TEST-028 全部通过，文档描述实际启用行为。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-017 | 依赖 TASK-014、TASK-015。创建 `internal/web/project_memory_routes.go` 实现 1.7 API；接入 server.go 路由；更新 `web-agent/shared/contracts.ts` 和 `web-agent/web/src/api.ts` 类型与方法；认证、归属、409、429／容量错误、分页和来源缺失显示固定契约。 | No | — |
| TASK-018 | 依赖 TASK-017。创建 `web-agent/web/src/ProjectMemory.tsx / projectMemoryState.ts`，更新 App.tsx 项目菜单和 styles.css；显示条目、来源、版本、开关、job 状态、文件同步与额外用量说明；编辑保存使用 expectedRevision，冲突保留草稿；面板隐藏停止定时刷新。 | No | — |
| TASK-019 | 依赖 TASK-017、TASK-018。创建 `internal/web/project_memory_routes_test.go` 和 `web-agent/web/test/project-memory.test.ts`，实现 TEST-018、TEST-019；测试项目切换时取消旧请求、拒绝旧响应回写。 | No | — |
| TASK-025 | 依赖 TASK-018、TASK-021、TASK-022、TASK-024。在 `web-agent/shared/contracts.ts / web-agent/web/src/api.ts / App.tsx / ProjectMemory.tsx / projectMemoryState.ts` 加本轮忽略菜单、名称描述 query、来源摘要／日期／过期状态和冲突重试提示；扩展 `internal/web/project_memory_routes.go` 的 query/includeExpired 和可选 validUntil 契约；在最终 fake provider HTTP 捕获中验证六协议主请求与无工具提取的附件／预算／忽略行为，覆盖 TEST-021–TEST-028 的跨层接缝。 | No | — |
| TASK-020 | 依赖 TASK-004、TASK-007、TASK-012、TASK-016、TASK-019、TASK-025。运行第 6 节验证命令；仅使用 scripts/build_lake.sh 构建 macOS 用户二进制，在隔离 home 完成两会话、中文、重启及忘记案例，保存 docs/validation/lake-project-memory.md；更新 README.md、web-agent/README.md 与本计划任务状态，实际完成后才改 status 为 Completed。 | No | — |

## 3. Alternatives

- **ALT-001**: 仅复用上下文压缩摘要。未采用，因为当前摘要属于单会话且会滚动改写，不能提供项目级来源、版本、编辑、忘记与提取任务恢复。
- **ALT-002**: 文件作为唯一真相、SQLite 只记文件名。未采用，因为模型提交、多个文件替换、索引更新与队列结算不能跨介质原子提交；采用 SQLite 原文事务与可重建 Markdown 投影。
- **ALT-003**: 原样移植 ZCode 五轮读写工具 Memory Agent。未采用，因为 Lake 首版只需从冻结快照学习，无工具 JSON 提取更容易限定权限和实现幂等提交；仍保留其项目身份、单条文件、索引、成功轮次触发思路。
- **ALT-004**: 首版接入 Semantic Recall、向量库或 Dream。未采用，因为用户范围是项目记忆、索引和自动提取，且上游此提交没有默认启用这些链路。后续必须基于记忆规模和检索测量另立方案。
- **ALT-005**: 普通回复结束时等待模型提取。未采用，因为模型延迟和失败会影响交互；只有明确用户要求的记忆工具同步提交，自动提取走持久队列。
- **ALT-006**: 仅在进程内排队并在重启时从最新 History 猜测遗漏。未采用，因为回复已保存但入队尚未发生存在丢失窗口，History 压缩与会话继续运行也会破坏稳定消息边界。
- **ALT-007**: 将 ZCode 的用户词数阈值直接用于中文。未采用，连续中文通常不含空格；使用 Unicode 类别与真实意图检测，并将寒暄规则作为独立过滤。

## 4. Dependencies

- **DEP-001**: 已有 Go 1.25、SQLite 驱动、Store 单后端锁、WAL 和迁移一致性备份；不新增外部服务、Node 运行时或向量库。
- **DEP-002**: 已有 `internal/platform` 原子替换／私有权限、Engine.stream 六协议模型适配和 modelSlots；模型认证只通过 Models 现有私有凭据路径解析。
- **DEP-003**: 已有 `golang.org/x/text/unicode/norm` 用于中文／混合输入规范化；`encoding/json`、`unicode`、`crypto/sha256`、`database/sql` 使用 Go 标准库。格式由服务端渲染，不新增 YAML 库。
- **DEP-004**: 已有 React、TypeScript、项目菜单、api.request 认证、前端 node:test 测试与构建入口；本计划不修改其依赖版本。
- **DEP-005**: TASK-020 依赖 macOS 已安装 Lake 签名身份；如缺少必须按 AGENTS.md 执行 setup 脚本。方案编写阶段不调用构建、不变更凭据。

## 5. Files

- **FILE-001**: `internal/ai/project_memory_types.go / project_memory_trigger.go / project_memory_snapshot.go / project_memory_outbox.go`：记忆类型、中文触发、脱敏快照、成功轮次持久 outbox 与 ack。
- **FILE-002**: `internal/ai/project_memory_context.go / project_memory_tools.go / project_memory_extraction.go` 与 `internal/ai/prompts/project-memory.txt / project-memory-extraction.txt`：索引预算、专用工具和无工具提取。
- **FILE-003**: `internal/ai/engine.go / types.go / tools.go / catalog.go / tool-catalog.json / context.go / context_compaction.go`：成功保存与快照接缝、目录权限和请求预算；不得改动普通工具授权。
- **FILE-004**: `internal/web/project_memory_types.go / project_memory_store.go / project_memory_files.go / project_memory.go`：规范化提交数据、迁移、版本、Markdown 投影与项目上下文。
- **FILE-005**: `internal/web/project_memory_outbox.go / project_memory_jobs.go / project_memory_worker.go / project_memory_routes.go`：入队、认领、恢复、生命周期和项目 API。
- **FILE-006**: `internal/web/store.go / server.go / agent.go / workflows.go / navigation_trash.go / model.go / model_providers.go`：迁移备份、主轮次接缝、启动退出、项目删除和模型引用解析；实施时保留当前工作区既有未提交修改。
- **FILE-007**: `web-agent/shared/contracts.ts / web-agent/web/src/api.ts / App.tsx / ProjectMemory.tsx / projectMemoryState.ts / styles.css`：契约、项目记忆面板和状态轮询。
- **FILE-008**: `internal/ai/project_memory_*_test.go / internal/web/project_memory_*_test.go / web-agent/web/test/project-memory.test.ts`：有意义的跨层、故障恢复和权限测试。
- **FILE-009**: `README.md / web-agent/README.md / docs/validation/lake-project-memory.md / plan/feature-project-memory-1.md`：使用、限制、运行验证与实施状态。
- **FILE-010**: `internal/ai/turn_input.go / internal/web/message_queue.go / message_queue_store.go`：排队输入的本轮忽略开关和服务器推导策略，保留旧消息缺字段兼容。

## 6. Testing

- **TEST-001**: 使用现有旧数据库 fixture 升级，验证新增记忆表前生成 `0600` 一致性备份，重复升级幂等，项目／会话／凭据引用不变。新库无历史迁移与旧 JSON 缺 memory 字段均可正常打开。
- **TEST-002**: 两个 projectId 的相同记忆键互不泄漏；项目重命名、资源路径改变与会话 cwd 改变不改变目录；跨项目 API／来源 ID 拒绝。
- **TEST-003**: 输入 501 条、超长描述／正文、路径穿越、符号链接、保留键、非法类型和无效版本均拒绝；索引稳定且完整行截断；中文 UTF-8 不被切坏；Markdown 正文能完整重建。
- **TEST-004**: 项目 A 的会话 1 提交一条记忆后，会话 2 首轮能看到索引并读取正文；会话 1 后续轮次看到更新；项目 B 不看到。覆盖 core、terminal2、db-query-editor 的主轮次以及资源／终端 AI 的真实项目归属。
- **TEST-005**: 模型请求体中记忆明确标记历史数据；记忆带“执行 rm／使用另一资源”等恶意文本不改变实际权限；索引预算不足时原用户文本和工具配对保留。重复轮次、压缩后和关闭使用后不残留 request-local 索引附件，关闭后旧记忆工具结果的正文不直接注入；既有普通回答／摘要保留且界面准确说明边界。
- **TEST-006**: 明确记住工具只有提交成功返回确认；失败不返回成功；忘记后正文与文件删除且保留无正文墓碑；普通自动提取不能重建墓碑键，用户显式 restore 可以。quoted“记住”与工具输出不能授权修改。
- **TEST-007**: `以后都用中文回答`、`这个项目发布前先备份`、中英混合、无空格中文、明确短“记住 X”按规则触发；`好的／谢谢／你好`、空白、标点、emoji 默认跳过；引用中 remember 不产生同步授权。
- **TEST-008**: extractor 返回空结果正常 no_op；重复键、未知字段、伪造 sourceId、路径、秘密值、observed 无证据、缺少 expectedRevision、输出截断／invalid JSON 均拒绝且不改数据库；以 fakeModel 检查 tools 为空、无 bridge／shell 调用。
- **TEST-009**: 本轮模型选择固定；切换前台模型不改变 queued job；移除／禁用原模型或失效凭据使 job blocked；修复后重试；六协议的有界文本 JSON 提取走已有适配器，不依赖 strict JSON schema 支持。
- **TEST-010**: Commit 已成功而文件写入失败／索引替换失败／publishedRevision 未更新时，读接口返回最新事务版本，重启重建正确文件且不调用模型；非规范／symlink 投影不被采纳。手动提交与 worker 发布重叠时整套文件来自同一 DB 快照，旧发布不能回退 publishedRevision，最终投影收敛到最新集合。
- **TEST-011**: 正常任务、错误、取消、子 Agent、压缩、已导入记忆与 extractor 自身的触发边界；同步记忆写入后后台仅考虑其他主题；快照／日志／DB／磁盘中不出现合成 API Key、SSH 私钥或认证 Header。
- **TEST-012**: 子进程或注入错误覆盖 1.6 崩溃矩阵全部边界，重新打开真实临时 SQLite 和 AI JSON 后验证 task 不丢失、同 turn 只一条 job、同 job 只一条 commit。
- **TEST-013**: compact 替换 History、同会话后续轮次、outbox ack 崩溃和乱序投递均不改变已冻结快照；snapshotHash 冲突拒绝；单任务失败不推进或吞掉其他 turn；outbox 满载产生可见 backlog_full。
- **TEST-014**: 两个同项目会话并发提取／手动修改发生 revision 冲突，结果不覆盖新版本；忘记、关闭开关或项目删除使 epoch 失效，取消无响应的旧模型迟到结果也不能提交。
- **TEST-015**: 429／网络／5xx 退避次数与 nextAttemptAtMs 重启后保留，三次失败达到终态；旧 boot 租约回收，旧 token 不能提交；model_unavailable 无无限重试；人工 retry 保留累计 Usage 和源 turn 身份。
- **TEST-016**: 退出取消提取、等待 worker 有界、Store 关闭后无写入；重新启动继续队列；页面关闭不取消队列；原普通回复成功、耗时和停止状态不因提取等待／失败变化；前台运行时后台不新占用模型槽。
- **TEST-017**: 项目软删除不运行旧任务，恢复项目后记忆保留但旧 job 不自动执行；来源 session 删除后提交前 job skipped，既有条目显示来源已删除；Clear 会话 History 不破坏已入队项目 job／独立来源快照。
- **TEST-018**: API Cookie/Bearer、Host/Origin、非本项目 job/key、409 乐观锁、32 KiB 请求体上限、分页、无效字段均覆盖；列表不返回快照全文、密钥或认证引用。
- **TEST-019**: 前端修改冲突保留草稿、项目切换拒绝迟到响应、开关与错误状态可操作、界面关闭清理计时器；提取完成正常刷新，来源已删除可读；使用与提取开关区别明确。
- **TEST-020**: 签名二进制、隔离 home、合成 fakeModel 完成“中文要求记住 → 同项目另一会话读取 → 后端重启仍在 → 排队提取跨重启续跑 → 忘记后旧任务不恢复”验收，验证现有命令审批及重启不自动重放。保存脱敏证据和环境信息。
- **TEST-021**: 来源轮次处于 UTC 日期边界且 worker 使用另一个时区时，相对日期按来源 timeZone 转换；有歧义不猜测。validUntil 截止时刻过滤索引／工具候选，面板仍可查看；updatedAt 不伪装为 observedAt，缺证据不生成验证时间。
- **TEST-022**: 项目有 500 条而默认索引最多 200 行时，query 仍可找到未注入条目；中文、中英混合、精确键、零结果与同分稳定顺序正确，不增加模型调用。16 KiB 单行正文可分段完整读取且游标推进；分页间编辑／删除返回 conflict／deleted，不混入旧页；墓碑实际 revision 可获取，明确 restore 才可重建。关联缺失不递归或扩大权限。
- **TEST-023**: 四种 use/extraction 设置组合准确；use=false/extraction=true 不读、不学。ignoreProjectMemory 随排队输入冻结，下一轮恢复；明确首句可停用、引用内同句不触发；新正文／忘记后本轮后续请求投影更新。六协议最终 HTTP 请求中无被屏蔽正文，旧 native 消息不绕过投影；当前用户原文和工具配对不变。
- **TEST-024**: 前一轮“本项目发布前先备份”之后“对，就按这个习惯来”可得到正确偏好；超过两条的前文不可引用，压缩／重启不改变冻结内容。只有 context 来源、错项目／epoch 前文、引用内忘记、assistant 推测均不能提交；ignored 输入不进入后续前文。
- **TEST-025**: 小窗口模型＋大快照＋长已有条目时，最终请求仍适配预算，mandatory user 太大则 blocked/context_budget 且零请求。输出 length、未完成 stream、半段 JSON 和重复对象字段零提交；至多三次调用，失败／重试 Usage 累计，降为最多 2 项的输出重试不突破模型上限、不影响主回答。
- **TEST-026**: 会话 A 首次创建、B 更新、UI 再编辑后，首次来源不改、最近来源准确且 manual-ui 不伪造会话来源；来源会话删除显示失联。7 天快照清理后独立摘要仍可核对，摘要脱敏且有界，忘记同时清空摘要与正文。
- **TEST-027**: 旧 job 因退避／迟到 outbox 晚于新 job 到达时，不能仅重取 expectedRevision 覆盖新事实；相同内容 no_op，无关键变化允许有限重算。冲突人工重试要求当前 expectedProjectRevision，过期值 409；源会话移到另一项目时旧 outbox 不迁移，新轮次才能在新项目学习。
- **TEST-028**: 注入时钟测试 7/30 天边界、待处理不清理、清理过程中崩溃及 FK 顺序；applied/no_op/skipped/failed 回执保留时迟到 outbox 不再创建任务。未发布 commit 不提前清理；快照清理后的 retry 返回 410；backlog_full 多于 20 条只累加计数，不无限增长 AI 状态。

实施验证命令，方案编写阶段不执行运行测试：

```sh
go test ./internal/ai ./internal/web
go test -race ./internal/ai ./internal/web
go test ./...
pnpm --dir web-agent check
pnpm --dir web-agent test:frontend
pnpm --dir web-agent build:web
scripts/build_lake.sh
codesign --verify --strict bin/lake
```

故障测试必须使用实际事务与持久文件，不能仅比较内存数组。浏览器验收使用独立 home／动态端口，记录签名身份、测试模型和恢复前后 job/commit 数量；不读取用户真实 secrets 文件。

补充验收以最终 provider HTTP body 为准，分别覆盖六种协议的主 Agent 与无工具提取；不能只检查 BuildMemoryAttachment 返回值而漏掉适配器重排、native 历史或重复注入。相关情景使用固定中文文本与合成来源，动态 session/turn/time 字段可规范化，正文、顺序、工具配对、预算和忽略后的缺失字段必须断言。

## 7. Risks & Assumptions

- **RISK-001**: 已有 engine.go 的成功保存 defer 持有 session.mu，event 又访问 Store；若在锁内入队／ack 易死锁。实施必须在最终状态快照保存后释放锁，再通知／入队；后台不得回调普通会话状态事件。
- **RISK-002**: 文件与 SQLite 双介质不可同时原子提交。SQLite 为权威、文件可重建且所有读经服务；禁止用“文件存在”推断任务已完成。直接编辑投影目录首版不导入，UI 需提示通过项目记忆面板修改。
- **RISK-003**: 两个会话自动修改相同知识可能冲突；串行 worker、expectedRevision、epoch 和有限重算避免覆盖用户编辑。墓碑不能完全判断换名的语义重复，保留来源限制并通过后续测量再考虑相似度审查。
- **RISK-004**: 自动提取产生额外模型费用与后台延迟。默认一次请求、最大三次调用、单 worker、快照与输出预算及独立 Usage 控制成本；指数退避不可通过重启重置。
- **RISK-005**: 模型会把“计划执行”或 assistant 推测写成事实。严格 sourceIds 与 verification 验证，observed 限定真实完成证据；提取失败／no_op 不影响正常回答，不能编造记忆成功。
- **RISK-006**: 记忆中的指令注入、秘密值或旧健康状态可能误导操作。保留专用历史数据包装、服务器执行边界、来源时间和全链路脱敏；任何记忆均不扩展当前权限。
- **RISK-007**: 前台长期繁忙时后台可能积压；outbox 上限、队列状态与 backlog_full 必须可见。首版不以不断启动提取抢占前台资源，也不承诺固定完成时限。
- **RISK-008**: 无工具提取缺少 ZCode 完整 Main context，有限前文只能解释部分指代；资料不足必须 no_op。初期用 TEST-024 的多轮中文样例评估，不把增加旧会话全量输入当默认补救。
- **RISK-009**: CAS 只阻止并发提交，不保证较晚执行的任务代表较新事实；需同时比较冻结 knowledgeBaseRevision，人工重试明确更新基线。日期过滤也不能保证未到期知识仍准确，主 Agent 使用前必须核验。
- **ASSUMPTION-001**: 用户此轮要求的是实施方案，只创建本计划，不开始运行代码修改、构建、部署或重启。
- **ASSUMPTION-002**: 当前 Lake Web 数据目录只由一个已取得 server.lock 的后端写入；若后续支持多节点共享数据库，需另立分布式租约与文件发布方案。
- **ASSUMPTION-003**: “跨会话”首版指同项目不同会话，包含资源／终端 AI；项目内的 user 类型不表示全局用户档案。跨项目共享、自动历史回填与无人值守事件触发不在本轮范围。
- **ASSUMPTION-004**: 外部 Markdown 直接编辑与第三方索引兼容首版只提供导出格式，不提供双向同步；通过 API／UI 编辑具有完整来源、版本与恢复保证。

## 8. Related Specifications / Further Reading

- [Lake 当前发布架构](../README.md)
- [Lake Go 工作台、数据与启动恢复](../web-agent/README.md)
- [仓库签名与凭据规则](../AGENTS.md)
- [Lake 会话权限方案](feature-session-permissions-1.md)
- [Lake 终端 AI 与资源访问边界](feature-hexhub-terminal-parity-1.md)
- [Lake 多 Agent 与后续复盘知识范围](architecture-lake-multi-agent-1.md)
- [Lake 会话压缩与首轮工具恢复](refactor-context-turn-recovery-1.md)
- [ZCode Memory 设计 v4：产品开关、Custom Agent 与 provider 验收](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/docs/design/v2/memory/README.md)
- [ZCode 项目记忆身份](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/memory/project-root.ts)
- [ZCode 记忆格式与索引规则](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/context/sections/memory.ts)
- [ZCode 索引加载](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/methods/context.ts)
- [ZCode 成功轮次后台提取入口](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/helpers/project-memory-extraction.ts)
- [ZCode 提取调度及真实用户文本判断](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/memory/extraction.ts)
- [ZCode Memory Agent 工具边界](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/memory/memory-agent-loop.ts)
- [ZCode 当前关闭的 Semantic Recall 分支](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/memory/project-memory-retrieval-branch.ts)
- [ZCode 尚未自动接入的 Dream handler](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/helpers/project-memory-dream.ts)
- [ZCode 自定义 Agent 独立持久记忆 scope](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/subagent/persistent-memory.ts)
