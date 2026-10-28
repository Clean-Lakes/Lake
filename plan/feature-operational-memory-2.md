---
goal: 为 Lake 建立可追溯、按资源隔离、按需读取且不会把历史现场当成当前事实的运维记忆
version: "2.1"
date_created: 2026-10-23
last_updated: 2026-10-28
owner: Lake
status: In progress
tags: [feature, architecture, memory, sre, migration]
---

# Introduction

> 2026-10-28：[自然记忆重塑计划](feature-natural-memory-1.md)承接统一记忆体验，扩展用户级偏好、自然长期意图、提交后轻提示/撤销及压缩前增量采集。本计划继续规定项目/资源事实的隔离、时效、来源和 V2 验收；“项目为隔离上界”针对项目事实，不表示允许跨项目共享事实。当前 `operationalMemoryV2Ready=false`，本次文档不改变门控，也不解除尚缺的验收要求。

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

本方案把 Lake 现有项目记忆升级为运维记忆 V2：每次请求只附带与当前问题相关的短索引，模型需要时分页读取专题；一次真实用户轮次完成后，在后台提炼有来源的增量。资源范围、事实发生时间和适用条件必须随记忆一起流转。

用户应得到的效果是：Lake 能记住“这个项目通常怎样排查和发布”，能找到“上次在哪台资源上看到过什么”，也能明确说明“这条记录已经过期，需要重新检查”。记忆不能替代当前授权、现场采样或执行结果。

本文是实施规格，当前正在开发；未通过验收的能力保持关闭。代码基线为 `origin/develop` 的 `eb4d90028b1c2e0b870475f44445f5613b185bba`，不将未合并 PR、旧验收记录或 Zcode 截图视作当前实现证明。仓库相对路径均以 Lake 根目录为基准；任务表记录代码状态；完整验收结果和剩余门槛见 [V2 验证记录](../docs/validation/lake-operational-memory-v2.md)。

### 当前能力与缺口

| 环节 | 基线已有实现 | V2 要补齐的行为 |
| --- | --- | --- |
| 存储 | SQLite 为事实源，Markdown 为可重建投影；项目 ID 隔离、revision、epoch、删除墓碑 | 结构化资源绑定、事实类型、来源记录、适用条件、复核与冲突状态 |
| 索引 | `ProjectMemoryIndex()` 按类型和更新时间排列，上限约 199 条、24 KiB | 先过滤范围，再按问题检索，最多 12 条、3 KiB；正文按需读取 |
| 范围 | `resourceIdsJSON` 已有列 | 写入、读取、工具、界面没有形成资源隔离闭环；不能视作已实现 |
| 来源 | 来源会话/轮次、摘要、`user-stated/observed/reference` | 工具执行身份、真实采样时间、完成状态与资源代次由运行时提供，不能由模型自报 |
| 时间 | `observedAt`、`validUntil`、过期过滤已有部分实现 | 区分内容编辑与新采样；资源配置改变立即失配；按知识种类设定有效期 |
| 提炼 | 成功轮次快照、outbox、持久任务、租约、重试、CAS、最多 5 条变更 | 严格证据资格、候选复核、前台抢占、预算、冲突处理 |
| 优先级 | worker 开始前检查 `runningMessages` | 前台新请求到达时取消正在进行的提炼，并拒绝迟到提交 |
| 管理 | `ProjectMemory.tsx` 支持搜索、编辑、到期时间、来源摘要、任务重试 | 范围与时间可见、来源跳转、待复核、冲突比较、本轮读取足迹 |

补充：当前 `MemoryEvidence.Completed` 的判断偏宽，不能仅凭可解析 JSON 或没有 Go error 认定采样成功；运行中、未派发、非零退出与结果未知必须单独识别。现有 `TargetScope` 由受信任后端提供，可复用；资源目录名称不是独立的环境或 Kubernetes 集群身份。

## 1. Requirements & Constraints

- **REQ-001**: 保留短索引、专题按需读取、后台增量提炼三层结构。主请求检索不得额外调用模型，不引入向量服务、外部数据库或独立 Agent 执行循环。
- **REQ-002**: 项目始终是隔离上界。绑定资源的记忆只能出现在包含其完整资源集合的当前目标范围内；模型自行提交的项目、目录、环境名称不能扩大范围。
- **REQ-003**: 一条记忆描述一个原子事实或一条方法。正文必须说明适用条件、事实/方法、来源、限制和再次使用前的检查点；多资源关系不能降格为任一单资源的事实。
- **REQ-004**: 区分偏好、方法、拓扑、配置和历史事故经验。实时健康、连通性、瞬时指标、待执行计划与未证实猜测不进入长期记忆。
- **REQ-005**: `observedAt` 只来自新证据，`updatedAt` 只表示条目变更。编辑文字、重建文件、重新提炼和用户点击复核均不得伪造新观测。
- **REQ-006**: 所有读取入口执行相同的项目、资源、代次、时间、状态检查；包括模型知道 key 后直接读取、分页续读和缓存命中。
- **REQ-007**: 用户能查看、修改、停用、明确遗忘和恢复条目；能单独关闭使用或提炼。后台不能删除、恢复墓碑、扩大适用范围或覆盖用户修正。
- **REQ-008**: 前台调查优先；提炼队列可恢复、幂等、有上限，候选不能在用户遗忘或资源切换后迟到生效。
- **REQ-009**: 保留最小来源和可定位的证据引用。原会话或证据不可用时明示不可用；不得为了补来源自动连接主机或调用外部系统。
- **REQ-010**: 迁移不自动信任旧条目、不扫描历史会话补写、不消耗模型费用。旧条目进入待复核区，用户确认范围后才参与召回。
- **REQ-011**: 记录本轮注入和实际读取的条目版本；界面显示“已读取”，不根据读过推断模型已采纳或操作已成功。
- **SEC-001**: 记忆正文、索引、来源摘录、文件和模型输出均为不可信资料。它们不能授权 SSH、SQL、MCP、部署、重试，也不能改变工具权限或结果未知的操作账本。
- **SEC-002**: 模型 API Key、密码、私钥内容、连接串凭据不进入任何记忆、索引、快照、候选、日志、导出及测试产物；已有脱敏加明确字段白名单双重校验，保存失败时不打印原文。
- **SEC-003**: Markdown 投影沿用目录 0700、文件 0600、原子替换及符号链接拒绝；不把直接编辑投影当作写入数据库的入口。
- **SEC-004**: 遗忘时清除条目正文、历史版本正文、来源摘录、关联候选及投影，只保留不含原文的防复活墓碑；不修改原会话、原执行证据及操作账本。已存在的用户备份不被静默改写，界面说明备份可能仍含旧记忆。
- **CON-001**: 使用现有 Go、SQLite、官方 ADK、React 和共享 contracts。记忆提炼复用 `ExtractMemory` 的无工具模型调用，不另造主模型/工具循环，不修改策略学习系统的职责。
- **CON-002**: Dev 验收只使用独立 Home 或 `~/.lake-dev`；签名构建使用 `scripts/build_lake.sh`，安装只使用 `scripts/build_lake_desktop.sh --dev --install` 和 `~/Applications/Lake Dev.app`，不接触正式版 Home、凭据或客户端。
- **CON-003**: 所有界面遵守 `docs/ui-guidelines.md`，选择字段使用 `AppSelect`，图标使用 `Glyph`，字体与主题沿用共享变量；验证键盘、深色和窄窗口。
- **CON-004**: 用户已授权开始实施；代码在独立分支形成草稿 PR 到 `develop`，能力门控仍关闭。合并、发布和生产安装分别需要明确授权。
- **PAT-001**: 采用“受信任执行元数据 → 可验证来源 → 有界候选 → 事务提交 → 可重建投影”的写入链路；使用“范围过滤 → 状态过滤 → 本地排序 → 短索引 → 分页正文”的读取链路。

### 1.1 记什么、不记什么

保留现有 `type=user|feedback|project|reference`，以兼容原分类和用户习惯；新增独立的 `knowledgeKind` 表示事实性质，不能用 `type` 推断时效。`verification` 保留 `user-stated|observed|reference`，仅表示来源性质，不代表结论已经被系统证明。

| knowledgeKind | 例子，均为虚构 | 默认范围 | 默认有效期 | 使用语义 |
| --- | --- | --- | --- | --- |
| `preference` | “本项目排查报告先给证据与结论” | 项目 | 无自动到期 | 持续偏好，可被用户修改/遗忘；不能授权执行 |
| `procedure` | “此部署方式更新前核对镜像摘要，再检查 rollout” | 项目或资源集合 | 无自动到期 | 条件式方法；工具与路径依然要核实 |
| `topology` | “应用 A 的数据库域名曾解析至资源 B” | 明确资源集合 | 7 天 | 历史线索，重新确认当前指向 |
| `configuration` | “应用 A 在版本摘要 D 中监听 8080” | 明确资源集合及 subject | 24 小时 | 必须比较适用版本并核实现状 |
| `incident_lesson` | “版本摘要 D 的配置路径错误曾导致启动失败” | 明确资源集合及历史 subject | 无自动到期 | 永远按历史案例表述，不能推出当前故障原因 |

`topology/configuration` 有效期从 `observedAt` 起算；用户陈述无现场证据时从 `assertedAt` 起算，且保持 `user-stated`。用户可以缩短有效期；延长或重新激活必须增加新的相应来源，单纯修改到期日期不能刷新旧事实。其他种类允许用户主动设置到期日期。

自动提炼直接丢弃“SSH 现在连不上”“CPU 当前 95%”“这次发布准备回滚”等瞬时信息。失败现场仍保存在原会话和证据里；只有经证据支持的条件式事故经验可成为候选，例如“遇到相同错误时先检查代理端口”，不能记成“这批主机永远无法登录”。

### 1.2 数据结构与存储选择

SQLite 继续为唯一事实源。为了避免旧客户端忽略新增范围字段后把 V2 全部条目注入模型，V2 正文使用独立表；现有队列、设置、事务提交与 outbox 机制继续复用。仅给 `projectMemories` 增加字段不足以实现降级隔离。

新增表的字段规范如下；`TEXT` 时间为 UTC RFC3339Nano，JSON 均由服务端规范序列化；所有外键和索引在迁移中建立。

| 表 | 主键和关键字段 | 约束 |
| --- | --- | --- |
| `projectMemoryMetaV2` | 单行 `id=1, schemaVersion=2, migratedAt` | 已迁移标记与数据搬迁同事务提交；未来版本大于 2 时 V2 启动失败 |
| `projectMemoryEntriesV2` | PK `(projectId,key)`；原 type/description/body/revision/projectRevision/contentHash；`knowledgeKind, scopeKind, scopeHash, subjectJSON, claimJSON, factKey, bindingsJSON, verification, assertedAt, observedAt, validUntil, reviewState, alwaysReference, originSessionId, originTurnId, createdAt, updatedAt, deletedAt` | key 沿用原正则且不能为 `memory`；scopeKind 为 project 或 resources；reviewState 为 active、needs_review、conflict、disabled；alwaysReference 默认 0；活动条目上限 500/项目 |
| `projectMemoryRevisionsV2` | PK `(projectId,key,revision)`；规范化条目快照、`changeKind, changedAt` | 每条最多保留最近 20 个版本；遗忘清除所有内容版本；回退内容仍产生新 revision，不能刷新观测 |
| `projectMemorySourcesV2` | PK `sourceId`；`projectId,key,entryRevision,kind,sessionId,turnId,callId,evidenceId,resourceId,resourceGeneration,observedAt,assertedAt,outcome,excerpt,sourceHash,claimSupport` | 每条来源摘录最多 512 UTF-8 字节；每条保留最近 8 个完整来源；被轮换掉的来源只留 ID/摘要哈希，不保留原文 |
| `resourceMemoryGenerations` | PK `resourceId`；`generation,updatedAt,reason` | generation 起始为 1，只在受信任资源事件中增加；不保存凭据或凭据哈希 |
| `projectMemoryCandidatesV2` | PK `candidateId`；`projectId,jobId,candidateHash,baseKey,baseRevision,proposalJSON,reason,status,createdAt,expiresAt` | status 为 pending、accepted、rejected、expired；有效 pending 上限 100/项目、30 天到期；与 jobId+candidateHash 唯一去重 |
| `projectMemoryJobAttemptsV2` | PK `attemptId`；`jobId,projectId,startedAt,finishedAt,status,inputUsage,outputUsage,usageKnown,modelRefHash,reason` | 每次实际派发独立记账；迟到响应只能补用量，不能提交记忆；未知用量保持未知 |

补充索引：entries `(projectId,deletedAt,reviewState,knowledgeKind)`、entries `(projectId,scopeHash,factKey)`、sources `(projectId,key,entryRevision)`、candidates `(projectId,status,createdAt)`、attempts `(projectId,startedAt)`。相同作用域内的活动 `factKey` 只允许一条；冲突版本进入候选，不建立两条互相矛盾的活动事实。

活动资源条目的 `bindingsJSON` 为按 resourceId 排序的非空数组 `[{resourceId,generation}]`；项目范围必须为空数组。迁移或范围不明的待复核条目允许 `scopeKind=resources, bindingsJSON=[]`，但永远不能参与普通召回，接受前必须补齐。`scopeHash=SHA256(scopeKind + 规范化资源ID数组 + subject 的稳定身份部分)`。generation 不属于逻辑事实身份，读取资格另外比较 generation，避免连接更新后生成重复事实。

`subjectJSON` 结构固定为 `{kind,identity,qualifiers,conditions}`：kind 为 `none|service|kubernetes_workload|database|artifact`；identity 使用来源已验证的对象 ID、Kubernetes UID 或规范名称；qualifiers 仅允许 `namespace,workloadKind,workloadName,workloadUID,imageDigest,configRevision,serviceName,databaseName`。conditions 为供人阅读的适用条件，不参与授权。未通过结构化执行元数据证明的字段保留为空，不从 shell 文本猜测集群或版本身份。

`factKey` 为最多 96 字符的 `[a-z0-9][a-z0-9._:/-]*` 原子事实名，例如 `service.listen-port`。新建候选由模型提出 factKey，服务端验证格式；它不是安全身份。仅当 scopeHash、factKey 和候选源条目 revision 都匹配，才允许自动去重；语义近似但 key 不同只提示人工合并，不调用模型自动融合。

正文上限沿用 16 KiB、description 上限 160 Unicode 字符。专题模板固定为“事实或方法 / 适用条件 / 为什么值得保留 / 再使用时检查 / 已知限制”；来源、时间、状态由服务端元数据渲染，正文中自称“已验证”不能覆盖元数据。

迁移旧条目的 factKey 固定为 `legacy.<原key>`，scopeHash 使用不可召回的 `legacy:<原key>` 哨兵值；复核接受时重新计算 scopeHash。配置/拓扑的 subject 稳定身份不含 imageDigest/configRevision，这两项属于适用版本条件，避免同一事实每次发版都绕开冲突检测。未知必要身份不能用空字符串拼成共享 scope。

### 1.3 范围判定：资源是身份，目录是入口

1. 服务端从当前项目、真实用户引用、`TargetScope` 和现有资源许可解析出允许集合 A，以及当前任务目标集合 T。T 必须为 A 的子集；目录引用在本轮解析为具体资源 ID，不把目录名称存作永久授权。
2. 资源记忆绑定集合 R 必须非空且 `R ⊆ T`；关系事实要求整个 R 同时满足，不能只因命中一个端点就注入。未知或有歧义的 T 不召回任何资源事实，只允许项目偏好和无资源依赖的方法。
3. 所有 R 的资源必须仍属于该项目、处于活动状态且可被当前会话引用。代次不符时仅能作为历史资料读取；普通索引不展示。
4. 当前 subject 身份由结构化可信结果提供时进行精确匹配。用户提到了服务名称但尚无稳定 subject 身份时，只展示匹配名称的历史线索并明确“适用版本待核实”；不得给出“当前有效”标签。
5. 主机只是通往集群的入口。不同主机不能仅凭同一目录名称被视为同一 Kubernetes 集群；没有经验证的集群统一身份前，不跨主机自动复用集群配置事实。

本版不新增环境/集群资产体系。“生产”“测试”“某集群”可以作为显示标签，但隔离依靠项目、资源 ID、对象身份。需要跨跳板共享同一集群知识时，先由用户明确关联稳定集群身份；该能力留在后续资产建模，不让模型猜测关联。

资源代次事件固定如下：

| 事件 | generation 行为 | 条目行为 |
| --- | --- | --- |
| 改名、拖动排序、移动资源目录 | 不变 | 身份仍匹配；显示名实时读取 |
| SSH host/port/username、认证方式/凭据轮换、执行 Shell 改变 | +1 | 绑定旧代次的条目变为失配；在途旧证据不能提交 |
| 其他资源连接配置变更，包括依赖 SSH 资源的有效连接变化 | +1；受依赖资源也 +1 | 同上；由资源写入路径发事件，不比较带秘密的原始 JSON |
| 归档、恢复资源 | 每次 +1 | 恢复不能自动让旧记忆重新生效 |
| 克隆、重新导入为新资源 | 新 ID、generation=1 | 不继承原资源记忆 |
| 原地应用发布、镜像或配置改变，Lake 未收到资产事件 | 不假定已检测 | subject/有效期辅助筛选，实际使用前仍需现场核对 |

### 1.4 来源资格与时间状态

新增 `MemoryEvidenceContext`，由实际执行器/桥接器登记：`callId, evidenceId, resourceBindings, subject, startedAt, finishedAt, outcome, exitCode, truncated, claimSupport`。模型 arguments、回复正文和远端返回的同名字段都不能覆盖此结构。没有受信任资源映射的 MCP 输出不能自动生成资源事实。

`outcome=completed_success` 要求派发已完成、效果可判定、无工具错误；有退出码时必须为 0；running、cancelled、not_executed、unknown、非零退出都不符合。`completed_failure` 可以支撑“某次故障现象”的事故候选，不能支撑操作成功或当前不可用。`claimSupport=metadata|structured_result|text_excerpt` 表明证据能支持到哪一层；成功退出只证明命令完成，不能自动证明健康恢复或根因成立。

自动生效条件：偏好/方法须有本轮真实用户陈述；拓扑/配置须有 `completed_success + structured_result`，并且事实字段能逐项对应结果字段。通用 shell、日志、任意 MCP 文本解释得到的结论默认进入待复核；不以一段自然语言的相似度冒充机械验证。事故经验默认进入待复核，复核只确认其历史适用性。

`claimJSON` 格式为 `{field,value,sourceId,jsonPointer}`，value 只允许单个 string/number/boolean 或有界字符串数组。结构化事实必须由受信任工具适配器提供字段定义和值类型，服务端按来源 JSON Pointer 逐项等值比较；没有适配器的字段一律进入候选。直写时由服务端用这些字段生成事实正文，不能验证一个端口字段却采纳模型正文里的其他结论；模型生成的附加解释留在待复核区。首版不为通用 shell/MCP 增加“自动理解输出”的适配器。

| 时间字段 | 含义 | 允许的写入者 |
| --- | --- | --- |
| `createdAt` | 首次建立条目 | 服务端提交时钟 |
| `updatedAt` | 本版本内容/状态变动 | 服务端提交时钟 |
| `assertedAt` | 用户明确陈述的时间 | 真实消息记录 |
| `observedAt` | 证据的采集完成时间 | 执行元数据；多证据事实取必要证据中最早完成时间 |
| `validUntil` | 本次事实的有效期上界 | 服务端按知识种类计算，与用户缩短值取较早者 |

读取时计算 `eligibility`，不依赖定时任务及时刷新数据库。优先级：`deleted → disabled → needs_review/conflict → archived/missing_resource → generation_mismatch → expired → eligible`。eligible 仅代表可召回，界面显示“范围匹配”，不显示“现场已确认”。事故经验另带 `historical=true`，无论是否过期都不得当作当前状态。

仅编辑标题、description 或排版元数据时保留原观测时间。人工改变拓扑/配置正文、范围或 subject 时，新版本改为 user-stated、observedAt 留空，旧观测仍保存在旧版本/来源；validUntil 不得晚于旧版本。新建的用户陈述才按 assertedAt 计算首次有效期；编辑旧事实不能借 assertedAt 延长它。真实重新采样并通过校验后，才填写新的 observedAt 并重算时限。

过去记录可通过显式“查历史记录/上次情况”的入口读取：保留范围校验，放宽时间/代次过滤，标题附失效原因、观测时间与旧代次，正文包装为历史资料。跨项目、目标不包含全部资源的记录仍不可读。

### 1.5 读取流程与上下文预算

```mermaid
flowchart LR
    U[真实问题与当前目标] --> S[服务端确定项目和资源范围]
    S --> F[过滤状态 时间 资源代次]
    F --> Q[本地检索与稳定排序]
    Q --> I[最多12条短索引]
    I --> R[模型按需分页读专题]
    R --> V[核对当前现场再形成结论]
    V --> O[完成轮次写入持久outbox]
    O --> E[后台无工具提炼]
    E --> C[来源校验与候选分类]
    C --> D[SQLite事务提交]
    D --> M[重建Markdown投影]
```

索引每条只包含 key、知识种类、短描述、范围简称、来源性质、观测/陈述日期及历史标记，不包含正文、原始来源摘录或完整资源配置。服务端先过滤再排序，禁止先对全项目做摘要再截断。

本地检索固定算法：NFKC、转小写、提取 Latin 数字词和相邻 Han 二元组；只索引 key、description、subject 的非秘密名称。当前用户消息最多 2,048 Unicode 字符，上一条真实用户消息最多 512 字符且只用于补足省略语。去重后最多 64 个查询 token。每个 token 命中 key 加 6 分、description 加 3 分、subject 名称加 4 分；完全匹配当前已验证 subject 加 20 分（本轮尚未接入；当前实现不根据历史或用户文字伪造“已验证”加分）；用户置于“始终参考”的项目偏好/方法加 10 分。先按分数降序，再按 key 升序；普通条目零分不注入。最多 2 条“始终参考”，只能由用户设置，不能自动把全部项目方法置顶。

常量与超限行为：

| 项目 | V2 固定值 | 超限处理 |
| --- | --- | --- |
| 自动短索引 | ≤12 条、≤3,072 UTF-8 字节 | 按整行裁切，附一条“可搜索更多”提示；元数据包装也计入 |
| 索引上下文预算 | 当前模型输入预算估算成本的 2%，且不得触发额外压缩 | 复用当前成本单位（代码中约 2 成本单位/输入 token），不足 256 字节时不注入；不得把估算说成精确 token |
| 单次正文读取 | ≤4,096 UTF-8 字节、≤200 行 | 返回 nextLine/nextByteOffset；按 UTF-8 边界分页 |
| 同轮新读取总量 | ≤16,384 字节且≤输入预算成本的 10% | 按 key+revision+范围去重；超限返回 `memory_budget_exhausted`，不循环读取 |
| 管理列表 | 每页≤50 条 | 只返回摘要和元数据，正文单条读取 |
| 提炼快照 | 沿用≤128 KiB | 不完整快照标记截断；缺失部分不能作为来源 |
| 提炼模型输入 | 规范化完整请求≤24 KiB，且符合模型输入预算 | 依次移除最旧的可选证据和已有摘要；真实用户输入与必要来源不能放下时该任务跳过 |

`requestMemoryContext()` 每次 provider 请求重新检查 revision、epoch 和目标签名。索引缓存 key 为 `(projectId, projectRevision, settingsRevision, targetSignature, queryHash)`；最多 64 项、30 秒，资源事件或设置变更主动失效。缓存不是权限判定结果，命中后仍检查范围/代次/时间。

`read_project_memory` 第一次读取也必须传索引/列表给出的 `expectedRevision`；旧调用不传时返回仅含当前版本的元数据与 `revision_required`，不直接返回正文。续读版本变化返回 409 和最新元数据，不拼接两个版本。正文读取也复核本轮目标，切换后不能复用旧页。

重复读取同一 key+revision+页范围返回 `already_read` 与原 accessId，不重复附加正文，避免用重复页绕过同轮预算。初次页面不足剩余字节预算时缩小分页；连必要元数据也放不下时只返回预算耗尽原因。

本轮省略记忆或关闭使用时，从下一次 provider 派发开始清除已注入的记忆片段与记忆工具正文，并禁止新读；不清除原始用户消息、执行证据或操作账本。已经发往供应商的请求无法收回，此开关不能承诺抹除已发送内容。关闭使用同时暂停提炼；关闭提炼仍可使用已有记忆。

### 1.6 增量提炼、冲突与调度

快照只来自本轮最终完成的主 Agent 用户轮次；计划模式、子 Agent、失败/取消轮次、本轮已显式保存/遗忘以及用户选择忽略记忆时沿用现有跳过规则。不扫描全部历史，也不把助手自己的结论当来源。成功主轮次内部含失败工具时，失败证据最多生成事故候选，不生成 observed 当前事实。

处理顺序固定为：持久 outbox → 验证快照 hash/版本 → 入队 → 等前台空闲 → 带租约提炼 → 严格 JSON 解析 → 脱敏与来源校验 → 计算范围/时间 → 判定直接生效或待复核 → CAS 事务提交 → 发布投影。提炼没有工具、网络探测或审批能力。

| 候选情况 | 确定处理 |
| --- | --- |
| 没有来源、来源不属于本轮、试图含秘密、项目/资源不合法 | 拒绝，不保存正文；任务记录原因码 |
| 新偏好/方法有真实用户明确陈述，范围无歧义 | 建立活动条目；用户没有明确说成长期偏好时进入候选 |
| 新拓扑/配置能机械对应结构化成功结果 | 建立活动条目，标为“已有观测”，按默认时限到期 |
| shell/日志解释、参考资料推断、事故经验、范围不确定 | 进入待复核；不能自动成为项目全局事实 |
| 同 scopeHash+factKey，内容及支持来源相同 | no-op，不刷新时间 |
| 同事实有新增来源、值一致、代次匹配、revision 未变 | 新 revision 追加来源，允许以新真实采样时间重算有效期 |
| 资源 ID 集合相同，旧代次已失配，本轮有新代次完整结构化证据且值一致 | 新 revision 更新绑定代次和采样时间；若值不同仍进入 conflict；不能借更新增加资源 ID |
| 同事实出现不同值 | 保存 conflict 候选，保持旧条目的原到期时间；无静默覆盖 |
| 自动任务试图修改用户编辑后的版本，或恢复已遗忘 key | CAS 拒绝；遗忘优先，不产生可一键恢复原文的候选 |
| 用户接受冲突或候选 | 重查范围/来源/有效期、提交新 revision；接受不是新采样，过期事实仍为历史 |

用户修正偏好可直接替换旧偏好，来源为本次用户消息。用户修正运维事实仍保持 user-stated，不能借此将其升级为 observed。用户点击“仍适用”只能延续方法的人工确认状态，不能延长配置/拓扑事实的观测有效期。新现场证据到达后才允许重新激活失配条目。

调度常量：全局同时提炼 1 个任务；前台所有会话空闲连续 2 秒后启动；单次调用 60 秒超时、租约 90 秒；每任务最多 5 个候选、真实失败最多 3 次，退避 30/120 秒；前台抢占不计失败次数。每项目每天 UTC 最多 20 次实际模型派发，包含失败、重试和被抢占的派发，防止取消重试绕过费用上限。达到上限标为 `budget_wait`，次日再排队；不借用其他项目预算。每项目最多 100 个待处理快照，超过时新任务 `skipped/queue_limit`；等待超过 7 天 `skipped/queue_expired`。

前台消息接纳与后台提交共用短临界区：接纳新消息时取消提炼 context、撤销租约，再启动前台；后台提交前再次核对“无前台任务 + 有效租约”。不得持锁等待模型退出。若提交已经完成，前台看到新 revision；若消息先接纳，迟到模型结果只能记录用量。取消不保证供应商不计费，界面如实展示已知/未知用量。

现有成功/no-op 快照 7 天后清空、失败/阻塞/跳过快照 30 天后清空的策略保留；新增候选 30 天到期清空 proposal 正文，派发用量记录保留 30 天。设置关闭、资源归档、遗忘和项目 epoch 改变需同时撤销在途提交资格，不等 worker 下一次轮询。

### 1.7 API、模型工具与界面

沿用现有路径，新增字段通过严格校验开放；客户端旧 PUT 缺少 V2 范围字段时返回 `422 scope_required`，不默认写成全项目。旧工具名称不变，模型不可提交 projectId、资源 generation、observedAt、verification 或来源摘录。它可以提交当前可引用资源 ID 与 subject 候选，服务端重新解析，不能扩大 T。

| 入口 | V2 契约 |
| --- | --- |
| GET `/api/projects/{project}/memory` | 新增 `knowledgeKind,reviewState,resourceId,history` 过滤；现有 query/offset/limit/includeExpired/includeDeleted 保留为别名；返回 scope、eligibility、时间、来源计数，不返回正文 |
| GET `/api/projects/{project}/memory/{key}` | 管理界面可查看本项目历史并标明状态；模型桥接入口还需当前任务范围；读取返回 revision 和来源元数据 |
| PUT `/api/projects/{project}/memory/{key}` | 保留 expectedRevision/restoreDeleted；新增 knowledgeKind/scopeKind/resourceIds/subject/factKey/alwaysReference；服务端填 generation/来源/时间；用户编辑遵守 1.4，常参考只允许用户设置且上限 2 条 |
| DELETE `/api/projects/{project}/memory/{key}` | expectedRevision 必填；清除内容并设墓碑；重复同 revision 删除返回幂等结果 |
| GET `/api/projects/{project}/memory-candidates` | 分页列出 pending/历史决定，默认只显示 pending |
| POST `/api/projects/{project}/memory-candidates/{id}/decision` | `{action:accept\|reject,expectedProjectRevision,expectedCandidateHash,resourceIds?,subject?}`；歧义候选接受时必须补齐范围；事务内重验，不接受模型自带时间 |
| GET `/api/projects/{project}/memory/{key}/sources/{sourceId}` | 返回最小脱敏来源与允许打开的会话/轮次/证据引用；来源归档或不存在时返回明确 unavailable 原因 |
| GET `/api/projects/{project}/memory-jobs` | 新增 budget_wait、失败原因中文映射、派发次数、已知/未知用量；未知不是 0 |
| `list_project_memories` | 新增 `includeHistory=false`；始终按受信任 T 过滤；不能接受任意项目或 UI 管理范围 |
| `read_project_memory` | expectedRevision 必填；新增 `includeHistory=false`；不符合资格时返回状态/原因，普通读取不含正文 |
| `save_project_memory` | 仍要求本轮真实用户明确记忆意图；新增知识种类、资源引用与条件；不能通过引用文档里的“记住”授权 |
| `forget_project_memory` | 仍要求真实用户明确遗忘意图及 expectedRevision；使用墓碑阻止迟到提炼 |

管理界面沿用项目记忆入口，桌面采用列表+详情布局；窄窗口改为列表/详情两层，返回时保留查询和滚动位置。默认列表展示活动记忆，顶部使用状态筛选“可参考 / 待复核 / 历史 / 已遗忘”，旁边保留两个独立开关。每行最多标题、范围和时间两行信息，避免嵌套大卡片。

详情顺序固定为：标题与来源性质 → 资源/适用对象 → 事实或方法 → 观测时间和有效期 → 来源列表 → 限制与操作。来源点开定位原会话轮次或证据；找不到时保留来源摘要并说明原因。冲突详情并排/上下对照旧值和新候选，不预选接受。危险操作只有遗忘使用现有确认样式，不为普通读取增加确认。

会话执行过程增加默认折叠的“已读取 2 条项目记忆”，展开显示 key、版本、观测日期、失效提示及来源跳转；只记录实际索引注入与正文读取，二者分开计数。后台自动新增时在项目入口显示轻量数量更新，冲突进入待复核计数，不弹出打断调查的确认框。

### 1.8 迁移、兼容与回退

1. 停止当前 Home 的后端后，由同一受锁保护的 `OpenStore()` 执行迁移。先用 SQLite `VACUUM INTO` 生成 `lake-web.before-memory-v2-<随机ID>.sqlite`，权限 0600；备份失败则停止迁移。新空 Home 无旧记忆时不生成空备份。
2. 同一事务创建 V2 表、把全部 V1 条目迁入 V2，活动旧条目统一设 `needs_review`，资源范围标为待补齐；来源/原时间原样保留、缺失保持空。旧 observed 标记不升级为可信证据。已遗忘条目只迁入无正文墓碑。
3. V1 正文搬迁完成后清空 `projectMemories` 的内容行；旧表结构保留。V2 不再写入此表。旧队列任务标 skipped/migrated_v2；旧 outbox 不做 V2 提炼，防止旧元数据生成无范围事实。原设置开关保留，不把旧条目自动激活。
4. 写入迁移标记并提交；事务失败恢复原状。提交后将旧 `memories/projects/<id>/memory/` 中由系统生成的记忆文件安全移除/清空，重新生成空索引；失败时停止启动并在下次启动继续清理，不能带着旧正文启动旧兼容路径。
5. V2 投影改为 `memories/v2/projects/<id>/memory/`，含全部未遗忘条目及状态，MEMORY.md 只含可参考条目。投影不注入模型，由数据库检索服务决定本轮短索引。新旧客户端不共享 V2 投影路径。
6. 已迁移 Home 再次启动时，若旧客户端曾写入 V1 行，只做无模型的隔离搬迁：导入为 needs_review、冲突则保存待复核，不覆盖 V2；清空 V1 内容。迁移哈希/旧 revision 去重，不能复活 V2 墓碑。
7. 功能回退优先在 V2 二进制内关闭使用和提炼，保持其他功能工作。必须降级旧二进制时，先关闭两开关、停止后端、完成 V1 空表/空投影检查，再启动旧版；旧版看不到 V2 正文。不能仅增加 schemaVersion 就声称旧二进制会拒绝启动。
8. 恢复整库迁移前备份只允许在隔离 Home 查看；整库恢复会同时回滚会话/操作账本，不能作为线上常规回退。正式数据恢复必须另行制定停机和账本核对方案，不能为了恢复记忆回放操作。

用户复核旧条目可批量选择“偏好/方法、全项目”或为选中条目绑定实际资源；确认仍保留原来源时间，配置/拓扑已过期时只能归入历史。首版不自动把 500 条旧记忆静默应用到所有资源。

## 2. Implementation Steps

以下六阶段顺序落地；前五阶段的门控代码在同一草稿中贯通版本协商，防止部分后端配旧界面。任务表的“代码已实现”不等于完整验收；最后一阶段仍未完成，门控保持关闭。

分阶段合入保护：新增编译期常量 `operationalMemoryV2Ready=false`，阶段 1–5 的生产入口仍使用 V1，不提前搬迁真实 Home；测试显式调用 V2 入口并使用临时 Home。阶段 6 全部验收通过后才将该常量改为 true，使迁移与 V2 API/工具/UI 同时启用。不存在半套新后端配旧编辑界面的自动切换，也不开放通过环境变量绕过验收的入口。

门控覆盖 Store 公共方法的 V1/V2 分派、迁移、模型工具 schema、worker 和 HTTP 路由；Settings 响应增加 `memorySchemaVersion=1|2`，前端按服务端版本选择兼容界面。默认关闭阶段仍执行原 V1 行为，不能仅门控迁移却让 CRUD 提前访问 V2 表。

### Implementation Phase 1

- **GOAL-001**: 建立 V2 存储、保守迁移和降级隔离。完成标准：同一 V1 fixture 迁移两次结果相同；旧条目全在待复核；V1 表和旧投影没有 V2 正文；故障注入不留下半迁移。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | 新增 `internal/web/project_memory_v2_schema.go` 的 `prepareMemoryV2Migration()`、`migrateMemoryV2()` 和默认关闭的 `operationalMemoryV2Ready`；在 `internal/web/store.go:OpenStore()` 的能力门控后接入备份和迁移；实现 1.2 全部表/索引/约束及 1.8 原子搬迁。依赖：无。通过 TEST-001、TEST-002。 | 代码已实现；待完整验收 | 2026-10-23 |
| TASK-002 | 新增 `internal/web/project_memory_v2_store.go` 的 `ValidateMemoryV2()`、`CommitMemoryV2()` 的遗忘分支；实现 revision/CAS、500 条、来源/版本上限、候选配额和无原文墓碑；现有 `project_memory_store.go` 公共方法改为 V2 适配。依赖：TASK-001。通过 TEST-003、TEST-004。 | 代码已实现；待完整验收 | 2026-10-23 |
| TASK-003 | 在 `internal/web/project_memory_files.go` 分派到新增 `project_memory_v2_files.go`，为 `memoryProjectionPath()`、`PublishProjectMemory()`、`ReconcileProjectMemoryFiles()` 增加 V2 路径、状态 frontmatter、旧投影清理和无模型隔离重迁移；失败不得发布部分索引。依赖：TASK-001、TASK-002。通过 TEST-002、TEST-005。 | 代码已实现；待完整验收 | 2026-10-23 |

### Implementation Phase 2

- **GOAL-002**: 建立可信来源和资源代次。完成标准：失败/运行中采样不能变成成功事实；改名排序不失效，连接变更与资源恢复立即失配，模型伪造来源无效。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-004 | 新增 `internal/web/project_memory_scope.go` 的 `MemoryResourceBindings()`、`BumpMemoryResourceGeneration()`、`ResolveMemoryReadScope()`；将 `store.go:CreateResource()`、`resource_edit.go:EditTerminalResource()`、`navigation_trash.go:ArchiveNavigation()`/恢复路径、`resource_import.go:commitResourceImport()` 和 `hexhub_local.go` 的同步写入接入，含依赖 SSH 的资源代次传播。依赖：TASK-001。通过 TEST-006。 | 代码已实现；待完整验收 | 2026-10-23 |
| TASK-005 | 在 `internal/ai/project_memory_snapshot.go` 新增 `MemoryEvidenceContext`；在新增 `project_memory_evidence.go` 提供 `memoryEvidenceEligible()`，在 `agent_evidence_records.go` 和 `agent_observations.go` 以服务端已解析的执行身份登记来源，桥接器在 `internal/web/agent.go` 返回受信任元数据；快照新增 schemaVersion=2，拒绝把旧未知字段补成成功。依赖：TASK-004。通过 TEST-007、TEST-008。 | 代码已实现；待完整验收 | 2026-10-23 |
| TASK-006 | 在 `internal/web/project_memory_scope.go` 实现 `EvaluateMemoryEligibility()`、`DeriveMemoryValidity()`，在 `project_memory_v2_extraction.go` 实现 `ValidateMemoryClaimSupport()`；实现 1.1/1.4 的种类、TTL、观测时间和历史判定。用户编辑和候选接受都走同一入口。依赖：TASK-002、TASK-005。通过 TEST-009。 | 代码已实现；待完整验收 | 2026-10-23 |

### Implementation Phase 3

- **GOAL-003**: 实现范围优先的短索引和有界正文读取。完成标准：所有旁路读取执行同一资格检查；500 条记忆下索引确定且不超过预算；切换目标/版本后分页不串读。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-007 | 新增 `internal/web/project_memory_retrieval.go` 的 `RankMemoryIndex()`、`BuildScopedMemoryIndex()`、`InvalidateMemoryIndexCache()`；实现 1.5 固定归一化/评分、12 条/3 KiB、最多 2 条用户常参考、64 项/30 秒缓存；缓存命中后再校验。依赖：TASK-006。通过 TEST-010、TEST-011。 | 部分实现：已验证 subject 加分待接入 | 2026-10-23 |
| TASK-008 | 修改 `internal/ai/project_memory.go:requestMemoryContext()` 与 `internal/ai/adk_provider_step.go` 的记忆注入位置，内联计算剩余记忆上下文预算并包含序列化包装成本；按实际模型输入预算扣除工具/历史成本，索引不能造成额外压缩，记忆工具结果计入同轮总读取量。依赖：TASK-007。通过 TEST-012。 | 代码已实现；待完整验收 | 2026-10-23 |
| TASK-009 | 修改 `internal/web/project_memory_bridge.go:projectMemoryBridge()` 及 `internal/ai/project_memory.go` 工具 schema；要求 expectedRevision、控制 includeHistory、屏蔽任意 projectId/generation/来源字段、统一 scope 检查和分页；保留真实用户显式保存/遗忘意图检查。依赖：TASK-008。通过 TEST-004、TEST-011、TEST-013。 | 代码已实现；待完整验收 | 2026-10-23 |
| TASK-010 | 在新增 `internal/ai/project_memory_access.go` 实现 `RecordMemoryAccess()`，通过 AI View 的 `memory_access` 卡片持久化并返回本轮最小读取足迹；只存 key/revision/范围签名/读到的页范围与时间，不存额外正文。依赖：TASK-009。通过 TEST-014。 | 代码已实现；待完整验收 | 2026-10-23 |

### Implementation Phase 4

- **GOAL-004**: 实现可抢占、有预算、不会覆盖修正的增量提炼。完成标准：前台消息可立即启动；迟到输出没有提交资格；重复恢复不重复派发或生效；费用和未知用量可审计。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-011 | 修改 `internal/web/project_memory_outbox.go:EnqueueMemoryTurn()` 与 `internal/ai/project_memory_snapshot.go:collectMemorySnapshot()`，只接纳 V2 合格快照，执行 100 项/项目与 7 天队列限制；旧快照跳过并记原因，不推测 scope。依赖：TASK-005、TASK-006。通过 TEST-015。 | 代码已实现；待完整验收 | 2026-10-23 |
| TASK-012 | 新增 `internal/web/project_memory_v2_extraction.go:memoryExtractionPromptV2`、`parseMemoryExtractionV2()`、`ClassifyMemoryCandidate()`，实现严格 V2 JSON、最多 5 条、来源字段机械验证、文本结论待复核、24 KiB 提炼请求上限和无工具调用。依赖：TASK-006、TASK-007、TASK-011。通过 TEST-008、TEST-016。 | 代码已实现；待完整验收 | 2026-10-23 |
| TASK-013 | 修改 `internal/web/project_memory_jobs.go:CommitMemoryExtraction()`，增加 `CommitMemoryCandidates()`；事务中验证租约/epoch/资源代次/revision/来源，原子写入活动条目或 conflict/pending 候选及提交回执；同值新来源才允许刷新采样，用户修改优先。依赖：TASK-012。通过 TEST-003、TEST-017。 | 代码已实现；待完整验收 | 2026-10-23 |
| TASK-014 | 在新增 `internal/web/project_memory_v2_worker.go` 实现 `PauseMemoryExtractionForForeground()`、`ReserveMemoryDispatch()`；在 `internal/web/message_queue.go:launchMessageLocked()` 与设置/资源事件接纳点接入取消；实现 2 秒空闲、60/90 秒、30/120 秒退避、20 次/UTC 日及独立派发用量记录，不持锁等待模型。依赖：TASK-011、TASK-013。通过 TEST-018、TEST-019。 | 代码已实现；待完整验收 | 2026-10-23 |
| TASK-015 | 修改 `internal/web/project_memory_jobs.go:RecoverMemoryJobs()`、`SettleMemoryJob()`、`PruneMemoryArtifacts()` 与 `RetryMemoryJob()`，处理 budget_wait、队列过期、候选 30 天到期、重启恢复及人工重试不能绕过预算/墓碑/新代次；迟到输出只结算一次用量。依赖：TASK-014。通过 TEST-015、TEST-019。 | 代码已实现；待完整验收 | 2026-10-23 |

### Implementation Phase 5

- **GOAL-005**: 交付可理解的记忆管理、复核和读取足迹。完成标准：用户能看懂范围/时间/来源，候选不自动接受；快速切换项目和资源不闪出上一个项目的正文。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-016 | 修改 `internal/web/project_memory_routes.go:projectMemoryRoute()`，新增 `DecideMemoryCandidate()`、`ResolveMemorySourceLink()`；实现 1.7 API、严格字段、CAS、422/409 和来源不可用语义。依赖：TASK-009、TASK-013、TASK-015。通过 TEST-013、TEST-020。 | 代码已实现；待完整验收 | 2026-10-23 |
| TASK-017 | 更新 `web-agent/shared/contracts.ts` 的 ProjectMemoryEntry/List/Job/Settings，并新增 MemoryCandidate/MemorySource/MemoryAccess；新增 `web-agent/web/src/projectMemoryState.ts` 的 `reduceMemoryView()` 管理项目+请求序号，丢弃过期响应并在切换项目时清空正文。依赖：TASK-016。通过 TEST-021。 | 代码已实现；待完整验收 | 2026-10-23 |
| TASK-018 | 修改 `web-agent/web/src/ProjectMemory.tsx`、`projectMemory.css`；新增 `ProjectMemoryDetail.tsx`、`ProjectMemoryCandidates.tsx`，按 1.7 实现范围/时效/来源、冲突比较、旧条目批量分类、编辑与遗忘；遵守 AppSelect/Glyph/主题/键盘规范。依赖：TASK-017。通过 TEST-021、TEST-022。 | 代码已实现；待完整验收 | 2026-10-23 |
| TASK-019 | 新增 `web-agent/web/src/MemoryAccessSummary.tsx` 并接入现有会话执行过程组件；显示“索引 N 条 / 已读取 M 条”、条目版本与历史提示，来源跳转复用会话导航，不新增顶层悬浮状态卡。依赖：TASK-010、TASK-017。通过 TEST-014、TEST-022。 | 代码已实现；待完整验收 | 2026-10-23 |

### Implementation Phase 6

- **GOAL-006**: 完成端到端验收、故障恢复与 Dev 交付。完成标准：下列测试全部具有最终 SHA 的真实证据；不足项明确阻塞对应平台启用，不用旧记录代替。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-020 | 在 `internal/ai/reference_memory_test.go`、新增 `internal/ai/project_memory_evidence_test.go`、`internal/web/project_memory_v2_test.go`、`project_memory_retrieval_test.go`、`project_memory_concurrency_test.go` 和现有 memory tests 中实现 TEST-001 至 TEST-020；fixture 只用虚构资源/凭据占位，覆盖现有支持协议的无工具提炼请求。依赖：TASK-015、TASK-016。 | 确定性回归已增加；矩阵待补齐 | 2026-10-23 |
| TASK-021 | 新增 `web-agent/web/test/project-memory.test.ts`、`web-agent/web/test/fixtures/project-memory.tsx`，完成 TEST-021、TEST-022；运行第 6 节命令与实际浏览器/Dev 交互，保存脱敏截图和验证 SHA。依赖：TASK-018、TASK-019、TASK-020。 | 浏览器 fixture 已验收；原生 Dev 待验 | 2026-10-23 |
| TASK-022 | 新增 `docs/validation/lake-operational-memory-v2.md`，记录每项测试命令/结果/平台/SHA/限制与迁移回退演练；更新 `docs/validation/lake-project-memory.md` 链接 V2，保留 V1 未补验历史；全套通过后将 `operationalMemoryV2Ready=true` 并对最终 head 复验。按阶段 PR 到 develop，最终候选只安装 Lake Dev；未授权不合并、不发布。依赖：TASK-020、TASK-021。 | 验证记录已建立；启用门槛未满足 | 2026-10-23 |

阶段边界：阶段 3 可以在隔离 fixture 中验证人工记忆与受限读取，阶段 4 验证自动提炼，阶段 5 完成 UI；阶段 6 才启用真实 Dev Home 的 V2 迁移。单阶段 PR 合入不表示全部 V2 验收通过。若决定提前交付受限版，必须另立仅含已验收能力的发布计划，不能临时绕过本方案的门控。

## 3. Alternatives

- **ALT-001**: 每轮注入完整 MEMORY.md 或完整正文。拒绝：无关条目挤占上下文，过时事实影响当前任务，也无法在读正文前可靠执行资源边界。
- **ALT-002**: 首版引入向量数据库和语义检索。暂不采用：500 条/项目下本地确定性检索可测、便于解释；向量命中也不能解决范围/时间/来源错误。只有未来相关性评测显示固定检索明显漏召回，再单独评估。
- **ALT-003**: 直接让 Agent 编辑 Markdown 作为事实源。拒绝：并发、墓碑、CAS、来源身份和权限检查难以贯通。Markdown 保留为本地可查、可重建的投影。
- **ALT-004**: 自动把所有旧记忆视作项目通用知识。拒绝：V1 资源绑定没有闭环，无法凭内容可靠恢复范围；迁移待复核能避免把旧现场扩散到全部机器。
- **ALT-005**: 自动覆盖同一事实的新值、自动合并冲突。首版拒绝：资源变化与采样差异未必代表旧值已失效；保留 conflict 候选比静默覆盖可追溯。
- **ALT-006**: 后台定时连接资源刷新记忆。拒绝：本方案提炼不能新增执行权限、费用和网络探测；现场刷新只能来自已授权的真实任务。
- **ALT-007**: 仅在旧 `projectMemories` 表加 scope 字段。拒绝：旧二进制忽略字段仍可能全量读取；独立 V2 正文表与空兼容投影使降级无法误读 V2 范围事实。
- **ALT-008**: 把资源目录直接建模为生产环境或集群。拒绝：目录可重命名/移动，可能只是导航分组；应由后续正式资产身份模型支持跨入口复用。

## 4. Dependencies

- **DEP-001**: 现有 `project_memory_*` 的事务、outbox、lease、CAS、epoch 与脱敏机制；迁移时复用框架，不能假设其已有 V2 范围和证据语义。
- **DEP-002**: 现有 `TargetScope`、资源引用许可、执行器来源记录；所有资源写入路径必须接入代次事件，新增写入口漏接属于发布阻塞问题。
- **DEP-003**: 现有模型协议和 `ExtractMemory` 无工具调用；使用任务捕获的 modelRef，不自动改用更贵模型；模型缺失时 blocked 并允许用户恢复原模型后重试。
- **DEP-004**: SQLite 锁、备份与平台私有权限实现；macOS、Windows 分别验证原子替换/ACL，不把 macOS 结果视作 Windows 通过。
- **DEP-005**: 现有 AppSelect、Glyph、主题、会话导航和执行过程展示组件。源码接线以实施时的最新 develop 为准，需保留已合入的其他 UI 优化。
- **DEP-006**: 版本对应的 Go/pnpm/Node 工具链与 signed Dev build。无需新增第三方运行时依赖或接入外部存储服务。

## 5. Files

- **FILE-001**: 修改 `internal/web/store.go`、`project_memory_store.go`；新增 `internal/web/project_memory_v2_schema.go`、`project_memory_v2_store.go`，负责迁移和 canonical CRUD。
- **FILE-002**: 新增 `internal/web/project_memory_scope.go`、`project_memory_retrieval.go`、`project_memory_v2_extraction.go`，负责范围、时间和本地检索。
- **FILE-003**: 修改 `internal/web/resource_edit.go`、`navigation_trash.go`、`resource_import.go`、`hexhub_local.go`，覆盖资源配置、归档恢复、导入同步与依赖事件。
- **FILE-004**: 修改 `internal/ai/project_memory_snapshot.go`、`adk_evidence.go`、`agent_evidence_records.go` 及 `internal/web/agent.go`，贯通受信任执行来源。
- **FILE-005**: 修改 `internal/ai/project_memory.go`、`adk_provider_step.go`、`internal/web/project_memory_bridge.go`，实现工具契约、预算和读取足迹。
- **FILE-006**: 修改 `internal/web/project_memory_outbox.go`、`project_memory_worker.go`、`project_memory_jobs.go`、`message_queue.go`，实现增量、抢占、候选和费用上限。
- **FILE-007**: 修改 `internal/web/project_memory_files.go`、`project_memory_routes.go`，实现 V2 投影和管理/API。
- **FILE-008**: 修改 `web-agent/shared/contracts.ts`、`web-agent/web/src/ProjectMemory.tsx`、`projectMemory.css`；新增 `projectMemoryState.ts`、`ProjectMemoryDetail.tsx`、`ProjectMemoryCandidates.tsx`、`MemoryAccessSummary.tsx`。
- **FILE-009**: 修改/新增 TASK-020、TASK-021 声明的 Go/前端测试和 fixtures，不更改操作账本或权限测试以迁就记忆行为。
- **FILE-010**: 新增 `docs/validation/lake-operational-memory-v2.md`；补充 `docs/validation/lake-project-memory.md`。代码和文档均已进入实施，默认门控仍关闭。

## 6. Testing

以下是完整启用验收门槛；已执行检查与未覆盖矩阵逐项记录在 [V2 验证记录](../docs/validation/lake-operational-memory-v2.md)，不能将测试命令通过等同于全部验收项完成。

- **TEST-001**: V1 fixture 包含活动、过期、已遗忘、缺来源条目；两次迁移后 V2 数量/哈希不变、缺失字段不伪造、所有非墓碑旧条目 needs_review，旧表无正文。
- **TEST-002**: 在备份、事务中间、提交后投影清理处分别注入失败并重启；不出现部分生效、旧目录残留正文被使用或迁移重复。旧版兼容 reader 读取同一库/旧投影为空；旧版新写 V1 的行下次 V2 启动只进入隔离区。
- **TEST-003**: 竞争修改同 revision 仅一个成功；相同 job/候选重放不重复增 revision；第 501 条活动记忆、第 101 个 pending 候选返回确定错误，不静默驱逐。
- **TEST-004**: 遗忘后立刻收到旧 worker 结果/旧候选接受/旧 outbox 重放，均不能恢复；旧正文、来源摘录、历史版本和文件不存在。明确恢复必须来自用户真实意图并重新提交新内容。
- **TEST-005**: 投影丢失后从 DB 重建完全一致；非法 key、符号链接、路径穿越被拒绝；POSIX 权限与 Windows ACL/替换分别有平台记录。
- **TEST-006**: rename/sort/move 不增 generation；host/port/user/credential rotation/依赖连接变化、归档/恢复都增代次；各资源创建/编辑/导入/同步路径都被参数化测试覆盖。
- **TEST-007**: running、not_executed、cancelled、unknown、非零 exitCode、含错误 JSON、无资源映射 MCP 结果不能产生 observed 成功事实；原始工具输出伪造 resourceId/finishedAt/verification 无效。
- **TEST-008**: 成功命令但业务失败不能标健康恢复；结构化字段可机械对应时才允许拓扑/配置直写；shell 自然语言根因只进候选；失败工具可提历史事故候选但不能证明成功。
- **TEST-009**: 固定时钟验证 24 小时/7 天边界；仅改标题不改 observedAt，人工改事实正文清除本版本 observedAt 且不延长 validUntil；新真实证据才能刷新；人工接受过期候选仍过期；事故经验永远 historical；多来源以必要证据最早观测时间计时。
- **TEST-010**: 500 条、中文/英文混合查询、Unicode 规范化、零分、同分、置顶 3 条越界、超长描述 fixtures：结果顺序稳定，索引≤12 条/3 KiB，正文不进入索引，普通索引只含 eligible。
- **TEST-011**: 项目 A/B、同名资源、不同集群目录、A↔B 关系、已知 key 直读、缓存命中、资源归档、目标歧义、版本/代次变化：任何入口均不跨范围；历史模式只放宽时效，不放宽目标。
- **TEST-012**: 小输入预算和超大工具目录下索引降至零；正文读取累计预算和分页边界正确；附加记忆不单独触发压缩、不截断用户约束；容量未知显示估算，不编造精确 token。
- **TEST-013**: API 严格字段、未知枚举、旧 PUT 缺 scope、伪造 projectId/来源/代次、过期 expectedRevision、引用文档中的“记住/忘记”、模型擅自恢复均被拒绝；真实用户显式保存路径仍可用。
- **TEST-014**: 足迹只记录实际注入和读取；正文拒绝不算已读；同 key 不同 revision 可区分；界面不能把“索引出现”显示成“已采纳”；来源跳转无权限或被删时显示不可用。
- **TEST-015**: outbox 持久化后崩溃、入队后崩溃、租约中断、DB 提交后文件失败都可恢复且不重复写；第 101 个队列项、超过 7 天任务、旧 V1 快照正确跳过；无历史全量扫描。
- **TEST-016**: 提炼请求使用测试 provider 捕获所有当前支持协议：无 tools、无多余循环、JSON 重复键/未知字段/多文档拒绝、最多 5 项、请求≤24 KiB；无 durable 信息时 no-op。
- **TEST-017**: 同事实同值同源不刷新时间，同值新源可刷新，异值进入 conflict，用户修正和墓碑优先；候选接纳重验 generation/epoch/revision/TTL，不能借接受变成现场确认。
- **TEST-018**: 在提炼运行/解析/提交前三个时点提交前台消息；前台接纳不等待网络结束，后台租约被撤销，迟到结果不写；反向顺序提交完成则前台看到新 revision。race 测试无数据竞争或死锁。
- **TEST-019**: 模型连续失败只派发 3 次，退避 30/120 秒；取消不占失败预算但占当日派发额度；第 21 次不派发，跨 UTC 日恢复；人工重试/重启不能绕额度；迟到用量幂等计入，未知不是零。
- **TEST-020**: 源证据删除/不可定位、项目关闭、资源恢复、关使用/提炼、单轮忽略均有确定 UI/API 原因；关闭使用后当前请求中的记忆片段不再发送，原执行账本和权限保持有效。
- **TEST-021**: 前端状态测试覆盖快速项目 A→B→A、搜索旧响应、编辑 CAS 冲突、候选接受失败、切换详情后请求取消和来源不可用；不出现跨项目正文闪现，不丢未保存编辑。
- **TEST-022**: 浏览器和 Lake Dev 实测 360×640 窄窗口及桌面、浅深主题、键盘/AppSelect/Escape/焦点恢复；验证候选、遗忘、历史标记、来源定位和读取足迹，无横向溢出或第二个顶层状态卡。

实施检查命令（在相应最终 SHA 执行；Go 命令从仓库根目录，pnpm 命令从 `web-agent/`）：

```sh
go test ./internal/web ./internal/ai
go test -race ./internal/web ./internal/ai
go vet ./internal/web ./internal/ai
python3 scripts/check_adk_runtime_boundary.py
pnpm check
pnpm test:frontend
pnpm build:web
```

完成目标平台验收后，macOS 使用 `scripts/build_lake_desktop.sh --dev --install` 安装并启动 `~/Applications/Lake Dev.app`；Windows 使用项目既有 Dev 构建流程。独立后端使用显式隔离 `--home` 与空闲 loopback 端口，不与已运行 Dev 共用 Home。截图、日志和 fixture 均不得含真实秘密。

性能验收在 500 条/项目、每条最大允许摘要的本地 fixture 上运行 1,000 次检索，预热 20 次后记录 p50/p95；macOS 当前开发机 p95 ≤30 ms，检索阶段模型调用数为 0。前台接纳对模拟阻塞提炼的增量等待 ≤50 ms，测试只测内存/锁接纳时间，不把供应商响应延迟计入。未达门槛先优化过滤/缓存，不放宽范围检查。

内容质量验收使用 60 个固定虚构案例：20 个应记（偏好/方法/结构化事实）、20 个不应记（短暂故障/计划/秘密/猜测）、20 个需复核（日志解释/旧来源/冲突）。确定性校验必须全通过；对使用的实际提炼模型重复 3 轮，禁止跨范围自动生效或无来源 observed，任何一次出现即阻塞启用；应记案例候选/活动召回率至少 90%。语义测试记录模型和协议，不把一个模型结果推广到全部供应商。

## 7. Risks & Assumptions

- **RISK-001**: 漏接资源变更事件会让旧绑定看似匹配。控制：所有写入路径参数化测试、依赖资源传播、读取现场核实；未知连接适配器默认不能自动写入事实。
- **RISK-002**: 可信证据不等于正确语义解释。控制：结构化字段机械对应才直写，shell/日志解释进候选；observed 文案仅代表有观测来源。
- **RISK-003**: 待复核迁移降低初期召回率。控制：批量分类和明确资源选择；宁可短期少用旧记忆，也不猜测范围自动激活。
- **RISK-004**: 关键词检索漏召回同义表达。控制：中文二元组、少量用户常参考和 list/read 工具；固定案例评测后再决定是否引入语义索引，不先扩大上下文。
- **RISK-005**: 前台抢占产生已计费但未采用的输出。控制：2 秒空闲、20 次/日硬派发上限、独立用量账；未知费用如实展示，不能承诺取消免费。
- **RISK-006**: SQLite 事务与文件系统没有跨介质原子性。控制：DB 提交回执、可重建投影、重启补发布；投影失败不回放外部操作。
- **RISK-007**: V2 表与空 V1 兼容层增加迁移复杂度。控制：保留旧表结构、隔离新正文路径、幂等 fixture 和降级 reader 验收；不依赖旧二进制会理解新增 schemaVersion。
- **RISK-008**: 内部事件不能感知资源之外发生的部署。控制：代次失效和 TTL 只是筛选条件，配置/拓扑使用前仍需当前现场检查，不能对所有变化提供即时失效保证。
- **RISK-009**: 文件备份或用户自行复制可能保留已遗忘内容。控制：产品明确遗忘范围，默认导出不含已遗忘正文；不承诺擦除外部副本，不删除原执行证据来伪造审计消失。
- **RISK-010**: 数据库和 Markdown 仍可被拥有本机文件权限的用户或工具读取。控制：这里的范围判定约束记忆 API/注入，不冒充本机文件安全沙箱；不让模型自动扫描所有项目投影来绕开检索，未来共享场景另设用户级存储与授权。
- **ASSUMPTION-001**: 首版仍以本机项目存储模型为基础，不在此方案引入多租户 RBAC。已有资源引用和会话许可必须继承，未来共享项目需要另做服务端用户级授权。
- **ASSUMPTION-002**: 资源当前有稳定 ID，但没有统一可信环境/集群实体。本版以资源集合和 subject 约束，不根据目录名称建立跨入口信任。
- **ASSUMPTION-003**: 用户希望学习可复用经验，而非保存每次监控样本。实时状态由原会话/证据承担，长期记忆不替代时序数据库、资产库或运行手册的版本管理。
- **ASSUMPTION-004**: 首版不承诺后台语义提炼完全正确；高影响事实默认可追溯且可复核。实际模型达不到第 6 节语义门槛时，保留人工记忆与检索，关闭自动提炼即可交付受限阶段。

## 8. Related Specifications / Further Reading

- [项目记忆 V1 计划](feature-project-memory-1.md)：已有实现的目标与历史任务，本文定义 V2 增量，不重写其完成状态。
- [项目记忆已有验证记录](../docs/validation/lake-project-memory.md)：历史记录中的未验证项仍需按 V2 实际补验。
- [前端 UI 规范](../docs/ui-guidelines.md)：字体、AppSelect、主题、交互与布局约束。
- [开发与分支流程](../docs/development-workflow.md)：阶段 PR、Dev 验证、生产提升及授权边界。
- [贡献指南](../CONTRIBUTING.md)：签名构建、隔离 Home、凭据和官方 ADK 约束。
- [官方 ADK 运行时架构](../docs/experiments/adk-runtime.md)：执行与恢复职责；记忆不能接管操作账本。
- 实施入口源码：`internal/ai/project_memory.go`、`internal/ai/project_memory_snapshot.go`、`internal/web/project_memory_store.go`、`internal/web/project_memory_jobs.go`、`internal/web/project_memory_worker.go`、`internal/ai/directory_targets.go`。本文没有断言 Zcode 的未核实内部实现；仅采用用户讨论的短索引、按需读取和增量提炼模式。
