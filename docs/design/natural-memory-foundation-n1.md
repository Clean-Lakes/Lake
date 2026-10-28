# N1 统一记忆基础与旧内容承接

基线为 develop 的 a566ad14dc3c8dc79d023a2046c4e55630bb7d1b，承接 [自然记忆计划](../../plan/feature-natural-memory-1.md)。N1 提供统一管理 API、旧设置映射、准确版本承接、来源/冲突检查与承接撤销。自然长期意图识别、自动整理、压缩采集及新的运行时召回分别属于 N2～N5，本阶段不注册新模型工具或启动新学习器。

## 存储与版本

沿用业务 SQLite。新增 naturalMemoryMeta v1 及独立 schema hash；不修改策略 v1～v6 或项目记忆的历史迁移/hash。已有 Home 首次升级先以 VACUUM INTO 创建 0600 的一致性业务库备份，再在单个事务中建表并提交 marker；失败不发布部分 marker。启动在旧迁移/恢复写入之前拒绝未知版本或错误 hash。

| 表 | 保存内容 |
| --- | --- |
| naturalMemorySettings | owner scope、revision/epoch、独立自动记忆值和 consentVersion；N1 仅可保存 false/0 |
| naturalMemoryLinks | 唯一 (scopeKey, assetId)、映射 revision、准确正文 revision/hash、预览 fingerprint、mapped/undone、更新时间 |
| naturalMemoryChanges | 承接/撤销身份、映射变更前后元数据、时间及撤销关联；不可改写或删除历史 |
| naturalMemoryReceipts | scope 内幂等 key hash、请求 hash 与仅含身份/修订的结果 |

正文、标题、原始来源和适用条件继续由现有不可变资产版本及血缘存储承载，不复制进新表。映射 revision 与正文 revision 分开，撤销不会改写正文或当前采用绑定。版本读取、来源状态与设置均经同一可信 host scope 校验；项目 ID 由路由解析，不接受 body/model 指定 owner。

## 设置映射与权限

| 原设置 | N1 行为 |
| --- | --- |
| strategy master/apply、全局与项目取交集 | 原值与原默认值保留，返回 preferenceSettings 及 effectiveUseEnabled，不隐式开启或写入 |
| projectMemorySettings use/extraction | 原值、原默认值、revision、epoch 保留，项目范围内返回；不转成用户级采集同意 |
| 已退役 learn/correct/online 与旧同意 | 继续 C1 退役，不作为新设置来源 |
| 新 autoEnabled | 隐式默认 false，automaticReady=false；PATCH true 在回执重放前返回 409 natural_memory_automatic_not_ready |
| operationalMemoryV2Ready | 仍 false；V1 正常运行，隔离 V2 fixture 验证适配，不迁移日常 Dev 为 V2 |

本阶段通过“记忆内容承接 · 实验”查看两类旧内容及其真实设置。完整新记忆主入口由 N5 收敛；原资产/项目记忆的编辑、遗忘和开关继续从原入口使用，避免把尚未交付的自动记忆显示成可用。

## 承接与撤销

仅对原归属范围中已采用且有效的用户偏好/报告要求开放承接。未采用、停用、拒绝、来源不可用、待复核、过期及方法类内容不自动转成有效偏好。方法保留兼容管理或导出为 Skill 的去向。全局资产在项目里的覆盖绑定不改变其归属，继续由原运行时处理。

预览展示准确正文、版本、归属、场景、资源类型、领域标签、关键词、有效期及原条件保留说明。previewToken 冻结正文 ref、完整 binding（含优先级/互斥组）、资产最新 revision/标题、适用条件、复用条件、评估说明、审核和来源可用性。确认须提交该 token 与当前映射 revision；同事务重验，不接受过时预览。

承接不新建第二份正文或第二条注入路径；现有 resolver 继续按原 adopted ref、条件、项目停用覆盖及来源权限运行。管理层仅读取同一版本，因此本阶段承接前后选中的 ref 和注入数量相同。新调用链真正接管召回前，不能删除该兼容 resolver。

旧绑定、版本或条件变化时，映射显示 conflict，不偷偷跟随新版。用户可以重新预览并明确承接新版本；未经该动作仍展示原准确版本及冲突。来源撤回、项目归档或晋升依赖失效后，新 API 也清空正文并显示 unavailable，不通过复制绕过撤回。用户级晋升内容不公开原项目 ID、来源身份或私密标题/正文。HTTP 输出另重验当前凭据，包括非活动 provider。

承接与撤销使用 Idempotency-Key 及 CAS。撤销只回退对应映射的前状态并增加 revision；不会停用或回滚原资产。若后续发生映射、正文或绑定修改，旧撤销返回 409，不能覆盖它们。撤销新承接后旧调用回执只报告 replay，不重新写入；已失效来源不能通过旧 carry 回执复活。新旧不同请求复用同 key 返回 409。

## API v1

全局前缀为 /api/natural-memory，项目为 /api/projects/:projectId/natural-memory。所有入口复用当前认证、loopback/Origin 与项目可用性校验。JSON 禁止未知字段、重复键、null、遗漏必需布尔值和多份文档；错误仅返回稳定状态/code，不含 SQL、凭据或来源原文。

| 方法与后缀 | 契约 |
| --- | --- |
| GET /settings | scope、独立新 revision/epoch、autoEnabled/automaticReady、原偏好及项目设置 |
| PATCH /settings | expectedRevision、autoEnabled；N1 只允许 false，不修改原项目/策略设置 |
| GET /legacy | 当前归属范围的原资产元数据、准确采用 revision、eligible/reason、linkRevision/linkState |
| GET /legacy/:id/preview | 准确正文与范围/条件及 previewToken |
| POST /legacy/:id/carry | expectedRevision、previewToken；返回 id/revision/changeId |
| GET /preferences 与 /preferences/:id | 映射列表/详情，category=preference，adapter=legacy_binding；管理状态不等于模型已采用 |
| GET /preferences/:id/revisions 与 /revisions/:revision | 原不可变版本历史及受来源控制的正文 |
| GET /project-entries 与 /project-entries/:key | 复用原 V1/V2 项目记忆适配器，不复制正文、不扩大项目范围；分类仍以原字段为准 |
| GET /changes | 仅身份、种类、时间、映射 revision 与 undoneBy，不返回历史正文快照 |
| POST /changes/:id/undo | expectedRevision；精确撤销承接元数据，返回新 changeId/revision |

列表 limit 为 1～50，默认 20；偏好/旧资产/变更按 ID 游标分页，项目记忆沿原 offset/limit。版本元数据每次至多 50 条，准确版本可独立读取。新写接口不接受 learn、correct、online、来源身份或验证等级。旧策略新提取/实验接口继续返回 410。

后续 N4 的覆盖记录契约以 owner、项目/会话、稳定消息/事件 ID、source hash、policyVersion、epoch 为身份，并区分 captured 与 processed；预算裁掉部分不得完成覆盖。N1 只冻结该契约，不创建空队列、扫描历史或假报采集进度。

## 固定意图质量判据

[NM intent v1](../../internal/web/testdata/natural-memory-intent-v1.json) 在 N2 分类器实现之前冻结 60 个虚构样本：全局长期、项目长期、明确更正、临时、引用、含糊各 10 个；30 个应保存、20 个应忽略、10 个仅可待核实。每个样本独立，修正类在测试准备中提供同项目旧偏好。

后续真实分类器各跑 3 轮，每轮错误自动写入、错误范围、无用户依据写入均须为 0；每轮明确长期/更正召回至少 27/30，不能以三轮均值掩盖单轮退化。保存时必须提供真实用户依据，引用/日志/模型复述不能成为来源。固定文件含阈值；N1 仅校验样本与数量，不执行模型或声称通过质量评测。

这组自然意图样本不替代运维 V2 原定的 60 个事实/证据虚构案例 × 3 轮及剩余资源/时效、竞态、Windows 验收。V2 本阶段需要的 V1/V2 读取适配、迁移隔离、来源撤回与旧设置保真由回归覆盖，其余启用门槛继续保留。

## 回退与阶段边界

N1 无自动批量承接或内容迁移，没有新的 provider 调用、辅助任务或直接保存工具授权放宽。后续 N2 的新记忆内容更新/撤销与 N3 语义冲突处理不能用这里的“承接撤销”冒充完成。

回退旧二进制只在隔离副本验证，不用旧库覆盖最新任务、来源撤回或未知操作；较旧程序会继续使用原绑定，新映射仍是惰性元数据。再次升级后，旧程序修改过的内容应显示 conflict。Dev 采用签名快速运行，生产目录不变。实际源码 SHA、全量检查、升级/回退与原生验证见 [N1 验收](../validation/natural-memory-foundation-n1.md)。
