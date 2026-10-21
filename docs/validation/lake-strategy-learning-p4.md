# 策略学习 P4 本地验证

2026-10-21，基于 PR #40 合入后的 `origin/develop@d49d77d`，分支 `codex/strategy-learning-p4`，PR 目标 develop。范围见 [P4 设计](../design/strategy-learning-candidates-v2.md)。

## 功能验证

定向 Go 回归 `go test ./internal/web ./internal/ai -run '^TestStrategy' -count=1` 已通过，包含：

- 原始关闭态提示词/目录黄金样例；默认关闭不采集、不调用模型；普通对话不触发；开启后的真实纠正轮次仅生成一次 single_observation 项目资产，未绑定、未改原回复。
- 来源对应真实宿主会话/用户消息；快照 hash、真实配对工具失败与 unknown 区分；无原始工具日志；取消、SRE/角色/工作流/辅助完成不触发。
- 严格模型 schema、伪造来源、未知字段/大小写别名/重复 key/超长正文拒绝；敏感正文丢弃；令牌预算不足不派发。
- 关闭开关、撤回来源和取消时迟到结果不能发布；usage 仍可登记，正文不保存。
- 固定幂等键及同来源任务复用；资产正文/项目记忆去重且不改已有记忆；原会话可正常删除、失效来源不可再次使用；删除原会话和候选资产时同步清理关联快照/提取结果正文。
- 重启前后已保存结果仅提交一次；提交失败仅重试业务事务；真实子进程 os.Exit 崩溃覆盖调用期间未知状态和结果持久边界，不自动重发模型。
- v1 升级前私有备份、v2 重开幂等、原冻结 DDL 不变；未知 schema/hash 在重启写入前拒绝。历史 P2/P3 测试继续运行。
- 同源接口、真实消息登记、跨项目隔离、分页、幂等取消/撤回；HTTP 不暴露 lease token/hash。

最终实现及签名 Dev 后端已测试 SHA：`ba8a28faa0b69c42f165914b69a3eb795c298a34`。最终记录提交只更新文档，发布前仍需验证合入 develop 的集成 SHA。未触发日常 PR CI，未合并或发布。

## 完整检查

| 检查 | 结果 |
| --- | --- |
| `go test ./...` | 最终实现通过；ai 56.040s、web 149.040s |
| `go vet ./...` | 最终实现通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 最终实现通过；ADK 仍为唯一模型/工具循环 |
| `go test ./internal/ai ./internal/web -run '^TestStrategy|TestMessageQueue' -count=5` | 通过；覆盖精确消息身份接入与既有队列行为 |
| `go test ./internal/web ./internal/ai -run '^TestStrategyLearning' -count=10` | 通过；web 34.493s、ai 0.498s |
| `corepack pnpm check`（web-agent） | 通过 |
| `corepack pnpm test:frontend`（同目录） | 352/352 通过 |
| `corepack pnpm build:web`（同目录） | 通过；保留既有大 bundle 提示 |
| `git diff --check origin/develop` | 通过 |

最终 `go test -race ./internal/ai ./internal/web ./internal/strategy` 通过：ai 138.375s、web 288.763s、strategy 缓存通过，覆盖全部最终 Go 代码。原始命令日志在本机 `/tmp/lake-p4-*.log`，未提交包、运行数据库、凭据或工具原始日志。

## 签名 Dev 与桌面交互

在干净提交使用 `LAKE_REUSE_WEB_ASSETS=1 scripts/build_lake_desktop.sh --dev --install`；安装位置 `~/Applications/Lake Dev.app`。`codesign --verify --deep --strict` 通过；build-origin 的 gitHead 为上述最终 SHA、dirty=false，后端 SHA-256 与 bin/lake 一致。未安装或重启生产 Lake，未访问生产 Home/Keychain，也未复制生产凭据。

桌面交互在 `e4134f423b4684b90bfe31200cce7974f1819f6c` 完成。之后只完善 Go 来源身份、证据判定和隐私清理，React/Swift 无差异；最终提交重新签名安装，并使用新隔离 Home 完成最终后端 smoke/删除/重启验证。

桌面使用独立 `lake-p4-ui-*` 临时 Home，仅合成项目、两条纠正消息和 loopback 模拟 provider，无外部模型/远程资源。实际观察：

1. 自动完成真实纠正轮次后，学习区显示来源原文、已完成任务、提取理由、输入 120 / 输出 80 tokens；资产显示「单次观察，效果尚未验证」「本范围未采用」。
2. 从同一来源再次点击生成复用任务；API 核对仅一个 job/asset，模拟 provider 仅一次学习调用。
3. 界面关闭项目学习后发送第二条明确纠正，原对话正常完成，没有新来源/任务；重新开启后也不补学。最终主对话调用 2、学习调用 1、记忆提取 0。
4. 撤回来源后原文/理由不再显示，来源选择和采用按钮禁用；只保留不可逆身份/hash与用量。只读 SQLite 检查 snapshotJSON/resultJSON 为空，完整性为 ok。
5. 深色、浅色、约 850×600 窄窗口、滚动、换行及圆角无异常；共享 AppSelect 通过 End/Enter 和 Home/Enter 切换全局/项目范围。验收后恢复浅色、窗口大小并正常退出 Dev。

最终签名后端在另一个全新隔离 Home 运行：真实用户消息 → 一次无工具提取 → 未采用候选，精确 messageId 来源登记成功；删除候选清空提取结果，删除原会话清空来源快照并 tombstone；重启保持一个任务，不再调用模型，数据库完整性 ok。模拟 provider 主调用 1、学习调用 1，未访问真实付费模型。

## 限制与回退

未在 Windows/Linux 或真实供应商验证，没有效果提升或语义去重结论。手工登记入口需要当前项目真实用户消息 ID；历史消息浏览器、隔离评估、自动优化/纠错和定期保留期裁剪尚未交付。来源快照在用户撤回或业务删除时清理；SQLite 历史页/WAL/备份按私有数据管理，不声称物理字节擦除。

v1 先创建 0600 备份再升级 v2；P2/P3 旧二进制会拒绝 v2。优先关闭学习退出本阶段；需要降级时使用另一隔离 Home 的升级前兼容副本，不覆盖升级后已产生业务操作的当前库或 ADK/资源操作账本。详见设计中的迁移/回退流程。
