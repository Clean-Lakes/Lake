# 配对快照与关闭门禁的恢复

本页说明当前后端管理原语。它提供停服快照、验证、保全与恢复，以及绑定原操作的范围确认和项目策略重确认。实际 enforced 激活仍受全部入口覆盖与 reader 门禁约束。恢复完成后保持 `gate=closed`；没有忽略未知结果、恢复旧授权或直接开闸的参数。整个过程不修改 UI。

## 管理命令

使用按仓库脚本签名构建的 Lake 二进制。先正常停止目标 Home 的后端；日常开发只操作 Lake Dev 或显式隔离 Home。

```sh
bin/lake security checkpoint --home /absolute/isolated-home --output /absolute/new-checkpoint
bin/lake security verify-backup --path /absolute/new-checkpoint
bin/lake security restore --home /absolute/isolated-home --from /absolute/new-checkpoint
bin/lake security recovery-status --home /absolute/isolated-home
```

`checkpoint` 和 `restore` 要求显式 Home，拒绝存活 owner、已用目录及与运行数据重叠的快照路径。普通重启不运行 restore。现有 `security status`、`risks` 和限定单库初始迁移的 `resume-initial-migration` 保持原语义；后者不是备份恢复的开闸方式。

### 已收尾初始迁移的启动恢复

旧版本启动失败可能留下 `StoreReady=true`、`gate=closed`，而 `resume-initial-migration` 只接受尚未完成的初始迁移。对于已验证收尾、仅有基础 reader 1 的单规范库，可使用单独的 host-only 维护命令：

```sh
bin/lake security recover-finalized-startup --home /absolute/existing-home
# 核对预览、正常停服、创建并验证当前配对 checkpoint，再明确授权以下动作。
bin/lake security recover-finalized-startup --home /absolute/existing-home --apply --expected-digest EXACT_PREVIEW_SHA256
```

默认预览只读，可在只读恢复界面运行期间使用，不创建目录、owner 或 schema。输出仅有资格、收尾 ID、原操作/未决数量和绑定摘要，不含结果正文或凭据。apply 需要独占 Home、规范根和 Web owner，核对 control、完整收尾 receipt、全部原操作身份、当前状态/句柄摘要及未决数量；在私有 `security/finalized-startup-recovery/<digest>.json` 持久化人工维护授权后，再次验证摘要，最后原子更新 control。中断后保持关闭；同一摘要可继续，已提交的同一动作可核验后幂等返回。命令不启动模型、Worker、终端或资源操作，也不写数据库。

该入口仅接受 `preserve_unresolved_no_replay` 的已收尾初始采用，且没有新增操作、域级 Security/Super-agent schema、任何 goal、实际 recoveryID/journal、在途 Web 工作或排队消息。收尾证明、原身份或路径变化、出现第二旧库、reader 升级、未决数量变化均拒绝。实际 restore/enforced 恢复仍必须使用下述完整协议，不能使用本命令代替。它不核实 unknown、不恢复旧授权、不扩大项目权限，也不表示 Memory 获得新的恢复资格。

成功后由正常客户端执行原有 schema 初始化和权限检查。重新启动前需保留可验证的当前配对 checkpoint；启动后验证 Pilot、原历史/资源、模型对话及未知操作防重放。若启动再失败，保留关闭现场和错误，不能删除历史、再次手改 gate 或自动忽略未知结果。正式 Home 的维护和重启仍须取得对应明确授权。

异设备导入必须明确加 `restore --import`。它在目标 Home 生成新的 storeID 和随机 recoveryEpoch；同设备恢复保留 storeID，仅生成新随机 epoch。导入也保持关闭门禁，不继承旧临时授权。全新空 Home 可直接导入：先保存绑定输入 manifest 摘要的初始化记录，持久化关闭的 control，再通过官方 SDK 的公开迁移器建立空规范库；不会启动模型或 worker。此初始化可在两个断点重入。没有 control 但存在旧数据、密钥目录或其他未分类文件的 Home 不视为空目录，拒绝覆盖，须先明确恢复其原身份与历史。

## 快照内容与验证

快照包含同一停服时间段的规范 ADK SQLite、存在时的 Web SQLite、调度 JSON，以及已识别的会话/子会话 JSON。SQLite 使用一致快照包含已提交 WAL；不会把正在运行的主文件直接复制作为数据库备份。

私有 `manifest.json` 绑定快照身份、storeID、epoch、成员是否存在、大小、SHA-256、SQLite user_version 与 schema 摘要。验证检查精确成员、路径、符号链接、摘要、SQLite 完整性、规范库 reader guard 和身份；SQLite 附带未验证 WAL/journal/SHM 时拒绝。未完成的快照没有正式 manifest，不能恢复。

普通快照不包含 `<Home>/security/control.json`、密钥目录或 provider 凭据目录。会话和执行账本仍属私有数据，应保持私有文件权限。管理输出只给元数据，不打印数据库正文、命令、结果、句柄或凭据。

## 恢复协议

1. 在独占 owner 下验证快照，持久化恢复意图；任何数据库变更前先原子写入新 epoch、唯一 recoveryID 和 `gate=closed`。
2. 在 `<Home>/security/recoveries/<recoveryID>/preserved/` 保全当前完整配对快照，包括备份之后新增的操作、证据和授权变更。没有完整且可验证的保全记录，不替换任何运行数据。
3. 将输入快照复制到私有 `incoming/`，验证后在暂存库使未消费的 pending/decided/authorized 审批失效、暂停未终结任务/目标、关闭执行绑定并 fencing、撤销存在的 task/schedule grants、将存在的项目策略标为 unconfirmed，禁用调度。旧任务保留原 epoch，不自动转成新授权；原 nativeOperation/nativeEvidence 不删改结果。
4. 为处理后的暂存成员重新计算配对 manifest，逐文件原子替换。旧 SQLite companion 与快照中没有的旧会话文件保全到 `replaced/`。任一断点失败都保持关闭门禁。
5. 持久化 `ledger-index.json`，绑定 preserved/incoming 的 manifest 摘要，以原库为唯一执行事实源。索引给出两个命名空间的操作/未决计数与有界脱敏引用；超过展示上限明确标记 truncated，不表示其余记录不存在。`resourceMapping=unverified` 明确表示它尚未成为逐资源解锁依据。
6. 记录 `confirmation_required`。重试同一恢复复用原 journal、epoch 与保全快照，不把部分恢复结果当作恢复前历史，不重复产生临时授权。保全/暂存/索引被损坏时停止并保留现场。

恢复管理状态可在原有鉴权下读取：`GET /api/security/status`、`GET /api/security/recovery/status`、`GET /api/security/recovery/ledger-index`。这些接口不创建 Engine、终端、MCP 或后台 worker。新增的 review/work-history 接口读取确认要求和命名空间隔离的只读目标历史；impact-map、policy-confirm、activate 是鉴权后的管理动作，绑定 recoveryID/epoch、expectedRevision 与 actionID，不使用模型参数中的 actor。

## 当前限制

范围确认要求原始冻结 descriptor 与摘要、全部原资源 ID/连接版本，以及原快照和当前资产配置一致；不存在可信记录的 legacy/opaque 操作保持整个 gate 关闭。范围明确后仍保存逐资源写阻断，不改变原 unknown 状态。项目策略展示恢复前后原规则，明确重确认后以高于两侧历史的版本绑定新 epoch。

项目策略清单另列 `catalogResources`。`policy-confirm` 的 `resources` 必须显式带上待重绑定的精确资源 ID、连接版本/摘要/身份；即使没有未决操作，也不能借确认策略自动批准整个资产映射。核验比较不可变 incoming 中的原 catalog 与原 source storeID/epoch，以及当前 Web 资产的同一连接配置；只更新已确认的元数据身份。项目中未列入策略 I/O ceiling 的旧 catalog 条目也须明确核实，才能供重启后的统一 catalog 正常加载；其身份确认不会扩大 `policy.ResourceIDs` 或赋予操作能力。缺失原始 catalog 证明或目标已经变化的条目要求另行资产迁移/核实，不凭显示名称推断，不伪造一条 impact 来绕过检查。

未决扫描统一区分“进程已退出”和“副作用已核实”。即使原状态为 failed/succeeded，只要仍有 orphan、closure 或 cancel 事实而没有明确的 `risk_resolved_at` 与 reconciled closure，初始清单、恢复影响表和历史风险索引都会保留它。影响摘要绑定这些原始部分副作用事实；不会因另一个任务成功而丢失阻断。恢复扫描只读取有界元数据与冻结 descriptor，不加载整段命令结果或原参数正文来生成索引。

完整重新启用仍必须通过全部入口的最终派发保护与真实矩阵验收。激活检查只读编译期覆盖清单，不接受请求布尔值、环境变量或动态 allow 桩；清单缺项时拒绝，即使范围与策略确认已完成。Reader 2 的最低读取门禁、保全绑定和恢复清单完成后才可提交最终控制变化。保全索引本身不证明副作用已经停止，也不解除任何 unknown。

当前编译清单显式登记 93 个工具和 13 个执行家族，与规范目录逐项精确比较；未来新增入口未取得实际保护证据并登记时，完整性检查仍会拒绝。shadow 只比较记录；enforce 与 recovery-activate 各自核实当前策略、存量状态、来源和 reader 前提后才能提交，不提供通用 open/unlock 或 ignore-unknown 功能。不得手改 control、删除 journal/原账本、用历史无 reader guard 二进制或用初始迁移命令绕过这些条件。继续原工作须在新 epoch 下明确选择原目标、创建新的 SecurityTask 并重新取得必要授权，保留原目标、尝试、证据和风险。

管理可使用 `security recovery-review`、`recovery-work-history`、`recovery-map --input FILE`、`recovery-confirm-policy --input FILE`、`recovery-confirm-legacy --input FILE` 和 `recovery-activate --input FILE`，均须显式 `--home`；动作文件须私有 JSON。目标历史仅使用 `recovery-history-` 命名空间投影为 paused，不允许通过虚拟 ID 继续派发或覆盖原目标。

实现位置为 `internal/ai/security_checkpoint.go`、`security_recovery.go`、`security_recovery_index.go`；相应测试覆盖 WAL、私有路径/身份/摘要损坏、独占 owner、审批与任务失效、较新 unknown 保全、跨设备身份、六类恢复断点和重入。

恢复时每个旧会话的七项有效设置另行列入 legacyPolicies，展示两个快照的原来源、设置与版本；须逐会话明确重确认。重确认只能保留或进一步收紧任一历史快照中的限制，不能复活较新的 deny，也不使用项目默认值替代原会话设置。确认生成新 epoch 和更高 revision，原 task/grant/approval 不随之恢复。

## Memory 独立恢复资格

资源 gate 打开、项目策略确认或 task grant 均不恢复 Memory 同意。只要 control 带有 recoveryID，记忆采集、读取、索引、上下文使用和后台 provider 默认拒绝；现有内容接口也拒绝返回旧记忆。设置接口可继续收紧同意，但打开旧设置不生成资格。后台 worker 在取得全局后台资格前不领取、清理或重排旧 Memory 工作。

`SecurityMemoryRecoveryVerifier` 是当前 Memory 组件所有者的本机只读协议。它须独立核对 preserved 中较新的同意/撤回/遗忘下限、incoming 和当前 Memory 状态，并核实原始 Memory 用户动作；不能拿安全审批或“任务成功”充当同意。Security 不合并或覆写 bearqy 的 Memory schema、归档或 tombstone，也不提供请求布尔值、CLI 或 HTTP 解锁。

所有者完成核验后才能调用 host-only `QualifySecurityMemoryRecovery`。资格记录和追加式 action 记录只保存 recoveryID、storeID/epoch、项目、原动作、两侧 manifest 绑定及同意/遗忘/当前代际摘要，不保存记忆正文或遗忘键。每次实际使用会重新调用所有者核验；代际、撤回、遗忘下限、动作、用途或任一配对绑定变化都拒绝，旧资格不能跨项目/epoch 使用。后台模型请求带 host 解析的项目上下文，派发前与写回前分别检查。

当前尚无针对 bearqy Memory 的实际恢复核验器。默认恢复后的 Memory 因此持续关闭；资格接口不是“已支持安全恢复记忆”的声明。后续 Memory 所有者应先完成最新撤回/遗忘下限的迁移与核验，再接入此协议；资源恢复可以独立完成。

恢复后的普通 Web 存储以 `SkipMemoryInitialization` 打开：保留通用项目/会话 schema 的升级，跳过全部 Memory 数据与投影迁移、文件重建、后台 job 恢复和清理。缺少旧 Memory schema 的 Home 仍可加载普通会话；配置仅取得关闭的 Memory 设置和同意投影，不查询缺失的 Memory 列，也不通过静默安装 schema 来修补。该运行实例不会因一次资格检查自动迁移或发布 Memory；所有者后续必须提供显式初始化协议，核对两侧同意/遗忘下限及当前资产代际后再接管。

现有配置的项目策略也会单独收紧 Memory：`memory.read` 约束读取/使用/索引/provider；`memory.write` 的项目 allow 与 Memory 自己的同意共同约束采集/后台任务。后台没有 ask 交互，task grant 不表示采集同意。没有项目策略时保留原 Memory 同意语义。已鉴权的精确遗忘端点和关闭同意动作仍可提交现有 Memory 所有者的 tombstone/撤回事务；使用原存储的 epoch/revision 递增，不使用关闭投影的默认值覆盖历史。恢复状态不会借此重建其他 Markdown；待清理投影明确报告。缺失/不支持的 Memory schema 不自动创建，不开放正向写入、恢复删除、撤回的反向 undo 或内容读取。


## 激活后的逐来源副作用核实

完成封闭恢复审查、实际编译覆盖证明和 reader 门禁后，激活只允许恢复资源运行，不解除已映射的写阻断。关闭只读管理实例，再正常启动同一 Home，以新 epoch 创建独立受限核验任务，明确授权只读 envelope 与有限次数/期限。原 task/grant 不复用。核验必须实际执行注册的结构化读或固定只读 command profile，并保留真实 nativeOperation、原任务/步骤/尝试和 completed nativeEvidence。

使用运行中实例的私有 loopback 管理通道，不打开第二个 owner：

```sh
bin/lake security recovery-live-review --home /absolute/isolated-home
bin/lake security recovery-reconcile-preview --home /absolute/isolated-home --impact ORIGINAL_IMPACT_ID --resource EXACT_RESOURCE_ID --operation NEW_READ_OPERATION_ID
bin/lake security recovery-reconcile --home /absolute/isolated-home --input /absolute/private-reconciliation.json
```

相应鉴权接口为 `GET /api/security/recovery/reconcile-preview` 和 `POST /api/security/recovery/reconcile`。preview 绑定不可变来源 checkpoint ID、原记录/descriptor 摘要、原操作脱敏引用、当前同一资源的连接版本/摘要/身份、新纪元任务与只读 envelope 摘要、真实读操作及精确 evidence ID/摘要。读必须覆盖原路径、数据库、集群命名空间/对象或 service；旧证据、任意 Shell/MCP、不同目标、已变更连接与 mutating envelope 均拒绝。证据最多五分钟有效，且不晚于任务期限。

提交包含 `action`（actionId/recoveryId/recoveryEpoch/expectedRevision）、impactId/sourceId/recordDigest/resourceId/operationId、完整 previewDigest/evidence，以及 preview 展示的明确人工声明。此声明是一次独立的实际人工核验动作，不把“新目标执行成功”解释成原副作用已消失。服务端重新核对全部冻结字段与原始保全库，原子追加 receipt/action 审计并只解除该来源、该影响记录、该资源的阻断。其他目标成功、遗漏来源、伪造 evidence 或通用 ignore/unlock 请求不会解除任何风险。多个来源的同一原操作必须逐一核实。

所有对应来源/资源均取得 receipt 后，才可将当前规范库中 descriptor 完全相同的原操作的派生风险字段标记为 reconciled，并追加核实证据；原 status/result/descriptor/目标/尝试及不可变 preserved/incoming/activation 归档保持原样。review 的 reconciliations 只展示核实引用和实际操作者，不返回原结果正文。资源被重指向时该协议拒绝放行，须先执行单独的资产迁移与原影响核验。


存在待核实 source block 的原操作还受规范事实保护：普通 ResolveOperation 人工修正、重启的 dispatched→unknown 转换以及普通 orphan 自动标记/清理不得改写该原行，必须转入上述逐来源核实协议。独立持久写阻断继续约束其资源；此保护不恢复旧 owner，不自动停止或接管无法验证的旧句柄，也不影响无 recovery 来源关联的普通运行恢复。这样不会因一次通用“已核实”或启动时派生标记，使原始来源摘要失配而留下永远无法核实的写阻断。


原操作所属 canonical attempt 也保留原执行 State。只有同一 goal/step/task/root/版本绑定一致、该 attempt 的全部 canonical 操作及 preserved-only 原操作的逐来源风险都已核实，才将其派生 ClosureState 记为 reconciled，receipt 与追加审计绑定这一关闭事实；不伪造缺失的 operation/evidence，不把新核验任务当作原业务结果或自动记 pass。用户随后明确选择原 goal 时，创建当前 epoch 的全新 task，retryOf 继续指向原 attempt；新授权另行确认，原失败/未知和 coverage 历史仍保留。


公共集成回归 `TestSecurityRecoveryActivateRestartAndExplicitEffectReconciliation` 已实际通过：原生只读操作中断后创建配对快照，恢复后逐来源确认、重新确认项目与会话策略，调用公共 activation；关闭只读 owner 并正常重新打开 Home，创建新纪元受限任务/grant，执行真实本机文件读取并提交原 nativeEvidence，再逐来源核实解除原资源写阻断。测试确认新目标成功本身不解风险、伪造来源/evidence 被拒、原 status/descriptor 与归档不变，最后为原 goal 创建全新的 task 和 retryOf 原 attempt，不继承 grant、不生成业务 pass。缺少任一编译入口的独立回归仍明确拒绝；这项集成结果不表示 legacy/opaque 未知影响可以跳过范围证明。
