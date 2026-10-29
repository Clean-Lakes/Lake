# C4：当前文档与兼容验收

> 后续状态（2026-10-29）：旧资产应用与兼容管理已完全退出；当前入口、归档和拒绝规则见[退出契约](legacy-asset-exit.md)。本文保留当时阶段的设计记录。

2026-10-29，基于 C3 #117 合入后的 `develop@01c5e139b79914afc351b71c517b8275f7eacafd`。本阶段收尾[清理计划](../../plan/refactor-harness-inspired-cleanup-1.md)的文档、脚本、CI 引用与本地集成验证；自然记忆仍为实验，不默认开启。Windows 原生验收按本次用户明确选择不运行，保留缺口，不将 C4 宣称为全平台放行或生产发布许可。

## 当前入口与历史材料

- [Lake Memory 指南](../lake-memory.md) 是当前使用说明；[strategy-learning.md](../strategy-learning.md) 保留旧链接导向。README 指向当前指南。
- P0～P8、R0～R5 的设计与原始结果保留，页首注明历史范围和当前入口。原始答案、分数、hash 和 inconclusive 不变；历史命令不是当前功能。
- 原 P8/R5 Dev 试跑脚本不再创建项目、打开数据库、读取模型配置或调用 provider，直接说明退役并退出 2；旧完整脚本可在 [C4 前基线](https://github.com/Clean-Lakes/Lake/tree/01c5e139b79914afc351b71c517b8275f7eacafd/scripts) 查到。

## 验证工具

| 入口 | 当前含义 |
| --- | --- |
| `scripts/verify_memory_compatibility.py --report <私有文件>` | 当前 OS 上的记忆、旧资产、退役、迁移、上下文、审批/unknown 恢复等确定回归；只提交测试身份与状态，原始输出留私有日志，不读取 Dev key、不评模型收益/桌面 UI |
| `scripts/verify_strategy_learning.py` | 兼容别名，运行上述新回归；不恢复旧试点 |
| `scripts/dev_acceptance.py` | 通用私有 Home/HTTP/轮次等待；只发送一次，必须等新的 rootTurnId，保留失败/审批和超时语义 |
| `scripts/test_dev_turn_wait.py` | 保留旧队列竞争、不能拿上一轮完成代替新轮、不能自动重发等回归；从旧 P8 脚本抽出 |
| `scripts/verify_memory_compatibility_dev.py --report <私有文件>` | 使用仓库已签名、来源/hash 匹配的 `bin/lake`；新建隔离 Home、使用本机合成 SSE 模型，验证人工准确采用/未采用、承接不重复注入、旧写入 410、两个真实 HTTP/ADK 轮次及重复重启 hash 保真 |
| 上一入口加 `--previous-binary <明确旧二进制>` | 只将已经停止、仅含虚构数据的 Home 复制到另一临时目录，用旧版和新版各启动/读取后停止；不执行任务、不改模型、不连接工作库。通过不代表任意版本/在途操作可安全降级 |

离线报告要求每个选中包均有真实顶层 pass，任何子测试 fail 都失败；不能用进程返回 0、只跑 helper 或另一个包通过填补未选中项。`test_memory_compatibility_tools.py` 覆盖空选择、包遗漏、子测试失败、输出隐私及旧入口零副作用。原生产必须的会话、操作和授权存储错误不降级为诊断。

新增 `TestC4RestoredHistoryKeepsUnknownOutboxAndManifestWithoutExecution` 将三种旧渠道组合在同一官方 ADK 会话中：准确旧 outbox、未知纠错历史、旧 manifest。删除可替换 JSON 缓存后从 canonical 恢复；历史读取零请求，显式由宿主重新配置模型后新普通任务可完成，旧未知身份/预留不改写、旧来源不物化、零新增实验清单。恢复历史不会恢复供应商凭据或自动续跑。

## CI 引用与额度

三个验证工作流继续只在同仓库 `develop -> master` PR 自动执行；日常工作分支/develop PR 与 push 不触发。手动 dispatch 仍需当次明确授权，本次没有执行。

ADK/Windows 工作流改用新的兼容 runner、准确名称与脱敏报告，不再把测试描述为在线纠错/有界优化执行。生产 Windows 验证包含旧人工资产确认和自然记忆两项真实 WebView2 测试；原生用例仅重命名用途/环境变量，操作边界保持不变。`tests.yml` 增补通用 Dev 和验证工具的离线 Python 回归。

Windows 手动入口 `compatibility_only=true` 专用于兼容验证，不含打包步骤；`compatibility_checks` 可选 all、backend-only、native-ui-only、legacy-ui-only、memory-ui-only，`compatibility_resume` 只跳过已经在该源码通过的前端检查。未来重跑须依据真实失败缩小范围；新源码影响已通过项时不能拿旧结果替代新验证。输入选择不代替授权，也不影响生产 PR 的完整门禁。

## 清理后仍保留的代码

| 代码/数据 | 保留理由与边界 |
| --- | --- |
| `internal/ai/strategy_assets.go`、Web strategy runtime/selection/reuse | 复杂条件、准确采用/项目停用、来源撤回仍有效。新偏好不能等价表达的内容继续最小兼容；不自动放宽成通用偏好或注入专员 |
| `internal/ai/strategy_online.go` 与 `internal/strategy/online.go` 报告类型 | 仅 nativeCorrection schema、历史解释和幂等退役恢复；unknown 身份、预留和原终态保留，没有控制器、重新采样或预算续跑 |
| 旧 outbox seal/ACK、PromptBaseline/Manifest/SkillSnapshot | 保持旧 JSON/hash、准确回执及历史读取；普通请求默认不产生实验清单。Skill 真正加载、权限和正文校验继续工作 |
| Web strategy SQL v1～v6、review/lineage/privacy/reports/receipts | 旧内容、拒绝、跨范围保护、删除/撤回、旧回执不能绕过 410；不 drop 表或修改历史迁移。人工管理与新自动偏好的同意独立 |
| `RunStrategyVariant` input/result 与拒绝 stub、纯历史评分类型 | 历史宿主形状和元数据兼容，立即拒绝执行；无模型、回调或 Home 副作用。无产品调用者的 progress 函数仅留测试 |
| C1 退役恢复、旧合法取消/正文清理端点 | 幂等收尾和用户合法管理需要；已派发/未知记录不能被当作“未执行”退款或自动重放 |

上述保留不代表清理失败，也不是永久恢复旧平台的开关。后续只有在调用者为零，或用户确认的内容承接保留全部范围/条件/撤回语义时才移除适配器。不为删除行数破坏用户内容或官方 ADK。资源事实/经验仍按项目记忆及独立运维 V2 门控；V2 不在本清理阶段宣布交付。

## 验收与剩余边界

V01～V13 的准确测试、最终源码与结果见 [C4 验收](../validation/memory-compatibility-c4.md)。全量/race、离线 runner、隔离签名后端和固定 Home 的真实 Dev 各自记录，不互相冒充。新偏好质量/复杂业务收益没有因本次可靠性检查得到证明；旧收益结论保留。生产提升前仍需补 Windows 原生与发布候选的集成验证，发布操作另行授权。
