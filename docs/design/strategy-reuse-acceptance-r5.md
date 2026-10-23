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
