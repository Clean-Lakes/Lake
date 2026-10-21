# P1 提示词组合与请求清单 v1

日期：2026-10-21。基线：`origin/develop@1dd1e5a6a425c569ab150ab597787b90c60043f1`。P0 已通过 PR #32 合入；用户于 2026-10-21 明确要求继续 P1，按该契约实施，不声称另有独立审批记录。

## 组合与关闭状态

`internal/strategy/prompt.go` 定义纯组合器 Composition / PromptPart 和三层 fixed_rules、builtin_strategy、task_context。`internal/ai/strategy_prompt.go` 代替 catalog 中原来的字符串组合，来源分类位于 strategy_prompt_layers.go。

分类保守进行：身份、目标/协议、秘密、授权、未知效果、角色输出 schema 和独立验收要求留在固定层；仅将逐字审阅的表达与工作方法片段拆成内置策略；用户偏好、实际目标和动态上下文另记。混合文件按准确片段拆分，不按整个文件视为可优化。未知恢复文本不能因自称 system 而取得固定层标签。

本阶段没有资产注入接口或策略编辑入口。模型收到的文本、空白和顺序保持原样；分层与来源标签是宿主元数据，不额外向模型添加标记。17 组关闭状态提示词与工具目录 golden 在修改组合器前，从上述 develop 基线生成并提交到 `internal/ai/testdata/strategy-disabled.v1.json`；仅操作系统占位值归一为 `<GOOS>`，其他内容按精确字节比较。

覆盖默认/core/terminal2/db-query-editor/未知 profile、记忆、两类权限、用户预设、图片能力、SRE 分流、工作流、旧调查兼容及四个 SRE 角色。P3 引入用户资产时再增加低权限资料分隔，不在 P1 改变原有模型输入。

## 请求关联与持久化

ExecuteTurn 冻结第一条 system 消息的 PromptBaseline（hash 与分层片段，不重复存正文），随原有本地状态和 ADK 原生 projection 持久化。adk_provider_step 在实际历史副本上追加团队、项目记忆、运行额度、输出恢复及 todos 时同步登记片段；完成上下文整理、工具选择后，在现有 provider 调用前保存 PromptManifest。

沿用 `nativeArtifacts` 和现有 `sessions.sqlite`：ADK runtime session 内每次准备请求创建 `prompt-manifest-<requestId>.json`，版本固定为 1；RuntimeCheckpoint.PromptManifest 指向最新记录，包含文件名、版本、requestId 和精确内容 hash。老版本 artifact 保留，不因 clear 清除；关联沿用原 session/run/turn/角色身份。无需新表或修改业务 SQLite schema。

记录语义是 **prepared**。它证明宿主准备了这些输入，不能证明网络请求已经送达，也不表示任务成功；额度、取消或网络仍可能阻止请求。清单保存或本地引用保存失败时不调用 provider，不自行重试。输出超限后的第二次准备使用新 requestId 和 retryOf；输入、模型思考选项变化也据实重新计算摘要。已有 SDK 模型/工具循环、审批和 unknown 操作账本保持原路径。

已有会话缺少可信布局、或用户恢复的第一条 system 与冻结 hash 不一致时，compositionMatched=false，实际文本只归为未分类上下文，保留 systemHash/requestHash，不伪造完整三层证据。下一轮正常 ExecuteTurn 会建立新的布局。

## 字段及敏感信息

除 P0 冻结字段外，清单增加 requestId、round、retryOf、buildDirty、profile/role、fragments、permissionSettingsHash、systemHash、requestHash、compositionMatched、preparedAt，便于定位实际准备的请求。buildCommit 读取 Go 构建 VCS 信息；无法取得时明确为 unknown，不冒充某个提交。

- 固定/内置策略 hash：对应有序片段的 layer、source、contentHash、bytes；片段 hash 使用精确 UTF-8 字节。
- modelConfigHash：仅提供方逻辑 ID（有则记录参与摘要）、模型名、协议、思考选项/能力、上下文与输出额度、图片能力。明确排除 URL、认证头、key 和 credentialRef；stdio 未提供逻辑 ID 时留空，不用 endpoint 推导。
- toolCatalogHash：实际此次提供的有序工具及 schema；不是所有潜在工具的并集。
- permissionSettingsHash / targetScopeHash：当前权限值及显式目标选择的摘要，目标采用字段白名单，不序列化 Asset 的连接设置或凭据。
- systemHash：实际所有 system 消息的有序数组摘要；requestHash：适配器输入的模型摘要、完整 Message 数组和 Tool 数组摘要。它们不是 HTTP 字节签名，也不能单凭 hash 重现运行。
- inputBudget：当次窗口、输出、步数上限及原有 historyCost/toolsCost。cost 是当前运行时的字符成本估算，不能冒充 provider 的 token usage。
- selectedAssets / omittedAssets 恒为空数组，settingsRevision/epoch=0；P1 不启用学习资产、候选生成、实验或纠错。

清单只存摘要与受限元数据，不存正文、原始日志、记忆、私密路径、认证配置或模型推理。最终序列化若命中已配置秘密则拒绝记录，不能脱敏后仍沿用旧 checksum。hash 不提供认证、脱敏证明、来源授权或收益证明。

Skill 只有成功走原有 load_skill 权限流程后才记录 ID、实际返回的已脱敏正文 hash、callId、实际配对工具消息 resultHash。后续请求只包含当前历史中 callId 与 resultHash 同时匹配的快照；不扫描目录、不读取源文件核对、不将仅发现但未加载的 Skill 写入清单。较大结果的 resultHash 对应实际裁剪预览，contentHash 对应已加载正文；发生裁剪不表示完整正文都进入过模型窗口。恢复、裁剪或移除历史使配对消息不匹配时，保守省略快照。

## 编码与边界

CanonicalJSON 使用固定 Go 结构字段顺序，encoding/json 的 UTF-8/HTML 转义与 map 键排序；可选字段遵循类型中的 omitempty。数组保留实际组合、工具和加载顺序，不排序后冒充实际注入顺序。P0 所述“排序后的集合”在此明确为：只有真正无序的集合才排序，P1 的有序数组不属于集合。编码 golden 位于 `internal/strategy/testdata/prompt-manifest.v1.json`。

运行时权限策略版本为 lake-runtime-permissions-v1，配合 buildCommit 和 permissionSettingsHash 标识；后续权限契约变更需评审是否提升该版本。权限不由该字符串或模型决定。权限摘要记录该请求的会话配置快照；工具派发仍执行既有实时权限/目标版本校验，清单不能替代这些检查。

P1 增加每次准备请求的持久化写入，磁盘错误会使请求停止。沿用现有 ADK artifact 的私有存储和保留机制；后续归档/保留策略在数据阶段统一处理。回退程序可忽略新增 JSON 字段，旧清单留存于原存储；回退不删除操作账本，也不表示外部操作回滚。

P2 才实现策略资产与血缘仓库，P3 才提供可见管理与开关。此阶段没有可点击的策略功能，也没有模型效果或线上排障收益结论。

关联：[P0 契约](strategy-learning-contract-v1.md)、[主计划](../../plan/feature-strategy-learning-1.md)、[P1 验证记录](../validation/lake-strategy-learning-p1.md)。
