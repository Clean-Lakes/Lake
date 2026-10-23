# R5：复用收益验收与旧优化退出

基于 PR #81 合入后的 develop `bb7228e`。不改写 P8 的 inconclusive；不因通过安全/平台回归而宣称模型收益。

## 冻结的配对契约

24 个登记留出回放，每类 6 个：明确报告偏好、私有项目命名、仍适用的维护经验、负迁移控制（不相关/过期/待复核/模型变化/工具变化/当轮覆盖历史偏好）。资产正文由独立开发说明预先编写，不含留出目标、trace、case ID 或答案。规则、问题/观察、字面判据版本和 hash 在真实模型调用前冻结；不提取、不提案、不合成，也不根据留出失败调提示再宣称原评估通过。共享规则使样本相关，不是 24 个独立真实用户任务。

每项 3 组 A/B，交替执行顺序；A 关闭应用，B 开启应用，其余当前模型/思考级别、上下文、空 Skills/项目记忆、空工具目录相同。B 走真实 Store 条件选择与准确采用绑定，不强行注入。每臂独立 Home/会话/运行账本，通过现有官方 ADK；两个实验臂的在线纠错和后台学习均关。只读回放观察由宿主提供，模型无任何工具权限；不把回放当实测恢复。

比较完成质量中的明确约定、原观察 target/trace 保真、负迁移、相同模型/固定提示/工具指纹与实际注入版本，并记录失败、不可比、耗时和 token。金额、供应商静默版本、用户真实再次纠正与审核负担未知；不估造。最多 144 次 provider 请求、4,000,000 保守 token、20 分钟；每臂最多 1 次请求，不重试失败样本。连续两次运行失败、选择/边界错误或供应商模型别名变化则停止，剩余任务保留未执行。

`TestR5ConfiguredDevModelPairedAcceptance` 必须显式传入非链接 `.lake-dev`、干净源码 SHA 和私有绝对报告路径。普通测试/CI 不读取 Dev 密钥、不调用外部模型。原 `RunStrategyVariant` 只增加宿主私有的日常选择器和无工具回放夹具，未新增模型/工具循环或 HTTP 可传执行器。通用收益结论始终独立于回放判据；无长期试用证据时维持 opt-in，不扩大默认范围。

## 旧路径退出与兼容

删除运行代码中的旧 optimizer 提案/合成提示词、执行器、checkpoint/resume/save-candidate 写入路径及前端操作/API。`optimization:true` 和旧 resume/save-candidate 返回 410；不重放旧幂等回执。普通手动 A/B 保留且不再依赖后台学习开关；来源、模型、预算、权限守卫不放宽。

策略 schema 保持 v6，不删除历史表/迁移。启动时在原恢复事务和进程锁内停止旧任务：未派发/已知 checkpoint 取消；running/intent/未知调用保留原 requestHash、usage、预留、runtime 和 unknown 状态，不再次派发。completed 产物与终态保留；重复启动不重复停止事件。旧报告仍可按项目读取、撤回来源和清理原文；canResume/canSave 永远 false。未知外部调用不因退出优化被当成完成或退款。

保留来源撤回、跨项目、真实进程崩溃/未知 intent、幂等恢复和迁移回退回归，以历史数据夹具替换已退出功能的继续执行断言。原生 ADK 审批/资源未知结果测试保留。无需清空数据库；回退代码前在隔离副本检查，不能通过旧版本恢复已取消任务或旧在线同意。

## 验证入口

```sh
go test ./...
go test -race ./internal/ai ./internal/web ./internal/strategy -run '^(TestStrategy|TestReuse|TestOnline|TestSRE|TestMultiAgent)' -count=1
go vet ./...
python3 scripts/check_adk_runtime_boundary.py
# web-agent 内：corepack pnpm check / test:frontend / build:web
```

真实模型试点（私有临时目录，显式选择当前 Dev 模型）：

```sh
LAKE_R5_DEV_MODEL_HOME="$HOME/.lake-dev" \
LAKE_R5_SOURCE_COMMIT="$(git rev-parse HEAD)" \
LAKE_R5_REPORT=/tmp/lake-r5-live-report.json \
go test ./internal/web -run '^TestR5ConfiguredDevModelPairedAcceptance$' -count=1 -timeout=25m
```

签名 Dev 仍用 `scripts/run_lake_dev.sh`，不打包。已运行 Dev 的两请求体验链路：`python3 scripts/test_strategy_reuse_dev.py --running-home "$HOME/.lake-dev" --report /tmp/lake-r5-dev-pair.json`。它使用独立临时项目、构造回放和手写偏好，不更改全局模型/用户资产/开关；试用后项目可恢复归档。原生界面检查需覆盖浅色/深色、最小宽度、历史报告与已移除操作。完成后在本页追加实际 SHA、计数、失败及局限。


## 实际验收（2026-10-23）

测试和签名运行代码提交 `0478f752558a72cadf23089517524422a7398f96`；后续提交只补文档/证据。汇总见 [R5 机器记录](../validation/lake-strategy-reuse-r5.json)，全部 144 臂的答案、判据和准确清单见 [可读记录](../validation/strategy-reuse-r5/same-model-replay.json)，原始完整报告及所有 manifest 另以 gzip 保留并记录 SHA-256；没有删失败、改分或重跑留出任务。

| 类别 | 配对 | 资产胜出 | 平局 | 退化 | 缺失/不可比 |
| --- | --- | --- | --- | --- | --- |
| 报告偏好 | 18 | 18 | 0 | 0 | 0 |
| 私有项目约定 | 18 | 16 | 2 | 0 | 0 |
| 仍适用维护经验 | 18 | 10 | 8 | 0 | 0 |
| 负迁移控制 | 18 | 0 | 18 | 0 | 0 |
| 合计 | 72 | 44 | 28 | 0 | 0 |

这里的平局不能全部理解为两组均通过：私有约定 2 臂、维护经验 8 臂的资产回答没有命中字面 private_requirement，A/B 在这些组均未通过该约定判据。10 项分别为 RU-07/3、RU-10/3、RU-13/3、RU-15/1、RU-15/2、RU-16/1、RU-16/3、RU-17/3、RU-18/1、RU-18/3。其协议、target/trace、边界、选择与负迁移检查都通过。原答中有“等级为：静水”代替“等级：静水”、“等待维护流程完成”代替“等待维护完成”等同义表达；这些更像字面评分的假阴性，不能直接认定语义错误。本次仍保留原判分，未来调整判据须预先冻结并使用新留出集，不能在已看过结果的样本上追认收益。

当前配置与响应别名均为 `deepseek-flash`，思考级别 low；144 次真实 provider 请求、零后台/提取请求，未触发预算/失败重试。A=330,955 tokens、B=342,150 tokens，B 多 11,195（约 3.38%），合计 673,105。金额未知。累计前台耗时 A=138,325ms、B=122,351ms；试点期间有两次额外 Dev 链路调用并行，耗时只作观察，不作因果性能收益。供应商版本/seed 未暴露，别名相同不证明权重不可变。

[签名 Dev 两请求对照](../validation/strategy-reuse-r5/signed-dev-pair.json)经固定 `~/.lake-dev` 的真实 HTTP/ADK 链路完成：两组事实与 trace 均正确、各一份 prepared 清单；只有资产组按约定使用“观察/判断/限制”标题。候选为零、无在线纠错或工具操作，未修改真实用户资产或全局模型/开关。临时项目已可恢复归档。Native 浅色/深色、2560/最小宽度 850、共享下拉的键盘焦点/悬停/裁切、旧优化按钮移除及学习关闭仍可进入手动 A/B 已检查，主题/窗口/原项目已恢复。

[旧版兼容](../validation/strategy-reuse-r5/rollback-compatibility.json)：私有 v6 夹具包含未派发、已知 checkpoint、未知 intent 和已撤回的历史记录，R5 先停止旧任务，再用此前签名 R4 二进制 `43496a7` 打开隔离副本，然后重新用 R5 打开。请求/预算/hash 与未知调用保留，旧 checkpoint 未续跑，旧在线同意没有复活。未接触正式版数据。迁移、跨项目读取、来源撤回和真实进程退出后的未知 intent 由回归补充覆盖；历史表/迁移与原生 ADK 资源审批/未知操作测试没有删除。

全量 Go、相关 race、vet、ADK AST 边界检查，426/426 前端测试和 Web 构建均通过；最终快照 worker 清理与兼容夹具另跑针对性 race。固定 Dev 已直接运行签名代码，无 ZIP/DMG、无原生替换；schema 保持 v6，业务和 ADK integrity=ok、foreign_key_check=0。全局应用/学习仍开、在线纠错仍关。Windows 原生界面未验证，本次没有手动 CI 或生产操作。

**决策：回放中观察到明确约定遵循改善，通用收益仍 inconclusive。** 保留用户级资产、明确采用及可选后台候选，停止旧自动优化，不扩大默认自动应用或自动晋升。独立真实用户任务、再次纠正次数、审核/拒绝负担和长期负迁移尚待自然试用收集。PR #81 已合入 develop 并清理本地/远端分支；PR #67 继续开放，不合并。
