---
goal: 退出为借鉴 Harness² 增加的在线优化与独立学习平台，保留用户内容和 Lake 原有任务能力
version: 1.2
date_created: 2026-10-27
last_updated: 2026-10-28
owner: Lake
status: In progress
tags: [cleanup, harness, strategy, compatibility, user-preferences]
---

# Harness² 衍生功能与代码清理计划

> 2026-10-28：C1 已经 [#107](https://github.com/Clean-Lakes/Lake/pull/107) 合入 develop。用户确认将原策略资产重塑为[自然记忆](feature-natural-memory-1.md)：自然形成偏好、空闲整理、按范围使用及压缩前补充提取。后续内容与入口承接以新计划为准；本计划继续约束旧执行退役、兼容数据及 C3/C4 清理，不将新记忆提炼视为恢复旧策略提取。

## 1. 决策、基线与执行范围

**Lake 当前不接入 Harness²，不移植其 Python 框架，也不继续建设独立的在线纠错、自动候选学习和递归优化产品。** 保留用户明确确认的内容、版本和来源保护，将有用能力逐步归回偏好、项目记忆与 Skills。先停止新执行，再整理用户入口，最后拆除失去用途的代码；不能按 `strategy*` 文件名整批删除。

盘点基线：`origin/develop@ac3ae1544b00472da8e587f5f931d075d4e33917`，即文档 PR [#105](https://github.com/Clean-Lakes/Lake/pull/105) 合入后。初版仅提交清理计划，随后经 #106 合入。C1 从 `081d6652` 实施新增执行退役，见 [C1 契约](../docs/design/strategy-execution-retirement-c1.md)；C1 已合入 #107；C2 的内容与入口承接转由自然记忆 N1～N5 落实，C3/C4 物理删除与兼容验收仍待实施。不能将下文所有目标描述为已完成。

本计划接替[用户资产与经验复用计划](refactor-user-assets-and-experience-1.md)的后续投入方向。P0～P8、R1～R5 的实现与原测试结果继续作为历史证据；不改写完成记录，也不将 inconclusive 改成收益成立。已关闭且未合并的 [#67](https://github.com/Clean-Lakes/Lake/pull/67) 不重新打开、不挑入其剩余在线增强；其主机检查、Dev 快跑与记忆边界修复已由 #69/#70/#71 交付，继续保留。

### 1.1 为什么清理

- Harness² 的主要方法是在同一任务上提出不同运行配置、执行对照、组合改进，并保留有证据的经验，见[官方说明](https://github.com/google-research/harness2#readme)和[实验指南](https://github.com/google-research/harness2/blob/main/docs/EXPERIMENTS.md)。Lake 的真实运维现场会变化，不能将重复执行直接当作可靠对照。
- 当前实现是 Lake 自有 Go 代码对研究思路的借鉴，没有需要卸载的 Harness²/Python 客户端依赖；官方 ADK Go 是 Lake 的运行基础，不是清理目标。
- 当前“策略资产”独立于偏好、项目记忆和 Skills；开关、候选、审核、采用、晋升及实验增加了用户管理负担。
- `resolveTurnStrategies` 与 `collectStrategySnapshot` 有意隔离协调者、专员和工作流，不能把普通对话资产的测试当成 Pilot 排障复用已成立。
- [五场景实测](../docs/validation/strategy-five-scenarios-dev-20261023.md)证明生命周期可走通，但保留了算术错误和无明确阈值的判断；[R5 试点](../docs/design/strategy-reuse-acceptance-r5.md)也未证明长期通用收益。继续增加控制器和评估 UI 缺少依据。

## 2. 清理后的产品边界

| 用户需要 | 归属与保留方式 | 本次清理不自动做的事 |
| --- | --- | --- |
| “以后回复简短些、按中文回答” | 简单的用户/项目偏好，明确保存范围，可编辑、停用；后续复用现有持久化能力承接 | 不把一次临时要求永久化，不把项目偏好自动扩大到用户全局 |
| 项目环境、约定和事实 | 原有项目记忆及其明确写入/自动提取规则 | 不将所有旧策略正文批量写入记忆，不改变项目记忆原有开关 |
| 可复用的操作方法 | 原有 Skills 或任务手册；用户检查正文和适用条件后选择是否保存、使用 | 不自动安装/覆盖 Skill，不将未验证候选变成已验证方法 |
| 当前任务失败后的调整 | 原有官方 ADK、工具结果、任务范围、权限和操作账本 | 不强制提交策略修订，不用新预算控制普通调查 |
| 过去保存的资产、候选与实验记录 | 受原权限约束的兼容查看、导出、撤回和历史访问 | 不因入口退出删除用户内容，不恢复旧实验或旧同意 |

收敛完成后不再有面向日常用户的独立“策略学习平台”。后续以统一“记忆”入口管理自然形成的偏好、项目事实与历史经验，用户可查看来源、修改和撤销；完整方法仍从 Skills 进入。旧内容的兼容管理入口保留至内容有安全去向；它不是新的常驻学习中心。

“从任务整理为 Skill 草稿”是可选的后续独立需求，不是本清理计划的必交项；不为替换一个被移除功能再建设另一套后台生成系统。Harness² 对照方法仅作为开发验证参考，不要求本轮新增离线优化框架。

## 3. 保留、拆分与移除清单

下表给出实现定位。一个文件内可能同时有业务保护、历史读取和待退役执行代码；实施 PR 必须按函数与调用关系拆分，不以文件前缀决定删除。

### 3.1 保留的 Lake 基础能力与用户内容

| 编号 | 能力与代码定位 | 清理决定 |
| --- | --- | --- |
| K01 | 官方运行、审批、操作、证据及恢复：[adk_driver.go](../internal/ai/adk_driver.go)、[adk_operations.go](../internal/ai/adk_operations.go)、[adk_recovery.go](../internal/ai/adk_recovery.go)、[adk_services.go](../internal/ai/adk_services.go) | **保留**。模型正常使用工具结果调整方法；原有输出/工具调用格式恢复、上下文压缩、审批及未知效果核实不按“纠错”字样删除 |
| K02 | 项目记忆：[project_memory.go](../internal/ai/project_memory.go)、[project_memory_v2_store.go](../internal/web/project_memory_v2_store.go)；Skills：[skills.go](../internal/ai/skills.go) | **保留**原有职责、发现顺序、读写授权、来源撤回及后台记忆提取；策略提取退出不等于关闭项目记忆提取 |
| K03 | Pilot/SRE：[lake-pilot.md](../docs/lake-pilot.md)、[sre_coordination.go](../internal/ai/sre_coordination.go)及相应专员实现 | **保留**任务规划、方向选择、独立验证和执行范围；不为资产复用放开角色权限或直接注入整份旧策略 |
| K04 | 已确认内容与版本：[strategy_store.go](../internal/web/strategy_store.go)、[strategy_review.go](../internal/web/strategy_review.go)、[strategy_settings.go](../internal/web/strategy_settings.go) | **保留内容与必要管理能力**：准确 revision/hash、CAS、用户/项目范围、采用/停用/回滚、导入导出。复用现有库承接偏好，暂不做全库改名或另建资产库 |
| K05 | 来源、跨项目保护、撤回与拒绝记录：[strategy_lineage.go](../internal/web/strategy_lineage.go)、[strategy_learning_privacy.go](../internal/web/strategy_learning_privacy.go)、[strategy_review.go](../internal/web/strategy_review.go) | **保留保护与历史**。可简化血缘图的日常展示，但不能删除来源依赖、拒绝抑制、脱敏和不可重新启用的墓碑 |
| K06 | 主机检查修复：[tools.go](../internal/ai/tools.go)、[inspect_host_target_test.go](../internal/ai/inspect_host_target_test.go)、[strategy_host_target_test.go](../internal/web/strategy_host_target_test.go) | **保留** #69 交付的目标/runtime 传递及真实桥接回归，可按职责重命名测试，不回退正常工具修复 |
| K07 | 签名与 Dev 快跑：[run_lake_dev.sh](../scripts/run_lake_dev.sh)、[dev_run_preflight.py](../scripts/dev_run_preflight.py)、[dev_build_origin.py](../scripts/dev_build_origin.py) | **保留**构建来源、占用与 Dev/生产隔离；脚本与 Harness² 运行无依赖关系 |

### 3.2 移除执行能力，保留兼容读取

| 编号 | 当前入口与代码定位 | 目标及保留边界 |
| --- | --- | --- |
| X01 | 在线控制器：[strategy_online.go](../internal/ai/strategy_online.go)、[online.go](../internal/strategy/online.go)、[progress.go](../internal/strategy/progress.go)；`revise_readonly_strategy` 及 provider/engine 接点 | **移除新在线修订、自动采样、在线预算和停止拦截**；删除活动工具注册和提示。保留旧报告解码、未知状态和受限历史卡，不再因旧会话恢复进入控制器 |
| X02 | 自动候选提取：[strategy_learning.go](../internal/ai/strategy_learning.go)、[strategy_learning_outbox.go](../internal/web/strategy_learning_outbox.go)、[strategy_learning_worker.go](../internal/web/strategy_learning_worker.go)、[strategy_learning_input.go](../internal/web/strategy_learning_input.go)、[strategy_learning_routes.go](../internal/web/strategy_learning_routes.go) | **移除纠正前缀触发、终态自动采集、新候选任务与模型提取**，同时停用手工登记来源后调用提取模型的入口。已有候选保留待审核身份，可查看、导出、拒绝；不自动采用 |
| X03 | 用户快照实验：[strategy_experiment.go](../internal/ai/strategy_experiment.go)、[strategy_experiment_worker.go](../internal/web/strategy_experiment_worker.go)、[strategy_experiment_routes.go](../internal/web/strategy_experiment_routes.go)、[fixtures.go](../internal/strategy/fixtures.go)、[reuse_evaluation.go](../internal/strategy/reuse_evaluation.go) | **移除产品内新增 A/B 任务、变体执行与快照工具目录**；旧报告查看、取消收尾、正文清理及读取鉴权保留。无运行调用者的夹具/评分器删除；仍有必要的回归夹具留测试代码，不为历史报告保留执行器 |
| X04 | 旧递归优化：[strategy_optimization_store.go](../internal/web/strategy_optimization_store.go)、[strategy_optimization_report.go](../internal/web/strategy_optimization_report.go) | 执行器和提案/合成已在 R5 退出，**不重复宣称本轮才移除**。保留 startup 退役恢复、未知调用和历史读取；resume/save-candidate 等旧写入口继续拒绝，不能顺带恢复 |
| X05 | 在线和学习开关/预算：[contracts.go](../internal/strategy/contracts.go)、[learning.go](../internal/strategy/learning.go)、[strategy_settings.go](../internal/web/strategy_settings.go)及共享前端契约 | **移除活动配置意义与预算调节 UI**，旧 JSON 字段只作兼容/审计。`master/apply` 在人工内容承接完成前仍服务原采用绑定，不能与在线开关一起删除 |
| X06 | 特化自动相关性和实验反馈：[selection.go](../internal/strategy/selection.go)、[reuse.go](../internal/strategy/reuse.go)、[strategy_reuse.go](../internal/web/strategy_reuse.go)、[strategy_reuse_routes.go](../internal/web/strategy_reuse_routes.go) | 原有绑定在承接前保留范围、条件、失效及准确版本检查；**承接完成后退出独立关键词评分、方法自动注入和实验收益反馈入口**。明确偏好的范围与输入限额仍需保留，不将旧条件丢弃后扩大应用 |

### 3.3 拆分共享运行代码和界面

| 编号 | 代码定位 | 目标 |
| --- | --- | --- |
| S01 | [strategy_prompt_layers.go](../internal/ai/strategy_prompt_layers.go)、[strategy_prompt.go](../internal/ai/strategy_prompt.go)、[prompt.go](../internal/strategy/prompt.go) | 保留实际身份、权限、工具指导与用户指令的优先级；退出为可优化槽位引入的精确字符串分类/匹配强依赖。普通任务仍按原规则构建提示词，不因某段文案改变而产生策略分类故障 |
| S02 | [strategy_assets.go](../internal/ai/strategy_assets.go)、[strategy_runtime.go](../internal/web/strategy_runtime.go)、[agent.go](../internal/web/agent.go) | 将人工偏好的加载与旧控制器/实验 epoch 检查拆开。暂保旧采用内容的冻结版本和撤回检查；承接完成后删无调用者的策略 provider，不向专员盲目继承普通会话资产 |
| S03 | [adk_provider_step.go](../internal/ai/adk_provider_step.go)、[strategy_manifest.go](../internal/ai/strategy_manifest.go)、[strategy_usage.go](../internal/ai/strategy_usage.go)、[strategy_manifest_test.go](../internal/ai/strategy_manifest_test.go) | 当前每次请求仍准备并持久化 PromptManifest，不能说关闭总开关就无此路径。拆除实验预算/清单强耦合；保留历史清单读取、准确内容版本追溯及必要的不含密钥诊断。将可选实验诊断从前台必写路径移出；不吞掉真实会话保存、授权或操作账本错误 |
| S04 | [server.go](../internal/web/server.go)、[strategy_learning_worker.go](../internal/web/strategy_learning_worker.go)、[strategy_jobs.go](../internal/web/strategy_jobs.go)、[types.go](../internal/ai/types.go)、[engine.go](../internal/ai/engine.go)、[adk_session.go](../internal/ai/adk_session.go) | 先拆开 worker、ModelActivity/前台优先回调、策略字段、Outbox、nativeCorrection 初始化和历史解码。停派发后移除无调用者的后台 ticker/锁/预算记账路径，保留已有记录与恢复隔离，不删除共享 ADK 服务 |
| S05 | [ModelSettings.tsx](../web-agent/web/src/ModelSettings.tsx)、[StrategySettings.tsx](../web-agent/web/src/StrategySettings.tsx)、[StrategySwitches.tsx](../web-agent/web/src/StrategySwitches.tsx)、[StrategyLearning.tsx](../web-agent/web/src/StrategyLearning.tsx)、[StrategyExperiments.tsx](../web-agent/web/src/StrategyExperiments.tsx) | 先去掉学习、在线及新评估操作；人工内容承接后退出独立“策略资产”主标签。兼容查看旧内容/报告从次级入口进入，不删除旧内容来隐藏入口 |
| S06 | [StrategyPromotion.tsx](../web-agent/web/src/StrategyPromotion.tsx)、[StrategyReuseEditor.tsx](../web-agent/web/src/StrategyReuseEditor.tsx)、[StrategyUsageHistory.tsx](../web-agent/web/src/StrategyUsageHistory.tsx)、[StrategyCorrectionCard.tsx](../web-agent/web/src/StrategyCorrectionCard.tsx)、[AIPanel.tsx](../web-agent/web/src/AIPanel.tsx)、[contracts.ts](../web-agent/shared/contracts.ts) | 日常偏好不再要求研究式“确认—晋升—调参—试跑”。仍保留用户决定跨项目范围的明确确认；旧纠错卡只解释历史终态，无“继续实验”入口，老卡片不破坏消息渲染 |

## 4. 用户数据与兼容要求

### 4.1 两套存储分别处理

业务 SQLite 通过 [strategy_migration.go](../internal/web/strategy_migration.go) 管理 v1～v6 及 schema hash，涉及资产/revision/正文、来源/血缘、绑定/设置、jobs/receipts/events、学习/实验/优化、审核/晋升/拒绝、复用条件/反馈等表。**保留现有 SQL 迁移与 hash 输入**，不 drop 表、改写历史迁移或直接降版本。若需新增清理状态或偏好映射，实施 PR 冻结字段与兼容性；不能在本计划中声称已存在。

ADK 持久化另有 `nativeCorrection`、`nativeArtifact` 和会话状态里的 `PromptManifest/PromptBaseline/SkillSnapshots/StrategyOutbox`。历史清单与纠错记录不等于业务库中的实验任务。清理必须覆盖两边的恢复入口、旧 JSON 和历史卡，不能只停止 Web worker。

备份使用现有权限私有、保持一致性的备份方式；自动化验证在隔离副本进行。回退旧二进制只能使用兼容离线副本，不能用旧数据库覆盖用户最新任务、已撤回内容或未知操作。保留资产与删除来源继续走原权限和撤回规则，不绕过墓碑。

### 4.2 停止旧任务和阻止复活

1. 在工作线程、轮次恢复和 provider 调用前生效退役状态。对持久化 `learn/correct/online` 的执行值清零或作等效持久停用，并保留旧值、revision/epoch 与退役原因；迁移幂等。`master/apply` 和人工绑定在承接前不自动放宽或清空。
2. 对确定未派发的 proposal/experiment，记录取消/退役并撤销租约；已派发或持有未知 intent 的任务保留身份、预留和 unknown/awaiting_reconciliation。已完成原结果保持不变，不退还未知费用或重新发模型请求。
3. 已保存 Outbox 只做退役确认/兼容收尾，不再物化成新候选；不扫描历史补学习。活动任务的停用不能错误取消无关普通任务，已经派发的真实资源操作继续走原核实流程。
4. 已退役写 API（新提取/实验/续跑/优化保存）在正常身份、范围检查后明确拒绝，使用稳定的退役错误（已知入口可用 HTTP 410）；拒绝检查不能被旧幂等成功回执绕过。只读、导出、撤回和合法清理端点继续鉴权。
5. 旧客户端提交 true、旧会话恢复、重启、重复迁移都不能重新开启执行。不能只删 UI 或只在内存设 false；对旧程序回退的限制必须写入用户说明并在隔离副本验证。

### 4.3 人工内容的承接契约

| 内容状态 | 处理要求 |
| --- | --- |
| 已明确采用的偏好 | 保留精确正文和版本，预览新的用户/项目归属及有效范围后确认承接。承接前沿用原窄范围和停用覆盖；承接不能重复注入或丢失原条件 |
| 已采用的方法类内容或复杂条件资产 | 不自动改成通用偏好。支持导出或用户确认整理为 Skill；条件无法等价表达时必须让用户选择保留兼容应用或停止应用，不静默扩大范围 |
| 未采用、待审核、已拒绝版本 | 保持原状态与来源，允许按权限查看/导出/删除；不批量确认，不因清理自动激活；拒绝和来源撤回记录保留 |
| 用户全局资产引用项目私有来源 | 保留来源权限和撤回依赖；承接/导出不得泄露原项目消息、标题和摘要，不能通过“复制为偏好”绕过撤回 |
| 有效手写 Skill、原项目记忆 | 原文件/索引/设置保留，不复制覆盖；从旧资产导出不等于安装或授予新读取权限 |

新用户的正常使用不再需要原策略总开关、纠错开关、候选预算或实验面板。迁移期允许保留必要的兼容后端；**退出旧主入口与保留旧数据是两个独立动作**。不能为了完成删除清单强制用户丢弃内容。

## 5. 分阶段实施与删除顺序

每阶段以当时最新 `origin/develop` 为基线，独立分支和 PR。实施清单必须补具体 API/字段、回归名称、验证 SHA 与未验证项，不能直接把计划勾为完成。

| 阶段 | 状态 | 范围与退出条件 |
| --- | --- | --- |
| C0 盘点与决策 | 已合入 #106 | 本计划、代码分类、兼容边界与验收矩阵；不改变运行行为 |
| C1 退役新增执行 | 已合入 #107（510aad88） | X01～X05 的在线/学习/评估入口停止新派发；持久退役、两库恢复、旧 API 防复活及界面移除新执行操作。保留人工应用、历史访问和必要的惰性兼容函数；[C1 契约](../docs/design/strategy-execution-retirement-c1.md)及[验收](../docs/validation/strategy-execution-retirement-c1.md) |
| C2 人工内容与入口收敛 | 转由自然记忆 N1～N5 落实 | 旧正文、绑定、范围与来源保真承接，统一记忆入口；新记忆采用自然形成/空闲整理/按范围使用/压缩补充提取的交互，不要求逐条采用。复杂方法不自动转成无条件偏好，Pilot 权限不变；见[新计划](feature-natural-memory-1.md) |
| C3 运行依赖与代码清理 | 待实施，依赖 C1/C2 | 拆分 S01～S04，去掉优化槽位、无用请求清单必写、策略 provider/配置及无人使用的工具/预算类型。对仍需兼容应用的内容保留最小适配器；未达到等价承接条件的代码不得提前删除 |
| C4 文档、测试和最终验收 | 待实施 | 更新 README/指南/测试脚本/CI 引用，保留历史证据；验证升级、重启、拒绝旧写入、内容承接、普通任务/Pilot、取消/审批/未知恢复；记录剩余兼容代码及理由 |

若 C2 的最小偏好承接仍需要复制整套策略平台，暂停扩展，优先保留受限的旧内容管理与导出；不能以清理名义新增向量检索、自动评分、多次试跑或另一套 Agent 循环。代码删除以零有效调用者、兼容读取和数据去向验证为门槛，不按删除行数验收。

## 6. 测试、脚本与文档处置

- 保留原生审批、未知操作、来源撤回、跨项目读取、版本采用/停用、签名/Dev 隔离、主机目标和项目记忆边界回归；必要时从策略测试中拆出。删除在线“继续执行成功”、候选自动生成、产品 A/B 新任务等旧功能正向断言时，补成退役拒绝和无额外调用测试，不能只删失败测试。
- [verify_strategy_learning.py](../scripts/verify_strategy_learning.py)、[test_strategy_learning_dev.py](../scripts/test_strategy_learning_dev.py)、[test_strategy_reuse_dev.py](../scripts/test_strategy_reuse_dev.py) 随对应阶段退役/缩为兼容验证；通用的“消息只发送一次、等待新轮次”的回归 [test_strategy_dev_wait.py](../scripts/test_strategy_dev_wait.py) 先确认仍有调用者再抽离/更名，不能连带丢失排队竞争覆盖。
- [strategy_daily_test.go](../internal/web/strategy_daily_test.go)、[原 strategy_background_test.go](https://github.com/Clean-Lakes/Lake/blob/081d66520dfc8f958a8eebbd84b675a183113613/internal/web/strategy_background_test.go)、[原 strategy_crash_test.go](https://github.com/Clean-Lakes/Lake/blob/081d66520dfc8f958a8eebbd84b675a183113613/internal/web/strategy_crash_test.go)、[strategy_reuse_acceptance_test.go](../internal/web/strategy_reuse_acceptance_test.go) 等按“正常能力保护/退役兼容/已无用途实验”重新归类；C1 已将无新增执行用途的正向测试替换为 [退役回归](../internal/web/strategy_retirement_test.go)，历史删除文件链接固定至 C1 前基线。真实模型收益脚本不成为日常测试默认项。
- [P0～P8 旧计划](feature-strategy-learning-1.md)、[R0～R5 旧计划](refactor-user-assets-and-experience-1.md)、`docs/design/strategy-*`、`docs/validation/` 中原始报告和失败原样保留，加日期/基线及承接说明，不重写样本得分。README 与 [当前指南](../docs/strategy-learning.md) 在运行代码落地时再同步“当前可用/已退役”，本次仅新增计划链接。
- `internal/strategy` 的纯类型、hash 与通用帮助函数先找出非实验使用者；仅在调用迁移和历史解码可用后删除或移动。不能整包删除导致官方运行、Skills 或项目记忆间接失效。

## 7. 实施验收矩阵

| 编号 | 场景 | 必须满足的结果 |
| --- | --- | --- |
| V01 | 新安装、旧全开设置、旧客户端回传 true | 无在线修订工具、提取模型调用或新实验派发；原项目记忆设置不变；重启后不复活 |
| V02 | 普通只读失败后调整调查；格式异常、上下文压缩 | 沿原 ADK/工具权限运行，不出现策略修订/额度停止；原协议恢复与上下文能力仍在 |
| V03 | queued/leased-none、intent/started/unknown、已完成实验及提取 | 分别退役或保留未知/终态；计数、费用预留、原身份不丢失，重复启动不重复派发 |
| V04 | ADK 旧会话、旧 Outbox、PromptManifest、纠错卡 | 正常加载且可受限查看历史，不注册修订工具、不回放操作、不把旧失败改成成功 |
| V05 | 已采用/未采用/拒绝/撤回资产的查看、导出和承接 | 版本、状态和来源保真；未采用不激活；旧内容与新偏好不重复注入 |
| V06 | 项目 A 晋升后在 B 读取，随后撤回 A 来源 | B 不读到 A 私密来源；原撤回链及 B 停用覆盖继续有效，无静默扩大范围 |
| V07 | 普通会话与 Pilot 的“简短中文”偏好、当轮要求覆盖 | 回复遵循明确范围，当轮要求优先；不把表达偏好当作工具授权，不为普通解释强制创建调查 |
| V08 | 方法类复杂条件、Skill 源变化/读取拒绝 | 不自动转换为通用规则或复制安装；范围/来源不等价时保留兼容或明确停止，不放宽边界 |
| V09 | 退役写 API 及旧成功幂等回执；匿名/错项目请求 | 不产生新副作用；保持身份/项目隔离，旧回执不绕过退役；合法历史访问仍可用 |
| V10 | 请求诊断失效与真实存储/授权故障 | 可选诊断不新增前台失败点；业务会话持久化、权限撤回和未知操作错误仍按真实边界处理 |
| V11 | 手写 Skills、项目记忆提取、主机目标/runtime、终端停止 | 原有行为和必要回归保留，策略清理不误删这些正常功能 |
| V12 | v1～v6 升级副本、重复迁移、回退兼容副本 | schema/hash 可核验，正文/关系/历史不丢失；未知记录不退款、不续跑，不能覆盖最新工作库 |
| V13 | macOS/Windows 历史渲染与新入口，浅/深主题、窄窗口 | 旧卡/旧内容可用；无失效主标签、残留执行按钮或布局问题；未验证平台如实列出 |

实施代码时运行相应 Go 回归、必要 race/vet、`python3 scripts/check_adk_runtime_boundary.py`；UI 改动运行项目固定 pnpm 的类型检查、相关测试及构建，并在签名 Lake Dev 验证。最终阶段再对集成 SHA 执行全量检查，不把旧阶段结果替代新删除后的验证。真实模型仅限有界、明确的验证场景，保留失败和用量；无需为本计划重跑 144 臂研究试点。

初版文档 PR 只核对代码定位、相对链接、引用记录与 `git diff --check`。后续实施 PR 按实际代码运行上列检查；Windows CI 仍需届时明确授权。

## 8. 完成标准与执行纪律

清理完成应同时满足：没有新增旧策略在线修订/候选提取/实验的可达路径；用户正常任务不再依赖研究式开关和预算；原有工具/权限/记忆/Skills/Pilot 工作；用户内容有保真的去向，历史和未知状态仍可查看；兼容代码列表、原因及测试已记录。不是“隐藏入口即完成”，也不是“数据库里没有 strategy 表才完成”。

所有实施遵守 [AGENTS.md](../AGENTS.md)、[CONTRIBUTING.md](../CONTRIBUTING.md) 和[开发规范](../docs/development-workflow.md)。文档批准不等于开始全部代码清理，也不等于 PR 合并或发布授权；后续按阶段推进，每个 PR 完成本地验证并另行获得合并授权。已运行的 Dev 与生产数据均不因本计划变更；正式发布另走 develop → master 流程。
