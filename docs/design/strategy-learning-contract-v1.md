# 策略学习 P0 契约 v1

状态：P0 已通过 [PR #32](https://github.com/Clean-Lakes/Lake/pull/32) 合入 develop；用户于 2026-10-21 明确要求继续 P1，以此契约实施。此处记录合并与继续指令，不声称存在额外的独立评审记录。变更必须同时修改本文件、Go 契约及相应测试，不能悄悄放宽权限或默认值。

本期只核对调用链、定义纯数据契约和选择测试案例。不改变当前提示词、工具目录、会话执行、SQLite schema、API 路由或界面，不调用真实模型、连接资源、执行实验或自动重试。用户当前看不到策略功能，这是 P3 的交付。

## 1. 基线及调用链

实施基于 `origin/develop` 提交 `de6ddebc8cb6ba752f070250581688250001b1f5`、Lake 0.3.21、Go 1.26.6、ADK Go v2.6.0。其与当时 master 的内容一致，但生产 PR 的合并历史不同；本次不将历史差异当作功能变更。

| 入口或环节 | 当前实际代码 | 后续职责 |
| --- | --- | --- |
| Web/Desktop | `internal/web/agent.go` 的 `configure` 构造 `ai.Config`；消息经 Engine.Chat/ChatImages | P1 建立组合清单，P3 从已校验项目解析策略范围 |
| CLI/stdio | `internal/ai/stdio.go` 的 Handle/configure/chat 最终进入同一 Engine | 不创建绕过 ADK 的执行入口 |
| 每轮开始 | `internal/ai/engine.go` 的 ChatImages 调用 Prompt(c)，插入/替换第一条 system，再追加本轮 user | 本轮开始冻结策略引用；P0 不修改这里 |
| 场景分流 | `catalog.go` 的 Prompt/profilePrompt 选择普通、terminal2、db-query-editor、SRE 分流/角色、工作流收尾 | 固定规则公共前缀始终保留；不能把全部场景一起拼入 |
| 模型循环 | `adk_driver.go` 创建 LlmAgent/Runner，provider.stream 回调 `adkTurnDriver.next` | ADK 仍是唯一循环；不是简单设置 llmagent Instruction 就完成策略注入 |
| 实际请求 | `adk_provider_step.go` 的 next 从 Lake 历史构造请求，附加团队、项目记忆、运行额度和 todos，调用 e.stream | 清单必须覆盖实际 provider 请求，不只记录最初 Prompt(c) |
| SRE 角色 | `adk_sre_roles.go` 加载 sre-角色提示词到子 Config.UserPrompt，附加输出要求与父偏好；角色历史隔离 | 角色身份、输出 schema、冻结操作和验收条件不可优化 |
| SRE DAG/恢复 | `adk_sre_workflow.go`、adk_operations/approval/recovery | 保留成功节点复用和操作账本；候选实验必须隔离 session 和缓存 |
| Skills | `session_tools.go` 检查本地执行/文件读取权限后 loadSkill；extensions.ScanSkills 首个有效同名项生效 | 不能以新策略注入绕过技能读取权限或覆盖原文件 |
| 记忆 | adk_provider_step 调用 requestMemoryContext；Web memory worker 处理受控候选 | P3 防重复注入；P4 另存策略来源与候选，不修改事实 |
| 固定验收 | `sre_checks.go` 的 EvaluateSREChecks、sre_verification.go | 不把模型评价或提示词变更当作固定验收通过 |

`internal/strategy` 只依赖标准库，不导入 ai/web/ADK，不暴露数据库、文件读取、网络、模型或工具执行能力。当前仅定义 Scope、Settings、Budget、RevisionRef、AssetRevision、StopReason、ExperimentArm 及结构校验。它不会判断用户有权访问某项目、来源真实或某操作只读。

## 2. 提示词分类边界

分类以句子和契约为单位，不按整个文件机械判定；同一个文件可能包含三层内容。P1 移动策略时保留关闭状态的基线语义，不在重构中修正其他产品行为。

| 当前来源 | 固定规则 F | 可优化策略 S | 任务上下文 C |
| --- | --- | --- | --- |
| identity-and-permissions.txt | 全部：身份、授权来源、秘密、任务范围和拒绝绕过 | 无 | 无 |
| core-tool-template、terminal2、db-query-editor | 精确目标、内部标识不外泄、禁止冒充执行、工具/协议语义 | 在能力允许时选择查询顺序、工具建议、信息组织 | 平台、选定 runtime/目标 |
| conversation-style.txt | 不省略安全相关未知、保留强制机器格式 | 篇幅、先给结果、展示层次、报告偏好 | 当轮用户明确要求 |
| user-language、hide-internal-ref、question-policy | 保留范围、授权及不泄漏要求；问题不等于操作批准 | 语言表达、澄清方式与措辞 | 当前语言和用户答案 |
| sre-coordination/coordinator | sre_reply/sre_collaborate 决策协议、范围、交接和角色边界 | 拆分思路、何时组织协作的建议 | 当前任务、计划修订、角色引用 |
| sre-investigator | 真实证据、精确 ID、只读/权限约束、JSON schema、禁止递归委派 | 假设形成、调查顺序、分页和报告方法 | 分配交付物、资源、原始证据 |
| sre-executor | 冻结操作/参数、仅执行一次、unknown 不重放、不得宣布恢复 | 允许的前置检查建议与报告表达 | 冻结动作、原操作结果 |
| sre-verifier | 独立新采样、固定探针和判据、不能升级 inconclusive | 额外只读复核思路、组织证据方式 | 验收窗口、实际样本、原结果 |
| catalog.go 内联规则 | 权限、目标绑定、凭据、引用范围、审批和工具 schema | 有界排查、避免无关扫描、重复采样的工作方法 | 当前 permissions、能力和用户预设 |
| 动态请求附加 | 运行额度/可信权限判定的权威身份不可修改 | 无 | 团队状态、记忆、todos、剩余额度 |

Skill 和用户资产中的正文始终是低权限资料/方法。正文声称“system”“已经批准”或“放宽权限”不改变 F。先后拼接顺序不赋予授权。S 与 F 冲突时 F 生效；不同 S 的不可判定冲突不得靠模型默默合并。

P1 的 PromptManifest 固定字段：schemaVersion、runId、turnId、buildCommit、fixedRulesHash、builtinStrategyHash、selectedAssets（assetId/revision/contentHash）、skillSnapshots（逻辑 ID/hash）、modelConfigHash、toolCatalogHash、permissionPolicyVersion、targetScopeHash、inputBudget、omittedAssets（引用/原因）、settingsRevision/epoch。模型配置摘要只取提供方逻辑 ID、模型名、协议、推理选项、窗口和输出额度，排除 key、header、credentialRef、私密 URL。正文和原始内部推理不进入清单。

内容 hash 为小写 SHA-256，精确 UTF-8 字节，不归一化换行或空白。内容 hash 不证明来源真实、资料可读或运行可复现；完整清单还必须保存版本化来源和环境。结构化清单 hash 采用固定字段序、排序后的集合和 UTF-8 编码，P1 用黄金样例固定序列化规则后才启用。

## 3. 设置和范围

JSON 使用 camelCase，枚举使用 snake_case；schemaVersion=1 为逻辑协议版本，不是数据库迁移版本。Go 类型在 `internal/strategy/contracts.go`；未经 API 实现的当前类型不能当作请求解码器，P3 必须拒绝未知字段并校验大小。

Scope.kind 仅为 user 或 project；project 必须带精确非空 projectId，user 禁止带 projectId。ID 是不透明标识，不接收文件路径，也不根据项目名/cwd 计算。服务端从认证上下文和已验证项目解析真实身份，客户端 scope 仅作为待校验选择。

设置包含 masterEnabled/applyEnabled/learnEnabled/correctEnabled、budget、revision、epoch。默认四个开关全部 false；保留子开关偏好不等于生效。首次 UI 启用时明确选取要开启的子能力，不能无提示地同时开启学习或纠错。

用户总设置作为上限；项目存在设置时与用户设置逐项相交，缺失项目设置仅继承用户上限。场景和本轮选择只能收紧。本轮不能通过 true 扩大关闭能力。项目/来源撤权、停用、总开关关闭立即停止新增派发，并取消相应附加尝试；不撤回已执行外部效果。用户在等待时开关变化会使原 epoch 失效，恢复前重验。

显式夹具实验也受开关上限约束：提案/反思需要 learnEnabled，任何资产试用需要 applyEnabled，C 臂还需要 correctEnabled；缺少前提则拒绝相应阶段，不静默打开设置。只有隔离实验可以试用尚未采用的候选 revision；普通会话只加载已采用绑定。用户可以关闭学习，仅手写资产并在有权的夹具实验中试用。

revision/epoch=0/0 仅表示未保存的隐式默认设置；首次提交分配正数，以后单调增加，永不重置。关闭/删除/范围变化使 epoch 增加，旧 worker 提交被拒绝。revision 乐观锁与幂等键分别处理并发修改和请求重放，不用 epoch 充当操作授权。

## 4. 资产版本及采用

类型冻结为 user_preference/domain_procedure/tool_guidance/report_guidance，暂不提供可编辑权限、工具 schema 或角色身份的类型。assetId 是稳定身份，标题非唯一键。revision 为正数；首版 parentRevision=0，其后父版本必须是同资产更早版本，允许从旧版本分叉。

正文为非空 UTF-8，最多 100000 字节；contentHash 必须匹配。每版有一个或多个去重 sourceIds，手工创建也登记 manual_authoring 来源。适用字段是 profiles/resourceKinds/domainTags，所有选择器由宿主核对；空集合表示该维度不附加限制，不代表授予资源。

验证等级 user_confirmed 仅表示用户确认偏好/正文；single_observation 表示单次来源观察，不表示改进有效；fixture_validated 和 multi_task_validated 必须引用对应评估。模型填一个枚举不会获得该等级，仓库根据来源/评估赋值。Go 结构校验只检查词汇和完整性。

生命周期使用追加事件投影：candidate → trial → adopted，candidate/trial 可 rejected；采用绑定可 disabled，再启用/回滚必须选精确 revision。验证等级、资产生命周期、采用状态和实验 verdict 是独立维度，不用一个 passed 字段混用。

binding 唯一键为逻辑资产与 scope，包含精确 revision、enabled、bindingRevision、exclusionGroup、priority。单资产选择顺序为本轮明确选择 → 项目绑定 → 用户全局绑定，前提是当前范围与权限允许。当前用户明确要求优先于历史偏好。不同资产同排他组时若未明确选择则标记冲突并排除，不单凭 priority 或正文先后来判胜；priority 仅用于确定性注入排序和预算裁剪，同值按 assetId 排序。

导入 Skill 是带源 hash 的新资产快照，不改源文件，不借自动注入跳过 load_skill 的读取限制。导出遵循文件写权限。现有项目记忆关闭/忽略语义不变，不将实验假设写入记忆；重复来源的正文只注入一次，采用策略时保存实际清单和被省略原因。

## 5. 来源与血缘权限

来源类型固定为 manual_authoring/user_correction/tool_result/task_outcome/fixture_evaluation/skill_import；由服务端登记。引用至少带 sourceId、kind、projectId（如有）、sessionId/turnId/callId（按类型适用）、hash、时间、availability。availability 为 available/tombstoned/revoked；摘要已脱敏，原文不复制到跨项目可读的全局资产。

手工与用户纠错必须指向真实用户输入/确认事件；工具来源核对原调用、返回状态、采集时间和所属范围；失败或 unknown 不能成为成功事实。sourceIds 不接受模型凭空生成并提交；读取/入队/模型调用前/最终提交都重新校验来源可见性。API 客户端不能设置验证等级、可信 risk、账本状态或 actor。

节点类型为 user_message/task/plan_revision/run/attempt/tool_call/operation/evidence/correction/asset_revision/evaluation/adoption。关系为 derived_from/proposed_to_fix/tested_by/compared_with/composed_from/adopted_as/supersedes/reverted_to。边附 actor、时间、逻辑 aggregate 与去重键；不声称 derived_from 已证明因果。

P2 事务内核对端点存在、归属、关系类型、自引用和 supersedes/reverted_to 的版本次序。正文、来源边、修订和事件原子提交；外部执行与 ADK 库通过稳定 ID/outbox 对账，不假定跨库原子性。引用操作账本而不创建第二份执行权威。

删除原文后保留不含私密内容的 tombstone，显示证据缺失并停止自动推广。全局资产只携带用户明确确认的通用正文与脱敏来源摘要；从其他项目查看血缘不能越过原项目权限。原始工具输出、模型思维链和秘密均不作为公开资产正文或清单内容。

## 6. 预算与停止契约

v1 默认值同时是初期服务端硬上限，客户端可以调小，不能调大。原计划的“建议默认值”在 P0 收紧为此约束；扩大上限须经新的契约/测试变更。所有值由 DefaultBudget 提供，本阶段不实现计数器或自动重试。

| 字段 | 上限/默认 | 下界与语义 |
| --- | --- | --- |
| extraReadRetries | 2 | 0 表示无附加瞬时重试；计入底层已发生重试 |
| maxRevisions | 2 | 0 表示无自动修订 |
| maxNoProgressRevisions | 2 | 必须为正，不能用 0 表示无限 |
| maxConcurrentExperiments | 1 | 必须为正，仍受全局模型限流 |
| maxRuns | 6 | 包含基线、通用/领域候选、合成及复验，不能每臂重新领预算 |
| maxOptimizationRequests | 12 | 包含全部实验臂中的模型请求、提案、比较、合成、反思及其重试 |
| maxAdditionalTokens | 100000 | 全任务新增模型用量；取父任务剩余与此上限较小值 |
| maxActiveSeconds | 600 | 优化活动时间；等待用户不继续自动派发 |
| userWaitTtlSeconds | 86400 | 单次人工等待最多 24 小时，过期须显式恢复并重验 |

任一额度耗尽停止；换专员、计划或上下文不清零。一次任务的基线执行和候选工具循环也计入该任务运行/token/活动耗时，不能只计算提案。M3 原任务已花费保持原计量，新增尝试另记附加账本，同时受父任务总预算约束。

请求前保守预留，结束后按已知量结算；缺失 usage 不记零，不用虚构价格换算费用。不透明 MCP、任意 Shell/SQL 不凭模型标签判为只读。已有 dispatched 等原句柄结果；变更 unknown 先 reconcile，禁止重放；可信只读 unknown 可在无在途调用时新建采样，但旧记录保持 unknown。

StopReason 枚举使用 contracts.go；它记录优化为何停止，不能替代原业务任务验收。只有固定任务判据满足才能标 completed。停止无进展依据实际新增证据、排除假设或消除阻塞；仅换措辞或新时间戳不算进展。progress 判定与计量逻辑分别在 P6/P7 实现。

## 7. API 契约与错误

下列为 P3/P4/P5 的保留接口，P0 不注册路由。与原计划相比，项目范围显式放入路径，避免依赖隐含“当前项目”；仍由服务端校验 project 与 session/source 的关系。用户全局集合使用 `/api/strategy`，项目集合使用 `/api/projects/:projectId/strategy`。共同后缀：

| 后缀和方法 | 契约 |
| --- | --- |
| GET settings | 返回解析后的设置、revision/epoch、默认来源和本轮有效值说明 |
| PATCH settings | expectedRevision、四开关与完整 budget；成功原子提升 revision/epoch |
| GET/POST assets | 分页列表；手工创建传 title/kind/body/applicability，不接受 actor/verified/status |
| GET assets/:id/revisions/:revision | 精确不可变版本，校验 scope 归属 |
| POST assets/:id/revisions | expectedRevision、parentRevision、正文/适用字段；分配新版本，保留旧版本 |
| POST assets/:id/bindings | action=adopt/disable/revert，精确 revision、expectedRevision；事件与绑定同事务提交 |
| GET assets/:id/lineage | cursor、limit≤50；逐节点校验，缺失原文返回 tombstone |
| POST proposals | 已有 sourceIds、幂等键；返回 202/jobId，不接受伪造结果或自行验证标签 |
| POST/GET experiments、GET experiments/:id | 仅登记夹具、冻结输入与模式；返回运行及附加预算，不启动生产试跑 |
| POST experiments/:id/cancel 或 resume | 原版本与幂等键；取消不等于回滚；显式恢复重验权限/epoch |
| GET experiments/:id/report | 结果、失败样本、用量、版本和限制；原文依来源授权分页 |

所有变更要求 `Idempotency-Key` 和 expectedRevision（创建时为 0），同 key 同内容返回原结果，异内容返回冲突。P3 固定请求体 schema 和最大长度并拒绝未知字段。403 表示权限拒绝；404 对越界资源不泄漏存在性；409 表示版本/幂等冲突；400 表示类型/枚举/参数不合法；能力未交付不能返回空成功。标准错误体为 `{ "error": "可展示原因", "code": "strategy_revision_conflict" }`，code 使用 strategy_ 前缀，错误不得回显秘密或完整原始输入。

P2 使用计划第 6 节表名；外键/唯一键/索引和迁移号在实际迁移 PR 确认，不为 P0 空建表。事件复用既有同源 session 通知或轮询，不修改 events CHECK 来伪造新事件。API/技能/模型皆不能直接采用候选或扩大范围。

## 8. 基线与案例

`internal/strategy/testdata/cases.v1.json` 选择 15 项合成案例，12 项 development、3 项 holdout。它是待实现夹具的规格，不是已完成故障环境、运行结果或性能证据。P5 才固定镜像摘要、复位脚本和初始状态证明；在此前不得运行或宣称可复现。

三臂定义：baseline=同一构建的内置策略且不注入学习资产/不新增纠错；assets=仅注入显式选定的试用候选或已采用资产版本；assets_with_correction=相同版本加有界只读纠错。试用不创建正式采用绑定。所有臂使用相同手写 Skills/记忆快照、模型设置、输入材料、固定判据及初态；每次 session/Home/终端/缓存独立。

案例文件包含 evaluatorChecks，属于评估器材料，不能复制到提案/执行模型可见目录或上下文。holdout 不能进入提案/合成/经验库，只供最后固定评估；顺序与失败样本全部记录。原任务用户提示可见，标准答案和检测判据不可见。保留集失败不能通过调整其标准来通过。

拒绝、无权限、缺能力和普通对话都定义合格的停止/直接回答条件，不能只看有多少工具调用。P0 的 manifest 测试只校验案例完整性、隔离声明、划分及覆盖范围，不运行模型或判定排障效果。

## 9. 阶段门禁及后续

P0 本地检查：`go test -race ./internal/strategy`、`go vet ./internal/strategy`、`python3 scripts/check_adk_runtime_boundary.py`、新包依赖边界、文档链接和 diff 检查。无运行时接线，不重建/安装应用；本地 Dev 已有运行不受影响。按当前 CI 规则开发 PR 不自动检测。

T01 为基线/调用链核对；T02 为上述契约和纯 Go 值对象；T03 为案例与 baseline 规格。实现/验证完成后标“待评审”，仅 PR 获评审采用后冻结 P0 并进入 P1。P1 抽组合器之前先为关闭状态建立各 profile、SRE 角色、workflow/stdio 的黄金基线，不能把 P0 类型存在当作功能已接入。

关联：[主开发计划](../../plan/feature-strategy-learning-1.md)、[ADK 运行时](../experiments/adk-runtime.md)、[分支规范](../development-workflow.md)。

### P1 实施补充 2026-10-21

组合器、请求级关联、既有 ADK artifact 持久化及固定编码规则见 [P1 清单说明](strategy-learning-prompt-manifest-v1.md)。数组保留实际顺序；仅真正无序的集合排序。P1 不实现本契约中的资产 API、预算计量或学习/纠错开关。


### P2 实施补充 2026-10-21

已实现的组件 schema、权限/删除边界、双范围 generation、任务租约及 outbox 见 [P2 存储说明](strategy-learning-storage-v1.md)。仅可信宿主可调用仓库，P3 仍需独立 HTTP 请求 DTO 和同源认证；P2 不直接解码模型来源/验证等级。后继格式由本版本拒绝，P2 以前的旧二进制只能按隔离兼容副本流程使用，不能声称具有追溯安装的拒绝能力。P2 没有后台学习 worker 或自动资源派发。
