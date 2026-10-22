# P5 隔离快照评估

P6 在此基础上增加显式有界优化、合成复验及已知结果阶段继续，见 [v4 说明](strategy-learning-optimization-v4.md)。本页保留普通 P5 A/B 的规则。

P5 交付登记夹具、独立 ADK 运行、固定客观判据及 A/B 报告（T20–T23）。首期是 **synthetic_snapshot 合成快照模式**：15 个与 P0 场景对应的可复位观测数据集，12 个开发场景、3 个保留场景。没有启动真实 SSH、Docker、PostgreSQL、Redis 或 Kubernetes，也不声称实现了 P0 目标规格中的真实故障注入/服务复位。原 `testdata/cases.v1.json` 保留为历史目标规格，实际登记表在 `internal/strategy/fixtures.go`。

## 用户入口与范围

在「工作区 → 设置 → 策略资产」打开本项目资产的一个精确版本，再展开「隔离快照评估」。选择至多 3 个场景、每个场景 1 次配对；或选择 1 个场景做 3 次配对。每场实验至多 6 个变体运行。全局与项目有效总开关、应用、学习均须允许；操作不会静默打开设置。默认关闭时不创建实验或模型请求。

A 使用同一构建的内置策略，不读取已采用学习资产；B 仅应用本次明确指定的资产 revision/hash。项目所有权、来源和精确修订由服务端验证，不能通过请求指定 actor 或验证等级；用户全局资产需先明确复制成项目资产。可试跑未采用版本，实验结果不修改采用绑定或不可变 verification。

C（有界纠错）、候选合成、自动多轮优化、显式继续中断实验属于 P6，不在 P5 提供。中断后使用新的明确实验请求，不自动补跑历史实验。

## 冻结与复位

创建时固定资产、场景版本、配对次数、当前模型逻辑身份/推理与输入输出额度、项目记忆快照、明确选择的手写 Skill 快照、有效预算与 user/project generation。当前模型协议首期限定 OpenAI Chat Completions 兼容接口。远端模型版本/seed 不可得时标明未知，不声称确定性复现远端生成。

上下文沿用当前模型显式/缓存容量及现有自动额度算法，再限制到最多 64000；未知时以 64000 作为本地输入预算，不能将其当作供应商已知容量。未指定输出上限时使用 2048，最终不超过 2048 或输入窗口的四分之一。冻结额度与实际请求清单一致。

项目记忆按 key 稳定排列，只取启用且未删除/过期内容，完整条目累计不超过 16 KiB，另记录遗漏数量、epoch/revision。共享上下文与所选至多 4 个已登记且启用的 Skill 原文合计不超过 32 KiB；超出或含已知敏感内容拒绝创建。两臂使用完全相同的快照，用户可在报告看到 contextHash/Skill hash。原记忆更新不混入正在运行的实验；遗忘记忆时清理关联实验副本并取消任务。Skill 修改/停用、来源撤回、资产修订、项目归档或开关变化会阻止后续派发/发布。

每个 run 有独立随机身份、0700 目录、0600 观测文件、独立 Engine 和 ADK SQLite session/artifact；不复制生产 Home、资源、凭据、终端、记忆数据库或主会话。首次创建目录若已存在即复位失败。复位证明记录实际文件 hash 与唯一 nonce，观测前及结束后再核对；每组相同初始 hash、不同目录/session/nonce。证明仅覆盖合成观测文件，不证明真实操作系统状态。

每场实验按场景/重复号交替 A→B、B→A 顺序，记录 ordinal。所有失败、未执行和未知样本都保留，不通过挑选最好一次形成收益结论。

## 唯一 ADK 循环与执行边界

每臂调用现有 `Engine.ExecuteTurn` → 官方 ADK Runner/LlmAgent，不新增模型/工具循环。实验 child 共享父 Engine 的模型并发槽；没有 Bridge、宿主扩展、工作流、团队协调或学习权限。

私有实验能力在目录和实际执行两个入口同时限制：core/terminal2 仅支持 `read(path=/fixture/observations.json)`；数据库场景仅支持精确 `execute_sql(asset_ref=fixture-db,schema=fixture,sql=SELECT * FROM fixture_observations)`，由 Go 读取对应快照，并无数据库连接。没有模型可提供的路径、SQL、Shell、网络或身份会进入普通宿主 executor；已知但未广告的伪造能力同样被拒绝，拒绝计入越界尝试。未知工具请求亦从真实历史计入指标。

模型请求依旧生成并保存实际 PromptManifest，记录 SDK run ID、固定规则/内置策略、工具目录、配置指纹和 B 实际注入的精确资产。未实际注入的 B 不参与候选胜出判断。上下文不足直接停止，不通过额外摘要模型逃离总预算。实验不保留流式思考、Reasoning 或 Native 响应块，只持久化工具配对、最终产物和有界可解释指标；依赖私有原生推理重放的供应商/模型不在首期验证范围。

## 预算、取消和恢复

实验使用 P2 strategyJobs 的固定 runtimeId、租约、generation/来源/CAS 检查；一场实验跨所有运行共享 MaxRuns（≤6）、MaxOptimizationRequests（≤12）、MaxAdditionalTokens（≤100000）与 MaxActiveSeconds（≤600）。每臂另外最多 3 个 ADK round、60 秒，不在新臂清零实验总额度。

每次实际请求前持久预留输入 UTF-8 字节、工具 schema、输出上限及余量；包括原有的一次输出恢复请求。结束后只有 input/output 均已知时按实际量结算；usage 缺失、进程退出或派发结果未知保留完整预留，不记为零。请求次数、保守令牌计费额、逐臂 usage/耗时可见；金额、提供方版本和随机种子未知时不编造。预留不足不派发模型。

派发前预写稳定 run 身份和 running 状态；原 ADK 是 SDK 执行事实权威，业务表记录实验协调及报告，不另造资源操作账本。取消/撤权由 watchdog 与每次请求/工具/发布前检查执行，已发出模型请求的用量仍记录，迟到正文不发布。

重启前未派发的 lease 可返回队列；一旦有实验派发意图，就把在途臂保留为 unknown、剩余臂为 not_executed，实验停止，不重新发出任何臂。已完成样本和稳定身份保留；已完成实验在业务提交与派发收尾之间崩溃也保持完成，释放并发占位。资源工具只有本地快照读取，派发对账完成不代表未知模型输出成功。报告允许 inconclusive。

## 固定评估与泄漏隔离

Actor 只收到用户任务、统一输出协议/全局分类词表、相同共享上下文及本臂资产；通过受限工具获取合成观测。每个任务的预期 outcome/finding、判据绑定、保留集标识、其他臂产物、评价反馈都不进入 Actor 请求。判据由 Go 执行，不让提案或比较模型修改，不运行另一个评判 LLM。

最终产物要求严格单 JSON：outcome、finding、answer、evidenceIds。固定检查包括正常 SDK 完成、无越界、严格 schema、预期任务状态/诊断分类、实际观测支持的证据 ID、基本诊断词，以及普通写作零资源调用。拒绝伪造证据、重复 key、尾随文档、错误分类及 unknown 冒充成功。这是结构/分类/证据/关键词检查，**不是对自由文本语义正确性的完整判断**，更不证明真实服务恢复。

报告分别显示开发/保留集配对的胜出、退化、平局、未完成/不可比。存在运行失败、复位失败、缺结果或 B 未注入时不宣称候选收益；完整可比样本才比较固定检查，退化优先展示。3 次重复仅提供原始配对结果，无统计显著性或普遍提升结论。

正常结束后登记真实 fixture_evaluation 来源和 tested_by 血缘，摘要与 hash 关联实际报告。不会自动生成/采用新修订，也不会提升旧修订 verification；P4 提案入口不接受 fixture_evaluation 来源，保留集评价不回流自动学习。

## API、报告与隐私

仅项目同源前缀 `/api/projects/:projectId/strategy`：GET fixtures、GET/POST experiments、GET experiments/:id（或 /report）、POST /cancel、DELETE experiments/:id。新建需 Idempotency-Key、精确 ref、场景 IDs、repetitions、skillNames；未知/null/重复字段沿用严格解析，跨项目 404。后台返回 jobId，不阻塞请求。列表显示最近 50 个实验；每个报告包含该实验全部臂，不隐藏失败样本。

API/导出不返回 frozenJSON、资产正文、共享原文、租约或认证配置，只返回身份/hash、实际有界产物、检查与预算。界面使用 AppSelect/Glyph/DisclosureSummary；比较是模拟数据，采用始终另行确认。

清理实验、撤回资产来源、删除资产/原会话或遗忘相关项目记忆时，清空关联 frozenJSON/reportJSON，保留最小身份/hash及状态，并清理已停止的独立实验 Home。删除不把未知状态补成成功。SQLite 历史页/WAL/兼容备份仍按私有数据管理；尚无自动 30/90 天保留期裁剪，用户需显式清理。

## v3 升级和回退

v1/v2 原 DDL 字节与 hash 算法保留；增加 strategyExperiments / strategyExperimentRuns 及约束。v2 升级前先产生私有的 lake-web.before-strategy-v3-*.sqlite；v1 保留已有 before-strategy-v2 命名兼容备份，再直接事务升级 v3。未知版本/hash 在任何重启写入前拒绝。DDL 失败回滚，重新打开 v3 不重复备份。

P4 旧程序拒绝 v3。优先关闭学习/应用停止新实验；需退回旧程序时使用另一隔离 Home 的升级前兼容副本，不覆盖升级后业务库或 ADK/资源操作账本。P5 实验目录独立于原会话和原资源账本。

验证见 [P5 记录](../validation/lake-strategy-learning-p5.md)。
