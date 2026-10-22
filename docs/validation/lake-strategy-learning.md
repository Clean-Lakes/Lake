# P8 策略学习验收记录

本文保留 PR #54 提交时的历史验收状态；后续真实模型、真实服务、Windows 与最终结论见 [P8 补充验收](lake-strategy-learning-p8-completion.md) 及 [补充 JSON](lake-strategy-learning-p8-completion.json)。不要将下述“未运行”当作后续补充验收的当前状态。

2026-10-22，从 `origin/develop@a783981ade1631d1466fcf6e8d785410bf88dfbb`（P7 PR #53 已合并）创建 `codex/strategy-learning-p8`。使用本地 `gh bearqy`，仅提交 develop PR，不合并、不触发 CI、不发布或操作生产。

**交付状态：Dev 验收工具、使用说明及退出演练已完成；完整发布验收尚未放行。** T33（macOS Dev）和 T34 已验证，T32 保留未完成：Windows 目标平台结果、真实 provider smoke 及推广用代表任务配对效果未取得，完整 M2 的真实故障环境仍未补齐。没有用合成模型替代这些门槛。

最终签名 Dev 与验收脚本验证提交为 `14845828e57264ab56df9111bd6253b6985b4331`，dirty=false；后续提交只追加计划、验证记录和截图。机器可读结果见 [验收 JSON](lake-strategy-learning.json)。用户操作、开关、停止原因和回退见 [使用说明](../strategy-learning.md)。

## 检查与修复

macOS arm64：Go 1.26.6、Node 24.18.0、项目固定 pnpm 10.33.4。Linux 为 Docker 中实际运行的 linux/arm64、Go 1.26.6，镜像 `golang:1.26.6@sha256:0d1d3a794be25f809dd2cb3160d8c73276c4056a9f8242a138e908ddeee7b6b6`；只读挂载源码/模块缓存，禁用网络，未连接真实模型或目标。它是 Linux 后端验证，不是 Linux 桌面或 Windows 替代验证。

| 检查 | 实际结果 |
| --- | --- |
| macOS `go test ./... -count=1 -timeout=8m` | 全包通过；AI 39.964s、Web 136.245s。测试修复后 AI 全量另跑通过（53.449s），Web 恢复案例在下述专项/完整 race 中复验 |
| `go test -race ./internal/ai ./internal/web ./internal/strategy -count=1` | 首轮 AI/strategy 通过，Web 暴露恢复测试的 Store 竞争；修复后 AI 完整 race 通过（143.072s），Web 完整 race 通过（346.736s） |
| 恢复案例 `go test -race ./internal/web -run '^TestStrategyOptimizationExplicitResumeKeepsBudgetAndCompletedRunIdentity$' -count=3` | 通过（34.338s），保留子进程崩溃、继续身份、TTL/epoch 和预算全部断言 |
| 两项手动压缩测试 `-count=5` | macOS 通过（1.979s）；最终 Linux 通过（0.840s） |
| macOS/Linux `go vet ./...` | 通过 |
| 最终 Linux `go test ./... -count=1 -timeout=8m` | 全包通过；AI 54.322s、Web 105.477s；不是交叉编译 |
| `python3 scripts/verify_strategy_learning.py --report <私有临时文件>` | macOS 最终提交通过；93 个顶层测试，含子项共 234 pass / 4 skip / 0 fail。4 项是仅供子进程启动的 helper，实际崩溃恢复由父测试执行 |
| ADK 边界、分支策略 | AST 边界通过，既有分支策略 4 项通过；未改变 CI 事件与来源限制 |
| 前端 `corepack pnpm check` / `test:frontend` / `build:web` | 在 web-agent 目录执行，全部通过，386 项、0 跳过；保留既有大 bundle 提示 |
| Dev 构建与签名 | 前端新产物构建后运行 `LAKE_REUSE_WEB_ASSETS=1 scripts/build_lake_desktop.sh --dev --install`；标准签名/安装成功，app codesign deep/strict、后端 hash 和干净提交校验通过 |
| 验收脚本负向检查 | 工具链失败、非零测试退出及成功退出但零测试，均返回失败；不生成“未跑也通过”的报告 |

首轮失败与修复：

- Linux 在并行负载下，既有手动压缩测试的 100ms 截止时间已到，测试才读取 live 状态。将 live 状态验证拆为明确 provider 阻塞/释放的测试；原 100ms 超时、原历史保留、checkpoint 和可重试断言均保留。未延长原超时来掩盖问题。
- Web race 实际检测到 P6 恢复测试替换 `b.Store` 时，New 启动的调度 ticker 同时读取该指针。只在测试中使用调度器已有的 `scheduleMu` 围住关闭/重开/替换，保留真实子进程崩溃和全部恢复断言。生产 Store 指针不发生这种替换，未改生产锁或执行语义。
- 原生 Dev 的资产面板使用 `window.confirm`，影响放弃编辑/删除的确认展示。改为页面内两步确认，暂停原编辑区；Tab/Shift+Tab 在确认按钮之间移动，Escape 返回编辑。初次原生复验发现 Tab 会离开确认区域，补充显式键盘边界后重新签名构建并复验。删除确认展示/取消、放弃草稿的取消与确认均检查；没有删除用户数据。

## V01～V16 覆盖映射

下表为现有自动回归与本次 Dev 证据的对应关系，不表示 Windows、真实模型或完整 M2 均已通过。测试名称可在仓库中直接检索；专项 JSON 保留实际测试身份和 pass/skip 状态。

| 验证项 | 证据 |
| --- | --- |
| V01 默认关闭 / 场景 / ADK | `TestStrategyDisabledPromptGolden`、`TestStrategyManifestAcrossProfilesRolesAndStdio`、`TestStrategyWebApplyOffOnNewRevisionAndProjectCap`；各独立 Home 默认五项均关闭 |
| V02 版本 / 绑定 / 范围 | `TestStrategyRepositoryVersionsBindingsAndIdempotency`、`TestStrategyRuntimePrecedenceAndRevocation`；A/B/C 的实际 prompt 和每个 Manifest 精确版本校验 |
| V03 Skills 改动 / 停用 / symlink | `TestStrategySkillImportPermissionsAndSourceChanges`、`TestSkillsRootsEnablementAndSymlinkIsolation`、`TestSkillCreationRejectsLinkedRootWithoutWritingOutside` |
| V04 秘密 / 授权伪造 | `TestStrategyRepositoryScopeSecretsAndTombstones`、`TestStrategyCompositionKeepsAuthorityOutsideStrategy`、`TestStrategyOptimizationParserRejectsForgedSourcesAndAuthority` |
| V05 并发 / CAS / epoch | `TestStrategyRepositoryTransactionRollbackAndConcurrentCAS`、`TestStrategyJobsStaleWorkersCannotCommit`、`TestStrategyOnlineOptInInheritanceAndFreshGuard` |
| V06 崩溃 / unknown / 派发身份 | `TestStrategyProcessCrashKeepsSingleCommitAndDispatchIdentity`、`TestStrategyLearningActualProcessCrashRecovery`、`TestStrategyExperimentActualADKProcessCrashNeverReplaysArms`、P6 实际 provider/checkpoint 崩溃与显式恢复测试；本次签名后端重启 |
| V07 实际进展 / 无进展 | `TestOnlineNoProgressAndUnresolvedOriginalGap`、`TestOnlineClosingAnotherFailureDoesNotEraseOriginalGap`、`TestOnlineFinalTextCannotCloseFailedCheck` |
| V08 权限 / 不透明 / 换目标 | `TestOnlineStopsBeforeOpaqueOrMutatingCorrection`、`TestOnlineFailureCategoriesAndDisabledCompatibility`、`TestOnlineOfficialADKReadonlyTimeoutProposalAndRecovery` |
| V09 运行中关闭 / 取消 | `TestStrategySwitchOffCancelsInFlightRequest`、`TestStrategyExperimentCancellationAndSourceRevocationStopsRemainingArms`；原生 Dev 在实际纠错请求进行中关闭、重新开启无重放 |
| V10 总预算 / 未知 usage | `TestOnlineBudgetUnknownUsageRevocationAndStrictProposal`、`TestOnlineSharedRoleBudgetConcurrentReservationAndRecovery`、`TestStrategyExperimentUnknownUsageAndRequestBudget`；退出保留保守预留 |
| V11 隔离 / 复位 / 不复用 | `TestStrategyExperimentResetFailureAndNoHostFallback`、`TestStrategyExperimentAllRegisteredSnapshotsAndIndependentADK`；本次 A/B/C 各三次独立 Home、服务复位、真实账本验证；完整真实服务 M2 仍未验收 |
| V12 合成 / 保留集 / 不自动采用 | `TestStrategyOptimizationSynthesisRevalidationHoldoutAndExplicitSave`、`TestStrategyOptimizationStopsForNoProgressRegressionAndBudget`、`TestStrategyExperimentHoldoutRepetitionsRegressionAndBoundary` |
| V13 血缘 / 删除 / 跨项目 | `TestStrategyDeletionInvalidatesSourcesAndArchiveKeepsReconciliation`、`TestStrategyLearningDeletionErasesPrivateSnapshotsAndResults`、`TestStrategyOptimizationMemoryForgetErasesCandidateCopies` |
| V14 递归学习 | `TestStrategyLearningAutomaticNewTurnAndNoRecursion`、`TestStrategyLearningCapturesOnlyOptedInRealSignals` |
| V15 UI | 前端 386 项；原生浅/深色、850×600、共享范围菜单/键盘、确认 Tab/Shift+Tab/Enter/Escape、版本/长 hash、继承开关和停止卡；截图见下方 |
| V16 无关问答 | `TestStrategyLearningCapturesOnlyOptedInRealSignals`；关闭后重开，新普通无工具问答只请求模型 1 次，无额外健康读取/纠错卡 |

## A/B/C 与原生退出演练

执行 `scripts/test_strategy_learning_dev.py --report /tmp/lake-p8-dev-verified.json --hold-for-ui`。脚本从已安装 Dev 的 Resources 使用签名后端，校验 Dev Bundle ID、codesign、build-origin、HEAD 和后端 hash。最终独立根目录为 `/var/folders/vd/tpn95_y535g6h9b4fkgmlc380000gn/T/lake-p8-acceptance-r3awxgb4`。不复制正式版配置/凭据，不读取 Keychain；关闭学习/记忆提取，Skills/记忆均为空且各臂一致。

健康服务是真实 loopback HTTP，第一次请求主动断连，第二次才返回固定 JSON；通过真实本机终端 `curl` 和既有只读 policy 调用。模型为无密钥、固定 SSE 的本机夹具，不是真实 provider。每臂重置服务状态并创建独立 Home/ADK session，顺序为 ABC、BCA、CAB；每次都验证原失败账本、实际版本清单，C 完成后还重启同一 Home 检查无重放。

| 臂 | 次数 | 每次真实 GET | 每次主任务模型请求 / 固定 fixture token | 结果 |
| --- | --- | --- | --- | --- |
| A 内置（新能力关闭） | 3 | 1 | 2 / 400 | 保留 failed，无资产注入或纠错记录 |
| B 仅应用同正文 v1 | 3 | 1 | 2 / 400 | 同样保留 failed，无纠错请求 |
| C 应用 + 在线只读纠错 | 3 | 2 | 4 / 800 | 原 failed 保留，提案后新调用 succeeded，准确缺口闭合 |

C 的纠错阶段为 3 次请求 / 600 token，包含最终报告；完整主任务为 4 次请求 / 800 fixture token。三个 C 均保留同一人工确认正文，修订 1 次，不生成或自动采用新资产。固定模型决定了这些数值；不能把 C 的成功率、耗时差或 token 当作真实模型增益。

原生 Dev 另用独立 Home，在源失败后的纠错模型请求已经实际进入 provider 时关闭总开关，任务为 cancelled，健康 GET 保持 1 次，旧报告保留 1 个未闭合检查及未知请求的保守预留。随后重新开启并发送普通无工具问答，只新增 1 次正常请求，不恢复旧任务。

通过 CUA 检查设置、项目继承状态、已采用 v1、停止卡与预算；未保存修改先确认，取消/Escape 保留草稿，Tab/Shift+Tab 不跳出确认区域，Enter 才执行放弃。浅/深色和 850×600 窄窗口的文本、按钮、菜单、圆角、滚动与裁切可读。恢复浅色和原窗口大小后正常退出这一 Dev。

- [浅色确认截图](images/strategy-learning-p8/confirmation-light.png)
- [深色窄窗口确认截图](images/strategy-learning-p8/confirmation-dark-narrow.png)

正常退出后，同一签名后端重启原生 Home：完整报告与预算保持；源操作仍为 failed/readonly，没有新采样。重复快照与空闲检查没有增加操作、健康请求或模型请求；native/Web SQLite integrity_check 均 ok。测试服务已退出；生产 Lake 保持运行且未重启。

## 门禁与后续

- 本 PR 提供可评审的 Dev 验收和文档，不修改 VERSION、不创建发布 PR/标签/Release、不合并 master。
- 自动 CI 仍只有同仓库 develop → master 提升 PR；没有添加 push/develop 触发，没有手动消耗 Actions。ADK 平台工作流加入相同的策略专项回归及仅含测试元数据的 JSON artifact，包含 Windows/Linux，并补齐 strategy/script 的路径匹配。
- **Windows 尚未实际运行。** 不能用本次 macOS 签名 Dev、Linux Docker、编译或未来会执行的 CI 代替结果。因此 T32 不勾选，发布门禁保持未放行。
- 未读取/使用真实 provider 的用户 Dev 凭据；真实模型兼容 smoke、冻结代表任务每臂至少三次、跨模型/范围效果与退化需另补原始结果。完整 M2 的可复位真实服务故障环境仍是前序明确留下的缺口，不能由这组 HTTP 断连控制流样本替代。
- 任一权限、秘密、重复操作、错误成功或关闭失效回归都应立即停止新增派发、保留账本；退出/回退步骤见使用文档，不恢复旧库覆盖新执行证据。
